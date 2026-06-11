"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Shell from "@/components/Shell";
import { MonthPicker, CleanupNamesButtons } from "@/components/Actions";
import { useToast } from "@/components/Toast";
import { useTxDrawer, useShelfActive } from "@/components/TransactionDrawer";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { postJson } from "@/lib/http";
import { usd, shortDate, defaultMonth } from "@/lib/format";

type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "semiannual" | "yearly";

type MatchRule = {
  matchMode: "exact" | "contains";
  matchText: string | null;
  amountTolerance: number | null;
};

type Settings = {
  matchMode: "exact" | "contains" | null;
  matchText: string | null;
  amountTolerance: number | null;
  alias: string | null;
  expectedAmount: number | null;
  cadence: Cadence | null;
  nextDate: string | null;
};

// Patch sent to /api/recurrings/settings (only included keys change).
type SettingsPatch = Partial<Settings>;

type Rec = {
  id: number;
  merchant: string;
  avgAmount: number;
  cadence: Cadence;
  lastDate: string;
  nextDate: string;
  count: number;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  expectedThisMonth: boolean;
  paid: boolean;
  paidAmount: number | null;
  dueDate: string;
  matchRule: MatchRule | null;
  linkedMerchants: string[];
  displayName: string;
  expectedAmount: number;
  settings: Settings | null;
};

type Cat = { id: number; name: string; color: string; icon: string };

type Suggestion = {
  merchant: string;
  reason: "variable" | "new";
  cadence: string | null;
  avgAmount: number;
  count: number;
  lastDate: string;
  category: { name: string; color: string; icon: string } | null;
  aliases: string[]; // other descriptors of the same vendor, folded in on Add
};

const CADENCE_LABEL: Record<Rec["cadence"], string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Every 6 months",
  yearly: "Yearly",
};

const CADENCE_DAYS: Record<Rec["cadence"], number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  semiannual: 182,
  yearly: 365,
};

// Active = charged within ~1.5 cycles (plus grace); else treated as stopped.
function isActive(r: Rec): boolean {
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
  const [merchantOptions, setMerchantOptions] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState(""); // "" = all, "none" = uncategorized, else id
  const [combineFor, setCombineFor] = useState<string | null>(null);
  const [combinePick, setCombinePick] = useState("");
  const toast = useToast();
  const openTx = useTxDrawer();

  const load = useCallback(async (m: string) => {
    const data = await fetch(`/api/recurrings?month=${m}`).then((r) => r.json());
    setRecs(data);
  }, []);

  const loadSuggestions = useCallback(async () => {
    const data = await fetch("/api/recurrings/suggested").then((r) => r.json());
    setSuggestions(data);
  }, []);
  useSyncedRefresh(() => {
    load(month);
    loadSuggestions();
  });

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then(setCats);
    fetch("/api/months")
      .then((r) => r.json())
      .then((ms: string[]) => {
        setMonths(ms);
        const def = defaultMonth(ms);
        setMonth(def);
        load(def);
      });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSuggestions();
    fetch("/api/merchants")
      .then((r) => r.json())
      .then((rows: { merchant: string }[]) => setMerchantOptions(rows.map((r) => r.merchant)));
  }, [load, loadSuggestions]);

  async function linkMerchants(alias: string, primary: string, unlink = false) {
    try {
      await postJson("/api/recurrings/link", unlink ? { alias, unlink: true } : { alias, primary });
      toast(unlink ? "Descriptor unlinked" : "Descriptors combined", "success");
      load(month);
      loadSuggestions();
    } catch {
      toast("Couldn't update — please try again", "error");
    }
  }

  // Add a suggested recurring: fold in any clustered aliases (so the vendor's
  // descriptor variants become one recurring), then force it.
  async function addSuggestion(s: Suggestion) {
    setSuggestions((arr) => arr.filter((x) => x.merchant !== s.merchant));
    try {
      for (const alias of s.aliases)
        await postJson("/api/recurrings/link", { alias, primary: s.merchant });
      await postJson("/api/recurrings/override", { merchant: s.merchant, status: "force" });
      toast(`Added "${s.merchant}" to recurrings`, "success");
      load(month);
    } catch {
      toast("Couldn't update — please try again", "error");
      loadSuggestions(); // restore the optimistic removal
    }
  }

  // Dismiss a suggestion: mute every descriptor so the whole cluster stays gone.
  async function dismissSuggestion(s: Suggestion) {
    setSuggestions((arr) => arr.filter((x) => x.merchant !== s.merchant));
    try {
      for (const m of [s.merchant, ...s.aliases])
        await postJson("/api/recurrings/override", { merchant: m, status: "mute" });
    } catch {
      loadSuggestions();
    }
  }

  function changeMonth(m: string) {
    setMonth(m);
    load(m);
  }

  async function recategorize(merchant: string, categoryId: number | null) {
    try {
      await postJson("/api/recurrings/recategorize", { merchant, categoryId });
      toast(`Recategorized "${merchant}"`, "success");
      load(month);
    } catch {
      toast("Couldn't recategorize — please try again", "error");
    }
  }

  async function saveSettings(merchant: string, patch: SettingsPatch | "clear") {
    try {
      await postJson(
        "/api/recurrings/settings",
        patch === "clear" ? { merchant, clear: true } : { merchant, ...patch }
      );
      toast(patch === "clear" ? "Settings reset" : "Recurring updated", "success");
      load(month);
    } catch {
      toast("Couldn't save — please try again", "error");
    }
  }

  async function markNotRecurring(merchant: string) {
    try {
      await postJson("/api/recurrings/override", { merchant, status: "mute" });
      toast(`"${merchant}" marked not recurring`, "success");
      load(month);
    } catch {
      toast("Couldn't update — please try again", "error");
    }
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

  const isCurrentMonth = month === new Date().toISOString().slice(0, 7);
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
    matchText(`${s.merchant} ${s.category?.name ?? ""}`) &&
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
        <>
          <MonthPicker months={months} value={month} onChange={changeMonth} />
          <CleanupNamesButtons onDone={() => load(month)} disabled={busy} />
          <button className="btn-ghost" disabled={busy} onClick={recompute}>
            {busy ? "Scanning…" : "Re-scan"}
          </button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search recurrings…"
          className="btn-ghost w-60 font-normal placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
        />
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          aria-label="Filter by category"
          className={`btn-ghost ml-auto max-w-44 cursor-pointer ${
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
      </div>
      {recs.length === 0 ? (
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
            <div className="card p-5">
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-2xl font-semibold tracking-tight">
                    {usd(paidSoFar, { cents: false })}
                  </div>
                  <div className="stat-label">paid so far</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-semibold tracking-tight">
                    {usd(leftToPay, { cents: false })}
                  </div>
                  <div className="stat-label">
                    {isCurrentMonth ? "left to pay" : "remaining"}
                  </div>
                </div>
              </div>
              <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[var(--background)]">
                <div
                  className="h-full rounded-full bg-[var(--accent)]"
                  style={{ width: `${Math.round((paidSoFar / totalBills) * 100)}%` }}
                />
              </div>
            </div>
          )}

          <BillList
            title="Recurring expenses"
            recs={shownBills}
            cats={cats}
            onRecategorize={recategorize}
            onMute={markNotRecurring}
            onSaveSettings={saveSettings}
            onLink={linkMerchants}
            merchantOptions={merchantOptions}
            onOpen={(m) => openTx(m, { onChange: () => load(month) })}
          />
          <BillList
            title="Recurring income"
            recs={shownIncome}
            cats={cats}
            onRecategorize={recategorize}
            onMute={markNotRecurring}
            onSaveSettings={saveSettings}
            onLink={linkMerchants}
            merchantOptions={merchantOptions}
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
                <div className="card divide-y divide-[var(--border)]">
                  {shownSuggestions.map((s) => {
                    const color = s.category?.color ?? "#94a3b8";
                    return (
                      <div key={s.merchant}>
                      <div className="group flex items-center gap-3 px-4 py-2.5">
                        <span
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base"
                          style={{ background: color + "22" }}
                        >
                          {s.category?.icon ?? "↻"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <button
                              data-drawer-row
                              onClick={() => openTx(s.merchant, { onChange: loadSuggestions })}
                              className="truncate text-left text-sm font-medium hover:underline"
                            >
                              {s.merchant}
                            </button>
                          </div>
                          <div className="text-xs text-[var(--muted)]">
                            {s.reason === "variable"
                              ? `regular ${s.cadence ?? ""} bill · variable amount`
                              : `looks like a subscription · ${s.count} charge${
                                  s.count === 1 ? "" : "s"
                                } so far`}
                            {s.aliases.length > 0
                              ? ` · ${s.aliases.length + 1} descriptors`
                              : ""}
                          </div>
                        </div>
                        <div className="w-20 text-right text-sm font-semibold tabular-nums text-[var(--muted)]">
                          {usd(Math.abs(s.avgAmount))}
                        </div>
                        <button
                          onClick={() => addSuggestion(s)}
                          className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium hover:bg-[var(--background)]"
                        >
                          Add
                        </button>
                        <button
                          onClick={() => {
                            setCombineFor((m) => (m === s.merchant ? null : s.merchant));
                            setCombinePick("");
                          }}
                          title="Combine into another recurring"
                          className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--muted)] hover:bg-[var(--background)] hover:text-[var(--foreground)]"
                        >
                          Combine
                        </button>
                        <button
                          onClick={() => dismissSuggestion(s)}
                          title="Dismiss"
                          className="shrink-0 rounded px-1.5 py-1 text-xs text-[var(--muted)] hover:text-rose-500"
                        >
                          ✕
                        </button>
                      </div>
                      {combineFor === s.merchant && (
                        <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--border)] bg-[var(--background)] px-4 py-3 text-xs">
                          <span className="text-[var(--muted)]">Fold this into</span>
                          <input
                            list="combine-merchants"
                            value={combinePick}
                            onChange={(e) => setCombinePick(e.target.value)}
                            placeholder="pick the recurring/merchant to keep…"
                            className="w-64 rounded-lg border border-[var(--border)] bg-card px-2 py-1"
                          />
                          <datalist id="combine-merchants">
                            {merchantOptions
                              .filter((m) => m !== s.merchant)
                              .slice(0, 1000)
                              .map((m) => (
                                <option key={m} value={m} />
                              ))}
                          </datalist>
                          <button
                            onClick={() => {
                              const v = combinePick.trim();
                              if (v && v !== s.merchant) {
                                linkMerchants(s.merchant, v);
                                setCombineFor(null);
                                setCombinePick("");
                              }
                            }}
                            className="rounded-lg bg-[var(--accent)] px-3 py-1 font-medium text-white"
                          >
                            Combine
                          </button>
                          <button
                            onClick={() => setCombineFor(null)}
                            className="rounded-lg px-2 py-1 text-[var(--muted)]"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {shownInactive.length > 0 && (
            <div>
              <button
                onClick={() => setShowInactive((s) => !s)}
                className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                {showInactive ? "▾" : "▸"} Inactive ({shownInactive.length})
              </button>
              {(showInactive || filtering) && (
                <BillList
                  title=""
                  recs={shownInactive}
                  dim
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
  onSaveSettings,
  onLink,
  merchantOptions,
  onOpen,
}: {
  title: string;
  recs: Rec[];
  dim?: boolean;
  cats?: Cat[];
  onRecategorize?: (merchant: string, categoryId: number | null) => void;
  onMute?: (merchant: string) => void;
  onSaveSettings?: (merchant: string, patch: SettingsPatch | "clear") => void;
  onLink?: (alias: string, primary: string, unlink?: boolean) => void;
  merchantOptions?: string[];
  onOpen?: (merchant: string) => void;
}) {
  const [matchEditId, setMatchEditId] = useState<number | null>(null);
  const [renameId, setRenameId] = useState<number | null>(null);
  const skipRenameSave = useRef(false); // set on Escape so the blur doesn't save
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
        <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          {title}
        </h3>
      )}
      <div className="card divide-y divide-[var(--border)]">
        {sections.map((section) => (
          <Fragment key={section.key}>
            {section.label && (
              <div className="bg-[var(--background)] px-4 py-1.5 text-xs font-semibold text-[var(--muted)]">
                {section.label}
              </div>
            )}
            {section.recs.map((r) => {
          const amount = r.paid ? r.paidAmount ?? 0 : r.expectedAmount;
          const color = r.categoryColor ?? "#94a3b8";
          return (
            <div key={r.id}>
            <div
              data-drawer-row
              onClick={onOpen ? () => onOpen(r.merchant) : undefined}
              className={`group flex items-center gap-3 px-4 py-2.5 ${dim ? "opacity-60" : ""} ${
                onOpen
                  ? shelfActive.isMerchant(r.merchant)
                    ? "cursor-pointer bg-[var(--accent)]/10"
                    : "cursor-pointer hover:bg-[var(--background)]"
                  : ""
              }`}
            >
              <div className="w-12 shrink-0 text-xs text-[var(--muted)]">
                {dim ? shortDate(r.lastDate) : shortDate(r.dueDate)}
              </div>
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base"
                style={{ background: color + "22" }}
              >
                {r.categoryIcon ?? "↻"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {renameId === r.id && onSaveSettings ? (
                    <input
                      autoFocus
                      defaultValue={r.displayName}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") {
                          skipRenameSave.current = true;
                          setRenameId(null);
                        }
                      }}
                      onBlur={(e) => {
                        if (skipRenameSave.current) skipRenameSave.current = false;
                        else onSaveSettings(r.merchant, { alias: e.target.value.trim() || null });
                        setRenameId(null);
                      }}
                      className="w-56 rounded-lg border border-[var(--border)] bg-card px-2 py-0.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
                    />
                  ) : (
                    <>
                      <span className="truncate text-sm font-medium">{r.displayName}</span>
                      {onSaveSettings && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenameId(r.id);
                          }}
                          title="Rename"
                          className="shrink-0 rounded text-xs text-[var(--muted)] opacity-0 transition-opacity hover:text-[var(--foreground)] focus:opacity-100 group-hover:opacity-100"
                        >
                          <span className="inline-block -scale-x-100">✎</span>
                        </button>
                      )}
                    </>
                  )}
                  <span className="shrink-0 text-xs text-[var(--muted)]">
                    {CADENCE_LABEL[r.cadence]}
                  </span>
                </div>
              </div>
              {editable && onMute && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMute(r.merchant);
                  }}
                  title="Mark as not recurring"
                  className="shrink-0 rounded px-1.5 text-xs text-[var(--muted)] opacity-0 transition-opacity hover:text-rose-500 group-hover:opacity-100"
                >
                  not recurring
                </button>
              )}
              {editable && onSaveSettings && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMatchEditId((id) => (id === r.id ? null : r.id));
                  }}
                  title={
                    r.settings
                      ? "Has custom settings (rename, amount, cadence, or matching) — click to view or reset"
                      : "Edit this recurring (rename, amount, cadence, matching)"
                  }
                  className={`shrink-0 rounded border border-[var(--border)] px-2 py-0.5 text-xs ${
                    r.settings
                      ? "text-[var(--accent)]"
                      : "text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  Edit{r.settings ? " •" : ""}
                </button>
              )}
              {editable && cats && onRecategorize ? (
                <select
                  value={r.categoryId ?? ""}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    onRecategorize(r.merchant, e.target.value ? Number(e.target.value) : null)
                  }
                  title="Category"
                  className={`hidden max-w-36 shrink-0 cursor-pointer appearance-none truncate rounded-full px-2.5 py-1 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 sm:block ${
                    r.categoryId != null
                      ? "text-[var(--foreground)] group-hover:ring-1 group-hover:ring-inset group-hover:ring-[var(--border)]"
                      : "border border-dashed border-[var(--border)] text-[var(--muted)]"
                  }`}
                  style={r.categoryId != null ? { background: color + "22" } : undefined}
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
                  <span
                    className="hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide sm:inline-block"
                    style={{ background: color + "22", color }}
                  >
                    {r.categoryName}
                  </span>
                )
              )}
              <div
                className={`w-20 text-right text-sm font-semibold tabular-nums ${
                  r.paid ? "" : "text-[var(--muted)]"
                }`}
              >
                {usd(amount)}
              </div>
            </div>
            {editable && onSaveSettings && matchEditId === r.id && (
              <SettingsEditor
                rec={r}
                merchantOptions={merchantOptions ?? []}
                onSave={(patch) => {
                  onSaveSettings(r.merchant, patch);
                  setMatchEditId(null);
                }}
                onLink={onLink}
                onClose={() => setMatchEditId(null)}
              />
            )}
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
const CAD_OPTS: { v: string; label: string }[] = [
  { v: "", label: "Auto (detected)" },
  { v: "weekly", label: "Weekly" },
  { v: "biweekly", label: "Every 2 weeks" },
  { v: "monthly", label: "Monthly" },
  { v: "quarterly", label: "Quarterly" },
  { v: "semiannual", label: "Every 6 months" },
  { v: "yearly", label: "Yearly" },
];
function SettingsEditor({
  rec,
  merchantOptions,
  onSave,
  onLink,
  onClose,
}: {
  rec: Rec;
  merchantOptions: string[];
  onSave: (patch: SettingsPatch | "clear") => void;
  onLink?: (alias: string, primary: string, unlink?: boolean) => void;
  onClose: () => void;
}) {
  const s = rec.settings;
  const [alias, setAlias] = useState(s?.alias ?? "");
  const [amount, setAmount] = useState(s?.expectedAmount != null ? String(s.expectedAmount) : "");
  const [cad, setCad] = useState<string>(s?.cadence ?? "");
  const [next, setNext] = useState(s?.nextDate ?? "");
  const [linkPick, setLinkPick] = useState("");
  const [mode, setMode] = useState<string>(s?.matchMode ?? "");
  const [text, setText] = useState(s?.matchText ?? "");
  const [tol, setTol] = useState<string>(
    s?.amountTolerance != null ? String(s.amountTolerance) : "0.05"
  );

  function save() {
    onSave({
      alias: alias.trim() || null,
      expectedAmount: amount.trim() === "" ? null : Math.abs(Number(amount)),
      cadence: (cad || null) as Settings["cadence"],
      nextDate: next || null,
      matchMode: (mode || null) as Settings["matchMode"],
      matchText: mode === "contains" ? text.trim() || null : null,
      amountTolerance: mode ? (tol === "any" ? null : Number(tol)) : null,
    });
  }

  const field = "rounded-lg border border-[var(--border)] bg-card px-2 py-1";
  return (
    <div
      className="flex flex-col gap-2 border-t border-dashed border-[var(--border)] bg-[var(--background)] px-4 py-3 text-xs"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-[var(--muted)]">Name</span>
        <input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder={rec.merchant}
          className={`${field} w-56`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-[var(--muted)]">Amount</span>
        <span className="text-[var(--muted)]">$</span>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder={String(rec.expectedAmount)}
          className={`${field} w-24`}
        />
        <span className="text-[var(--muted)]">expected (go-forward; history unchanged)</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-[var(--muted)]">Cadence</span>
        <select value={cad} onChange={(e) => setCad(e.target.value)} className={field}>
          {CAD_OPTS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="ml-2 text-[var(--muted)]">Next due</span>
        <input
          type="date"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={field}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-[var(--muted)]">Match</span>
        <select value={mode} onChange={(e) => setMode(e.target.value)} className={field}>
          <option value="">Auto (default)</option>
          <option value="exact">merchant exactly</option>
          <option value="contains">merchant contains</option>
        </select>
        {mode === "contains" && (
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="text in description"
            className={`${field} w-40`}
          />
        )}
        {mode && (
          <select value={tol} onChange={(e) => setTol(e.target.value)} className={field}>
            <option value="0.05">±5%</option>
            <option value="0.1">±10%</option>
            <option value="0.25">±25%</option>
            <option value="any">any amount</option>
          </select>
        )}
      </div>
      {onLink && (
        <div className="flex flex-wrap items-start gap-2">
          <span className="w-20 shrink-0 pt-1 text-[var(--muted)]">Combine</span>
          <div className="flex flex-1 flex-col gap-1">
            {rec.linkedMerchants.map((m) => (
              <div key={m} className="flex items-center gap-1 text-[var(--muted)]">
                <span className="truncate">↳ {m}</span>
                <button
                  onClick={() => onLink(m, rec.merchant, true)}
                  title="Unlink"
                  className="rounded px-1 hover:text-rose-500"
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <input
                list={`merchants-${rec.id}`}
                value={linkPick}
                onChange={(e) => setLinkPick(e.target.value)}
                placeholder="fold another descriptor in…"
                className={`${field} w-56`}
              />
              <datalist id={`merchants-${rec.id}`}>
                {merchantOptions
                  .filter((m) => m !== rec.merchant && !rec.linkedMerchants.includes(m))
                  .slice(0, 1000)
                  .map((m) => (
                    <option key={m} value={m} />
                  ))}
              </datalist>
              <button
                onClick={() => {
                  const v = linkPick.trim();
                  if (v && v !== rec.merchant) {
                    onLink(v, rec.merchant);
                    setLinkPick("");
                  }
                }}
                className="rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-card"
              >
                Link
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 pt-1">
        {rec.settings && (
          <button
            onClick={() => onSave("clear")}
            className="rounded-lg px-2 py-1 text-[var(--muted)] hover:text-rose-500"
          >
            Reset all
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-[var(--muted)]">
            Cancel
          </button>
          <button
            onClick={save}
            className="rounded-lg bg-[var(--accent)] px-3 py-1 font-medium text-white"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
