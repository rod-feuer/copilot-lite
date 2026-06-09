"use client";

import { useCallback, useEffect, useState } from "react";
import { useCategoryShelf } from "@/components/TransactionDrawer";
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
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const toast = useToast();

  const load = useCallback(async (m: string) => {
    const data = await fetch(`/api/categories${m ? `?month=${m}` : ""}`).then((r) =>
      r.json()
    );
    setCats(data);
  }, []);

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
    await fetch(`/api/categories/${c.id}`, { method: "DELETE" });
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

  const excluded = cats.filter((c) => c.excludeFromTotals);
  const expense = cats.filter((c) => c.kind === "expense" && !c.excludeFromTotals);
  const income = cats.filter((c) => c.kind === "income" && !c.excludeFromTotals);

  return (
    <Shell
      title="Categories"
      subtitle="Totals for the selected month"
      actions={<MonthPicker months={months} value={month} onChange={changeMonth} />}
    >
      <div className="card mb-5 p-4">
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

      <Group
        title="Expenses"
        month={month}
        cats={expense}
        onDelete={remove}
        onBudget={saveBudget}
        onToggleExclude={toggleExclude}
        confirmingId={confirmingDelete}
      />
      {income.length > 0 && (
        <div className="mt-5">
          <Group
            title="Income"
            month={month}
            cats={income}
            onDelete={remove}
            confirmingId={confirmingDelete}
          />
        </div>
      )}
      {excluded.length > 0 && (
        <div className="mt-5">
          <Group
            title="Excluded from totals"
            hint="Not counted toward income or expenses — e.g. transfers, credit-card payments, reimbursements."
            month={month}
            cats={excluded}
            onDelete={remove}
            onToggleExclude={toggleExclude}
            confirmingId={confirmingDelete}
          />
        </div>
      )}
    </Shell>
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
  confirmingId,
}: {
  title: string;
  hint?: string;
  month: string;
  cats: Cat[];
  onDelete: (c: Cat) => void;
  onBudget?: (id: number, amount: number | null) => void;
  onToggleExclude?: (id: number, exclude: boolean) => void;
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
        {cats.map((c) => (
          <div
            key={c.id}
            data-drawer-row
            onClick={() => openCategory(c.id, month)}
            title={`View ${c.name} transactions`}
            className="group flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-[var(--background)]"
          >
            <span
              className="flex h-9 w-9 items-center justify-center rounded-full text-base"
              style={{ background: c.color + "22" }}
            >
              {c.icon}
            </span>
            <div className="flex-1">
              <div className="text-sm font-medium">{c.name}</div>
              <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
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
              </div>
            </div>
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: c.color }}
            />
            <div
              className={`w-24 text-right text-sm font-semibold tabular-nums ${
                c.excludeFromTotals ? "text-[var(--muted)] line-through" : ""
              }`}
            >
              {usd(c.total, { cents: false })}
            </div>
            {onBudget && (
              <div onClick={(e) => e.stopPropagation()}>
                <BudgetCell
                  key={`b-${c.id}-${c.budget ?? "none"}`}
                  budget={c.budget}
                  recurringBaseline={c.recurringBaseline}
                  onSave={(v) => onBudget(c.id, v)}
                />
              </div>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c);
              }}
              className={`text-xs transition-opacity ${
                confirmingId === c.id
                  ? "font-semibold text-rose-600 opacity-100"
                  : "text-[var(--muted)] opacity-0 hover:text-rose-500 group-hover:opacity-100"
              }`}
              aria-label={`Delete ${c.name}`}
            >
              {confirmingId === c.id ? "Confirm?" : "Delete"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Monthly-budget editor for one category. Uncontrolled + remounted via `key`
// when the saved value changes, so we avoid syncing prop→state in an effect.
// Shows the detected recurring baseline so the user can size the ad-hoc portion.
function BudgetCell({
  budget,
  recurringBaseline,
  onSave,
}: {
  budget: number | null;
  recurringBaseline: number;
  onSave: (amount: number | null) => void;
}) {
  function commit(raw: string) {
    const t = raw.trim();
    if (t === "") return budget === null ? undefined : onSave(null);
    const n = Number(t.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n >= 0 && n !== budget) onSave(n);
  }
  const hint =
    recurringBaseline <= 0 ? null : budget === null ? (
      `recurring ${usd(recurringBaseline, { cents: false })}`
    ) : budget >= recurringBaseline ? (
      `${usd(recurringBaseline, { cents: false })} rec · ${usd(budget - recurringBaseline, { cents: false })} ad-hoc`
    ) : (
      <span className="text-rose-600">
        under recurring by {usd(recurringBaseline - budget, { cents: false })}
      </span>
    );
  return (
    <div className="w-32 text-right">
      <div className="relative">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-[var(--muted)]">
          $
        </span>
        <input
          defaultValue={budget === null ? "" : String(budget)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="—"
          inputMode="decimal"
          aria-label="Monthly budget"
          className="btn-ghost w-full pl-5 text-right font-normal tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
        />
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-[var(--muted)]">{hint}</div>}
    </div>
  );
}
