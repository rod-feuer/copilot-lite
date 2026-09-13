"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { HeaderMenu } from "@/components/HeaderMenu";
import { RowMenu, RowMenuItem } from "@/components/RowMenu";
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
  biweekly: "Every 2 weeks",
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

  async function recategorize(merchant: string, categoryId: number | null) {
    await mutate(
      () => postJson("/api/recurrings/recategorize", { merchant, categoryId }),
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

  async function markNotRecurring(merchant: string) {
    await mutate(
      () => postJson("/api/recurrings/override", { merchant, status: "mute" }),
      {
        success: `"${merchant}" marked not recurring`,
        error: "Couldn't update — please try again",
      }
    );
  }

  // Mark a subscription as ended/canceled as of today: it stops counting as an
  // upcoming bill and toward expected outflow immediately, keeps its history,
  // and moves to Inactive. Reactivate clears it.
  async function setEnded(merchant: string, ended: boolean) {
    await mutate(
      () =>
        postJson("/api/recurrings/settings", {
          merchant,
          endedDate: ended ? new Date().toISOString().slice(0, 10) : null,
        }),
      {
        success: ended ? `"${merchant}" marked ended` : `"${merchant}" reactivated`,
        error: "Couldn't update — please try again",
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
  const matchRec = (r: Rec) =>
    matchText(`${r.displayName ?? r.merchant} ${r.categoryName ?? ""}`) &&
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
      subtitle="Bills & subscriptions by month"
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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-semibold tabular-nums">{usd(paidSoFar, { cents: false })}</span>
              <span className="text-[var(--muted)]">paid so far</span>
              <span className="text-[var(--muted)]">·</span>
              <span className="font-semibold tabular-nums">
                {isCurrentMonth ? "≈ " : ""}
                {usd(leftToPay, { cents: false })}
              </span>
              <span className="text-[var(--muted)]">{isCurrentMonth ? "left to pay (expected)" : "remaining"}</span>
              <div className="ml-auto h-1 w-40 overflow-hidden rounded-full bg-[var(--border)]">
                <div
                  className="h-full rounded-full bg-[var(--accent)]"
                  style={{ width: `${Math.round((paidSoFar / totalBills) * 100)}%` }}
                />
              </div>
            </div>
          )}

          <BillList
            title=""
            recs={shownBills}
            cats={cats}
            onRecategorize={recategorize}
            onMute={markNotRecurring}
            onEnd={setEnded}
            onSaveSettings={saveSettings}
            onOpen={(m) => openTx(m, { onChange: () => load(month) })}
          />
          <BillList
            title="Recurring income"
            recs={shownIncome}
            cats={cats}
            onRecategorize={recategorize}
            onMute={markNotRecurring}
            onEnd={setEnded}
            onSaveSettings={saveSettings}
            onOpen={(m) => openTx(m, { onChange: () => load(month) })}
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
                <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
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
                            : "hover:bg-[var(--background)]"
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
                          className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium hover:bg-[var(--background)]"
                        >
                          Add
                        </button>
                        <Tooltip label="Dismiss" onlyIfTruncated={false} className="shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              dismissSuggestion(s);
                            }}
                            className="rounded px-1.5 py-1 text-xs text-[var(--muted)] hover:text-rose-500"
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
                  onEnd={setEnded}
                  onOpen={(m) => openTx(m, { onChange: () => load(month) })}
                />
              )}
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

function BillList({
  title,
  recs,
  dim,
  cats,
  onRecategorize,
  onMute,
  onEnd,
  onSaveSettings,
  onOpen,
}: {
  title: string;
  recs: Rec[];
  dim?: boolean;
  cats?: Cat[];
  onRecategorize?: (merchant: string, categoryId: number | null) => void;
  onMute?: (merchant: string) => void;
  onEnd?: (merchant: string, ended: boolean) => void;
  onSaveSettings?: (merchant: string, patch: SettingsPatch | "clear") => void;
  onOpen?: (merchant: string) => void;
}) {
  const shelfActive = useShelfActive();
  if (recs.length === 0) return null;
  const editable = !!(cats && onRecategorize && onMute);

  // Convey paid status by grouping rather than a cryptic per-row ✓/○. Unpaid
  // bills split by due date: Overdue (date already passed — expected but not yet
  // matched to a charge) vs Upcoming (still ahead). Headers are shown only when
  // there's something to distinguish; a lone all-paid list renders flat.
  const today = new Date().toISOString().slice(0, 10);
  const groups = [
    { key: "od", label: "Overdue", recs: recs.filter((r) => !r.paid && r.dueDate < today) },
    { key: "up", label: "Upcoming", recs: recs.filter((r) => !r.paid && r.dueDate >= today) },
    { key: "pd", label: "Paid this month", recs: recs.filter((r) => r.paid) },
  ].filter((g) => g.recs.length > 0);
  const onlyPaid = groups.length === 1 && groups[0].key === "pd";
  const sections = dim
    ? [{ key: "all", label: "", recs }]
    : groups.map((g) => ({ ...g, label: onlyPaid ? "" : g.label }));
  return (
    <div>
      {title && (
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          {title}
        </h3>
      )}
      <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
        {sections.map((section) => (
          <Fragment key={section.key}>
            {section.label && (
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--background)] px-2 py-1.5 text-xs font-medium text-[var(--muted)]">
                {section.label}
                <span
                  className={`rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${
                    section.key === "od" ? "bg-amber-500/15 text-amber-600" : "bg-[var(--border)] text-[var(--muted)]"
                  }`}
                >
                  {section.recs.length}
                </span>
              </div>
            )}
            {section.recs.map((r) => {
          const amount = r.paid ? r.paidAmount ?? 0 : r.expectedAmount;
          return (
            <div key={r.id}>
            <div
              data-drawer-row
              {...(onOpen ? rowButtonProps(() => onOpen(r.merchant)) : {})}
              className={`group flex items-center gap-3 px-2 py-2 text-[13px] ${ROW_FOCUS} ${
                dim ? "opacity-60" : ""
              } ${
                onOpen
                  ? shelfActive.isMerchant(r.merchant)
                    ? "cursor-pointer bg-[var(--accent)]/10"
                    : "cursor-pointer hover:bg-[var(--background)]"
                  : ""
              }`}
            >
              {/* Secondary facts in one muted string; the glyph alone, untinted. */}
              <div className="w-36 shrink-0 truncate text-xs text-[var(--muted)]">
                {dim ? shortDate(r.lastDate) : shortDate(r.dueDate)} · {CADENCE_LABEL[r.cadence]}
              </div>
              <CategoryBadge icon={r.categoryIcon} color={r.categoryColor} fallback={r.displayName} size="xs" plain />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {onSaveSettings ? (
                  <InlineEdit
                    value={r.displayName}
                    textClassName="text-[13px] font-medium"
                    cueOnHover
                    onCommit={(raw) => onSaveSettings(r.merchant, { alias: raw.trim() || null })}
                  />
                ) : (
                  <span className="truncate font-medium">{r.displayName}</span>
                )}
                {r.settings && (
                  <Tooltip label="Has custom settings — edit or reset them in the shelf" onlyIfTruncated={false} className="shrink-0">
                    <span aria-label="Has custom settings" className="text-[var(--accent)]">•</span>
                  </Tooltip>
                )}
                {r.ended && (
                  <Tooltip
                    label="You marked this subscription ended — it no longer counts as upcoming or expected"
                    onlyIfTruncated={false}
                    className="inline-flex shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600"
                  >
                    Ended{r.endedDate ? ` ${shortDate(r.endedDate)}` : ""}
                  </Tooltip>
                )}
              </div>
              {/* Category as a quiet property: icon + name, no tint; still a
                  native select with its caret (a visible affordance), editing
                  in place. Hidden on a phone, where the row opens the shelf. */}
              {editable && cats && onRecategorize ? (
                <select
                  value={r.categoryId ?? ""}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    onRecategorize(r.merchant, e.target.value ? Number(e.target.value) : null)
                  }
                  aria-label="Category"
                  className={`select-caret hidden w-40 shrink-0 cursor-pointer appearance-none truncate rounded-md bg-transparent py-1 pl-1.5 pr-6 text-xs transition-colors hover:bg-[var(--background)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 sm:block ${
                    r.categoryId != null ? "text-[var(--muted)] hover:text-[var(--foreground)]" : "italic text-[var(--muted)]"
                  }`}
                >
                  <option value="">Uncategorized</option>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon} {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                r.categoryName && (
                  <span className="hidden w-40 shrink-0 truncate text-xs text-[var(--muted)] sm:inline-block">
                    {r.categoryIcon} {r.categoryName}
                  </span>
                )
              )}
              {/* The only visible control: the row's ⋯ (the row itself opens the
                  shelf, which is where editing lives). */}
              {editable ? (
                <RowMenu>
                  {onEnd && !r.ended && !dim && (
                    <RowMenuItem label="Mark ended" onSelect={() => onEnd(r.merchant, true)} />
                  )}
                  {onEnd && r.ended && (
                    <RowMenuItem label="Reactivate" onSelect={() => onEnd(r.merchant, false)} />
                  )}
                  {onMute && !r.ended && (
                    <RowMenuItem label="Not recurring" onSelect={() => onMute(r.merchant)} className="hover:text-rose-500" />
                  )}
                </RowMenu>
              ) : (
                <span className="w-6 shrink-0" aria-hidden />
              )}
              <div className="w-24 shrink-0 text-right font-semibold tabular-nums text-[var(--foreground)]">
                {usd(amount)}
              </div>
            </div>
            </div>
          );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// Inline editor for a recurring's overrides: display name (alias), go-forward
// expected amount, cadence, next-due, and the match rule. Empty / "Auto" means
// "no override — use the detected value". Save sends a full patch so cleared
// fields revert. Reset removes all overrides.
