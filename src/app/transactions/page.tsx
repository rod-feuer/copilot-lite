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
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import Shell from "@/components/Shell";
import { MonthPicker, ImportButton } from "@/components/Actions";
import { useToast } from "@/components/Toast";
import { useTxDrawer, useShelfActive } from "@/components/TransactionDrawer";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { MergeQueue } from "@/components/MergeQueue";
import { NameCleanupQueue } from "@/components/NameCleanupQueue";
import { CategorizeQueue } from "@/components/CategorizeQueue";
import { SearchBox } from "@/components/SearchBox";
import { Tooltip } from "@/components/Tooltip";
import { postJson, patchJson } from "@/lib/http";
import { usd, longDate, shortDate, defaultMonth } from "@/lib/format";
import { createLatestGuard } from "@/lib/latestGuard";

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
  // txs accumulates the pages fetched so far (server-side pagination). count/net
  // describe the FULL filtered set (the header figures), since the list is paged.
  const [txs, setTxs] = useState<Tx[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [netTotal, setNetTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false); // synchronous guard against double-fetch
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

  // Query string for one page of the current filter set.
  const buildTxQuery = useCallback((f: Filters, offset: number) => {
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
    // A vendor (statement) view is bounded — load it whole so its totals and
    // grouping are exact. Otherwise page the list server-side.
    if (!f.vendor) {
      p.set("limit", String(PAGE));
      if (offset) p.set("offset", String(offset));
    }
    return p.toString();
  }, []);

  // Latest filters + loaded count, so loadMore (fired from the scroll observer)
  // always pages the current view without re-subscribing on every render.
  const filtersRef = useRef<Filters | null>(null);
  const loadedCountRef = useRef(0);
  useEffect(() => {
    loadedCountRef.current = txs.length;
  }, [txs.length]);

  // "Latest wins" guard (see lib/latestGuard): every page-1 load supersedes prior
  // tokens, and each fetch applies its result only if its token is still current —
  // so an out-of-order page-1 response, or a loadMore still in flight when the
  // filter changes, is discarded instead of corrupting a newer result set.
  const guardRef = useRef(createLatestGuard());

  // Page 1: replace the list and capture the full-set count + net total. Retries
  // a transient failure (a just-started dev route, a network blip) so the first
  // load self-recovers instead of leaving an empty list that needs a manual
  // refresh. The gen-guard keeps a retry from clobbering a newer load.
  const load = useCallback(
    (f: Filters) => {
      filtersRef.current = f;
      const token = guardRef.current.begin(); // one token for this load + its retries
      const run = async (attempt: number): Promise<void> => {
        if (!guardRef.current.isCurrent(token)) return; // a newer load superseded this one
        try {
          const res = await fetch(`/api/transactions?${buildTxQuery(f, 0)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!guardRef.current.isCurrent(token)) return;
          setTxs(data.rows ?? []);
          setTotalCount(data.count ?? data.rows?.length ?? 0);
          setNetTotal(data.net ?? 0);
        } catch {
          // Transient failure (cold dev route / blip) → retry, so the first load
          // self-recovers instead of leaving an empty list that needs a refresh.
          if (guardRef.current.isCurrent(token) && attempt < 2) {
            setTimeout(() => run(attempt + 1), 500);
          }
        }
      };
      void run(0);
    },
    [buildTxQuery]
  );

  // Append the next page. Guarded (ref) so overlapping scroll triggers can't
  // double-fetch, and tied to the current load generation so a page that resolves
  // after a filter change is dropped rather than appended under the new filter.
  const loadMore = useCallback(async () => {
    const f = filtersRef.current;
    if (!f || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const token = guardRef.current.current(); // ride the current result set
    try {
      const data = await fetch(
        `/api/transactions?${buildTxQuery(f, loadedCountRef.current)}`
      ).then((r) => r.json());
      if (!guardRef.current.isCurrent(token)) return; // filters changed mid-flight — discard
      setTxs((prev) => [...prev, ...(data.rows ?? [])]);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [buildTxQuery]);

  useEffect(() => {
    // Retry a transient first-load failure (a just-started dev route / network
    // blip) so the page self-recovers instead of needing a manual refresh; give
    // up gracefully after a few tries so the rest of the page still works.
    let cancelled = false;
    let tries = 0;
    const go = () => {
      loadStatic().catch(() => {
        if (cancelled) return;
        if (tries++ < 2) setTimeout(go, 500);
        else setReady(true);
      });
    };
    go();
    return () => {
      cancelled = true;
    };
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

  // Fetch the next page when the bottom sentinel scrolls into view.
  const hasMore = txs.length < totalCount;
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "600px" } // start loading before it's actually visible
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

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

  // Recurring control — VENDOR-level (the row's common intent): is this vendor a
  // recurring bill? `force` marks the whole vendor recurring; `mute` makes the
  // whole series not-recurring (and the route clears any stale per-charge
  // exclusions, so no "excluded from the series" ghost lingers). Per-charge
  // one-off exclusion is a finer operation that belongs on the vendor shelf.
  const setRecurringVendor = useCallback(
    async (t: Tx, recurring: boolean) => {
      try {
        await postJson("/api/recurrings/override", {
          merchant: t.merchant,
          status: recurring ? "force" : "mute",
        });
        toast(recurring ? `Marked "${t.merchant}" recurring` : `"${t.merchant}" not recurring`, "success");
        setRefreshKey((k) => k + 1);
      } catch {
        toast("Couldn't update — please try again", "error");
      }
    },
    [toast]
  );

  // Per-charge recurring exclusion — the FINER counterpart to the vendor-level
  // toggle above: keep the vendor's series, but drop (or re-add) this one charge
  // as a one-off (e.g. a double payment). Only offered when the charge is already
  // in/out of a series (the ⋯ menu gates on recState), so it can't create a ghost
  // "excluded" marker on a vendor that isn't recurring at all. The server re-runs
  // detection, so refresh to pick up the new recurringId.
  const setChargeRecurring = useCallback(
    async (t: Tx, excluded: boolean) => {
      try {
        await patchJson(`/api/transactions/${t.id}`, { recurringExcluded: excluded });
        toast(excluded ? "Charge excluded from its series" : "Charge added back to its series", "success");
        setRefreshKey((k) => k + 1);
      } catch {
        toast("Couldn't update — please try again", "error");
      }
    },
    [toast]
  );

  // Exclude/include a single charge from all totals (the per-transaction
  // counterpart to a category's exclude-from-totals). Optimistic for instant
  // pill + day-subtotal feedback; refresh to resync the header net (server-side).
  const setExcluded = useCallback(
    async (t: Tx, excluded: boolean) => {
      setTxs((prev) => prev.map((x) => (x.id === t.id ? { ...x, excluded: excluded ? 1 : 0 } : x)));
      try {
        await patchJson(`/api/transactions/${t.id}`, { excluded });
        toast(excluded ? "Excluded from totals" : "Included in totals", "success");
        setRefreshKey((k) => k + 1);
      } catch {
        toast("Couldn't update — please try again", "error");
        setRefreshKey((k) => k + 1);
      }
    },
    [toast]
  );

  // The charge being split (drives the split dialog). null = closed.
  const [splitTx, setSplitTx] = useState<Tx | null>(null);

  const onOpenRow = useCallback(
    (merchant: string) => openTx(merchant, { onChange: () => setRefreshKey((k) => k + 1) }),
    [openTx]
  );

  // Group the list under day headers when it's in date order (the rows are
  // already date-sorted by the server, so consecutive runs share a day). Other
  // sorts (amount, merchant) stay a flat list — a date header would be nonsense.
  // Grouping operates on the loaded pages; the header's net/count come from the
  // server (netTotal/totalCount) and span the full filtered set.
  const grouping = sort === "date";
  const grouped = useMemo(() => {
    if (!grouping) return [{ key: "__all", label: "", total: 0, rows: txs }];
    const out: { key: string; label: string; total: number; rows: Tx[] }[] = [];
    for (const t of txs) {
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
  }, [txs, grouping]);

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
  const chipSelect =
    "max-w-40 cursor-pointer appearance-none select-caret bg-transparent pr-5 text-xs focus:outline-none";

  return (
    <Shell
      title="Transactions"
      subtitle={`${totalCount} shown · net ${usd(netTotal, { sign: true })}`}
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
          className="btn-ghost select-caret ml-auto cursor-pointer appearance-none pr-8 text-sm"
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
                    onSetRecurring={setRecurringVendor}
                    onSetChargeRecurring={setChargeRecurring}
                    onToggleExcluded={setExcluded}
                    onSplit={setSplitTx}
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
                onClick={loadMore}
                disabled={loadingMore}
                className="text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] hover:underline disabled:opacity-50"
              >
                {loadingMore
                  ? "Loading…"
                  : `Show more · ${totalCount - txs.length} of ${totalCount} remaining`}
              </button>
            </div>
          )}
          </>
        )}
      </div>
      {splitTx && (
        <SplitDialog
          tx={splitTx}
          cats={cats}
          onClose={() => setSplitTx(null)}
          onDone={() => {
            setSplitTx(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </Shell>
  );
}

// The row's always-visible "⋯" — one anchor for the actions that used to be
// hover-gated (set date, add/edit note, recurring toggle), so they're reachable
// without hover and on touch (DESIGN.md §1 Anchor, §3 Reach). The menu is
// PORTALED to document.body: the row uses content-visibility (paint containment)
// which would clip an in-row popover. Fixed-positioned from the button's rect and
// closed on scroll/resize/outside-click/Escape (it can't follow a scroll).
function RowActionsMenu({
  recState,
  hasNote,
  hasDateOverride,
  excluded,
  canSplit,
  onSetDate,
  onEditNote,
  onSetRecurring,
  onSetChargeRecurring,
  onToggleExcluded,
  onSplit,
}: {
  recState: "in" | "out" | "none";
  hasNote: boolean;
  hasDateOverride: boolean;
  excluded: boolean;
  canSplit: boolean;
  onSetDate: () => void;
  onEditNote: () => void;
  onSetRecurring: (recurring: boolean) => void;
  onSetChargeRecurring: (excluded: boolean) => void;
  onToggleExcluded: (excluded: boolean) => void;
  onSplit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: globalThis.MouseEvent) => {
      const node = e.target as Node;
      if (btnRef.current?.contains(node) || menuRef.current?.contains(node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", close, true); // any ancestor scroll
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(e: ReactMouseEvent) {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  }

  // Vendor-level: if the vendor has any recurring relationship (in/out), offer to
  // make the whole vendor not-recurring; otherwise offer to mark it recurring.
  const isRecurring = recState !== "none";

  const item = (label: string, fn: () => void) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        fn();
      }}
      className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--background)]"
    >
      {label}
    </button>
  );
  const divider = <div className="my-1 border-t border-[var(--border)]" />;

  return (
    <>
      <Tooltip label="More actions" onlyIfTruncated={false} className="shrink-0">
        <button
          ref={btnRef}
          onClick={toggle}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={open}
          className={`rounded-md px-1.5 py-1 text-base leading-none transition-colors hover:bg-[var(--background)] hover:text-[var(--foreground)] ${
            open ? "bg-[var(--background)] text-[var(--foreground)]" : "text-[var(--muted)]"
          }`}
        >
          ⋯
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            onClick={(e) => e.stopPropagation()}
            style={{ position: "fixed", top: pos.top, right: pos.right }}
            className="z-50 w-48 rounded-xl border border-[var(--border)] bg-card p-1 shadow-lg"
          >
            {item(hasDateOverride ? "Change date" : "Set date", onSetDate)}
            {item(hasNote ? "Edit note" : "Add note", onEditNote)}
            {canSplit && item("Split…", onSplit)}
            {divider}
            {item(isRecurring ? "Not recurring" : "Mark recurring", () =>
              onSetRecurring(!isRecurring)
            )}
            {/* Per-charge series exclusion — only when the vendor IS a series, so
                it can't strand a ghost marker on a non-recurring vendor. */}
            {recState === "in" && item("Exclude this charge", () => onSetChargeRecurring(true))}
            {recState === "out" && item("Add charge to series", () => onSetChargeRecurring(false))}
            {divider}
            {item(excluded ? "Include in totals" : "Exclude from totals", () =>
              onToggleExcluded(!excluded)
            )}
          </div>,
          document.body
        )}
    </>
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
  onSetRecurring,
  onSetChargeRecurring,
  onToggleExcluded,
  onSplit,
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
  onSetRecurring: (t: Tx, recurring: boolean) => void;
  onSetChargeRecurring: (t: Tx, excluded: boolean) => void;
  onToggleExcluded: (t: Tx, excluded: boolean) => void;
  onSplit: (t: Tx) => void;
  onSetCategory: (id: number, categoryId: number | null) => void;
}) {
  const sameCat =
    modal && String(t.categoryId ?? "none") === String(modal.categoryId ?? "none");
  const sameAcct = modal && t.account === modal.account;
  const recState = t.recurringId != null ? "in" : t.recurringExcluded ? "out" : "none";
  const commitDate = onCommitDate;
  const saveNote = onSaveNote;
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
                          <Tooltip label="Edit effective date" onlyIfTruncated={false}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingDateId(t.id);
                              }}
                              className="text-sm font-medium hover:underline"
                            >
                              {longDate(t.effectiveDate ?? t.date)}
                            </button>
                          </Tooltip>
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
                              <Tooltip label="Revert to posted date" onlyIfTruncated={false} className="ml-1">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    commitDate(t, null);
                                  }}
                                  className="hover:text-[var(--foreground)]"
                                >
                                  ↺
                                </button>
                              </Tooltip>
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{t.displayName}</span>
                    {/* Passive recurring marker — glanceable state; the toggle
                        lives in the ⋯ menu (so the icon isn't a cryptic control). */}
                    {recState !== "none" && (
                      <Tooltip
                        label={
                          recState === "in"
                            ? "Part of a recurring series"
                            : "Excluded from its recurring series"
                        }
                        onlyIfTruncated={false}
                        className="shrink-0"
                      >
                        <span
                          className={`text-xs ${
                            recState === "in"
                              ? "text-[var(--accent)]"
                              : "text-[var(--muted)] line-through"
                          }`}
                        >
                          ↻
                        </span>
                      </Tooltip>
                    )}
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
                            <Tooltip label="Revert to posted date" onlyIfTruncated={false} className="ml-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  commitDate(t, null);
                                }}
                                className="hover:text-[var(--foreground)]"
                              >
                                ↺
                              </button>
                            </Tooltip>
                          </span>
                        )}
                        {/* Date editing is reached via the row's ⋯ menu (Set date);
                            the inline editor still renders here when active. */}
                        {isEditingDate && (
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
                          <Tooltip label="Edit effective date" onlyIfTruncated={false}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingDateId(t.id);
                              }}
                              className="hover:text-[var(--foreground)] hover:underline"
                            >
                              {longDate(t.effectiveDate ?? t.date)}
                            </button>
                          </Tooltip>
                        )}
                        {t.effectiveDate && t.effectiveDate !== t.date && (
                          <span className="text-amber-600">
                            · posted {shortDate(t.date)}
                            <Tooltip label="Revert to posted date" onlyIfTruncated={false} className="ml-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  commitDate(t, null);
                                }}
                                className="hover:text-[var(--foreground)]"
                              >
                                ↺
                              </button>
                            </Tooltip>
                          </span>
                        )}
                        <span>· {t.account}</span>
                      </>
                    )}
                    {/* Adding a note is reached via the row's ⋯ menu (Add note);
                        a set note renders on its own line below. */}
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
                    <Tooltip label="Edit note" onlyIfTruncated={false} className="mt-0.5 flex max-w-full">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingNoteId(t.id);
                        }}
                        className="flex max-w-full items-baseline gap-1 text-left text-xs italic text-[var(--muted)] hover:text-[var(--foreground)]"
                      >
                        <span className="shrink-0 not-italic opacity-70">✎</span>
                        <span className="truncate">{t.note}</span>
                      </button>
                    </Tooltip>
                  ) : null}
                    </>
                  )}
                </div>
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
                  className={`select-caret max-w-[9rem] shrink-0 cursor-pointer appearance-none truncate rounded-full py-1 pl-2.5 pr-6 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 ${
                    t.categoryId != null
                      ? "text-[var(--foreground)] group-hover:ring-1 group-hover:ring-inset group-hover:ring-[var(--border)]"
                      : "border border-dashed border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                  style={
                    t.categoryId != null
                      ? // backgroundColor (not the `background` shorthand) so the
                        // .select-caret chevron's background-image isn't reset.
                        { backgroundColor: (t.categoryColor ?? "#94a3b8") + "22" }
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
                  className={`w-24 text-right text-[15px] font-semibold tabular-nums ${
                    t.amount >= 0 ? "text-emerald-600" : "text-[var(--foreground)]"
                  }`}
                >
                  {usd(t.amount, { sign: true })}
                </div>
                <RowActionsMenu
                  recState={recState}
                  hasNote={!!t.note}
                  hasDateOverride={!!(t.effectiveDate && t.effectiveDate !== t.date)}
                  excluded={!!t.excluded}
                  canSplit={t.amount < 0}
                  onSetDate={() => setEditingDateId(t.id)}
                  onEditNote={() => setEditingNoteId(t.id)}
                  onSetRecurring={(recurring) => onSetRecurring(t, recurring)}
                  onSetChargeRecurring={(excluded) => onSetChargeRecurring(t, excluded)}
                  onToggleExcluded={(excluded) => onToggleExcluded(t, excluded)}
                  onSplit={() => onSplit(t)}
                />
              </li>
  );
});

// Split a single charge into category parts. Records a split rule keyed on the
// charge's merchant + amount and applies it immediately (see the split route);
// the parts must reconcile to the charge total before it can be saved. Portaled
// + centered so it escapes the list's content-visibility clipping.
function SplitDialog({
  tx,
  cats,
  onClose,
  onDone,
}: {
  tx: Tx;
  cats: Cat[];
  onClose: () => void;
  onDone: () => void;
}) {
  const total = Math.abs(tx.amount);
  const [parts, setParts] = useState<{ categoryId: string; amount: string; label: string }[]>(() => [
    { categoryId: tx.categoryId ? String(tx.categoryId) : "", amount: "", label: "" },
    { categoryId: "", amount: "", label: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const sum = parts.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const remaining = Number((total - sum).toFixed(2));
  const valid =
    parts.length >= 2 &&
    parts.every((p) => p.categoryId !== "" && Number(p.amount) > 0) &&
    Math.abs(remaining) <= 0.01;

  const update = (i: number, patch: Partial<(typeof parts)[number]>) =>
    setParts((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await postJson(`/api/transactions/${tx.id}/split`, {
        parts: parts.map((p) => ({
          categoryId: Number(p.categoryId),
          amount: Number(p.amount),
          label: p.label.trim() || cats.find((c) => c.id === Number(p.categoryId))?.name || "Part",
        })),
      });
      toast("Transaction split", "success");
      onDone();
    } catch {
      toast("Couldn't split — please try again", "error");
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-sm font-semibold">Split transaction</div>
        <div className="mb-3 text-xs text-[var(--muted)]">
          {tx.displayName} · {usd(tx.amount, { sign: true })}
        </div>

        <div className="space-y-2">
          {parts.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={p.categoryId}
                onChange={(e) => update(i, { categoryId: e.target.value })}
                className="select-caret min-w-0 flex-1 cursor-pointer appearance-none rounded-lg border border-[var(--border)] bg-card py-1.5 pl-2.5 pr-7 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              >
                <option value="">Category…</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.icon} {c.name}
                  </option>
                ))}
              </select>
              <input
                value={p.amount}
                onChange={(e) => update(i, { amount: e.target.value })}
                placeholder="$"
                inputMode="decimal"
                className="w-20 rounded-lg border border-[var(--border)] bg-card px-2 py-1.5 text-right text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              />
              {parts.length > 2 ? (
                <button
                  onClick={() => setParts((prev) => prev.filter((_, j) => j !== i))}
                  aria-label="Remove part"
                  className="rounded px-1 text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  ✕
                </button>
              ) : (
                <span className="w-5" />
              )}
            </div>
          ))}
        </div>

        <div className="mt-2 flex items-center justify-between text-xs">
          <button
            onClick={() => setParts((prev) => [...prev, { categoryId: "", amount: "", label: "" }])}
            className="font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            + Add part
          </button>
          <span className={Math.abs(remaining) > 0.01 ? "text-amber-600 tabular-nums" : "text-[var(--muted)] tabular-nums"}>
            {remaining === 0 ? "balanced" : `${usd(remaining)} left`}
          </span>
        </div>

        <p className="mt-3 text-[11px] leading-snug text-[var(--muted)]">
          Splits this and any future {tx.displayName} charge of {usd(total)} into the parts above.
        </p>

        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!valid || saving}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Splitting…" : "Split"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

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
