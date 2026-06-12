"use client";

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import Shell from "@/components/Shell";
import { MonthPicker, ImportButton } from "@/components/Actions";
import { useToast } from "@/components/Toast";
import { useTxDrawer, useShelfActive } from "@/components/TransactionDrawer";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { MergeQueue } from "@/components/MergeQueue";
import { NameCleanupQueue } from "@/components/NameCleanupQueue";
import { CategorizeQueue } from "@/components/CategorizeQueue";
import { SearchBox } from "@/components/SearchBox";
import { postJson, patchJson } from "@/lib/http";
import { usd, longDate, shortDate, defaultMonth } from "@/lib/format";

type Tx = {
  id: number;
  date: string;
  merchant: string;
  displayName: string;
  amount: number;
  account: string;
  source: string;
  excluded: 0 | 1;
  effectiveDate: string | null;
  recurringId: number | null;
  recurringExcluded: 0 | 1; // user flagged this charge as a one-off
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  categoryExcluded: number;
  note: string | null;
};

type Cat = { id: number; name: string; color: string; icon: string; kind: string };

type Filters = {
  month: string;
  cat: string;
  q: string;
  vendor: string;
  type: string;
  account: string;
  minAmount: string;
  maxAmount: string;
  recurring: string;
  sort: string;
  dir: string;
};

// Render the list in pages of this many rows, appending more as the user scrolls
// (or via "Show more"). Caps the initial React mount regardless of match count —
// a single month or a 10k-row all-history search both mount one page first.
const PAGE = 60;

export default function TransactionsPage() {
  const [months, setMonths] = useState<string[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [txs, setTxs] = useState<Tx[]>([]);
  // How many rows are currently mounted (incremental rendering — see PAGE).
  const [visibleCount, setVisibleCount] = useState(PAGE);
  // Review-queue widgets are deferred to after first paint so their fetches
  // (esp. the ~155ms merge scan) don't compete with the list on load.
  const [showQueues, setShowQueues] = useState(false);
  const [editingDateId, setEditingDateId] = useState<number | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  // Which row's category <select> has its full option list mounted. At rest a
  // row renders only its current value (1 option), not all ~27 categories — so a
  // long month builds ~1 option/row instead of ~28, the page's main render cost.
  const [activeCatSelect, setActiveCatSelect] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [month, setMonth] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [q, setQ] = useState("");
  // Search is otherwise scoped to the selected month, so a typed query would
  // silently miss anything outside it. When a search begins we widen to all
  // months (stashing where we were); clearing the search snaps back — unless
  // the user manually narrowed to a month mid-search, which we respect.
  const monthBeforeSearch = useRef<string | null>(null);
  function search(value: string) {
    const had = q.length > 0;
    const has = value.length > 0;
    if (!had && has) {
      monthBeforeSearch.current = month;
      setMonth("");
    } else if (had && !has) {
      if (month === "" && monthBeforeSearch.current) setMonth(monthBeforeSearch.current);
      monthBeforeSearch.current = null;
    }
    setQ(value);
  }
  const [vendor, setVendor] = useState(""); // deep-link only (from the drawer)
  const [type, setType] = useState("");
  const [account, setAccount] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [recurring, setRecurring] = useState(""); // "", "yes", "no"
  const [sort, setSort] = useState("date");
  const [dir, setDir] = useState("desc");
  const [added, setAdded] = useState<string[]>([]); // filters explicitly added but maybe not yet valued
  const [menuOpen, setMenuOpen] = useState(false);
  // Gate the URL←→filter sync until the initial deep-link has been read, so the
  // sync never wipes the incoming params before loadStatic applies them.
  const [ready, setReady] = useState(false);
  const toast = useToast();
  const openTx = useTxDrawer();
  const shelfActive = useShelfActive();
  useSyncedRefresh(() => setRefreshKey((k) => k + 1));

  const loadStatic = useCallback(async () => {
    const [ms, cs, accts] = await Promise.all([
      fetch("/api/months").then((r) => r.json()),
      fetch("/api/categories").then((r) => r.json()),
      fetch("/api/accounts").then((r) => r.json()),
    ]);
    setMonths(ms);
    setCats(cs);
    setAccounts(accts);
    // Honor deep-links from the dashboard, e.g. /transactions?month=2026-05&category=35
    // or ?type=expense or ?q=Chubb. Each present param pre-applies its filter.
    const params = new URLSearchParams(window.location.search);
    // A vendor deep-link (from the drawer's "View all transactions") or a search
    // deep-link spans history, so default to all months unless a month was given.
    const wide = !!params.get("vendor") || !!params.get("q");
    setMonth(
      (cur) => cur || params.get("month") || (wide ? "" : defaultMonth(ms))
    );
    const apply = (key: string, setter: (v: string) => void) => {
      const v = params.get(key);
      if (v) setter(v);
    };
    apply("category", setCatFilter);
    apply("type", setType);
    apply("account", setAccount);
    apply("q", setQ);
    apply("vendor", setVendor);
    apply("recurring", setRecurring);
    apply("minAmount", setMinAmount);
    apply("maxAmount", setMaxAmount);
    setReady(true);
  }, []);

  const load = useCallback(async (f: Filters) => {
    const p = new URLSearchParams();
    if (f.month) p.set("month", f.month);
    if (f.cat) p.set("category", f.cat);
    if (f.q) p.set("q", f.q);
    if (f.vendor) p.set("vendor", f.vendor);
    if (f.type) p.set("type", f.type);
    if (f.account) p.set("account", f.account);
    if (f.minAmount) p.set("minAmount", f.minAmount);
    if (f.maxAmount) p.set("maxAmount", f.maxAmount);
    if (f.recurring) p.set("recurring", f.recurring);
    p.set("sort", f.sort);
    p.set("dir", f.dir);
    const data = await fetch(`/api/transactions?${p}`).then((r) => r.json());
    setTxs(data);
    setVisibleCount(PAGE); // new result set → start from the first page
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStatic();
  }, [loadStatic]);

  // Defer the review-queue widgets until the browser is idle after first paint,
  // so the list renders first and the queues' fetches (esp. the merge scan)
  // don't contend on load.
  useEffect(() => {
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const reveal = () => setShowQueues(true);
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(reveal);
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(reveal, 200);
    return () => clearTimeout(id);
  }, []);

  // Append the next page of rows when the bottom sentinel scrolls into view —
  // incremental rendering without mounting the whole result set up front.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= txs.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisibleCount((c) => c + PAGE);
      },
      { rootMargin: "600px" } // start loading before it's actually visible
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visibleCount, txs.length]);

  // Debounced reload whenever any filter (or a forced refresh) changes.
  useEffect(() => {
    const t = setTimeout(
      () =>
        load({
          month,
          cat: catFilter,
          q,
          vendor,
          type,
          account,
          minAmount,
          maxAmount,
          recurring,
          sort,
          dir,
        }),
      200
    );
    return () => clearTimeout(t);
  }, [month, catFilter, q, vendor, type, account, minAmount, maxAmount, recurring, sort, dir, refreshKey, load]);

  // Keep the browser URL in sync with the live filters, so clearing a filter
  // (e.g. the Uncategorized deep-link) actually sticks across reloads and a
  // plain /transactions nav starts clean. Replace (not push) to avoid history
  // spam. sort/dir stay out — they're view prefs, not deep-linkable filters.
  useEffect(() => {
    if (!ready) return;
    const p = new URLSearchParams();
    if (month) p.set("month", month);
    if (catFilter) p.set("category", catFilter);
    if (q) p.set("q", q);
    if (vendor) p.set("vendor", vendor);
    if (type) p.set("type", type);
    if (account) p.set("account", account);
    if (minAmount) p.set("minAmount", minAmount);
    if (maxAmount) p.set("maxAmount", maxAmount);
    if (recurring) p.set("recurring", recurring);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [ready, month, catFilter, q, vendor, type, account, minAmount, maxAmount, recurring]);

  // Handlers are stabilized with useCallback so the memoized TxRow only
  // re-renders when its own data/flags change — not on every keystroke or
  // optimistic edit elsewhere in the list. (setTxs/setRefreshKey/setEditingDateId
  // and toast are stable; cats is the only mutable dep, and it changes rarely.)
  const setCategory = useCallback(
    async (id: number, categoryId: number | null) => {
      setTxs((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                categoryId,
                categoryName: cats.find((c) => c.id === categoryId)?.name ?? null,
                categoryColor: cats.find((c) => c.id === categoryId)?.color ?? null,
                categoryIcon: cats.find((c) => c.id === categoryId)?.icon ?? null,
              }
            : t
        )
      );
      try {
        await patchJson(`/api/transactions/${id}`, { categoryId });
      } catch {
        toast("Couldn't save category — please try again", "error");
        setRefreshKey((k) => k + 1); // re-sync the optimistic update from the server
      }
    },
    [cats, toast]
  );

  // Set/clear a transaction's free-text note. Empty clears it. Optimistic, with
  // a server re-sync on failure (same pattern as setCategory).
  const saveNote = useCallback(
    async (id: number, raw: string) => {
      const note = raw.trim() || null;
      setTxs((prev) => prev.map((t) => (t.id === id ? { ...t, note } : t)));
      try {
        await patchJson(`/api/transactions/${id}`, { note });
      } catch {
        toast("Couldn't save note — please try again", "error");
        setRefreshKey((k) => k + 1);
      }
    },
    [toast]
  );

  // Set/clear a transaction's effective (accounting) date. Equal to the posted
  // date or empty means clear the override.
  const commitDate = useCallback(
    async (t: Tx, value: string | null) => {
      setEditingDateId(null);
      const eff = !value || value === t.date ? null : value;
      if (eff === (t.effectiveDate ?? null)) return;
      try {
        await patchJson(`/api/transactions/${t.id}`, { effectiveDate: eff });
      } catch {
        toast("Couldn't update date — please try again", "error");
      }
      setRefreshKey((k) => k + 1);
    },
    [toast]
  );

  // Recurring control. A charge that's part of a recurring can be flagged as a
  // one-off (per transaction); a flagged one can be added back; and a merchant
  // with no recurring at all can be forced recurring (merchant-level). All
  // persist across re-scans.
  const toggleRecurring = useCallback(
    async (t: Tx) => {
      try {
        if (t.recurringId != null) {
          await patchJson(`/api/transactions/${t.id}`, { recurringExcluded: true });
          toast("Excluded this charge from the recurring", "success");
        } else if (t.recurringExcluded) {
          await patchJson(`/api/transactions/${t.id}`, { recurringExcluded: false });
          toast("Added this charge back to the recurring", "success");
        } else {
          await postJson("/api/recurrings/override", { merchant: t.merchant, status: "force" });
          toast(`Marked "${t.merchant}" recurring`, "success");
        }
        setRefreshKey((k) => k + 1);
      } catch {
        toast("Couldn't update — please try again", "error");
      }
    },
    [toast]
  );

  const onOpenRow = useCallback(
    (merchant: string) => openTx(merchant, { onChange: () => setRefreshKey((k) => k + 1) }),
    [openTx]
  );

  // Net mirrors Copilot: excluded rows (incl. internal transfers) don't count.
  const total = useMemo(
    () => txs.reduce((a, t) => a + (t.excluded || t.categoryExcluded ? 0 : t.amount), 0),
    [txs]
  );

  // Only the first `visibleCount` rows are mounted; the rest append on scroll.
  // Grouping/headers operate on the visible slice; `total` (above) stays over the
  // full match set so the header figure is correct regardless of how much is shown.
  const visibleTxs = useMemo(() => txs.slice(0, visibleCount), [txs, visibleCount]);
  const hasMore = visibleCount < txs.length;

  // Group the list under day headers when it's in date order (the rows are
  // already date-sorted by the server, so consecutive runs share a day). Other
  // sorts (amount, merchant) stay a flat list — a date header would be nonsense.
  const grouping = sort === "date";
  const grouped = useMemo(() => {
    if (!grouping) return [{ key: "__all", label: "", total: 0, rows: visibleTxs }];
    const out: { key: string; label: string; total: number; rows: Tx[] }[] = [];
    for (const t of visibleTxs) {
      const day = t.effectiveDate ?? t.date;
      let g = out[out.length - 1];
      if (!g || g.key !== day) {
        g = { key: day, label: dayLabel(day), total: 0, rows: [] };
        out.push(g);
      }
      g.rows.push(t);
      if (!(t.excluded || t.categoryExcluded)) g.total += t.amount;
    }
    return out;
  }, [visibleTxs, grouping]);

  // Statement mode: when the vendor filter is active, every row is the same
  // merchant — and usually the same category/account. Collapse that constant
  // identity into one header and let the rows read like a statement (date ·
  // amount), surfacing category/account only on the charges that break the
  // pattern. `modal` holds the vendor's most-common values (null = normal mode).
  const modal = useMemo(() => {
    if (vendor === "" || txs.length === 0) return null;
    const catCount = new Map<string, number>();
    const acctCount = new Map<string, number>();
    for (const t of txs) {
      const ck = String(t.categoryId ?? "none");
      catCount.set(ck, (catCount.get(ck) ?? 0) + 1);
      acctCount.set(t.account, (acctCount.get(t.account) ?? 0) + 1);
    }
    const topCat = [...catCount].sort((a, b) => b[1] - a[1])[0]?.[0];
    const topAcct = [...acctCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const rep = txs.find((t) => String(t.categoryId ?? "none") === topCat) ?? txs[0];
    return {
      displayName: txs[0].displayName,
      categoryId: rep.categoryId,
      categoryName: rep.categoryName,
      categoryColor: rep.categoryColor,
      categoryIcon: rep.categoryIcon,
      account: topAcct,
      count: txs.length,
      total: txs.reduce((a, t) => a + t.amount, 0),
    };
  }, [vendor, txs]);

  // Linear-style filters: a filter shows as a chip only when active (has a
  // value) or explicitly added from the "+ Filter" menu. The menu lists the rest.
  const FILTERS = [
    { id: "category", label: "Category" },
    { id: "type", label: "Type" },
    { id: "account", label: "Account" },
    { id: "amount", label: "Amount" },
    { id: "recurring", label: "Recurring" },
  ];
  const isActive = (id: string) =>
    id === "category"
      ? catFilter !== ""
      : id === "type"
      ? type !== ""
      : id === "account"
      ? account !== ""
      : id === "amount"
      ? minAmount !== "" || maxAmount !== ""
      : id === "recurring"
      ? recurring !== ""
      : false;
  const shown = (id: string) => isActive(id) || added.includes(id);
  function removeFilter(id: string) {
    setAdded((a) => a.filter((x) => x !== id));
    if (id === "category") setCatFilter("");
    if (id === "type") setType("");
    if (id === "account") setAccount("");
    if (id === "amount") {
      setMinAmount("");
      setMaxAmount("");
    }
    if (id === "recurring") setRecurring("");
  }
  const chipSelect = "max-w-40 cursor-pointer bg-transparent text-xs focus:outline-none";

  return (
    <Shell
      title="Transactions"
      subtitle={`${txs.length} shown · net ${usd(total, { sign: true })}`}
      actions={
        <>
          <MonthPicker months={months} value={month} onChange={setMonth} allowAll />
          <ImportButton onDone={() => loadStatic().then(() => setRefreshKey((k) => k + 1))} />
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={search} placeholder="Search merchant or amount…" />

        {vendor && (
          <Chip onRemove={() => setVendor("")}>
            <span className="max-w-40 truncate text-xs">
              Vendor: <span className="font-medium">{vendor}</span>
            </span>
          </Chip>
        )}
        {shown("category") && (
          <Chip onRemove={() => removeFilter("category")}>
            <select
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}
              className={chipSelect}
            >
              <option value="">Category…</option>
              <option value="none">Uncategorized</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon} {c.name}
                </option>
              ))}
            </select>
          </Chip>
        )}
        {shown("type") && (
          <Chip onRemove={() => removeFilter("type")}>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className={chipSelect}
            >
              <option value="">Type…</option>
              <option value="expense">Expenses</option>
              <option value="income">Income</option>
            </select>
          </Chip>
        )}
        {shown("account") && (
          <Chip onRemove={() => removeFilter("account")}>
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className={chipSelect}
            >
              <option value="">Account…</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Chip>
        )}
        {shown("amount") && (
          <Chip onRemove={() => removeFilter("amount")}>
            <input
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value)}
              placeholder="min $"
              inputMode="decimal"
              className="w-14 bg-transparent text-xs focus:outline-none"
            />
            <span className="text-[var(--muted)]">–</span>
            <input
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value)}
              placeholder="max $"
              inputMode="decimal"
              className="w-14 bg-transparent text-xs focus:outline-none"
            />
          </Chip>
        )}
        {shown("recurring") && (
          <Chip onRemove={() => removeFilter("recurring")}>
            <select
              value={recurring}
              onChange={(e) => setRecurring(e.target.value)}
              className={chipSelect}
            >
              <option value="">Recurring…</option>
              <option value="yes">Recurring</option>
              <option value="no">One-time</option>
            </select>
          </Chip>
        )}

        {FILTERS.some((f) => !shown(f.id)) && (
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="rounded-lg border border-dashed border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              + Filter
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute left-0 z-20 mt-1 w-40 rounded-xl border border-[var(--border)] bg-card p-1 shadow-[0_4px_16px_rgba(16,24,40,0.12)]">
                  {FILTERS.filter((f) => !shown(f.id)).map((f) => (
                    <button
                      key={f.id}
                      onClick={() => {
                        setAdded((a) => [...a, f.id]);
                        setMenuOpen(false);
                      }}
                      className="block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-[var(--background)]"
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <select
          value={`${sort}-${dir}`}
          onChange={(e) => {
            const [s, d] = e.target.value.split("-");
            setSort(s);
            setDir(d);
          }}
          className="btn-ghost ml-auto cursor-pointer text-sm"
        >
          <option value="date-desc">Newest</option>
          <option value="date-asc">Oldest</option>
          <option value="amount-desc">Largest amount</option>
          <option value="amount-asc">Smallest amount</option>
          <option value="merchant-asc">Merchant A–Z</option>
        </select>
      </div>

      {showQueues && (
        <>
          <CategorizeQueue onChange={() => loadStatic().then(() => setRefreshKey((k) => k + 1))} />

          <NameCleanupQueue onChange={() => loadStatic().then(() => setRefreshKey((k) => k + 1))} />

          <MergeQueue onChange={() => loadStatic().then(() => setRefreshKey((k) => k + 1))} />
        </>
      )}

      <div className="card overflow-hidden">
        {txs.length === 0 ? (
          <p className="p-8 text-center text-sm text-[var(--muted)]">
            No transactions match.
          </p>
        ) : (
          <>
            {modal && (
              <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--background)] px-4 py-3">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg"
                  style={{ background: (modal.categoryColor ?? "#94a3b8") + "22" }}
                >
                  {modal.categoryIcon ?? "•"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{modal.displayName}</div>
                  <div className="truncate text-xs text-[var(--muted)]">
                    {modal.count} transaction{modal.count === 1 ? "" : "s"} ·{" "}
                    {modal.categoryName ?? "Uncategorized"}
                    {modal.account ? ` · ${modal.account}` : ""}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold tabular-nums">
                    {usd(modal.total, { sign: true })}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
                    total
                  </div>
                </div>
              </div>
            )}
            <ul className="divide-y divide-[var(--border)]">
            {grouped.map((g) => {
              // Only group under a day header when the day actually has more than
              // one transaction — otherwise the header + its subtotal just echo the
              // single row below it. Solo-charge days show the date inline instead.
              const headed = grouping && g.rows.length > 1;
              return (
              <Fragment key={g.key}>
                {headed && (
                  <li className="flex items-center justify-between bg-[var(--background)] px-4 py-1.5">
                    <span className="text-xs font-semibold text-[var(--muted)]">{g.label}</span>
                    <span className="text-xs tabular-nums text-[var(--muted)]">
                      {usd(g.total, { sign: true })}
                    </span>
                  </li>
                )}
                {g.rows.map((t) => (
                  <TxRow
                    key={t.id}
                    t={t}
                    modal={modal}
                    headed={headed}
                    isEditingDate={editingDateId === t.id}
                    isEditingNote={editingNoteId === t.id}
                    isCatActive={activeCatSelect === t.id}
                    isShelfActive={shelfActive.isMerchant(t.merchant)}
                    cats={cats}
                    onOpen={onOpenRow}
                    setEditingDateId={setEditingDateId}
                    setEditingNoteId={setEditingNoteId}
                    setActiveCatSelect={setActiveCatSelect}
                    onCommitDate={commitDate}
                    onSaveNote={saveNote}
                    onToggleRecurring={toggleRecurring}
                    onSetCategory={setCategory}
                  />
                ))}
              </Fragment>
              );
            })}
          </ul>
          {hasMore && (
            // Sentinel: scrolling near here auto-loads the next page. The button
            // is the keyboard/no-IntersectionObserver fallback and a clear count.
            <div
              ref={sentinelRef}
              className="flex items-center justify-center border-t border-[var(--border)] p-3"
            >
              <button
                onClick={() => setVisibleCount((c) => c + PAGE)}
                className="text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] hover:underline"
              >
                Show more · {txs.length - visibleCount} of {txs.length} remaining
              </button>
            </div>
          )}
          </>
        )}
      </div>
    </Shell>
  );
}

// One transaction row, memoized so an edit or keystroke elsewhere in the list
// doesn't re-render every row. Receives per-row flags (computed by the parent
// from a single piece of state, e.g. isEditingDate) and stable
// callbacks, so React.memo's shallow compare actually skips unaffected rows.
const TxRow = memo(function TxRow({
  t,
  modal,
  headed,
  isEditingDate,
  isEditingNote,
  isCatActive,
  isShelfActive,
  cats,
  onOpen,
  setEditingDateId,
  setEditingNoteId,
  setActiveCatSelect,
  onCommitDate,
  onSaveNote,
  onToggleRecurring,
  onSetCategory,
}: {
  t: Tx;
  modal: { categoryId: number | null; account: string } | null;
  headed: boolean;
  isEditingDate: boolean;
  isEditingNote: boolean;
  isCatActive: boolean;
  isShelfActive: boolean;
  cats: Cat[];
  onOpen: (merchant: string) => void;
  setEditingDateId: Dispatch<SetStateAction<number | null>>;
  setEditingNoteId: Dispatch<SetStateAction<number | null>>;
  setActiveCatSelect: Dispatch<SetStateAction<number | null>>;
  onCommitDate: (t: Tx, value: string | null) => void;
  onSaveNote: (id: number, raw: string) => void;
  onToggleRecurring: (t: Tx) => void;
  onSetCategory: (id: number, categoryId: number | null) => void;
}) {
  const sameCat =
    modal && String(t.categoryId ?? "none") === String(modal.categoryId ?? "none");
  const sameAcct = modal && t.account === modal.account;
  const recState = t.recurringId != null ? "in" : t.recurringExcluded ? "out" : "none";
  const commitDate = onCommitDate;
  const saveNote = onSaveNote;
  const toggleRecurring = onToggleRecurring;
  const setCategory = onSetCategory;
  return (
              <li
                data-drawer-row
                onClick={() => onOpen(t.merchant)}
                // content-visibility lets the browser skip layout + paint for rows
                // scrolled off-screen — virtualizing the render without unmounting
                // (so Cmd-F, scroll position, and a11y still work). The intrinsic
                // size is an estimate that keeps the scrollbar stable.
                style={{ contentVisibility: "auto", containIntrinsicSize: "auto 56px" }}
                className={`group flex cursor-pointer items-center gap-3 px-4 py-3 ${
                  isShelfActive
                    ? "bg-[var(--accent)]/10"
                    : "hover:bg-[var(--background)]"
                } ${t.excluded ? "opacity-55" : ""}`}
              >
                {!modal && (
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                    style={{ background: (t.categoryColor ?? "#94a3b8") + "22" }}
                  >
                    {t.categoryIcon ?? "•"}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {modal ? (
                    <>
                      <div className="flex items-center gap-2">
                        {isEditingDate ? (
                          <input
                            type="date"
                            defaultValue={t.effectiveDate ?? t.date}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => commitDate(t, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") setEditingDateId(null);
                            }}
                            className="rounded border border-[var(--border)] bg-card px-1 py-0.5 text-sm"
                          />
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingDateId(t.id);
                            }}
                            className="text-sm font-medium hover:underline"
                            title="Edit effective date"
                          >
                            {longDate(t.effectiveDate ?? t.date)}
                          </button>
                        )}
                        {t.excluded ? (
                          <span className="pill shrink-0 bg-[var(--background)] text-[10px] text-[var(--muted)]">
                            excluded
                          </span>
                        ) : null}
                      </div>
                      {(!sameAcct || (t.effectiveDate && t.effectiveDate !== t.date)) && (
                        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--muted)]">
                          {!sameAcct && <span>{t.account}</span>}
                          {t.effectiveDate && t.effectiveDate !== t.date && (
                            <span className="text-amber-600">
                              {!sameAcct ? "· " : ""}posted {shortDate(t.date)}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  commitDate(t, null);
                                }}
                                className="ml-1 hover:text-[var(--foreground)]"
                                title="Revert to posted date"
                              >
                                ↺
                              </button>
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{t.displayName}</span>
                    {t.excluded ? (
                      <span className="pill shrink-0 bg-[var(--background)] text-[10px] text-[var(--muted)]">
                        excluded
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--muted)]">
                    {headed ? (
                      <>
                        <span>{t.account}</span>
                        {t.effectiveDate && t.effectiveDate !== t.date && (
                          <span className="text-amber-600">
                            · posted {shortDate(t.date)}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                commitDate(t, null);
                              }}
                              className="ml-1 hover:text-[var(--foreground)]"
                              title="Revert to posted date"
                            >
                              ↺
                            </button>
                          </span>
                        )}
                        {isEditingDate ? (
                          <span className="inline-flex items-center gap-1">
                            ·
                            <input
                              type="date"
                              defaultValue={t.effectiveDate ?? t.date}
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                              onBlur={(e) => commitDate(t, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") e.currentTarget.blur();
                                if (e.key === "Escape") setEditingDateId(null);
                              }}
                              className="rounded border border-[var(--border)] bg-card px-1 py-0.5"
                            />
                          </span>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingDateId(t.id);
                            }}
                            className="hidden hover:text-[var(--foreground)] hover:underline group-hover:inline"
                            title="Set effective date"
                          >
                            · edit date
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        {isEditingDate ? (
                          <input
                            type="date"
                            defaultValue={t.effectiveDate ?? t.date}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => commitDate(t, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") setEditingDateId(null);
                            }}
                            className="rounded border border-[var(--border)] bg-card px-1 py-0.5"
                          />
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingDateId(t.id);
                            }}
                            className="hover:text-[var(--foreground)] hover:underline"
                            title="Edit effective date"
                          >
                            {longDate(t.effectiveDate ?? t.date)}
                          </button>
                        )}
                        {t.effectiveDate && t.effectiveDate !== t.date && (
                          <span className="text-amber-600">
                            · posted {shortDate(t.date)}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                commitDate(t, null);
                              }}
                              className="ml-1 hover:text-[var(--foreground)]"
                              title="Revert to posted date"
                            >
                              ↺
                            </button>
                          </span>
                        )}
                        <span>· {t.account}</span>
                      </>
                    )}
                    {/* Empty-note affordance lives INLINE in the meta row (like
                        "edit date") so revealing it on hover never changes the
                        row height — avoids list-wide jitter as the pointer moves. */}
                    {!t.note && !isEditingNote && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingNoteId(t.id);
                        }}
                        title="Add a note"
                        className="hidden hover:text-[var(--foreground)] hover:underline group-hover:inline"
                      >
                        · + note
                      </button>
                    )}
                  </div>
                  {/* A set note (or the editor) takes its own line below — that's
                      persistent content, not a hover reveal, so it doesn't jitter. */}
                  {isEditingNote ? (
                    <input
                      autoFocus
                      defaultValue={t.note ?? ""}
                      placeholder="What was this for?"
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        saveNote(t.id, e.target.value);
                        setEditingNoteId(null);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setEditingNoteId(null);
                      }}
                      className="mt-0.5 w-full max-w-md rounded border border-[var(--border)] bg-card px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/40"
                    />
                  ) : t.note ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingNoteId(t.id);
                      }}
                      title="Edit note"
                      className="mt-0.5 flex max-w-full items-baseline gap-1 text-left text-xs italic text-[var(--muted)] hover:text-[var(--foreground)]"
                    >
                      <span className="shrink-0 not-italic opacity-70">✎</span>
                      <span className="truncate">{t.note}</span>
                    </button>
                  ) : null}
                    </>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRecurring(t);
                  }}
                  title={
                    recState === "in"
                      ? "Part of a recurring — click to exclude this charge"
                      : recState === "out"
                        ? "Excluded from the recurring — click to add it back"
                        : "Make recurring"
                  }
                  className={`shrink-0 rounded-md px-1.5 py-1 text-sm transition-opacity ${
                    recState === "in"
                      ? "text-[var(--accent)]"
                      : recState === "out"
                        ? "text-[var(--muted)] line-through opacity-70 hover:opacity-100"
                        : "text-[var(--muted)] opacity-0 hover:bg-[var(--background)] group-hover:opacity-100"
                  }`}
                >
                  ↻
                </button>
                {(!modal || !sameCat) && (
                <select
                  value={t.categoryId ?? ""}
                  onClick={(e) => e.stopPropagation()}
                  // Mount the full option list before the native menu opens
                  // (mousedown/focus both fire first); React flushes the update
                  // synchronously for these discrete events, so the options are
                  // present when the dropdown appears.
                  onMouseDown={() => setActiveCatSelect(t.id)}
                  onFocus={() => setActiveCatSelect(t.id)}
                  onBlur={() => setActiveCatSelect((cur) => (cur === t.id ? null : cur))}
                  onChange={(e) =>
                    setCategory(t.id, e.target.value ? Number(e.target.value) : null)
                  }
                  title="Category"
                  className={`max-w-[9rem] shrink-0 cursor-pointer appearance-none truncate rounded-full px-2.5 py-1 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 ${
                    t.categoryId != null
                      ? "text-[var(--foreground)] group-hover:ring-1 group-hover:ring-inset group-hover:ring-[var(--border)]"
                      : "border border-dashed border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                  style={
                    t.categoryId != null
                      ? { background: (t.categoryColor ?? "#94a3b8") + "22" }
                      : undefined
                  }
                >
                  {isCatActive ? (
                    <>
                      <option value="">Uncategorized</option>
                      {cats.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.icon} {c.name}
                        </option>
                      ))}
                    </>
                  ) : t.categoryId != null ? (
                    // At rest: just the current value, so the pill shows correctly.
                    <option value={t.categoryId}>
                      {t.categoryIcon ? `${t.categoryIcon} ` : ""}
                      {t.categoryName}
                    </option>
                  ) : (
                    <option value="">Uncategorized</option>
                  )}
                </select>
                )}
                <div
                  className={`w-24 text-right text-sm font-semibold ${
                    t.amount >= 0 ? "text-emerald-600" : "text-[var(--foreground)]"
                  }`}
                >
                  {usd(t.amount, { sign: true })}
                </div>
              </li>
  );
});

// Day-group header label, e.g. "Saturday, June 6". UTC to match the stored dates.
function dayLabel(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Active-filter chip: an inline control + a remove (✕). Shown only for applied
// filters, so the toolbar stays calm until you opt into complexity (Linear-style).
function Chip({
  children,
  onRemove,
}: {
  children: ReactNode;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-card py-1 pl-2.5 pr-1 text-xs">
      {children}
      <button
        onClick={onRemove}
        className="rounded px-1 text-[var(--muted)] hover:bg-[var(--background)] hover:text-[var(--foreground)]"
        aria-label="Remove filter"
      >
        ✕
      </button>
    </span>
  );
}
