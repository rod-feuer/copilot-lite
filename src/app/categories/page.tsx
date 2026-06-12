"use client";

import { useCallback, useEffect, useState } from "react";
import { useCategoryShelf } from "@/components/TransactionDrawer";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import Shell from "@/components/Shell";
import { MonthPicker } from "@/components/Actions";
import { useToast } from "@/components/Toast";
import { usd, defaultMonth } from "@/lib/format";

type Cat = {
  id: number;
  name: string;
  color: string;
  icon: string;
  kind: "expense" | "income";
  total: number;
  txCount: number;
  budget: number | null;
  recurringBaseline: number;
  suggestedBudget: number;
  excludeFromTotals: 0 | 1;
};

const PALETTE = [
  "#6366f1", "#22c55e", "#f97316", "#0ea5e9", "#a855f7",
  "#eab308", "#ec4899", "#ef4444", "#14b8a6", "#64748b",
];

export default function CategoriesPage() {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState("");
  const [cats, setCats] = useState<Cat[]>([]);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🏷️");
  const [color, setColor] = useState(PALETTE[0]);
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [adding, setAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  // Default to budget pressure so the categories nearest/over their budget rise
  // to the top — the thing a budget exists to surface. "spent" is the old order.
  const [sort, setSort] = useState<"pressure" | "spent" | "name">("pressure");
  // Attention filter, driven by clicking the summary counts: narrow the expense
  // list to the categories that need action (over budget / not yet budgeted).
  const [filter, setFilter] = useState<"over" | "unbudgeted" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const toast = useToast();

  const load = useCallback(async (m: string) => {
    const data = await fetch(`/api/categories${m ? `?month=${m}` : ""}`).then((r) =>
      r.json()
    );
    setCats(data);
  }, []);
  useSyncedRefresh(() => load(month));

  useEffect(() => {
    fetch("/api/months")
      .then((r) => r.json())
      .then((ms: string[]) => {
        setMonths(ms);
        const def = defaultMonth(ms);
        setMonth(def);
        load(def);
      });
  }, [load]);

  function changeMonth(m: string) {
    setMonth(m);
    load(m);
  }

  async function create() {
    if (!name.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), icon, color, kind }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast(d.error ?? "Could not create category.", "error");
        return;
      }
      setName("");
      load(month);
    } finally {
      setAdding(false);
    }
  }

  // Two-step delete (no native confirm): first click arms it for 3s, second
  // click within that window actually deletes, then a toast confirms.
  async function remove(c: Cat) {
    if (confirmingDelete !== c.id) {
      setConfirmingDelete(c.id);
      setTimeout(
        () => setConfirmingDelete((cur) => (cur === c.id ? null : cur)),
        3000
      );
      return;
    }
    setConfirmingDelete(null);
    const res = await fetch(`/api/categories/${c.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast(`Couldn't delete "${c.name}" — please try again`, "error");
      return;
    }
    toast(
      `Deleted "${c.name}" · ${c.txCount} transaction${
        c.txCount === 1 ? "" : "s"
      } now uncategorized`,
      "success"
    );
    load(month);
  }

  async function saveBudget(id: number, amount: number | null) {
    await fetch(`/api/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budget: amount }),
    });
    load(month);
  }

  async function toggleExclude(id: number, excludeFromTotals: boolean) {
    await fetch(`/api/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excludeFromTotals }),
    });
    load(month);
  }

  // Budget pressure: fraction of budget spent. Unbudgeted categories have no
  // pressure, so they sort below budgeted ones (and among themselves by spend).
  const pressure = (c: Cat) => (c.budget && c.budget > 0 ? c.total / c.budget : -1);
  const sortCats = (list: Cat[]) => {
    const arr = [...list];
    if (sort === "name") return arr.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "pressure")
      return arr.sort((a, b) => pressure(b) - pressure(a) || b.total - a.total);
    return arr.sort((a, b) => b.total - a.total); // "spent"
  };
  const excluded = sortCats(cats.filter((c) => c.excludeFromTotals));
  const expense = sortCats(
    cats.filter((c) => c.kind === "expense" && !c.excludeFromTotals)
  );
  // The attention filter only narrows expenses (where budgets live).
  const shownExpense =
    filter === "over"
      ? expense.filter((c) => c.budget != null && c.total > c.budget)
      : filter === "unbudgeted"
      ? expense.filter((c) => c.budget == null && c.name !== "Uncategorized")
      : expense;
  const income = sortCats(
    cats.filter((c) => c.kind === "income" && !c.excludeFromTotals)
  );

  return (
    <Shell
      title="Categories"
      subtitle="Totals for the selected month"
      actions={
        <>
          <MonthPicker months={months} value={month} onChange={changeMonth} />
          <button
            onClick={() => setShowAddForm((v) => !v)}
            className="btn-ghost"
          >
            + New category
          </button>
        </>
      }
    >
      <BudgetSummary
        cats={cats}
        filter={filter}
        onFilter={(f) => setFilter((cur) => (cur === f ? null : f))}
      />

      {showAddForm && (
      <div className="card mb-5 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">New category</h3>
          <button
            onClick={() => setShowAddForm(false)}
            className="rounded px-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <input
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            className="btn-ghost w-14 text-center text-lg"
            aria-label="Icon"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="New category name"
            className="btn-ghost min-w-44 flex-1 font-normal focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "expense" | "income")}
            className="btn-ghost cursor-pointer"
          >
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
          <div className="flex items-center gap-1">
            {PALETTE.map((p) => (
              <button
                key={p}
                onClick={() => setColor(p)}
                className={`h-6 w-6 rounded-full ${
                  color === p ? "ring-2 ring-offset-2 ring-[var(--foreground)]" : ""
                }`}
                style={{ background: p }}
                aria-label={`color ${p}`}
              />
            ))}
          </div>
          <button className="btn-primary" disabled={adding} onClick={create}>
            Add
          </button>
        </div>
      </div>
      )}

      <div className="mb-4 flex items-center justify-end">
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          aria-label="Sort categories"
          className="btn-ghost cursor-pointer text-sm"
        >
          <option value="pressure">Budget used</option>
          <option value="spent">Most spent</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      <Group
        title={filter === "over" ? "Over budget" : filter === "unbudgeted" ? "Not budgeted" : "Expenses"}
        month={month}
        cats={shownExpense}
        onDelete={remove}
        onBudget={saveBudget}
        onToggleExclude={toggleExclude}
        onChange={() => load(month)}
        confirmingId={confirmingDelete}
      />
      {/* While an attention filter is active, hide unrelated sections to focus. */}
      {!filter && income.length > 0 && (
        <div className="mt-5">
          <Group
            title="Income"
            month={month}
            cats={income}
            onDelete={remove}
            onChange={() => load(month)}
            confirmingId={confirmingDelete}
          />
        </div>
      )}
      {!filter && excluded.length > 0 && (
        <div className="mt-5">
          <Group
            title="Excluded from totals"
            hint="Not counted toward income or expenses — e.g. transfers, credit-card payments, reimbursements."
            month={month}
            cats={excluded}
            onDelete={remove}
            onToggleExclude={toggleExclude}
            onChange={() => load(month)}
            confirmingId={confirmingDelete}
          />
        </div>
      )}
    </Shell>
  );
}

// Top-of-page orientation: how the month's spend sits against budgets overall,
// plus the two things that need attention (categories over budget, categories
// with no budget). Scoped to budgeted expense categories so the bar compares
// like-for-like; unbudgeted spend is surfaced separately rather than distorting it.
function BudgetSummary({
  cats,
  filter,
  onFilter,
}: {
  cats: Cat[];
  filter: "over" | "unbudgeted" | null;
  onFilter: (f: "over" | "unbudgeted") => void;
}) {
  const expense = cats.filter((c) => c.kind === "expense" && !c.excludeFromTotals);
  if (expense.length === 0) return null;
  const budgeted = expense.filter((c) => c.budget != null);
  // "Uncategorized" is a catch-all, not a real budget line — don't count it as
  // needing a budget.
  const unbudgeted = expense.filter((c) => c.budget == null && c.name !== "Uncategorized");
  const budget = budgeted.reduce((s, c) => s + (c.budget ?? 0), 0);

  if (budget === 0) {
    const totalSpent = expense.reduce((s, c) => s + c.total, 0);
    return (
      <div className="card mb-5 p-5">
        <div className="text-2xl font-semibold tracking-tight">
          {usd(totalSpent, { cents: false })}
        </div>
        <div className="stat-label">spent this month</div>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Set a budget on any category below to track spending against it.
        </p>
      </div>
    );
  }

  const spent = budgeted.reduce((s, c) => s + c.total, 0);
  const overCats = budgeted.filter((c) => c.total > (c.budget ?? 0));
  const overCount = overCats.length;
  // Name the over-budget categories when there are only a couple — far more
  // useful than a bare count; fall back to a count when there are several.
  const overLabel =
    overCount <= 2 ? `${overCats.map((c) => c.name).join(" & ")} over budget` : `${overCount} categories over budget`;
  const remaining = budget - spent;
  const over = remaining < 0;
  const pct = Math.min((spent / budget) * 100, 100);
  return (
    <div className="card mb-5 p-5">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-semibold tracking-tight">
            {usd(spent, { cents: false })}
          </div>
          <div className="stat-label">
            spent of {usd(budget, { cents: false })} budgeted
          </div>
        </div>
        <div className="text-right">
          <div
            className={`text-2xl font-semibold tracking-tight ${
              over ? "text-rose-600" : ""
            }`}
          >
            {usd(Math.abs(remaining), { cents: false })}
          </div>
          <div className="stat-label">{over ? "over budget" : "left"}</div>
        </div>
      </div>
      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[var(--background)]">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: over ? "#e11d48" : "var(--accent)" }}
        />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 text-xs">
        {overCount > 0 ? (
          <button
            onClick={() => onFilter("over")}
            className={`font-medium text-rose-600 hover:underline ${filter === "over" ? "underline" : ""}`}
            title="Show the categories over budget"
          >
            {overLabel}
          </button>
        ) : (
          <span className="text-[var(--muted)]">On track — nothing over budget</span>
        )}
        {unbudgeted.length > 0 && (
          <>
            <span className="text-[var(--muted)]">·</span>
            <button
              onClick={() => onFilter("unbudgeted")}
              className={`text-[var(--muted)] hover:text-[var(--foreground)] hover:underline ${
                filter === "unbudgeted" ? "text-[var(--foreground)] underline" : ""
              }`}
              title="Show the categories with no budget, to set one"
            >
              {unbudgeted.length} not budgeted
            </button>
          </>
        )}
        {filter && (
          <button
            onClick={() => onFilter(filter)}
            className="ml-1 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            ✕ clear
          </button>
        )}
      </div>
    </div>
  );
}

function Group({
  title,
  hint,
  month,
  cats,
  onDelete,
  onBudget,
  onToggleExclude,
  onChange,
  confirmingId,
}: {
  title: string;
  hint?: string;
  month: string;
  cats: Cat[];
  onDelete: (c: Cat) => void;
  onBudget?: (id: number, amount: number | null) => void;
  onToggleExclude?: (id: number, exclude: boolean) => void;
  // Reload the list when a transaction is edited inside the category shelf, so
  // totals/budgets update in place instead of needing a manual refresh.
  onChange?: () => void;
  confirmingId?: number | null;
}) {
  const openCategory = useCategoryShelf();
  return (
    <div>
      <h3
        className={`px-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)] ${
          hint ? "mb-1" : "mb-2"
        }`}
      >
        {title}
      </h3>
      {hint && <p className="mb-2 px-1 text-xs text-[var(--muted)]">{hint}</p>}
      <div className="card divide-y divide-[var(--border)]">
        {cats.length === 0 && (
          <p className="p-5 text-sm text-[var(--muted)]">No categories.</p>
        )}
        {cats.map((c) => {
          const budgeted = onBudget != null && c.budget != null;
          const budget = c.budget ?? 0;
          const over = budgeted && c.total > budget;
          // Nearing the limit but not over yet — amber, between identity and red.
          const atRisk = budgeted && !over && budget > 0 && c.total / budget >= 0.9;
          const remaining = budget - c.total;
          return (
            <div
              key={c.id}
              data-drawer-row
              onClick={() => openCategory(c.id, month, { onChange })}
              className="group flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-[var(--background)]"
            >
              <span
                className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                style={{ background: c.color + "22" }}
              >
                {c.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium">{c.name}</span>
                  <span className="flex shrink-0 items-baseline gap-1 text-sm">
                    <span
                      className={`font-semibold tabular-nums ${
                        over
                          ? "text-rose-600"
                          : atRisk
                          ? "text-amber-600"
                          : c.excludeFromTotals
                          ? "text-[var(--muted)] line-through"
                          : ""
                      }`}
                    >
                      {usd(c.total, { cents: false })}
                    </span>
                    {onBudget && c.name !== "Uncategorized" && (
                      <span onClick={(e) => e.stopPropagation()}>
                        <BudgetInput
                          key={`b-${c.id}-${c.budget ?? "none"}`}
                          budget={c.budget}
                          suggested={c.suggestedBudget}
                          onSave={(v) => onBudget(c.id, v)}
                        />
                      </span>
                    )}
                  </span>
                </div>

                {budgeted && (
                  <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--muted)]/15">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min((c.total / budget) * 100, 100)}%`,
                        background: over ? "#e11d48" : atRisk ? "#f59e0b" : c.color,
                      }}
                    />
                    {c.recurringBaseline > 0 && (
                      <div
                        className="absolute top-0 h-2 w-0.5 rounded bg-[var(--foreground)]/40"
                        style={{ left: `${Math.min((c.recurringBaseline / budget) * 100, 100)}%` }}
                        title={`${usd(c.recurringBaseline, { cents: false })} recurring`}
                      />
                    )}
                  </div>
                )}

                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
                  <span className="flex items-center gap-2">
                    <span>
                      {c.txCount} transaction{c.txCount === 1 ? "" : "s"}
                    </span>
                    {onToggleExclude && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleExclude(c.id, !c.excludeFromTotals);
                        }}
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                          c.excludeFromTotals
                            ? "bg-amber-500/15 text-amber-600"
                            : "text-[var(--muted)] opacity-0 hover:bg-[var(--background)] group-hover:opacity-100"
                        }`}
                      >
                        {c.excludeFromTotals ? "excluded from totals ✓" : "exclude from totals"}
                      </button>
                    )}
                  </span>
                  {budgeted ? (
                    <span
                      className={`font-medium ${
                        over
                          ? "text-rose-600"
                          : atRisk
                          ? "text-amber-600"
                          : "text-[var(--foreground)]"
                      }`}
                    >
                      {remaining >= 0
                        ? `${usd(remaining, { cents: false })} left`
                        : `${usd(-remaining, { cents: false })} over`}
                      {c.recurringBaseline > 0 && (
                        <span
                          className={`font-normal ${
                            c.recurringBaseline > budget
                              ? "text-amber-600"
                              : "text-[var(--muted)]"
                          }`}
                          title={
                            c.recurringBaseline > budget
                              ? "Budget is below this category's known recurring cost"
                              : "Recurring cost in this category"
                          }
                        >
                          {" · "}
                          {usd(c.recurringBaseline, { cents: false })} recurring
                        </span>
                      )}
                    </span>
                  ) : onBudget && c.recurringBaseline > 0 ? (
                    <span>
                      {usd(c.recurringBaseline, { cents: false })} recurring · set a budget
                    </span>
                  ) : null}
                </div>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c);
                }}
                className={`mt-0.5 shrink-0 text-xs transition-opacity ${
                  confirmingId === c.id
                    ? "font-semibold text-rose-600 opacity-100"
                    : "text-[var(--muted)] opacity-0 hover:text-rose-500 group-hover:opacity-100"
                }`}
                aria-label={`Delete ${c.name}`}
              >
                {confirmingId === c.id ? "Confirm?" : "Delete"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Inline monthly-budget editor, rendered as "/ $<amount>" next to the spent
// figure. Uncontrolled + remounted via `key` when the saved value changes, so we
// avoid syncing prop→state in an effect. The recurring baseline and spent-vs-
// budget status are shown by the row's bar + caption, not here.
function BudgetInput({
  budget,
  suggested = 0,
  onSave,
}: {
  budget: number | null;
  suggested?: number;
  onSave: (amount: number | null) => void;
}) {
  function commit(raw: string) {
    const t = raw.trim();
    if (t === "") return budget === null ? undefined : onSave(null);
    const n = Number(t.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n >= 0 && n !== budget) onSave(n);
  }
  // No budget yet, but we have a typical-spend figure → offer it as a single
  // one-tap chip ("Use $20") rather than stuffing the number into the input
  // (suggest, you confirm). The input stays empty so you can type your own. The
  // chip lives in a fixed-width slot that's reserved even when there's no
  // suggestion, so the "—"/amount columns line up across all unbudgeted rows.
  return (
    <span className="inline-flex items-baseline gap-1.5 text-[var(--muted)]">
      of&nbsp;$
      <input
        defaultValue={budget === null ? "" : budget.toLocaleString("en-US")}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder="—"
        inputMode="decimal"
        aria-label="Monthly budget"
        title="Monthly budget"
        className="w-14 rounded bg-transparent text-right font-medium tabular-nums text-[var(--foreground)] hover:bg-[var(--background)] focus:bg-[var(--background)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/40"
      />
      {budget === null && (
        <span className="flex w-20 shrink-0 justify-end">
          {suggested > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSave(suggested);
              }}
              title={`Set this month's budget to your ~$${suggested.toLocaleString("en-US")}/mo average`}
              className="whitespace-nowrap rounded-md bg-[var(--accent)]/10 px-1.5 py-0.5 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
            >
              Use ${suggested.toLocaleString("en-US")}
            </button>
          )}
        </span>
      )}
    </span>
  );
}
