"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { HeaderMenu } from "@/components/HeaderMenu";
import { NEW_CATEGORY, NewCategoryOption, useNewCategory } from "@/components/NewCategoryOption";
import { withoutAmountQualifier, isSeriesKey } from "@/lib/series";
import { InlineEdit } from "@/components/InlineEdit";
import { CategoryBadge } from "@/components/CategoryBadge";
import { rowButtonProps, ROW_FOCUS } from "@/components/rowButton";
import { MonthPicker } from "@/components/Actions";
import { useMutation } from "@/components/useMutation";
import { useTxDrawer, useShelfActive } from "@/components/TransactionDrawer";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { InfoHint } from "@/components/InfoHint";
import { Tooltip } from "@/components/Tooltip";
import { SearchBox } from "@/components/SearchBox";
import { getJson, postJson } from "@/lib/http";
import { CADENCE_DAYS } from "@/lib/cadence";
import { LoadError, LoadingRows } from "@/components/LoadState";
import { SummaryCard } from "@/components/SummaryCard";
import { usd, shortDate, defaultMonth, isCurrentMonth as isCurrentMonthOf } from "@/lib/format";
import type { RecurringSettings, RecurringForMonth, RecurringSuggestion } from "@/lib/queries";
import type { Category } from "@/lib/types";

// Shapes come from the library that produces them; the aliases keep the file's
// existing names. `Settings` used to omit endedDate — the page wrote it anyway.
type Settings = RecurringSettings;
type SettingsPatch = Partial<Settings>;
type Rec = RecurringForMonth;
type Cat = Category;
type Suggestion = RecurringSuggestion;

const CADENCE_LABEL: Record<Rec["cadence"], string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Every 6 months",
  yearly: "Yearly",
};

// Active = charged within ~1.5 cycles (plus grace); else treated as stopped. A
// user-ended (canceled) subscription is inactive immediately, regardless of how
// recently it last charged.
function isActive(r: Rec): boolean {
  if (r.ended) return false;
  const days = (Date.now() - new Date(r.lastDate + "T00:00:00Z").getTime()) / 86_400_000;
  return days <= CADENCE_DAYS[r.cadence] * 1.5 + 5;
}

export default function RecurringsPage() {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState("");
  const [recs, setRecs] = useState<Rec[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState(""); // "" = all, "none" = uncategorized, else id
  const openTx = useTxDrawer();
  const shelfActive = useShelfActive();

  // "loading" until the first bills read lands; a failed read is "error",
  // never the "No recurring patterns detected yet" empty state.
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async (m: string) => {
    try {
      setRecs(await getJson<Rec[]>(`/api/recurrings?month=${m}`));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  const mutate = useMutation(useCallback(() => load(month), [load, month]));

  const loadSuggestions = useCallback(async () => {
    try {
      setSuggestions(await getJson<Suggestion[]>("/api/recurrings/suggested"));
    } catch {
      // Suggestions are an aside; a failed read leaves the last list in place.
    }
  }, []);
  useSyncedRefresh(() => {
    load(month);
    loadSuggestions();
  });

  // Months, then the month's bills. Also the Retry path.
  const boot = useCallback(async () => {
    setStatus("loading");
    try {
      const ms = await getJson<string[]>("/api/months");
      setMonths(ms);
      const def = defaultMonth(ms);
      setMonth(def);
      await load(def);
    } catch {
      setStatus("error");
    }
  }, [load]);

  useEffect(() => {
    // Category and vendor pickers are secondary: a failed read leaves them
    // empty rather than failing the page.
    getJson<Cat[]>("/api/categories").then(setCats).catch(() => {});
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSuggestions();
    void boot();
  }, [boot, loadSuggestions]);


  // Add a suggested recurring: fold in any clustered aliases (so the vendor's
  // descriptor variants become one recurring), then force it.
  async function addSuggestion(s: Suggestion) {
    setSuggestions((arr) => arr.filter((x) => x.merchant !== s.merchant));
    const write = async () => {
      for (const alias of s.aliases)
        await postJson("/api/recurrings/link", { alias, primary: s.merchant });
      await postJson("/api/recurrings/override", { merchant: s.merchant, status: "force" });
    };
    if (
      !(await mutate(write, {
        success: `Added "${s.merchant}" to recurrings`,
        error: "Couldn't update — please try again",
      }))
    )
      loadSuggestions(); // restore the optimistic removal
  }

  // Dismiss a suggestion: mute every descriptor so the whole cluster stays gone.
  async function dismissSuggestion(s: Suggestion) {
    setSuggestions((arr) => arr.filter((x) => x.merchant !== s.merchant));
    const write = async () => {
      for (const m of [s.merchant, ...s.aliases])
        await postJson("/api/recurrings/override", { merchant: m, status: "mute" });
    };
    if (
      !(await mutate(
        write,
        { error: "Couldn't dismiss — please try again" },
        { refresh: "never" }
      ))
    )
      loadSuggestions();
  }

  function changeMonth(m: string) {
    setMonth(m);
    load(m);
  }

  // A category created from a row's dropdown: add it to the pickers, then
  // apply it to that row (which reloads the month).
  async function addCategoryFromRow(cat: Cat, r: Rec) {
    setCats((cs) => [...cs, cat]);
    await recategorize(r, cat.id);
  }

  async function recategorize(r: Rec, categoryId: number | null) {
    const merchant = r.vendor;
    // A split series ("Netflix · 26th") recategorizes only its own charges.
    const recurringId = r.vendor !== r.merchant ? r.id : undefined;
    await mutate(
      () => postJson("/api/recurrings/recategorize", { merchant, categoryId, recurringId }),
      {
        success: `Recategorized "${merchant}"`,
        error: "Couldn't recategorize — please try again",
      }
    );
  }

  async function saveSettings(merchant: string, patch: SettingsPatch | "clear") {
    await mutate(
      () =>
        postJson(
          "/api/recurrings/settings",
          patch === "clear" ? { merchant, clear: true } : { merchant, ...patch }
        ),
      {
        success: patch === "clear" ? "Settings reset" : "Recurring updated",
        error: "Couldn't save — please try again",
      }
    );
  }


  async function recompute() {
    setBusy(true);
    try {
      await fetch("/api/recompute", { method: "POST" });
      await load(month);
    } finally {
      setBusy(false);
    }
  }

  const isCurrentMonth = isCurrentMonthOf(month);
  const byDue = (a: Rec, b: Rec) => a.dueDate.localeCompare(b.dueDate);

  // Upcoming only applies to the live month (a past month is already settled).
  const upcoming = (r: Rec) => !r.paid && r.expectedThisMonth && isActive(r);

  const expenses = recs.filter((r) => r.avgAmount < 0);
  const bills = [
    ...expenses.filter((r) => r.paid),
    ...(isCurrentMonth ? expenses.filter(upcoming) : []),
  ].sort(byDue);

  const income = recs.filter((r) => r.avgAmount >= 0);
  const incomeBills = [
    ...income.filter((r) => r.paid),
    ...(isCurrentMonth ? income.filter(upcoming) : []),
  ].sort(byDue);

  const paidSoFar = bills.filter((r) => r.paid).reduce((a, r) => a + (r.paidAmount ?? 0), 0);
  const leftToPay = bills
    .filter((r) => !r.paid)
    .reduce((a, r) => a + r.expectedAmount, 0);
  const totalBills = paidSoFar + leftToPay;
  // The status line under the summary bar: overdue in red when there are any.
  const todayIso = new Date().toISOString().slice(0, 10);
  const overdueCount = bills.filter((r) => !r.paid && r.dueDate < todayIso).length;
  const upcomingCount = bills.filter((r) => !r.paid && r.dueDate >= todayIso).length;
  const paidCount = bills.filter((r) => r.paid).length;

  // Stale recurrings that didn't charge this month — tucked away.
  const inactive = recs
    .filter((r) => !isActive(r) && !r.paid)
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate));

  // The search box and the category picker both filter the displayed lists (not
  // the summary). Suggestions carry a category by name (no id), so match those by
  // the selected category's name.
  const ql = q.trim().toLowerCase();
  const catName =
    catFilter && catFilter !== "none"
      ? cats.find((c) => String(c.id) === catFilter)?.name ?? null
      : null;
  const matchText = (text: string) => !ql || text.toLowerCase().includes(ql);
  // Search the shown name AND the bank's descriptor, so "zelle" still finds a
  // payee whose display name has the rail stripped.
  const matchRec = (r: Rec) =>
    matchText(`${r.displayName ?? r.merchant} ${r.merchant} ${r.categoryName ?? ""}`) &&
    (!catFilter ||
      (catFilter === "none" ? r.categoryId == null : String(r.categoryId) === catFilter));
  const matchSug = (s: Suggestion) =>
    matchText(`${s.displayName} ${s.merchant} ${s.category?.name ?? ""}`) &&
    (!catFilter || (catFilter === "none" ? !s.category : s.category?.name === catName));
  const shownBills = bills.filter(matchRec);
  const shownIncome = incomeBills.filter(matchRec);
  const shownInactive = inactive.filter(matchRec);
  const shownSuggestions = suggestions.filter(matchSug);
  const filtering = ql.length > 0 || catFilter !== "";
  const noMatches =
    filtering &&
    shownBills.length + shownIncome.length + shownInactive.length + shownSuggestions.length === 0;

  return (
    <Shell
      title="Recurrings"
      actions={
        // One toolbar for every view control; the rare action (Re-scan) is in
        // the header's ⋯, not a peer of the month picker.
        <>
          <SearchBox value={q} onChange={setQ} placeholder="Search…" className="w-full sm:w-48" />
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            aria-label="Filter by category"
            className={`btn-ghost select-caret max-w-44 cursor-pointer appearance-none pr-8 ${
              catFilter ? "text-[var(--foreground)]" : "text-[var(--muted)]"
            }`}
          >
            <option value="">All categories</option>
            <option value="none">Uncategorized</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon} {c.name}
              </option>
            ))}
          </select>
          <MonthPicker months={months} value={month} onChange={changeMonth} />
          <HeaderMenu>
            <button className="btn-ghost" disabled={busy} onClick={recompute}>
              {busy ? "Scanning…" : "Re-scan"}
            </button>
          </HeaderMenu>
        </>
      }
    >
      {status === "loading" ? (
        <LoadingRows />
      ) : status === "error" ? (
        <LoadError what="recurring bills" onRetry={boot} />
      ) : recs.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="mb-2 text-4xl">↻</div>
          <p className="text-sm text-[var(--muted)]">
            No recurring patterns detected yet. Recurrings are found automatically
            from 3+ regular, similar-amount charges — load data or re-scan.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {totalBills > 0 && (
            <SummaryCard
              primary={{
                value: usd(paidSoFar, { cents: false }),
                // "Expected" is the word that needs teaching; the hint sits on it.
                // Inline, not inline-flex: when the label wraps on a narrow
                // screen the hint must follow "expected", not float mid-height.
                label: (
                  <span>
                    paid{isCurrentMonth ? " so far" : ""} of {usd(totalBills, { cents: false })} expected{" "}
                    <InfoHint text="Expected amounts are each bill's latest charge. Change one, or its cadence, in the shelf." />
                  </span>
                ),
              }}
              secondary={{
                value: usd(leftToPay, { cents: false }),
                // A closed month's unmatched bills weren't "left to pay"; they went unpaid.
                label: <span className="whitespace-nowrap">{isCurrentMonth ? "left to pay" : "unpaid"}</span>,
              }}
              progress={paidSoFar / totalBills}
              barLabel={`${Math.round((paidSoFar / totalBills) * 100)}% of expected bills paid`}
              status={
                <>
                  {overdueCount > 0 ? (
                    <SectionLink section="od" className="font-medium text-[var(--warn)]">
                      {overdueCount} {isCurrentMonth ? "overdue" : "unpaid"}
                    </SectionLink>
                  ) : (
                    <span className="text-[var(--muted)]">{isCurrentMonth ? "Nothing overdue" : "Nothing unpaid"}</span>
                  )}
                  {isCurrentMonth && (
                    <>
                      <span className="text-[var(--muted)]">·</span>
                      <SectionLink section="up">{upcomingCount} upcoming</SectionLink>
                    </>
                  )}
                  <span className="text-[var(--muted)]">·</span>
                  <SectionLink section="pd">{paidCount} paid</SectionLink>
                </>
              }
            />
          )}

          <BillList
            title=""
            recs={shownBills}
            cats={cats}
            onRecategorize={recategorize}
            onNewCategory={addCategoryFromRow}
            onSaveSettings={saveSettings}
            onOpen={(m, series) => openTx(m, { onChange: () => load(month), series })}
            pastMonth={!isCurrentMonth}
          />
          <BillList
            title="Recurring income"
            recs={shownIncome}
            cats={cats}
            onRecategorize={recategorize}
            onNewCategory={addCategoryFromRow}
            onSaveSettings={saveSettings}
            onOpen={(m, series) => openTx(m, { onChange: () => load(month), series })}
          />

          {!filtering && bills.length === 0 && incomeBills.length === 0 && (
            <p className="card p-6 text-center text-sm text-[var(--muted)]">
              No recurring bills this month.
            </p>
          )}

          {noMatches && (
            <p className="card p-6 text-center text-sm text-[var(--muted)]">
              No recurrings match {ql ? `“${q}”` : "this filter"}.
            </p>
          )}

          {shownSuggestions.length > 0 && (
            <div>
              <button
                onClick={() => setShowSuggestions((s) => !s)}
                className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--accent)] hover:opacity-80"
              >
                {showSuggestions ? "▾" : "▸"} Suggested ({shownSuggestions.length})
              </button>
              {showSuggestions && (
                <div className="card divide-y divide-[var(--border)] overflow-hidden">
                  {shownSuggestions.map((s) => {
                    return (
                      <div key={s.merchant}>
                      <div
                        data-drawer-row
                        {...rowButtonProps(() =>
                          openTx(s.merchant, {
                            onChange: loadSuggestions,
                            amountHint: Math.abs(s.avgAmount),
                          })
                        )}
                        className={`group flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors ${ROW_FOCUS} ${
                          shelfActive.isMerchant(s.merchant)
                            ? "bg-[var(--accent)]/10"
                            : "hover:bg-[var(--hover)]"
                        }`}
                      >
                        <CategoryBadge icon={s.category?.icon} color={s.category?.color} fallback={s.displayName} size="xs" plain />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{s.displayName}</div>
                          <div className="text-xs text-[var(--muted)]">
                            {s.reason === "variable"
                              ? `regular ${s.cadence ?? ""} bill · variable amount`
                              : `looks like a subscription · ${s.count} charge${
                                  s.count === 1 ? "" : "s"
                                } so far`}
                            {s.aliases.length > 0
                              ? ` · ${s.aliases.length + 1} names`
                              : ""}
                          </div>
                        </div>
                        <div className="w-20 text-right text-sm font-semibold tabular-nums text-[var(--muted)]">
                          {usd(Math.abs(s.avgAmount))}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            addSuggestion(s);
                          }}
                          className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium hover:bg-[var(--hover)]"
                        >
                          Add
                        </button>
                        <Tooltip label="Dismiss" onlyIfTruncated={false} className="shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              dismissSuggestion(s);
                            }}
                            className="rounded px-1.5 py-1 text-xs text-[var(--muted)] hover:text-[var(--bad)]"
                          >
                            ✕
                          </button>
                        </Tooltip>
                      </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {shownInactive.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5">
                <button
                  onClick={() => setShowInactive((s) => !s)}
                  className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  {showInactive ? "▾" : "▸"} Inactive ({shownInactive.length})
                </button>
                <InfoHint text="Recurrings that haven't charged within ~1.5 cycles — including subscriptions you marked ended. They no longer count as upcoming or toward expected spend, but their history is kept." />
              </div>
              {(showInactive || filtering) && (
                <BillList
                  title=""
                  recs={shownInactive}
                  dim
                  onOpen={(m, series) => openTx(m, { onChange: () => load(month), series })}
                />
              )}
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

// A count in the summary's status line that jumps to its section below —
// the same job the Categories status line does with its filters.
function SectionLink({
  section,
  className = "text-[var(--muted)] hover:text-[var(--foreground)]",
  children,
}: {
  section: "od" | "up" | "pd";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-section-link={section}
      onClick={() =>
        document
          .querySelector(`[data-bill-anchor="${section}"], [data-bill-status="${section}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
      className={`hover:underline ${className}`}
    >
      {children}
    </button>
  );
}

function BillList({
  title,
  recs,
  dim,
  cats,
  onRecategorize,
  onNewCategory,
  onSaveSettings,
  onOpen,
  pastMonth = false,
}: {
  title: string;
  recs: Rec[];
  dim?: boolean;
  cats?: Cat[];
  onRecategorize?: (r: Rec, categoryId: number | null) => void;
  onNewCategory?: (cat: Cat, r: Rec) => void; // created from the row's dropdown → apply to the row
  onSaveSettings?: (merchant: string, patch: SettingsPatch | "clear") => void;
  onOpen?: (merchant: string, series?: string) => void; // series: the plan's key when the vendor carries several
  pastMonth?: boolean; // a closed month: unmatched bills are "Unpaid", not "Overdue"
}) {
  const shelfActive = useShelfActive();
  // "+ New category…" chosen in a row's dropdown: the create form opens under
  // that dropdown and the new category is applied to that row on Add.
  const newCat = useNewCategory<Rec>((cat, rec) => onNewCategory?.(cat, rec));
  if (recs.length === 0) return null;
  const editable = !!(cats && onRecategorize);

  // One list in date order — the month as it happens — instead of three cards
  // (Overdue / Upcoming / Paid) that put a Sep 26 bill above a Sep 3 one. The
  // amount cell already carries the state (settled, provisional, overdue) and
  // the summary card the counts, so grouping said nothing the row didn't. A
  // "Today" divider splits what has happened from what is ahead; an unpaid
  // bill above it is overdue and wears amber. A past month has no today.
  const today = new Date().toISOString().slice(0, 10);
  const status = (r: Rec): "pd" | "od" | "up" => (r.paid ? "pd" : r.dueDate < today ? "od" : "up");
  const dividerAt = dim || pastMonth ? -1 : recs.findIndex((r) => r.dueDate >= today);
  const showDivider = dividerAt > 0; // something behind it and something ahead
  return (
    <div className="flex flex-col gap-4">
      {title && (
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          {title}
        </h3>
      )}
      <div className="card divide-y divide-[var(--border)] overflow-hidden" data-bill-list>
        {recs.map((r, i) => {
          const st = status(r);
          const amount = r.paid ? r.paidAmount ?? 0 : r.expectedAmount;
          // The amount column already says "$200"; a series keyed by amount
          // needn't repeat it in its name. A user-set name is shown as typed.
          const rowName = r.settings?.alias ? r.displayName : withoutAmountQualifier(r.displayName);
          return (
            <div key={r.id}>
            {i === dividerAt && showDivider && (
              <div
                data-bill-anchor="up"
                className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--hover)]/60 px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]"
              >
                <span className="w-12 shrink-0">Today</span>
                <span className="tabular-nums">{shortDate(today)}</span>
              </div>
            )}
            <div
              data-drawer-row
              data-bill-status={st}
              data-due={r.dueDate}
              {...(onOpen ? rowButtonProps(() => onOpen(r.vendor, isSeriesKey(r.merchant) ? r.merchant : undefined)) : {})}
              className={`group flex items-center gap-3 px-4 py-2 text-[13px] ${ROW_FOCUS} ${
                dim ? "opacity-60" : ""
              } ${
                onOpen
                  ? shelfActive.isMerchant(r.vendor, isSeriesKey(r.merchant) ? r.merchant : undefined)
                    ? "cursor-pointer bg-[var(--accent)]/10"
                    : "cursor-pointer hover:bg-[var(--hover)]"
                  : ""
              }`}
            >
              {/* Date and cadence as two fixed columns with tabular figures, so
                  every row's cadence starts on the same x. The date carries the
                  status colour: amber when overdue. */}
              <div
                className={`w-12 shrink-0 text-xs tabular-nums ${
                  st === "od" ? "font-medium text-[var(--warn)]" : "text-[var(--muted)]"
                }`}
              >
                {dim ? shortDate(r.lastDate) : shortDate(r.dueDate)}
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {onSaveSettings ? (
                  <InlineEdit
                    value={rowName}
                    textClassName="text-[13px] font-medium"
                    cueOnHover
                    onCommit={(raw) => onSaveSettings(r.merchant, { alias: raw.trim() || null })}
                  />
                ) : (
                  <span className="truncate font-medium">{rowName}</span>
                )}
                {/* Cadence only when it isn't monthly, as a quiet tag after the
                    name: the exception is the information, and a column for it
                    sat empty on nearly every row. The shelf states it in full. */}
                {r.cadence !== "monthly" && (
                  <span
                    data-cadence
                    className="shrink-0 rounded-full bg-[var(--border)] px-1.5 text-[10px] font-medium text-[var(--muted)]"
                  >
                    {CADENCE_LABEL[r.cadence]}
                  </span>
                )}
                {r.ended && (
                  <Tooltip
                    label="You marked this subscription ended — it no longer counts as upcoming or expected"
                    onlyIfTruncated={false}
                    className="inline-flex shrink-0 rounded-full bg-[var(--warn)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--warn)]"
                  >
                    Ended{r.endedDate ? ` ${shortDate(r.endedDate)}` : ""}
                  </Tooltip>
                )}
              </div>
              {/* Category as a quiet property: icon + name, no tint; still a
                  native select with its caret (a visible affordance), editing
                  in place. Hidden on a phone, where the row opens the shelf. */}
              {/* The category property: a visible label with its chevron right
                  beside it (a native select sizes to its widest option, which
                  stranded the chevron), and the real <select> laid transparently
                  over the label — still native, still keyboard, caret visible. */}
              {/* The category property needs ~176px. With the sidebar up, the
                  content column is only ~330px wide until the lg breakpoint, so
                  the property waits for lg; below that the shelf carries it. */}
              <div className="hidden w-44 shrink-0 justify-end lg:flex">
                {editable && cats && onRecategorize ? (
                  <span className="group/cat relative inline-flex max-w-full items-center gap-1 rounded-md py-1 pl-1.5 pr-1 text-xs text-[var(--muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]/40">
                    <span className={`truncate ${r.categoryId == null ? "italic" : ""}`}>
                      {r.categoryId != null ? `${r.categoryIcon ?? ""} ${r.categoryName ?? ""}`.trim() : "Uncategorized"}
                    </span>
                    <svg data-category-caret width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                    <select
                      value={r.categoryId ?? ""}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        if (e.target.value === NEW_CATEGORY) {
                          newCat.open(e.currentTarget, r, `New category for ${r.displayName}`);
                          return;
                        }
                        onRecategorize(r, e.target.value ? Number(e.target.value) : null);
                      }}
                      aria-label="Category"
                      className="absolute inset-0 w-full cursor-pointer opacity-0"
                    >
                      <option value="">Uncategorized</option>
                      {cats.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.icon} {c.name}
                        </option>
                      ))}
                      <NewCategoryOption />
                    </select>
                  </span>
                ) : (
                  r.categoryName && (
                    <span className="truncate text-xs text-[var(--muted)]">
                      {r.categoryIcon} {r.categoryName}
                    </span>
                  )
                )}
              </div>
              {/* The only visible control: the row's ⋯ (the row itself opens the
                  shelf, which is where editing lives). */}
              {/* No row menu. Mark ended / Reactivate / Not recurring are rare
                  verbs and live in the shelf — the control surface — which the
                  row opens on click, tap, or Enter. */}
              {/* The amount says what kind of number it is: a posted charge is
                  settled (bold, foreground); an expected one is provisional
                  (medium, muted — the app's qualifier colour); an overdue one
                  wears the row's amber. A paid row that differed from its
                  expected shows the difference — the one fact a paid row can
                  tell you that you didn't already know. */}
              {(() => {
                const state = r.paid ? "paid" : st === "od" ? "overdue" : "expected";
                const delta =
                  r.paid && r.paidAmount != null && Math.abs(r.paidAmount - r.expectedAmount) >= 0.5
                    ? r.paidAmount - r.expectedAmount
                    : null;
                return (
                  <div
                    data-amount-state={state}
                    className={`w-32 shrink-0 text-right tabular-nums ${
                      state === "paid"
                        ? "font-semibold text-[var(--foreground)]"
                        : state === "overdue"
                          ? "font-semibold text-[var(--warn)]"
                          : "font-medium text-[var(--muted)]"
                    }`}
                  >
                    {delta != null && (
                      <span className="mr-1.5 text-[10px] font-medium text-[var(--muted)]">
                        {delta > 0 ? "+" : "−"}
                        {usd(Math.abs(delta))}
                      </span>
                    )}
                    {usd(amount)}
                  </div>
                );
              })()}
            </div>
            </div>
          );
        })}
      </div>
      {newCat.popover}
    </div>
  );
}

// Inline editor for a recurring's overrides: display name (alias), go-forward
// expected amount, cadence, next-due, and the match rule. Empty / "Auto" means
// "no override — use the detected value". Save sends a full patch so cleared
// fields revert. Reset removes all overrides.
