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
type Vendor = { merchant: string; displayName: string };
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
  alias: string | null; // user-set name override (null = using the bank descriptor)
  expectedAmount: number | null; // user-set go-forward amount (null = detected)
  cadence: string | null; // user-set cadence override (null = using detected)
  detectedCadence: string | null; // what detection found, for the "detected X" hint
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

// amountHint lets the caller (e.g. a suggestion row) seed the expected-amount
// placeholder with the exact figure it displays, so the two never disagree.
type OpenOpts = { onChange?: () => void; amountHint?: number | null };
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
  const [amountHint, setAmountHint] = useState<number | null>(null);
  const [cats, setCats] = useState<Cat[]>([]);
  // Vendors (one per canonical merchant, with display name) for the Combine picker.
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const onChange = useRef<(() => void) | undefined>(undefined);
  const asideRef = useRef<HTMLElement>(null);
  const toast = useToast();

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then(setCats);
    fetch("/api/vendors")
      .then((r) => r.json())
      .then(setVendors);
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
    setAmountHint(null);
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
      setAmountHint(opts?.amountHint ?? null);
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
      setAmountHint(null);
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
    setAmountHint(null);
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

  // Save a per-merchant override (name and/or go-forward amount) edited right in
  // the shelf, where the recent charges that justify the value are on screen.
  async function saveMerchantSettings(
    patch: { alias?: string | null; expectedAmount?: number | null; cadence?: string | null },
    message: string
  ) {
    if (target?.kind !== "merchant") return;
    const merchant = target.merchant;
    try {
      await postJson("/api/recurrings/settings", { merchant, ...patch });
      toast(message, "success");
      fetchMerchant(merchant);
      onChange.current?.();
    } catch {
      toast("Couldn't save — please try again", "error");
    }
  }

  // Merge two vendors into one. `loser` folds into `primary` (the survivor, which
  // becomes canonical); an optional `alias` sets the merged vendor's display name
  // (used when the user picks a custom name). The component resolves which is the
  // survivor from the name they chose, so "canonical" is never surfaced. Close the
  // shelf afterward — its target may now be the folded-away descriptor.
  async function combineMerchant(
    loser: string,
    primary: string,
    alias?: string,
    categoryId?: number | null
  ) {
    try {
      await postJson("/api/recurrings/link", { alias: loser, primary });
      if (alias != null) await postJson("/api/recurrings/settings", { merchant: primary, alias });
      // Unify the category when the user chose to, so a combined vendor isn't
      // left split across categories. Recategorize covers all linked descriptors.
      if (categoryId != null)
        await postJson("/api/recurrings/recategorize", { merchant: primary, categoryId });
      toast("Vendors combined", "success");
      onChange.current?.();
      close();
    } catch {
      toast("Couldn't combine — please try again", "error");
    }
  }

  async function unlinkName(alias: string) {
    if (target?.kind !== "merchant") return;
    const merchant = target.merchant;
    try {
      await postJson("/api/recurrings/link", { alias, unlink: true });
      toast(`Separated “${alias}”`, "success");
      fetchMerchant(merchant);
      onChange.current?.();
    } catch {
      toast("Couldn't separate — please try again", "error");
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
                <MerchantHeader
                  merchant={target.merchant}
                  data={mData}
                  onUnlink={unlinkName}
                  onRename={(alias) => saveMerchantSettings({ alias }, alias ? "Name updated" : "Name reset")}
                />
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
                onSaveSettings={saveMerchantSettings}
                amountHint={amountHint}
                vendors={vendors}
                onCombine={combineMerchant}
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

// The shelf's heading name, click-to-edit in place (no separate Name field).
// Typing the underlying bank name clears the override. Commits on Enter/blur,
// reverts on Escape, and flushes on unmount so closing the shelf mid-edit keeps
// the change (same teardown guard as ShelfEditField).
function EditableName({
  value,
  underlying,
  currentAlias,
  onSave,
}: {
  value: string;
  underlying: string;
  currentAlias: string | null;
  onSave: (alias: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reverted = useRef(false);
  const committed = useRef(value);

  const commit = (raw: string) => {
    committed.current = raw;
    const v = raw.trim();
    const next = v && v !== underlying ? v : null; // editing back to the bank name = clear
    if (next !== currentAlias) onSave(next);
  };

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    return () => {
      if (!reverted.current && el && el.value !== committed.current) commit(el.value);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (!editing) {
    return (
      <button
        onClick={() => {
          committed.current = value;
          setEditing(true);
        }}
        title="Rename"
        className="group/n flex max-w-full items-center gap-1 text-left"
      >
        <span className="truncate text-sm font-semibold">{value}</span>
        <span className="shrink-0 text-[10px] text-[var(--muted)] opacity-0 transition-opacity group-hover/n:opacity-100">
          <span className="inline-block -scale-x-100">✎</span>
        </span>
      </button>
    );
  }
  return (
    <input
      ref={inputRef}
      autoFocus
      defaultValue={value}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          reverted.current = true;
          setEditing(false);
        }
      }}
      onBlur={(e) => {
        if (reverted.current) {
          reverted.current = false;
          setEditing(false);
          return;
        }
        commit(e.target.value);
        setEditing(false);
      }}
      className="w-full rounded-md border border-[var(--border)] bg-card px-1.5 py-0.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
    />
  );
}

function MerchantHeader({
  merchant,
  data,
  onUnlink,
  onRename,
}: {
  merchant: string;
  data: Summary | null;
  onUnlink: (alias: string) => void;
  onRename: (alias: string | null) => void;
}) {
  const [showNames, setShowNames] = useState(false);
  return (
    <>
      {data ? (
        <EditableName
          value={data.displayName}
          underlying={data.merchant}
          currentAlias={data.alias}
          onSave={onRename}
        />
      ) : (
        <div className="truncate text-sm font-semibold">{merchant}</div>
      )}
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
                title="The bank names grouped under this vendor"
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
                  title="Separate this name back into its own vendor"
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
  onSaveSettings,
  amountHint,
  vendors,
  onCombine,
}: {
  data: Summary;
  cats: Cat[];
  onRecategorize: (categoryId: number | null) => void;
  onToggleRecurring: () => void;
  onSaveSettings: (
    patch: { alias?: string | null; expectedAmount?: number | null; cadence?: string | null },
    message: string
  ) => void;
  amountHint?: number | null;
  vendors: Vendor[];
  onCombine: (loser: string, primary: string, alias?: string, categoryId?: number | null) => void;
}) {
  const [combining, setCombining] = useState(false);
  const d = data.recurringDetail;
  const monthsActive = monthsSince(data.firstSeen);
  // Placeholder for the expected-amount editor. Priority: a caller-supplied hint
  // (the suggestion row's exact figure, so the two never disagree) → the detected
  // per-charge for a confirmed recurring → the most recent charge (current price).
  const detectedAmount =
    d?.perCharge ??
    amountHint ??
    (data.recent[0] ? Number(Math.abs(data.recent[0].amount).toFixed(2)) : null);
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

      {/* Edit / correct — name lives in the header (click to rename); here: a
          compact 2-up grid so the top half stays scannable. */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap gap-x-3 gap-y-2.5">
          <div className="min-w-[140px] flex-1">
            <ShelfEditField
              label="Expected"
              edited={data.expectedAmount != null}
              prefix="$"
              inputMode="decimal"
              defaultValue={data.expectedAmount != null ? data.expectedAmount.toFixed(2) : ""}
              placeholder={detectedAmount != null ? detectedAmount.toFixed(2) : "amount"}
              onCommit={(v) => {
                const t = v.trim();
                if (t === "") {
                  if (data.expectedAmount != null) onSaveSettings({ expectedAmount: null }, "Expected amount cleared");
                  return;
                }
                const n = Math.abs(Number(t));
                if (!Number.isFinite(n)) return; // ignore non-numeric input
                if (n !== (data.expectedAmount ?? null)) onSaveSettings({ expectedAmount: n }, "Expected amount updated");
              }}
            />
          </div>

          {data.recurring && (
            <div className="min-w-[140px] flex-1">
              <CadenceCorrection
                detected={data.detectedCadence}
                override={data.cadence}
                onSave={(c) => onSaveSettings({ cadence: c }, c ? "Cadence updated" : "Cadence reset to auto")}
              />
            </div>
          )}

          <div className="min-w-[140px] flex-1">
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
            </div>
          </div>
        </div>

        {/* Two secondary actions, compact and side-by-side. Combine is a
            disclosure — its panel drops below the row only while in use. */}
        <div className="flex gap-2">
          <button onClick={onToggleRecurring} className="btn-ghost flex-1 text-xs">
            {data.recurring ? "↻ Not recurring" : "↻ Make recurring"}
          </button>
          <button
            onClick={() => setCombining((v) => !v)}
            className={`btn-ghost flex-1 text-xs ${combining ? "text-[var(--accent)]" : ""}`}
          >
            ＋ Combine
          </button>
        </div>
        {combining && (
          <CombineControl
            current={{
              merchant: data.merchant,
              name: data.displayName,
              count: data.count,
              categoryId: data.categoryId,
              categoryName: data.categoryName,
            }}
            cats={cats}
            vendors={vendors}
            onCombine={onCombine}
            onClose={() => setCombining(false)}
          />
        )}
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

// Merge this vendor with another. The only decision surfaced is the resulting
// NAME — which silently determines the survivor (canonical), so the user never
// reasons about "primary". Defaults to the cleaner name; a preview shows the
// combined charge count; and the merge is reversible (split via the header).
type CombineVendor = {
  merchant: string;
  name: string;
  count: number;
  categoryId: number | null;
  categoryName: string | null;
};

function CombineControl({
  current,
  cats,
  vendors,
  onCombine,
  onClose,
}: {
  current: CombineVendor;
  cats: Cat[];
  vendors: Vendor[];
  onCombine: (loser: string, primary: string, alias?: string, categoryId?: number | null) => void;
  onClose: () => void;
}) {
  const [pick, setPick] = useState("");
  const [other, setOther] = useState<CombineVendor | null>(null);
  const [choice, setChoice] = useState<"current" | "other" | "custom">("current");
  const [custom, setCustom] = useState("");
  const [showList, setShowList] = useState(false); // vendor-picker dropdown open
  // The category to apply to all the combined charges, or "asis" to leave them.
  const [unifyCat, setUnifyCat] = useState<number | "asis">("asis");

  const reset = () => {
    setPick("");
    setOther(null);
    setCustom("");
    setChoice("current");
    setUnifyCat("asis");
    setShowList(false);
    onClose();
  };

  // Live matches for the custom picker dropdown — one row per vendor, shown by
  // friendly display name (filters on the name or the raw descriptor).
  const q = pick.trim().toLowerCase();
  const matches = q
    ? vendors
        .filter(
          (v) =>
            v.merchant !== current.merchant &&
            (v.displayName.toLowerCase().includes(q) || v.merchant.toLowerCase().includes(q))
        )
        .slice(0, 50)
    : [];

  // Cleaner = fewer words, then shorter, with a digit penalty (bank descriptors
  // tend to be long, multi-word, and id-laden). Returns true if `a` is cleaner.
  const score = (s: string) => s.trim().split(/\s+/).length * 100 + s.length + (/\d/.test(s) ? 50 : 0);
  const currentCleaner = () => !other || score(current.name) <= score(other.name);
  // Categories differ → offer to unify them (a combined vendor shouldn't stay
  // split across categories).
  const categoriesDiffer = !!other && current.categoryId !== other.categoryId;

  async function chooseOther(merchant?: string) {
    // A clicked row passes its canonical merchant; Enter/Next takes the top match.
    const m = merchant ?? matches[0]?.merchant;
    if (!m || m === current.merchant || !vendors.some((v) => v.merchant === m)) return;
    setShowList(false);
    const o = await fetch(`/api/merchant?name=${encodeURIComponent(m)}`).then((r) => r.json());
    const next: CombineVendor = {
      merchant: m,
      name: o.displayName as string,
      count: o.count as number,
      categoryId: (o.categoryId ?? null) as number | null,
      categoryName: (o.categoryName ?? null) as string | null,
    };
    setOther(next);
    const curCleaner = score(current.name) <= score(next.name);
    setChoice(curCleaner ? "current" : "other");
    // Default the unify target to the survivor's category, else the other's.
    const survivor = curCleaner ? current.categoryId : next.categoryId;
    const fallback = curCleaner ? next.categoryId : current.categoryId;
    setUnifyCat(survivor ?? fallback ?? "asis");
  }

  function combine() {
    if (!other) return;
    const cat = categoriesDiffer && unifyCat !== "asis" ? unifyCat : undefined;
    if (choice === "current") onCombine(other.merchant, current.merchant, undefined, cat);
    else if (choice === "other") onCombine(current.merchant, other.merchant, undefined, cat);
    else {
      const name = custom.trim();
      if (!name) return;
      const primary = currentCleaner() ? current.merchant : other.merchant;
      const loser = primary === current.merchant ? other.merchant : current.merchant;
      onCombine(loser, primary, name, cat);
    }
    reset();
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3 text-xs">
      {!other ? (
        <>
          <div className="relative">
            <input
              autoFocus
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                setShowList(true);
              }}
              onFocus={() => setShowList(true)}
              onKeyDown={(e) => e.key === "Enter" && chooseOther()}
              onBlur={() => setTimeout(() => setShowList(false), 150)}
              placeholder="Find a vendor to combine…"
              className="w-full rounded-lg border border-[var(--border)] bg-card px-2 py-1"
            />
            {showList && matches.length > 0 && (
              <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-lg border border-[var(--border)] bg-card py-1 shadow-lg">
                {matches.map((v) => (
                  <li key={v.merchant}>
                    <button
                      // mousedown (not click) + preventDefault so selecting fires
                      // before the input's blur closes the list.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        chooseOther(v.merchant);
                      }}
                      className="block w-full px-2 py-1.5 text-left leading-snug hover:bg-[var(--background)]"
                    >
                      {v.displayName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => chooseOther()}
              className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-card"
            >
              Next
            </button>
            <button onClick={reset} className="text-[var(--muted)] hover:text-[var(--foreground)]">
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="text-[var(--muted)]">Combine into one vendor — name it:</div>
          {[
            { key: "current" as const, label: current.name, cleaner: currentCleaner() },
            { key: "other" as const, label: other.name, cleaner: !currentCleaner() },
          ].map((opt) => (
            <label key={opt.key} className="flex items-center gap-2">
              <input
                type="radio"
                checked={choice === opt.key}
                onChange={() => setChoice(opt.key)}
              />
              <span className="min-w-0 truncate">{opt.label}</span>
              {opt.cleaner && <span className="shrink-0 text-[10px] text-[var(--accent)]">recommended</span>}
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input type="radio" checked={choice === "custom"} onChange={() => setChoice("custom")} />
            <input
              value={custom}
              onFocus={() => setChoice("custom")}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Something else…"
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-card px-2 py-0.5"
            />
          </label>
          {categoriesDiffer && (
            <div className="flex flex-col gap-1 border-t border-dashed border-[var(--border)] pt-2">
              <span className="text-[var(--muted)]">
                Different categories: {current.categoryName ?? "Uncategorized"} ·{" "}
                {other.categoryName ?? "Uncategorized"}
              </span>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[var(--muted)]">Set all charges to</span>
                <select
                  value={unifyCat === "asis" ? "asis" : String(unifyCat)}
                  onChange={(e) => setUnifyCat(e.target.value === "asis" ? "asis" : Number(e.target.value))}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-card px-2 py-1"
                >
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon} {c.name}
                    </option>
                  ))}
                  <option value="asis">Leave as-is</option>
                </select>
              </div>
            </div>
          )}
          <div className="text-[var(--muted)]">
            {current.count + other.count} charges combined · you can split them apart anytime
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={reset} className="rounded-lg px-2 py-1 text-[var(--muted)]">
              Cancel
            </button>
            <button
              onClick={combine}
              className="rounded-lg bg-[var(--accent)] px-3 py-1 font-medium text-white"
            >
              Combine
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Auto vs. edited legibility: shows whether a field holds the system's detected
// value or one the user changed — so corrections are visible and trusted.
function StateTag({ edited }: { edited?: boolean }) {
  return edited ? (
    <span className="rounded-full bg-[var(--accent)]/15 px-1.5 text-[10px] font-medium text-[var(--accent)]">
      edited
    </span>
  ) : (
    <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">auto</span>
  );
}

const CADENCE_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Every 6 months",
  yearly: "Yearly",
};

// One-line correction for a misread cadence: pick the right rhythm and the
// override saves + re-derives next-due (server-side). "Auto" shows what detection
// found and clears the override. Framed as correcting a guess, not configuring.
function CadenceCorrection({
  detected,
  override,
  onSave,
}: {
  detected: string | null;
  override: string | null;
  onSave: (cadence: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label className="stat-label">Cadence</label>
        <StateTag edited={override != null} />
      </div>
      <select
        value={override ?? "__auto"}
        onChange={(e) => onSave(e.target.value === "__auto" ? null : e.target.value)}
        className="btn-ghost w-full cursor-pointer text-sm"
      >
        {/* The "auto" row shows what detection currently reads. "detected" is
            redundant with the AUTO tag above and overflowed the half-width
            select (e.g. "Auto · detected Every 6 months"), so it's dropped. */}
        <option value="__auto">
          Auto{detected ? ` · ${CADENCE_LABELS[detected] ?? detected}` : ""}
        </option>
        {Object.entries(CADENCE_LABELS).map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

// A labeled, self-evidently editable field for the merchant shelf. Uncontrolled:
// Enter or blur commits, Escape reverts. Keyed on defaultValue so a refreshed
// value (after a save elsewhere) reseeds the input. Crucially, a pending edit is
// also flushed on unmount — closing the shelf (click-outside, Esc, ✕, switching
// vendor) tears the field down before blur fires, so without this the typed
// value would be silently dropped and the list never updates.
function ShelfEditField({
  label,
  defaultValue,
  placeholder,
  prefix,
  inputMode,
  hint,
  edited,
  onCommit,
}: {
  label: string;
  defaultValue: string;
  placeholder?: string;
  prefix?: string;
  inputMode?: "decimal";
  hint?: string;
  edited?: boolean;
  onCommit: (value: string) => void;
}) {
  const reverted = useRef(false);
  const committed = useRef(defaultValue); // last value we've already sent on
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (value: string) => {
    committed.current = value;
    onCommit(value);
  };

  // Flush on unmount: hold the node from mount time (the ref may be detached by
  // the time cleanup runs) and commit if the live value is an uncommitted edit.
  useEffect(() => {
    const el = inputRef.current;
    return () => {
      if (!reverted.current && el && el.value !== committed.current) onCommit(el.value);
    };
    // Mount/unmount only — capturing the node at mount is the point; re-running
    // on every onCommit identity change would defeat the flush-on-teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label className="stat-label">{label}</label>
        <StateTag edited={edited} />
      </div>
      <div className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-[var(--accent)]/30">
        {prefix && <span className="shrink-0 text-sm text-[var(--muted)]">{prefix}</span>}
        <input
          key={defaultValue}
          ref={inputRef}
          defaultValue={defaultValue}
          placeholder={placeholder}
          inputMode={inputMode}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              reverted.current = true;
              e.currentTarget.value = defaultValue;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            if (reverted.current) {
              reverted.current = false;
              return;
            }
            commit(e.target.value);
          }}
          className="w-full bg-transparent text-sm focus:outline-none"
        />
      </div>
      {hint && <span className="text-[10px] text-[var(--muted)]">{hint}</span>}
    </div>
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
