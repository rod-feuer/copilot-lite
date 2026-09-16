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
import { useMutation } from "@/components/useMutation";
import { InlineEdit, CommitInput } from "@/components/InlineEdit";
import { RecurringGlyph, RECURRING_LABEL, recurringState, type RecurringState } from "@/components/RecurringGlyph";
import { Money } from "@/components/Money";
import { rowButtonProps, ROW_FOCUS } from "@/components/rowButton";
import { Tooltip } from "@/components/Tooltip";
import { getJson, postJson, patchJson } from "@/lib/http";
import { merchantKey } from "@/lib/merchant";
import { LoadError } from "@/components/LoadState";
import { InfoHint } from "@/components/InfoHint";
import { usd, shortDate, shortDatePad, monthDayYear, isCurrentMonth } from "@/lib/format";
import type { MerchantSummary, CategorySummary, MatchRule } from "@/lib/queries";
import type { Category } from "@/lib/types";
import { NEW_CATEGORY, NewCategoryOption, useNewCategory } from "@/components/NewCategoryOption";

// Shapes come from the library that produces them; the aliases keep the file's
// existing names.
type Cat = Category;
type Vendor = { merchant: string; displayName: string }; // the Combine picker's projection of /api/vendors
type Summary = MerchantSummary;
type CatSummary = CategorySummary;

type OpenOpts = { onChange?: () => void; amountHint?: number | null; series?: string }; // series: one plan of a multi-plan vendor
type Target =
  | { kind: "merchant"; merchant: string; series?: string }
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
    isMerchant: (m: string, series?: string) =>
      active?.kind === "merchant" && active.merchant === m && (active.series ?? null) === (series ?? null),
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
  // A category created from a shelf dropdown joins the pickers at once.
  const addCat = useCallback((c: Cat) => setCats((cs) => [...cs, c]), []);
  // Vendors (one per canonical merchant, with display name) for the Combine picker.
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const onChange = useRef<(() => void) | undefined>(undefined);
  const asideRef = useRef<HTMLElement>(null);
  // Each handler below re-reads its own target (the merchant or the category)
  // after a write, so the shared refresh policy is "never" and the refresh
  // happens on the returned success flag.
  const mutate = useMutation();

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then(setCats);
    fetch("/api/vendors")
      .then((r) => r.json())
      .then(setVendors);
  }, []);

  // A failed shelf read shows an error with Retry instead of the skeleton —
  // `loading` below is derived from missing data, so without this flag a
  // failed fetch would pulse forever.
  const [loadError, setLoadError] = useState(false);
  // `keep`: a re-read after a write keeps the current panel on screen until
  // the new data lands — no skeleton, no scroll reset, no jump.
  const fetchMerchant = useCallback((m: string, series?: string, keep = false) => {
    if (!keep) setMData(null);
    setLoadError(false);
    getJson<Summary>(`/api/merchant?name=${encodeURIComponent(m)}${series ? `&series=${encodeURIComponent(series)}` : ""}`)
      .then(setMData)
      .catch(() => setLoadError(true));
  }, []);
  const fetchCategory = useCallback((id: number, month: string, keep = false) => {
    if (!keep) setCData(null);
    setLoadError(false);
    getJson<CatSummary>(`/api/category?id=${id}&month=${encodeURIComponent(month)}`)
      .then(setCData)
      .catch(() => setLoadError(true));
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
      if (target?.kind === "merchant" && target.merchant === m && (target.series ?? null) === (opts?.series ?? null)) {
        close();
        return;
      }
      onChange.current = opts?.onChange;
      setAmountHint(opts?.amountHint ?? null);
      setBack(null);
      setCData(null);
      setTarget({ kind: "merchant", merchant: m, series: opts?.series });
      fetchMerchant(m, opts?.series);
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
      // An in-shelf control can remove the clicked element synchronously on
      // mousedown (e.g. the combine picker closes its dropdown when you pick a
      // vendor). By the time this bubbles to window the node is detached, so a
      // contains() check would wrongly read it as an outside click and close the
      // shelf. A disconnected target came from our own re-render — never close.
      if (!el.isConnected) return;
      if (asideRef.current?.contains(el)) return;
      if (el.closest("[data-drawer-row]")) return;
      // A popover opened from a shelf control (the New-category form) is
      // portaled to <body>, outside the panel — clicking into it is not leaving.
      if (el.closest("[role='dialog']")) return;
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
    const series = target.series;
    if (
      await mutate(
        // One plan of several recategorizes only its own charges.
        () => postJson("/api/recurrings/recategorize", { merchant, categoryId, recurringId: mData?.seriesId ?? undefined }),
        { success: `Recategorized "${merchant}"`, error: "Couldn't recategorize — please try again" },
        { refresh: "never" }
      )
    ) {
      fetchMerchant(merchant, series, true);
      onChange.current?.();
    }
  }

  // Save a per-merchant override (name and/or go-forward amount) edited right in
  // the shelf, where the recent charges that justify the value are on screen.
  async function saveMerchantSettings(
    patch: {
      alias?: string | null;
      expectedAmount?: number | null;
      cadence?: string | null;
      endedDate?: string | null;
      nextDate?: string | null;
      matchMode?: "exact" | "contains" | null;
      matchText?: string | null;
      amountTolerance?: number | null;
      clear?: boolean; // reset every override (not endedDate)
    },
    message: string
  ) {
    if (target?.kind !== "merchant") return;
    const merchant = target.merchant;
    const series = target.series;
    if (
      await mutate(
        // Overrides live under the plan's key when the shelf is on one plan.
        () => postJson("/api/recurrings/settings", { merchant: mData?.settingsKey ?? merchant, ...patch }),
        { success: message, error: "Couldn't save — please try again" },
        { refresh: "never" }
      )
    ) {
      fetchMerchant(merchant, series, true);
      onChange.current?.();
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
    if (
      await mutate(
        async () => {
          await postJson("/api/recurrings/link", { alias: loser, primary });
          if (alias != null) await postJson("/api/recurrings/settings", { merchant: primary, alias });
          // Unify the category when the user chose to, so a combined vendor isn't
          // left split across categories. Recategorize covers all linked descriptors.
          if (categoryId != null)
            await postJson("/api/recurrings/recategorize", { merchant: primary, categoryId });
        },
        { success: "Vendors combined", error: "Couldn't combine — please try again" },
        { refresh: "never" }
      )
    ) {
      onChange.current?.();
      close();
    }
  }

  async function unlinkName(alias: string) {
    if (target?.kind !== "merchant") return;
    const merchant = target.merchant;
    if (
      await mutate(
        () => postJson("/api/recurrings/link", { alias, unlink: true }),
        { success: `Separated “${alias}”`, error: "Couldn't separate — please try again" },
        { refresh: "never" }
      )
    ) {
      fetchMerchant(merchant, target.series, true);
      onChange.current?.();
    }
  }

  async function toggleRecurring() {
    if (target?.kind !== "merchant" || !mData) return;
    const merchant = target.merchant;
    const series = target.series;
    const makeIt = !mData.recurring;
    if (
      await mutate(
        // "Not recurring" on one plan mutes that plan, not the vendor.
        () => postJson("/api/recurrings/override", { merchant: mData.settingsKey ?? merchant, status: makeIt ? "force" : "mute" }),
        {
          success: makeIt ? "Marked recurring" : "No longer recurring",
          error: "Couldn't update — please try again",
        },
        { refresh: "never" }
      )
    ) {
      fetchMerchant(merchant, series, true);
      onChange.current?.();
    }
  }

  // Per-transaction edits from inside the category shelf. Refresh the shelf so
  // totals/lists update (e.g. recategorizing a row out of the category).
  const refreshCategory = () => {
    if (target?.kind === "category") fetchCategory(target.categoryId, target.month, true);
  };
  // Re-read whichever detail is open after a per-charge write.
  const refreshTarget = () => {
    if (target?.kind === "category") fetchCategory(target.categoryId, target.month, true);
    else if (target?.kind === "merchant") fetchMerchant(target.merchant, target.series, true);
  };
  async function txRecategorize(txId: number, categoryId: number | null) {
    if (
      await mutate(
        () => patchJson(`/api/transactions/${txId}`, { categoryId }),
        { success: "Recategorized", error: "Couldn't recategorize — please try again" },
        { refresh: "never" }
      )
    ) {
      refreshTarget();
      onChange.current?.();
    }
  }
  // One charge in or out of its plan (a device purchase under
  // "Apple" is not the subscription). The server rebuilds detection.
  async function txSetMembership(txId: number, put: "in" | "out", plan: string | null) {
    if (
      await mutate(
        () =>
          put === "out"
            ? patchJson(`/api/transactions/${txId}`, { recurringExcluded: true })
            : patchJson(`/api/transactions/${txId}`, { recurringIncluded: plan }),
        {
          success: put === "out" ? "Charge taken out of the plan" : "Charge put in the plan",
          error: "Couldn't update — please try again",
        },
        { refresh: "never" }
      )
    ) {
      refreshTarget();
      onChange.current?.();
    }
  }
  async function txToggleRecurring(merchant: string, makeIt: boolean) {
    if (
      await mutate(
        () => postJson("/api/recurrings/override", { merchant, status: makeIt ? "force" : "mute" }),
        {
          success: makeIt ? "Marked recurring" : "No longer recurring",
          error: "Couldn't update — please try again",
        },
        { refresh: "never" }
      )
    ) {
      refreshCategory();
      onChange.current?.();
    }
  }

  const loading = target?.kind === "merchant" ? !mData : !cData;

  return (
    <Ctx.Provider value={{ openMerchant, openCategory, active: target }}>
      {children}
      {target && (
        <>
          {/* Dim backdrop on mobile (this is a bottom sheet there); the desktop
              right-side panel has none, as before. */}
          <div
            className="fixed inset-0 z-40 bg-black/30 sm:hidden"
            onClick={close}
            aria-hidden
          />
          <aside
            data-shelf
            ref={asideRef}
            // Bottom sheet on mobile (slides up, capped height, rounded top);
            // right-side panel on desktop (sm:+) exactly as before.
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88vh] flex-col rounded-t-2xl border-t border-[var(--border)] bg-card shadow-2xl sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-auto sm:h-full sm:max-h-none sm:w-full sm:max-w-sm sm:rounded-none sm:border-t-0 sm:border-l"
          >
            {/* Grab handle — bottom-sheet affordance (mobile only). */}
            <div
              className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--border)] sm:hidden"
              aria-hidden
            />
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
              className="shrink-0 rounded-md px-2 py-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
              aria-label="Close"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-y-auto p-4">
            {loadError ? (
              <LoadError
                what={target.kind === "merchant" ? "this vendor" : "this category"}
                onRetry={() =>
                  target.kind === "merchant"
                    ? fetchMerchant(target.merchant, target.series)
                    : fetchCategory(target.categoryId, target.month)
                }
              />
            ) : loading ? (
              <div className="space-y-2">
                <div className="h-16 animate-pulse rounded-xl bg-[var(--background)]" />
                <div className="h-9 animate-pulse rounded-xl bg-[var(--background)]" />
                <div className="h-40 animate-pulse rounded-xl bg-[var(--background)]" />
              </div>
            ) : target.kind === "merchant" && mData ? (
              <MerchantBody
                data={mData}
                cats={cats}
                onAddCategory={addCat}
                onRecategorize={recategorize}
                onTxSetMembership={txSetMembership}
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
                onAddCategory={addCat}
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
              className="block rounded-lg px-2 py-2 text-center text-sm font-medium text-[var(--accent)] hover:bg-[var(--hover)]"
            >
              View all transactions →
            </Link>
          </footer>
          </aside>
        </>
      )}
    </Ctx.Provider>
  );
}

// The shelf's heading name, click-to-edit in place (no separate Name field).
// Typing the underlying bank name clears the override. Commits on Enter/blur,
// reverts on Escape, and flushes on unmount so closing the shelf mid-edit keeps
// the change (same teardown guard as the property cards' CommitInput).
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
  return (
    <InlineEdit
      value={value}
      textClassName="text-sm font-semibold"
      onCommit={(raw) => {
        const v = raw.trim();
        const next = v && v !== underlying ? v : null; // editing back to the bank name = clear
        if (next !== currentAlias) onSave(next);
      }}
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
      {/* The descriptor only when a name makes it differ from the title; a
          plan says what a plan shelf needs to say — that the vendor has more. */}
      {data && data.alias != null && data.displayName !== data.merchant && (
        <div className="truncate text-[11px] text-[var(--muted)]">{data.merchant}</div>
      )}
      {data && data.series && data.plans > 1 && (
        <div className="truncate text-[11px] text-[var(--muted)]">One of {data.plans} plans under this vendor</div>
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
              <Tooltip label="The bank names grouped under this vendor" onlyIfTruncated={false}>
                <button
                  onClick={() => setShowNames((s) => !s)}
                  className="underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
                >
                  {data.nameVariants} names {showNames ? "▾" : "▸"}
                </button>
              </Tooltip>
            </>
          ) : null}
        </div>
      )}
      {data && showNames && data.names.length > 1 && (
        <ul className="mt-2 flex flex-col divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {data.names.map((n) => (
            <li key={n.name} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
              <Tooltip label={n.name} className="min-w-0 flex-1 truncate">
                {n.name}
              </Tooltip>
              <span className="shrink-0 tabular-nums text-[var(--muted)]">{n.count}</span>
              {n.canUnlink ? (
                <Tooltip
                  label="Separate this name back into its own vendor"
                  onlyIfTruncated={false}
                  className="inline-flex shrink-0"
                >
                  <button
                    onClick={() => onUnlink(n.name)}
                    className="rounded px-1 text-[var(--muted)] hover:text-rose-500"
                  >
                    ✕
                  </button>
                </Tooltip>
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
  onAddCategory,
  onRecategorize,
  onTxSetMembership,
  onToggleRecurring,
  onSaveSettings,
  amountHint,
  vendors,
  onCombine,
}: {
  data: Summary;
  cats: Cat[];
  onAddCategory: (c: Cat) => void;
  onRecategorize: (categoryId: number | null) => void;
  onTxSetMembership: (txId: number, put: "in" | "out", plan: string | null) => void;
  onToggleRecurring: () => void;
  onSaveSettings: (
    patch: {
      alias?: string | null;
      expectedAmount?: number | null;
      cadence?: string | null;
      endedDate?: string | null;
      nextDate?: string | null;
      matchMode?: "exact" | "contains" | null;
      matchText?: string | null;
      amountTolerance?: number | null;
      clear?: boolean; // reset every override (not endedDate)
    },
    message: string
  ) => void;
  amountHint?: number | null;
  vendors: Vendor[];
  onCombine: (loser: string, primary: string, alias?: string, categoryId?: number | null) => void;
}) {
  // "+ New category…" in the Category field: create it here and apply it.
  const newCat = useNewCategory<null>((cat) => {
    onAddCategory(cat);
    onRecategorize(cat.id);
  });
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
  // What varies across the Recent rows, if anything: the descriptor (shown as
  // the part after the names' shared prefix, so three "Healthy Paws Pet Ins…"
  // don't all truncate alike), else the category.
  const rowText = (() => {
    // Descriptors count as different only when their vendor keys differ —
    // genuinely different labels ("Central In Academy" / "Central Indiana
    // Academ"), not one label with and without a trailing "Payment". Shown
    // whole; a trimmed tail ("…Il Payment") read as junk.
    const keys = new Set(data.recent.map((r) => merchantKey(r.merchant)));
    const categories = new Set(data.recent.map((r) => r.categoryName ?? "Uncategorized"));
    if (keys.size > 1) return (r: { merchant: string }) => r.merchant;
    if (categories.size > 1) return (r: { categoryName: string | null }) => r.categoryName ?? "Uncategorized";
    return () => undefined;
  })();
  const boxes = d
    ? [
        { label: "per charge", value: usd(d.perCharge, { cents: false }) },
        { label: "per year", value: usd(d.annualized, { cents: false }) },
        { label: "next due", value: shortDate(d.nextDate) },
      ]
    : [
        { label: "last 12 mo", value: usd(data.trailing12, { cents: false }) },
        { label: "per active mo", value: usd(data.trailing12 / monthsActive, { cents: false }) },
        { label: "txns / 12mo", value: String(data.count12) },
      ];
  if (data.received > 0)
    boxes.push({ label: "received, all time", value: usd(data.received, { cents: false }) });

  return (
    <div className="flex flex-col gap-4">
      {d ? (
        <>
          {/* The plan's properties, each a stat that IS its editor: one fact,
              one place. Per charge edits the expected amount; next due edits
              the date; the cadence select sits on the caption line with the
              per-year figure it drives. */}
          {/* Date on the left, amount on the right — the rows' order. */}
          <div className="grid grid-cols-2 gap-2">
            <PropertyCard label="Next due" edited={data.nextDate != null}>
              {/* The app writes dates as "Sep 18"; the native picker (its own
                  locale format) is laid transparently over that and opens on
                  click. */}
              <span className="relative flex items-center justify-between">
                <span className="text-sm font-semibold tabular-nums">{shortDate(data.nextDate ?? d.nextDate)}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--muted)]" aria-hidden>
                  <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
                </svg>
                <input
                  type="date"
                  aria-label="Next due"
                  value={data.nextDate ?? d.nextDate ?? ""}
                  onClick={(e) => (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.()}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "" || v === d.nextDate) onSaveSettings({ nextDate: null }, "Next due reset to auto");
                    else if (v !== data.nextDate) onSaveSettings({ nextDate: v }, "Next due updated");
                  }}
                  className="absolute inset-0 w-full cursor-pointer opacity-0"
                />
              </span>
            </PropertyCard>
            <PropertyCard label="Per charge" edited={data.expectedAmount != null}>
              <div className="flex items-center">
                <span className="text-sm font-semibold text-[var(--muted)]">$</span>
                <CommitInput
                  key={data.expectedAmount != null ? data.expectedAmount.toFixed(2) : ""}
                  defaultValue={data.expectedAmount != null ? data.expectedAmount.toFixed(2) : ""}
                  placeholder={detectedAmount != null ? detectedAmount.toFixed(2) : "amount"}
                  inputMode="decimal"
                  aria-label="Expected amount"
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
                  className="w-full min-w-0 bg-transparent text-sm font-semibold tabular-nums placeholder:font-semibold placeholder:text-[var(--foreground)] focus:outline-none"
                />
              </div>
            </PropertyCard>
          </div>
          {/* The plan's other properties on one line: category, cadence (the
              value first, its auto/edited state beside it, like the cards), and
              the per-year figure the cadence drives. */}
          <div className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
            <CaptionSelect
              label={data.categoryId != null ? `${data.categoryIcon ?? ""} ${data.categoryName ?? ""}`.trim() : "Uncategorized"}
              value={data.categoryId ?? ""}
              aria-label="Category"
              onChange={(e) => {
                if (e.target.value === NEW_CATEGORY) {
                  newCat.open(e.currentTarget, null, `New category for ${data.displayName}`);
                  return;
                }
                onRecategorize(e.target.value ? Number(e.target.value) : null);
              }}
            >
              <option value="">Uncategorized</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon} {c.name}
                </option>
              ))}
              <NewCategoryOption />
            </CaptionSelect>
            {newCat.popover}
            {/* Items are separated by space, not dots: a wrap can then never
                strand a separator at either end of a line. */}
            <span className="inline-flex items-center whitespace-nowrap">
              <CaptionSelect
                label={(data.cadence ?? data.detectedCadence) ? CADENCE_LABELS[data.cadence ?? data.detectedCadence ?? ""] ?? (data.cadence ?? data.detectedCadence ?? "") : "Auto"}
                tag={<StateTag edited={data.cadence != null} />}
                aria-label="Cadence"
                value={data.cadence ?? "__auto"}
                onChange={(e) => onSaveSettings({ cadence: e.target.value === "__auto" ? null : e.target.value }, e.target.value === "__auto" ? "Cadence reset to auto" : "Cadence updated")}
              >
                <option value="__auto">{data.detectedCadence ? `${CADENCE_LABELS[data.detectedCadence] ?? data.detectedCadence} (auto)` : "Auto"}</option>
                {Object.entries(CADENCE_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </CaptionSelect>
            </span>
            <span className="whitespace-nowrap">{usd(d.annualized, { cents: false })} per year expected</span>
            {data.received > 0 && (
              <span className="whitespace-nowrap">{usd(data.received, { cents: false })} received all time</span>
            )}
          </div>
        </>
      ) : (
        <div className={`grid gap-2 text-center ${boxes.length > 3 ? "grid-cols-2" : "grid-cols-3"}`}>
          {boxes.map((b) => (
            <Metric key={b.label} label={b.label} value={b.value} />
          ))}
        </div>
      )}

      {!d && (
        <>
          <div className="grid grid-cols-1 gap-2">
          <PropertyCard label="Expected" edited={data.expectedAmount != null}>
            <div className="flex items-center">
              <span className="text-sm font-semibold text-[var(--muted)]">$</span>
              <CommitInput
                key={data.expectedAmount != null ? data.expectedAmount.toFixed(2) : ""}
                defaultValue={data.expectedAmount != null ? data.expectedAmount.toFixed(2) : ""}
                placeholder={detectedAmount != null ? detectedAmount.toFixed(2) : "amount"}
                inputMode="decimal"
                aria-label="Expected amount"
                onCommit={(v) => {
                  const t = v.trim();
                  if (t === "") {
                    if (data.expectedAmount != null) onSaveSettings({ expectedAmount: null }, "Expected amount cleared");
                    return;
                  }
                  const n = Math.abs(Number(t));
                  if (!Number.isFinite(n)) return;
                  if (n !== (data.expectedAmount ?? null)) onSaveSettings({ expectedAmount: n }, "Expected amount updated");
                }}
                className="w-full min-w-0 bg-transparent text-sm font-semibold tabular-nums placeholder:font-semibold placeholder:text-[var(--foreground)] focus:outline-none"
              />
            </div>
          </PropertyCard>
          </div>
          <div className="-mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--muted)]">
            <CaptionSelect
              label={data.categoryId != null ? `${data.categoryIcon ?? ""} ${data.categoryName ?? ""}`.trim() : "Uncategorized"}
              value={data.categoryId ?? ""}
              aria-label="Category"
              onChange={(e) => {
                if (e.target.value === NEW_CATEGORY) {
                  newCat.open(e.currentTarget, null, `New category for ${data.displayName}`);
                  return;
                }
                onRecategorize(e.target.value ? Number(e.target.value) : null);
              }}
            >
              <option value="">Uncategorized</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon} {c.name}
                </option>
              ))}
              <NewCategoryOption />
            </CaptionSelect>
            {newCat.popover}
          </div>
        </>
      )}

      {data.priceChange && (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
          {data.priceChange.to > data.priceChange.from ? "↑" : "↓"} price changed{" "}
          {usd(data.priceChange.from)} → {usd(data.priceChange.to)} since{" "}
          {monthDayYear(data.priceChange.since)}
        </div>
      )}

      {/* Evidence before controls: the shelf exists to edit a vendor where its
          charges are on screen, so the charges come first. */}
      <div>
        <div className="stat-label mb-1.5">Recent</div>
        {/* Each charge carries one two-state pill — "In plan" / "Not in
            plan" — and clicking always flips it. An "edited" tag beside it
            says the user decided (took it out, or put in a charge the
            detector left out); no tag means the detector did (a device
            purchase under "Apple" is not the subscription). No menu:
            recategorizing a single charge is the Transactions tab's job.
            The text slot shows only what VARIES across these rows — the
            descriptor a charge posted under, else its category — and nothing
            when every row would say the same thing. */}
        {/* No box: the list sits on the panel's edges like the titles and the
            by-year figures, so dates and amounts share one edge all the way
            down. Only the property cards are boxes. */}
        <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]" data-edge-list>
          {data.recent.map((r) => (
            <ShelfRow
              key={r.id}
              date={r.date}
              name={rowText(r)}
              amount={r.amount}
              muted={r.excluded === 1}
              excluded={!!r.excluded || !!r.categoryExcluded}
              recurring={recurringState(r)}
              // A charge excluded from totals was never eligible for a plan;
              // it carries no membership control, just what it is.
              membership={
                r.excluded === 1
                  ? undefined
                  : {
                      kind: "charge",
                      edited: r.recurringExcluded === 1 || r.recurringIncluded === 1,
                      onToggle: () => onTxSetMembership(r.id, r.recurringId != null ? "out" : "in", data.planKey),
                    }
              }
              note={r.excluded === 1 ? "not counted" : undefined}
              flush
              unsignedDebits
            />
          ))}
        </ul>
        {/* The continuation sits where the list ends, not at the panel's foot. */}
        {data.count > data.recent.length && (
          <Link
            href={`/transactions?vendor=${encodeURIComponent(data.merchant)}`}
            className="mt-2 inline-block text-[11px] font-medium text-[var(--accent)] hover:underline"
          >
            {data.series ? "All this vendor's charges →" : `Show all ${data.count} →`}
          </Link>
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
                  {/* A partial year says so — the honesty rule for figures mid-flight. */}
                  <span className="w-[4.6rem] shrink-0 text-[var(--muted)]">
                    {y.year}
                    {y.year === String(new Date().getUTCFullYear()) ? " so far" : ""}
                  </span>
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

      {/* A divider ranks the corrections a tier below the evidence — things
          you reach for occasionally, not every visit. */}
      <div className="border-t border-[var(--border)]" />

      <div className="flex flex-col gap-3">
        {/* One labelled row for the rare control, with Reset on its line. */}
        {data.recurring ? (
          <MatchCorrection
            key={JSON.stringify(data.matchRule)}
            rule={data.matchRule}
            trailing={
              data.hasSettings && (
                <button
                  type="button"
                  onClick={() => onSaveSettings({ clear: true }, "Overrides reset")}
                  className="text-xs text-[var(--muted)] hover:text-rose-500"
                >
                  Reset all overrides
                </button>
              )
            }
            onSave={(r) =>
              onSaveSettings(
                r
                  ? { matchMode: r.matchMode, matchText: r.matchText, amountTolerance: r.amountTolerance }
                  : { matchMode: null, matchText: null, amountTolerance: null },
                r ? "Match rule updated" : "Match rule reset to auto"
              )
            }
          />
        ) : (
          data.hasSettings && (
            <button
              type="button"
              onClick={() => onSaveSettings({ clear: true }, "Overrides reset")}
              className="self-start text-xs text-[var(--muted)] hover:text-rose-500"
            >
              Reset all overrides
            </button>
          )
        )}

        {data.recurring && data.ended && (
          <Tooltip
            label="Marked ended — no longer counts as upcoming or expected"
            onlyIfTruncated={false}
            className="inline-flex self-start rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600"
          >
            Ended{data.endedDate ? ` ${shortDate(data.endedDate)}` : ""}
          </Tooltip>
        )}
        {/* One actions row, one style: the §2 verbs. Combine is a disclosure —
            its panel drops below the row only while in use. */}
        <div className="flex gap-2">
          <button onClick={onToggleRecurring} className="btn-ghost flex-1 text-xs">
            {data.recurring ? "Not recurring" : "Make recurring"}
          </button>
          {data.recurring &&
            (data.ended ? (
              <button
                onClick={() => onSaveSettings({ endedDate: null }, "Reactivated")}
                className="btn-ghost flex-1 text-xs"
              >
                Reactivate
              </button>
            ) : (
              <button
                onClick={() => onSaveSettings({ endedDate: new Date().toISOString().slice(0, 10) }, "Marked ended")}
                className="btn-ghost flex-1 text-xs"
              >
                Mark as ended
              </button>
            ))}
          <button
            onClick={() => setCombining((v) => !v)}
            className={`btn-ghost flex-1 text-xs ${combining ? "text-[var(--accent)]" : ""}`}
          >
            Combine
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
    </div>
  );
}

function CategoryBody({
  data,
  cats,
  onAddCategory,
  onOpenMerchant,
  onTxRecategorize,
  onTxToggleRecurring,
}: {
  data: CatSummary;
  cats: Cat[];
  onAddCategory: (c: Cat) => void;
  onOpenMerchant: (merchant: string) => void;
  onTxRecategorize: (txId: number, categoryId: number | null) => void;
  onTxToggleRecurring: (merchant: string, makeIt: boolean) => void;
}) {
  const isIncome = data.kind === "income";
  const isExcluded = data.excludeFromTotals === 1;
  const budgeted = data.budget != null && !isIncome && !isExcluded;

  // Card 1 — how much.
  // Mid-month, "spent" and the trend compare a partial month with full ones.
  const partial = isCurrentMonth(data.month);
  const card1 = {
    label: `${isIncome ? "received" : isExcluded ? "total" : "spent"}${partial ? " so far" : ""}`,
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
    label: partial ? "so far vs last mo" : "vs last mo",
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
                recurring="in"
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
                muted={t.excluded === 1}
                excluded={isExcluded}
                recurring={recurringState(t)}
                onClick={() => onOpenMerchant(t.merchant)}
                editable={{
                  cats,
                  onAddCategory,
                  onRecategorize: (cid) => onTxRecategorize(t.id, cid),
                }}
                membership={{ kind: "vendor", onToggle: () => onTxToggleRecurring(t.merchant, t.recurringId == null) }}
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
  onAddCategory: (c: Cat) => void;
  onRecategorize: (categoryId: number | null) => void;
};
// The row's membership control: a labelled pill that says its state and
// toggles it. "charge": this charge in or out of its plan (the vendor shelf).
// "vendor": the whole vendor recurring or not (the category shelf).
type Membership = { kind: "charge" | "vendor"; onToggle: () => void; edited?: boolean };
function ShelfRow({
  date,
  name,
  amount,
  sign,
  muted,
  excluded,
  recurring = "none",
  onClick,
  editable,
  membership,
  flush = false,
  unsignedDebits = false,
  note,
}: {
  date: string;
  name?: string; // omitted when every row in the list would say the same thing
  amount: number;
  sign?: boolean;
  muted?: boolean;
  excluded?: boolean; // doesn't count toward totals → an inflow is not green
  recurring?: RecurringState;
  onClick?: () => void;
  editable?: RowEdit; // the ⋯ editor (recategorize) — the category shelf only
  membership?: Membership;
  flush?: boolean; // no horizontal padding: the list sits on the panel's edges
  unsignedDebits?: boolean; // a plan's charges are debits by definition — no minus on every row
  note?: string; // quiet text in the pill's slot when there is no control (e.g. "not counted")
}) {
  const [editing, setEditing] = useState(false);
  // "+ New category…" in the row's Recategorize picker.
  const newCat = useNewCategory<null>((cat) => {
    editable?.onAddCategory(cat);
    editable?.onRecategorize(cat.id);
    setEditing(false);
  });
  return (
    <li>
      <div
        {...(onClick ? rowButtonProps(onClick) : {})}
        className={`group flex w-full items-center gap-2 py-2 text-xs ${flush ? "" : "px-3"} ${
          onClick ? `cursor-pointer hover:bg-[var(--hover)] ${ROW_FOCUS}` : ""
        }`}
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {/* The glyph gutter belongs to lists without a membership pill (the
              shelf's Upcoming list); a flush list never renders it, or its
              rows would indent by the gutter when a row has no pill. */}
          {flush || membership ? null : recurring !== "none" ? (
            <Tooltip label={RECURRING_LABEL[recurring]} onlyIfTruncated={false} className="w-3.5 shrink-0">
              <RecurringGlyph state={recurring} muted={muted} className="block w-full text-center" />
            </Tooltip>
          ) : (
            <span className="w-3.5 shrink-0" aria-hidden />
          )}
          <span className="w-11 shrink-0 tabular-nums text-[var(--muted)]">{shortDatePad(date)}</span>
          {name && (
            <Tooltip
              label={name}
              className={`truncate font-medium ${muted ? "text-[var(--muted)]" : ""}`}
            >
              {name}
            </Tooltip>
          )}
        </span>
        {!membership && note && <span className="shrink-0 text-[11px] text-[var(--muted)]">{note}</span>}
        {membership &&
          // One two-state pill beside the amount, auto width so the date /
          // name columns keep their edges and the amount stays flush right.
          // Clicking always flips the state; an "edited" tag says the user
          // decided it.
          (() => {
            const inPlan = recurring === "in";
            const text =
              membership.kind === "charge"
                ? inPlan ? "In plan" : "Not in plan"
                : inPlan ? "Recurring" : "Not recurring";
            const action =
              membership.kind === "charge"
                ? inPlan ? "Take this charge out of the plan" : "Put this charge in the plan"
                : inPlan ? "Mark vendor not recurring" : "Mark vendor recurring";
            // Quiet for the default (in) — every row would say it; a charge
            // the user took out wears amber, the one state they chose to
            // notice; what the detector left out on its own is plain grey.
            const edited = !!membership.edited;
            const tone = inPlan
              ? "border border-[var(--border)] text-[var(--muted)] opacity-40 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
              : edited && membership.kind === "charge"
                ? "bg-amber-500/15 text-amber-600 hover:bg-amber-500/25"
                : "bg-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]";
            return (
              <span className="flex shrink-0 items-center gap-1">
                {edited && <StateTag edited />}
                <button
                  type="button"
                  data-membership={recurring}
                  data-edited={edited ? "1" : undefined}
                  aria-label={action}
                  title={action}
                  onClick={(e) => {
                    e.stopPropagation();
                    membership.onToggle();
                  }}
                  className={`shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium transition-colors ${tone}`}
                >
                  {text}
                </button>
              </span>
            );
          })()}
        {/* A fixed amount column, so a pill beside it lands on one edge in every row. */}
        {muted ? (
          <span className="w-20 shrink-0 text-right tabular-nums text-[var(--muted)]">
            {usd(unsignedDebits && amount < 0 ? -amount : amount, { sign: !!sign })}
          </span>
        ) : unsignedDebits && amount < 0 ? (
          <span className="w-20 shrink-0 text-right tabular-nums text-[var(--foreground)]">{usd(-amount)}</span>
        ) : (
          <Money value={amount} sign={!!sign || (unsignedDebits && amount > 0)} excluded={excluded} className="w-20 shrink-0 text-right" />
        )}
        {editable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditing((v) => !v);
            }}
            className={`w-5 shrink-0 rounded text-[var(--muted)] transition-opacity hover:text-[var(--foreground)] focus:opacity-100 ${
              editing ? "opacity-100" : "opacity-60 focus-visible:opacity-100 group-hover:opacity-100"
            }`}
            aria-label="Edit transaction"
          >
            ⋯
          </button>
        )}
      </div>
      {editable && editing && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs"
        >
          <select
            defaultValue="__p"
            aria-label="Recategorize"
            onChange={(e) => {
              const v = e.target.value;
              if (v === NEW_CATEGORY) {
                newCat.open(e.currentTarget, null, `New category for ${name}`);
                return;
              }
              editable.onRecategorize(v === "none" ? null : Number(v));
              setEditing(false);
            }}
            className="select-caret cursor-pointer appearance-none rounded-lg border border-[var(--border)] bg-card py-1 pl-2 pr-8"
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
            <NewCategoryOption />
          </select>
          {newCat.popover}
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
                      className="block w-full px-2 py-1.5 text-left leading-snug hover:bg-[var(--hover)]"
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
                  className="select-caret min-w-0 flex-1 cursor-pointer appearance-none rounded-lg border border-[var(--border)] bg-card py-1 pl-2 pr-8"
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
    <span className="rounded-full bg-[var(--accent)]/15 px-1.5 text-[11px] font-medium text-[var(--accent)]">
      edited
    </span>
  ) : (
    <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">auto</span>
  );
}

const CADENCE_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Every 6 months",
  yearly: "Yearly",
};


// Match correction: how a charge is recognised as this bill. Auto = exact
// vendor, or the vendor's category + amount. "contains" widens it to any
// descriptor containing the text; the tolerance bounds the amount.
// A "contains" rule is incomplete until it has text (the route drops one without),
// so the mode is held locally and saved only once the rule is whole: Auto and
// "exact" save at once; "contains" saves when its text is entered. The parent
// remounts this on every server change (key), so local state never goes stale.
function MatchCorrection({
  rule,
  onSave,
  trailing,
}: {
  rule: MatchRule | null;
  onSave: (rule: MatchRule | null) => void;
  trailing?: ReactNode; // e.g. "Reset all overrides", on the label line
}) {
  const [mode, setMode] = useState<string>(rule?.matchMode ?? "");
  const [text, setText] = useState(rule?.matchText ?? "");
  const [tol, setTol] = useState(rule ? (rule.amountTolerance == null ? "any" : String(rule.amountTolerance)) : "0.05");
  const complete = (m: string, t: string) => m === "exact" || (m === "contains" && t.trim() !== "");
  const save = (m: string, t: string, tl: string) => {
    if (!m) return onSave(null);
    if (!complete(m, t)) return; // wait for the text
    onSave({ matchMode: m as "exact" | "contains", matchText: m === "contains" ? t.trim() : null, amountTolerance: tl === "any" ? null : Number(tl) });
  };
  const sel = "btn-ghost select-caret cursor-pointer appearance-none pr-8 text-sm";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label className="stat-label">Match</label>
        <StateTag edited={rule != null} />
        <InfoHint text="How a charge is recognised as this bill. Auto: the vendor exactly, or the same vendor under a relabeled descriptor within 5% of the amount. A rule widens or narrows that." />
        {trailing && <span className="ml-auto">{trailing}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Match rule" value={mode} onChange={(e) => { setMode(e.target.value); save(e.target.value, text, tol); }} className={sel}>
          <option value="">vendor exactly, or relabeled within 5%</option>
          <option value="exact">vendor exactly</option>
          <option value="contains">descriptor contains…</option>
        </select>
        {mode === "contains" && (
          <input
            aria-label="Match text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => save(mode, text, tol)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            placeholder="text in the description"
            className="btn-ghost min-w-0 flex-1 text-sm"
          />
        )}
        {mode && (
          <select aria-label="Amount tolerance" value={tol} onChange={(e) => { setTol(e.target.value); save(mode, text, e.target.value); }} className={sel}>
            <option value="0.05">±5%</option>
            <option value="0.1">±10%</option>
            <option value="0.25">±25%</option>
            <option value="any">any amount</option>
          </select>
        )}
      </div>
    </div>
  );
}



// A select on a caption line: a visible label with its caret right beside it
// (a native select sizes to its widest option, which strands the caret), and
// the real <select> laid transparently over the label — still native, still
// keyboard, caret visible. The same pattern the recurrings row uses.
function CaptionSelect({ label, tag, className = "", children, ...select }: { label: string; tag?: ReactNode; className?: string; children: ReactNode } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex max-w-[11rem] items-center gap-0.5 rounded-md py-0.5 pl-1 pr-1 text-[11px] font-medium text-[var(--foreground)] hover:bg-[var(--hover)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]/40 ${className}`.trim()}>
      <span className="truncate">{label}</span>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--muted)]" aria-hidden>
        <path d="M6 9l6 6 6-6" />
      </svg>
      {tag && <span className="ml-1 shrink-0">{tag}</span>}
      <select {...select} className="absolute inset-0 w-full cursor-pointer opacity-0">
        {children}
      </select>
    </span>
  );
}

// A stat that is its own editor: the value on top, the label and its
// auto/edited state beneath, in the same box the read-only metrics use.
function PropertyCard({ label, edited, children }: { label: string; edited?: boolean; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-[var(--background)] px-3 py-2 focus-within:ring-2 focus-within:ring-[var(--accent)]/30">
      {children}
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</span>
        {/* Only properties with a detected value carry an auto/edited state. */}
        {edited !== undefined && <StateTag edited={edited} />}
      </div>
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
      <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
    </div>
  );
}
