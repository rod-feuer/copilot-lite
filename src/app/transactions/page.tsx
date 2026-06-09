"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Shell from "@/components/Shell";
import {
  MonthPicker,
  ImportButton,
  CategorizeButton,
  CleanupNamesButtons,
} from "@/components/Actions";
import { useToast } from "@/components/Toast";
import { useTxDrawer, useShelfActive } from "@/components/TransactionDrawer";
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
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  categoryExcluded: number;
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

export default function TransactionsPage() {
  const [months, setMonths] = useState<string[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [editingDateId, setEditingDateId] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [month, setMonth] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [q, setQ] = useState("");
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
  const toast = useToast();
  const openTx = useTxDrawer();
  const shelfActive = useShelfActive();

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
    // A vendor deep-link (from the drawer's "View all transactions") shows the
    // full vendor history, so default to all months unless a month was given.
    const hasVendor = !!params.get("vendor");
    setMonth(
      (cur) => cur || params.get("month") || (hasVendor ? "" : defaultMonth(ms))
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
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStatic();
  }, [loadStatic]);

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

  async function setCategory(id: number, categoryId: number | null) {
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
  }

  // Set/clear a transaction's effective (accounting) date. Equal to the posted
  // date or empty means clear the override.
  async function commitDate(t: Tx, value: string | null) {
    setEditingDateId(null);
    const eff = !value || value === t.date ? null : value;
    if (eff === (t.effectiveDate ?? null)) return;
    try {
      await patchJson(`/api/transactions/${t.id}`, { effectiveDate: eff });
    } catch {
      toast("Couldn't update date — please try again", "error");
    }
    setRefreshKey((k) => k + 1);
  }

  // Make a merchant recurring (or un-mark it) — persists across re-scans.
  async function toggleRecurring(t: Tx) {
    const makeIt = !t.recurringId;
    try {
      await postJson("/api/recurrings/override", {
        merchant: t.merchant,
        status: makeIt ? "force" : "mute",
      });
      toast(
        makeIt ? `Marked "${t.merchant}" recurring` : `"${t.merchant}" is no longer recurring`,
        "success"
      );
      setRefreshKey((k) => k + 1);
    } catch {
      toast("Couldn't update — please try again", "error");
    }
  }

  // Net mirrors Copilot: excluded rows (incl. internal transfers) don't count.
  const total = useMemo(
    () => txs.reduce((a, t) => a + (t.excluded || t.categoryExcluded ? 0 : t.amount), 0),
    [txs]
  );

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
          <CleanupNamesButtons
            onDone={() => loadStatic().then(() => setRefreshKey((k) => k + 1))}
          />
          <CategorizeButton onDone={() => setRefreshKey((k) => k + 1)} />
          <ImportButton onDone={() => loadStatic().then(() => setRefreshKey((k) => k + 1))} />
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search merchant or amount…"
          className="btn-ghost w-60 font-normal placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
        />

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

      <div className="card overflow-hidden">
        {txs.length === 0 ? (
          <p className="p-8 text-center text-sm text-[var(--muted)]">
            No transactions match.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {txs.map((t) => (
              <li
                key={t.id}
                data-drawer-row
                onClick={() => openTx(t.merchant, { onChange: () => setRefreshKey((k) => k + 1) })}
                className={`group flex cursor-pointer items-center gap-3 px-4 py-3 ${
                  shelfActive.isMerchant(t.merchant)
                    ? "bg-[var(--accent)]/10"
                    : "hover:bg-[var(--background)]"
                } ${t.excluded ? "opacity-55" : ""}`}
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                  style={{ background: (t.categoryColor ?? "#94a3b8") + "22" }}
                >
                  {t.categoryIcon ?? "•"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{t.displayName}</span>
                    {t.excluded ? (
                      <span className="pill shrink-0 bg-[var(--background)] text-[10px] text-[var(--muted)]">
                        excluded
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-1 text-xs text-[var(--muted)]">
                    {editingDateId === t.id ? (
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
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRecurring(t);
                  }}
                  title={t.recurringId ? "Mark as not recurring" : "Make recurring"}
                  className={`shrink-0 rounded-md px-1.5 py-1 text-sm transition-opacity ${
                    t.recurringId
                      ? "text-[var(--accent)]"
                      : "text-[var(--muted)] opacity-0 hover:bg-[var(--background)] group-hover:opacity-100"
                  }`}
                >
                  ↻
                </button>
                <select
                  value={t.categoryId ?? ""}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    setCategory(t.id, e.target.value ? Number(e.target.value) : null)
                  }
                  className="max-w-37 rounded-lg border border-[var(--border)] bg-card px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  <option value="">Uncategorized</option>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon} {c.name}
                    </option>
                  ))}
                </select>
                <div
                  className={`w-24 text-right text-sm font-semibold ${
                    t.amount >= 0 ? "text-emerald-600" : "text-[var(--foreground)]"
                  }`}
                >
                  {usd(t.amount, { sign: true })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
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
