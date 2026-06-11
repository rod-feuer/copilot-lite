"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useToast } from "@/components/Toast";
import { Tooltip } from "@/components/Tooltip";
import { postJson, patchJson } from "@/lib/http";
import { usd, shortDate, shortDatePad, monthDayYear } from "@/lib/format";

type Cat = { id: number; name: string; color: string; icon: string };
type Recent = {
  id: number;
  date: string;
  amount: number;
  account: string;
  excluded: 0 | 1;
  categoryName: string | null;
};
type Summary = {
  merchant: string;
  displayName: string;
  nameVariants: number;
  count: number;
  spent: number;
  received: number;
  monthlyAvg: number;
  trailing12: number;
  count12: number;
  firstSeen: string | null;
  recurring: boolean;
  recurringDetail: {
    cadence: string;
    perCharge: number;
    annualized: number;
    nextDate: string;
  } | null;
  byYear: { year: string; spent: number }[];
  priceChange: { from: number; to: number; since: string } | null;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  names: { name: string; count: number; canUnlink: boolean }[];
  recent: Recent[];
};
type CatSummary = {
  id: number;
  name: string;
  icon: string;
  color: string;
  kind: "expense" | "income";
  excludeFromTotals: 0 | 1;
  month: string;
  spent: number;
  txCount: number;
  prevSpent: number;
  monthlyAvg: number;
  budget: number | null;
  upcoming: { merchant: string; displayName: string; dueDate: string; amount: number }[];
  transactions: {
    id: number;
    date: string;
    merchant: string;
    displayName: string;
    amount: number;
    account: string;
    recurringId: number | null;
  }[];
};

type OpenOpts = { onChange?: () => void };
type Target =
  | { kind: "merchant"; merchant: string }
  | { kind: "category"; categoryId: number; month: string };

type Shelf = {
  openMerchant: (merchant: string, opts?: OpenOpts) => void;
  openCategory: (categoryId: number, month: string, opts?: OpenOpts) => void;
  active: Target | null; // what the shelf is currently showing, for active-state styling
};
const Ctx = createContext<Shelf>({
  openMerchant: () => {},
  openCategory: () => {},
  active: null,
});
export const useTxDrawer = () => useContext(Ctx).openMerchant;
export const useCategoryShelf = () => useContext(Ctx).openCategory;

// Whether a given trigger is the one the shelf is currently showing — so a row or
// bar can render a "selected" state while its detail is open (and make the
// click-again-to-close gesture discoverable).
export const useShelfActive = () => {
  const { active } = useContext(Ctx);
  return {
    isMerchant: (m: string) => active?.kind === "merchant" && active.merchant === m,
    isCategory: (id: number, month: string) =>
      active?.kind === "category" && active.categoryId === id && active.month === month,
  };
};

export function TxDrawerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [mData, setMData] = useState<Summary | null>(null);
  const [cData, setCData] = useState<CatSummary | null>(null);
  const [back, setBack] = useState<Target | null>(null);
  const [cats, setCats] = useState<Cat[]>([]);
  const onChange = useRef<(() => void) | undefined>(undefined);
  const asideRef = useRef<HTMLElement>(null);
  const toast = useToast();

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then(setCats);
  }, []);

  const fetchMerchant = useCallback((m: string) => {
    setMData(null);
    fetch(`/api/merchant?name=${encodeURIComponent(m)}`)
      .then((r) => r.json())
      .then(setMData)
      .catch(() => {});
  }, []);
  const fetchCategory = useCallback((id: number, month: string) => {
    setCData(null);
    fetch(`/api/category?id=${id}&month=${encodeURIComponent(month)}`)
      .then((r) => r.json())
      .then(setCData)
      .catch(() => {});
  }, []);

  const close = useCallback(() => {
    setTarget(null);
    setBack(null);
  }, []);

  const openMerchant = useCallback(
    (m: string, opts?: OpenOpts) => {
      // Re-clicking the row whose detail is already showing toggles the shelf
      // shut (matches the in-place, non-modal feel — the trigger stays in view).
      if (target?.kind === "merchant" && target.merchant === m) {
        close();
        return;
      }
      onChange.current = opts?.onChange;
      setBack(null);
      setCData(null);
      setTarget({ kind: "merchant", merchant: m });
      fetchMerchant(m);
    },
    [target, close, fetchMerchant]
  );
  const openCategory = useCallback(
    (categoryId: number, month: string, opts?: OpenOpts) => {
      if (
        target?.kind === "category" &&
        target.categoryId === categoryId &&
        target.month === month
      ) {
        close();
        return;
      }
      onChange.current = opts?.onChange;
      setBack(null);
      setMData(null);
      setTarget({ kind: "category", categoryId, month });
      fetchCategory(categoryId, month);
    },
    [target, close, fetchCategory]
  );

  // Drill from a category's transaction into that vendor, remembering the
  // category so the panel can offer a "← Back".
  const drillToMerchant = (m: string) => {
    setBack(target);
    setCData(null);
    setTarget({ kind: "merchant", merchant: m });
    fetchMerchant(m);
  };
  const goBack = () => {
    const b = back;
    if (!b) return;
    setBack(null);
    setTarget(b);
    if (b.kind === "category") fetchCategory(b.categoryId, b.month);
    else fetchMerchant(b.merchant);
  };

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, close]);

  // Non-modal: close when clicking outside the panel — but not when clicking a
  // drawer row (`data-drawer-row`), so clicking another row updates the panel in
  // place instead of closing it.
  useEffect(() => {
    if (!target) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el) return;
      if (asideRef.current?.contains(el)) return;
      if (el.closest("[data-drawer-row]")) return;
      close();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [target, close]);

  // Non-modal panel: close it when the route changes (e.g. switching tabs).
  const pathname = usePathname();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTarget(null);
  }, [pathname]);

  async function recategorize(categoryId: number | null) {
    if (target?.kind !== "merchant") return;
    const merchant = target.merchant;
    try {
      await postJson("/api/recurrings/recategorize", { merchant, categoryId });
      toast(`Recategorized "${merchant}"`, "success");
      fetchMerchant(merchant);
      onChange.current?.();
    } catch {
      toast("Couldn't recategorize — please try again", "error");
    }
  }

  async function unlinkName(alias: string) {
    if (target?.kind !== "merchant") return;
    const merchant = target.merchant;
    try {
      await postJson("/api/recurrings/link", { alias, unlink: true });
      toast(`Unlinked “${alias}”`, "success");
      fetchMerchant(merchant);
      onChange.current?.();
    } catch {
      toast("Couldn't unlink — please try again", "error");
    }
  }

  async function toggleRecurring() {
    if (target?.kind !== "merchant" || !mData) return;
    const merchant = target.merchant;
    const makeIt = !mData.recurring;
    try {
      await postJson("/api/recurrings/override", { merchant, status: makeIt ? "force" : "mute" });
      toast(makeIt ? "Marked recurring" : "No longer recurring", "success");
      fetchMerchant(merchant);
      onChange.current?.();
    } catch {
      toast("Couldn't update — please try again", "error");
    }
  }

  // Per-transaction edits from inside the category shelf. Refresh the shelf so
  // totals/lists update (e.g. recategorizing a row out of the category).
  const refreshCategory = () => {
    if (target?.kind === "category") fetchCategory(target.categoryId, target.month);
  };
  async function txRecategorize(txId: number, categoryId: number | null) {
    try {
      await patchJson(`/api/transactions/${txId}`, { categoryId });
      toast("Recategorized", "success");
      refreshCategory();
      onChange.current?.();
    } catch {
      toast("Couldn't recategorize — please try again", "error");
    }
  }
  async function txToggleRecurring(merchant: string, makeIt: boolean) {
    try {
      await postJson("/api/recurrings/override", { merchant, status: makeIt ? "force" : "mute" });
      toast(makeIt ? "Marked recurring" : "No longer recurring", "success");
      refreshCategory();
      onChange.current?.();
    } catch {
      toast("Couldn't update — please try again", "error");
    }
  }

  const loading = target?.kind === "merchant" ? !mData : !cData;

  return (
    <Ctx.Provider value={{ openMerchant, openCategory, active: target }}>
      {children}
      {target && (
        <aside
          ref={asideRef}
          className="fixed right-0 top-0 z-50 flex h-full w-full max-w-sm flex-col border-l border-[var(--border)] bg-card shadow-2xl"
        >
          <header className="flex items-start justify-between border-b border-[var(--border)] px-4 py-3">
            <div className="min-w-0">
              {back && (
                <button
                  onClick={goBack}
                  className="mb-0.5 text-xs text-[var(--accent)] hover:underline"
                >
                  ← Back
                </button>
              )}
              {target.kind === "merchant" ? (
                <MerchantHeader merchant={target.merchant} data={mData} onUnlink={unlinkName} />
              ) : (
                <CategoryHeader data={cData} month={target.month} />
              )}
            </div>
            <button
              onClick={close}
              className="shrink-0 rounded-md px-2 py-1 text-[var(--muted)] hover:bg-[var(--background)] hover:text-[var(--foreground)]"
              aria-label="Close"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="space-y-2">
                <div className="h-16 animate-pulse rounded-xl bg-[var(--background)]" />
                <div className="h-9 animate-pulse rounded-xl bg-[var(--background)]" />
                <div className="h-40 animate-pulse rounded-xl bg-[var(--background)]" />
              </div>
            ) : target.kind === "merchant" && mData ? (
              <MerchantBody
                data={mData}
                cats={cats}
                onRecategorize={recategorize}
                onToggleRecurring={toggleRecurring}
              />
            ) : target.kind === "category" && cData ? (
              <CategoryBody
                data={cData}
                cats={cats}
                onOpenMerchant={drillToMerchant}
                onTxRecategorize={txRecategorize}
                onTxToggleRecurring={txToggleRecurring}
              />
            ) : null}
          </div>

          <footer className="border-t border-[var(--border)] p-3">
            <Link
              href={
                target.kind === "merchant"
                  ? `/transactions?vendor=${encodeURIComponent(target.merchant)}`
                  : `/transactions?category=${target.categoryId}&month=${target.month}`
              }
              onClick={close}
              className="block rounded-lg px-2 py-2 text-center text-sm font-medium text-[var(--accent)] hover:bg-[var(--background)]"
            >
              View all transactions →
            </Link>
          </footer>
        </aside>
      )}
    </Ctx.Provider>
  );
}

function MerchantHeader({
  merchant,
  data,
  onUnlink,
}: {
  merchant: string;
  data: Summary | null;
  onUnlink: (alias: string) => void;
}) {
  const [showNames, setShowNames] = useState(false);
  return (
    <>
      <div className="truncate text-sm font-semibold">{data?.displayName ?? merchant}</div>
      {data && data.displayName !== data.merchant && (
        <div className="truncate text-[11px] text-[var(--muted)]">{data.merchant}</div>
      )}
      {data && (
        <div className="text-xs text-[var(--muted)]">
          {data.count} transaction{data.count === 1 ? "" : "s"}
          {data.firstSeen
            ? ` · since ${new Date(data.firstSeen + "T00:00:00Z").toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
                timeZone: "UTC",
              })}`
            : ""}
          {data.nameVariants > 1 ? (
            <>
              {" · "}
              <button
                onClick={() => setShowNames((s) => !s)}
                className="underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
                title="The bank descriptors grouped under this vendor"
              >
                {data.nameVariants} names {showNames ? "▾" : "▸"}
              </button>
            </>
          ) : null}
          {data.recurring ? " · recurring ↻" : ""}
        </div>
      )}
      {data && showNames && data.names.length > 1 && (
        <ul className="mt-2 flex flex-col divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {data.names.map((n) => (
            <li key={n.name} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate" title={n.name}>
                {n.name}
              </span>
              <span className="shrink-0 tabular-nums text-[var(--muted)]">{n.count}</span>
              {n.canUnlink ? (
                <button
                  onClick={() => onUnlink(n.name)}
                  title="Unlink this descriptor — split it back into its own vendor"
                  className="shrink-0 rounded px-1 text-[var(--muted)] hover:text-rose-500"
                >
                  ✕
                </button>
              ) : (
                <span className="w-[18px] shrink-0" aria-hidden />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CategoryHeader({ data, month }: { data: CatSummary | null; month: string }) {
  const label = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return (
    <>
      <div className="truncate text-sm font-semibold">
        {data ? `${data.icon} ${data.name}` : "…"}
      </div>
      {data && (
        <div className="text-xs text-[var(--muted)]">
          {data.upcoming.length > 0
            ? `${data.txCount} posted`
            : `${data.txCount} transaction${data.txCount === 1 ? "" : "s"}`}{" "}
          · {label}
        </div>
      )}
    </>
  );
}

function MerchantBody({
  data,
  cats,
  onRecategorize,
  onToggleRecurring,
}: {
  data: Summary;
  cats: Cat[];
  onRecategorize: (categoryId: number | null) => void;
  onToggleRecurring: () => void;
}) {
  const d = data.recurringDetail;
  const monthsActive = monthsSince(data.firstSeen);
  const boxes = d
    ? [
        { label: "per charge", value: usd(d.perCharge, { cents: false }) },
        { label: "per year", value: usd(d.annualized, { cents: false }) },
        { label: "next due", value: shortDate(d.nextDate) },
      ]
    : [
        { label: "last 12 mo", value: usd(data.trailing12, { cents: false }) },
        { label: "per month", value: usd(data.trailing12 / monthsActive, { cents: false }) },
        { label: "txns / 12mo", value: String(data.count12) },
      ];
  if (data.received > 0)
    boxes.push({ label: "received", value: usd(data.received, { cents: false }) });

  return (
    <div className="flex flex-col gap-4">
      <div className={`grid gap-2 text-center ${boxes.length > 3 ? "grid-cols-2" : "grid-cols-3"}`}>
        {boxes.map((b) => (
          <Metric key={b.label} label={b.label} value={b.value} />
        ))}
      </div>

      {data.priceChange && (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
          {data.priceChange.to > data.priceChange.from ? "↑" : "↓"} price changed{" "}
          {usd(data.priceChange.from)} → {usd(data.priceChange.to)} since{" "}
          {monthDayYear(data.priceChange.since)}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="stat-label">Category</label>
        <select
          value={data.categoryId ?? ""}
          onChange={(e) => onRecategorize(e.target.value ? Number(e.target.value) : null)}
          className="btn-ghost w-full cursor-pointer text-sm"
        >
          <option value="">Uncategorized</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon} {c.name}
            </option>
          ))}
        </select>
        <button onClick={onToggleRecurring} className="btn-ghost w-full text-sm">
          {data.recurring ? "↻ Mark as not recurring" : "↻ Make recurring"}
        </button>
      </div>

      {data.byYear.length > 1 && (
        <div>
          <div className="stat-label mb-1.5">By year</div>
          <div className="flex flex-col gap-1.5">
            {(() => {
              const max = Math.max(...data.byYear.map((y) => y.spent), 1);
              return data.byYear.map((y) => (
                <div key={y.year} className="flex items-center gap-2 text-xs">
                  <span className="w-9 shrink-0 text-[var(--muted)]">{y.year}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--background)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent)]"
                      style={{ width: `${(y.spent / max) * 100}%` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right tabular-nums">
                    {usd(y.spent, { cents: false })}
                  </span>
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      <div>
        <div className="stat-label mb-1.5">Recent</div>
        <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
          {data.recent.map((r) => (
            <li
              key={r.id}
              className={`flex items-center justify-between gap-2 px-3 py-2 text-sm ${
                r.excluded ? "opacity-55" : ""
              }`}
            >
              <span className="text-xs text-[var(--muted)]">{monthDayYear(r.date)}</span>
              <span className={`tabular-nums ${r.amount >= 0 ? "text-emerald-600" : ""}`}>
                {usd(r.amount, { sign: true })}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CategoryBody({
  data,
  cats,
  onOpenMerchant,
  onTxRecategorize,
  onTxToggleRecurring,
}: {
  data: CatSummary;
  cats: Cat[];
  onOpenMerchant: (merchant: string) => void;
  onTxRecategorize: (txId: number, categoryId: number | null) => void;
  onTxToggleRecurring: (merchant: string, makeIt: boolean) => void;
}) {
  const isIncome = data.kind === "income";
  const isExcluded = data.excludeFromTotals === 1;
  const budgeted = data.budget != null && !isIncome && !isExcluded;

  // Card 1 — how much.
  const card1 = {
    label: isIncome ? "received" : isExcluded ? "total" : "spent",
    value: usd(data.spent, { cents: false }),
  };
  // Card 2 — the trailing-12 "typical month" benchmark, always (the budget bar
  // below owns the budget, so the three cards stay a consistent actual/typical/
  // trend triad for every category).
  const remaining = (data.budget ?? 0) - data.spent;
  const card2 = { label: "avg/mo", value: usd(data.monthlyAvg, { cents: false }) };
  // Card 3 — trend vs last month: a direction arrow + % (compact, so a large
  // dollar swing no longer dominates the row), tinted green when it moved the
  // "good" way (expense down / income up) and amber otherwise.
  const delta = data.spent - data.prevSpent;
  const pct = data.prevSpent ? Math.round((delta / data.prevSpent) * 100) : 0;
  const better = isIncome ? delta > 0 : delta < 0;
  const hasTrend = data.prevSpent > 0 && pct !== 0;
  const card3 = {
    label: "vs last mo",
    value:
      data.prevSpent === 0
        ? data.spent === 0
          ? "—"
          : "new"
        : `${pct > 0 ? "↑ " : pct < 0 ? "↓ " : ""}${Math.abs(pct)}%`,
    valueClass: hasTrend ? (better ? "text-emerald-600" : "text-amber-600") : undefined,
  };
  const cards: { label: string; value: string; valueClass?: string }[] = [card1, card2, card3];

  const pctOfBudget = budgeted && data.budget ? Math.min(100, (data.spent / data.budget) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2 text-center">
        {cards.map((b) => (
          <Metric key={b.label} label={b.label} value={b.value} valueClass={b.valueClass} />
        ))}
      </div>

      {budgeted && data.budget != null && (
        // A tinted summary module (matching the Metric cards). The two figures
        // bookend the progress bar: "spent of budget" caps its left, "X left"
        // caps its right — both right/left edges are the box content edges, the
        // same px-3 that bounds the bar, so they align to the bar by structure.
        <div className="rounded-xl border border-transparent bg-[var(--background)] px-3 py-2">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-[var(--muted)]">
            <span className="min-w-0 flex-1 truncate">
              {usd(data.spent, { cents: false })} of {usd(data.budget, { cents: false })}
            </span>
            <span className={`shrink-0 tabular-nums ${remaining < 0 ? "text-amber-600" : ""}`}>
              {remaining >= 0
                ? `${usd(remaining, { cents: false })} left`
                : `${usd(-remaining, { cents: false })} over`}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--muted)]/15">
            <div
              className={`h-full rounded-full ${remaining < 0 ? "bg-rose-500" : "bg-[var(--accent)]"}`}
              style={{ width: `${pctOfBudget}%` }}
            />
          </div>
        </div>
      )}

      {data.upcoming.length > 0 && (
        <div>
          <div className="stat-label mb-1.5">Upcoming this month</div>
          <ul className="divide-y divide-[var(--border)] rounded-xl border border-dashed border-[var(--border)]">
            {data.upcoming.map((u) => (
              <ShelfRow
                key={u.merchant}
                date={u.dueDate}
                name={u.displayName}
                amount={-u.amount}
                muted
                recurring
              />
            ))}
            {/* Total — a column-foot total: the label sits under the name column,
                the amount under the amount column, mirroring the rows above. */}
            <li className="flex w-full items-center gap-2 px-3 py-2 text-xs">
              <span className="w-3.5 shrink-0" aria-hidden />
              <span className="w-11 shrink-0" aria-hidden />
              <span className="flex-1 font-medium text-[var(--muted)]">Total expected</span>
              <span className="shrink-0 font-medium tabular-nums">
                {usd(-data.upcoming.reduce((a, u) => a + u.amount, 0))}
              </span>
              <span className="w-5 shrink-0" aria-hidden />
            </li>
          </ul>
        </div>
      )}

      <div>
        <div className="stat-label mb-1.5">Transactions</div>
        {data.transactions.length === 0 ? (
          <p className="rounded-xl border border-[var(--border)] p-4 text-center text-xs text-[var(--muted)]">
            No transactions this month.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
            {data.transactions.map((t) => (
              <ShelfRow
                key={t.id}
                date={t.date}
                name={t.displayName}
                amount={t.amount}
                sign
                recurring={t.recurringId != null}
                onClick={() => onOpenMerchant(t.merchant)}
                editable={{
                  cats,
                  onRecategorize: (cid) => onTxRecategorize(t.id, cid),
                  onToggleRecurring: () => onTxToggleRecurring(t.merchant, t.recurringId == null),
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Calendar months from firstSeen through today (inclusive), clamped to [1, 12]
// — the denominator for the trailing-12 "per month" average.
function monthsSince(firstSeen: string | null): number {
  if (!firstSeen) return 12;
  const fs = new Date(firstSeen + "T00:00:00");
  const now = new Date();
  const span =
    (now.getFullYear() - fs.getFullYear()) * 12 + (now.getMonth() - fs.getMonth()) + 1;
  return Math.min(12, Math.max(1, span));
}

// Shared shelf row: a fixed-width date column, gap, then the name; amount right;
// an optional "⋯" edit menu (a reserved slot keeps amounts aligned across rows).
// Used by both the Upcoming and Transactions lists so they line up.
type RowEdit = {
  cats: Cat[];
  onRecategorize: (categoryId: number | null) => void;
  onToggleRecurring: () => void;
};
function ShelfRow({
  date,
  name,
  amount,
  sign,
  muted,
  recurring,
  onClick,
  editable,
}: {
  date: string;
  name: string;
  amount: number;
  sign?: boolean;
  muted?: boolean;
  recurring?: boolean;
  onClick?: () => void;
  editable?: RowEdit;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <li>
      <div
        onClick={onClick}
        className={`group flex w-full items-center gap-2 px-3 py-2 text-xs ${
          onClick ? "cursor-pointer hover:bg-[var(--background)]" : ""
        }`}
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {editable ? (
            // The ↻ gutter doubles as the recurring toggle: solid when the
            // charge is part of a recurring series, a faint hover affordance
            // when it isn't. Operates on the whole vendor (force/mute).
            <button
              onClick={(e) => {
                e.stopPropagation();
                editable.onToggleRecurring();
              }}
              title={recurring ? "Mark vendor not recurring" : "Mark vendor recurring"}
              aria-label={recurring ? "Mark vendor not recurring" : "Mark vendor recurring"}
              className={`w-3.5 shrink-0 text-center transition-opacity hover:text-[var(--accent)] ${
                recurring
                  ? "text-[var(--accent)] opacity-100"
                  : "text-[var(--muted)] opacity-0 focus:opacity-100 group-hover:opacity-100"
              }`}
            >
              ↻
            </button>
          ) : (
            <span
              className={`w-3.5 shrink-0 text-center ${
                muted ? "text-[var(--muted)]" : "text-[var(--accent)]"
              }`}
              title={recurring ? "Recurring" : undefined}
              aria-hidden={!recurring}
            >
              {recurring ? "↻" : ""}
            </span>
          )}
          <span className="w-11 shrink-0 tabular-nums text-[var(--muted)]">{shortDatePad(date)}</span>
          <Tooltip
            label={name}
            className={`truncate font-medium ${muted ? "text-[var(--muted)]" : ""}`}
          >
            {name}
          </Tooltip>
        </span>
        <span
          className={`shrink-0 tabular-nums ${
            muted ? "text-[var(--muted)]" : amount >= 0 ? "text-emerald-600" : ""
          }`}
        >
          {usd(amount, { sign: !!sign })}
        </span>
        {editable ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditing((v) => !v);
            }}
            className={`w-5 shrink-0 rounded text-[var(--muted)] transition-opacity hover:text-[var(--foreground)] focus:opacity-100 ${
              editing ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
            aria-label="Edit transaction"
          >
            ⋯
          </button>
        ) : (
          <span className="w-5 shrink-0" aria-hidden />
        )}
      </div>
      {editable && editing && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs"
        >
          <select
            defaultValue="__p"
            onChange={(e) => {
              const v = e.target.value;
              editable.onRecategorize(v === "none" ? null : Number(v));
              setEditing(false);
            }}
            className="rounded-lg border border-[var(--border)] bg-card px-2 py-1"
          >
            <option value="__p" disabled>
              Recategorize…
            </option>
            <option value="none">Uncategorized</option>
            {editable.cats.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.icon} {c.name}
              </option>
            ))}
          </select>
          <span className="text-[var(--muted)]">
            Recurring? Use the ↻ at the start of the row.
          </span>
        </div>
      )}
    </li>
  );
}

function Metric({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl bg-[var(--background)] py-2">
      <div className={`text-sm font-semibold tabular-nums ${valueClass ?? ""}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
    </div>
  );
}
