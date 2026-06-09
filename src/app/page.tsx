"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { usd, shortDate, defaultMonth } from "@/lib/format";
import {
  MonthPicker,
  ImportButton,
  CategorizeButton,
  SeedButton,
  SyncBankButton,
} from "@/components/Actions";
import Shell from "@/components/Shell";
import { useTxDrawer, useCategoryShelf, useShelfActive } from "@/components/TransactionDrawer";

type Dash = {
  monthLabel: string;
  income: number;
  expenses: number;
  net: number;
  byCategory: {
    name: string;
    categoryId: number | null;
    color: string;
    icon: string;
    total: number;
    budget: number | null;
  }[];
  budget: { total: number; spent: number; projected: number | null } | null;
  pace: {
    series: {
      date: string;
      actual: number | null;
      projected: number | null;
      prev: number | null;
    }[];
    projectedMonthEnd: number | null;
    daysElapsed: number;
    daysInMonth: number;
  };
  recentCount: number;
  needsReview: number;
  prev: {
    month: string;
    income: number;
    expenses: number;
    net: number;
    throughDay: number | null;
  } | null;
  upcoming: {
    windowDays: number;
    total: number;
    count: number;
    items: {
      merchant: string;
      name: string;
      nextDate: string;
      amount: number;
      categoryColor: string | null;
      categoryIcon: string | null;
    }[];
  };
};

type Tx = {
  id: number;
  date: string;
  merchant: string;
  displayName: string;
  amount: number;
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  // 1 when the category is excluded from totals (transfers, CC payments) — such a
  // positive amount is money moving, not income, so it shouldn't read as green.
  categoryExcluded: 0 | 1;
};

export default function DashboardPage() {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState<string>("");
  const [data, setData] = useState<Dash | null>(null);
  const [recent, setRecent] = useState<Tx[]>([]);
  const [loading, setLoading] = useState(true);
  const openTx = useTxDrawer();
  const shelfActive = useShelfActive();

  const loadMonths = useCallback(async () => {
    const ms = (await (await fetch("/api/months")).json()) as string[];
    setMonths(ms);
    setMonth((cur) => cur || defaultMonth(ms));
    return ms;
  }, []);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    try {
      const q = m ? `?month=${m}` : "";
      const [d, r] = await Promise.all([
        fetch(`/api/dashboard${q}`).then((x) => x.json()),
        fetch(`/api/transactions${m ? `?month=${m}&` : "?"}limit=8`).then((x) => x.json()),
      ]);
      setData(d);
      setRecent(r);
    } finally {
      // Always clear loading, even on a failed/empty read, so the page can't
      // hang on the spinner forever.
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMonths().then((ms) => load(defaultMonth(ms)));
  }, [loadMonths, load]);

  const refresh = useCallback(async () => {
    const ms = await loadMonths();
    await load(month || defaultMonth(ms));
  }, [loadMonths, load, month]);

  function changeMonth(m: string) {
    setMonth(m);
    load(m);
  }

  if (!loading && months.length === 0) {
    return (
      <Shell title="Dashboard" subtitle="No data yet">
        <div className="card flex flex-col items-center gap-4 p-12 text-center">
          <div className="text-5xl">📊</div>
          <div>
            <h2 className="text-lg font-semibold">Nothing here yet</h2>
            <p className="mt-1 max-w-sm text-sm text-[var(--muted)]">
              Load realistic sample data to explore the app, or import a CSV export
              from your bank or Copilot.
            </p>
          </div>
          <div className="flex gap-2">
            <SeedButton onDone={refresh} />
            <ImportButton onDone={refresh} />
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="Dashboard"
      subtitle={data?.monthLabel ?? ""}
      actions={
        <>
          <MonthPicker months={months} value={month} onChange={changeMonth} />
          <SyncBankButton onDone={refresh} />
          <CategorizeButton onDone={refresh} />
          <ImportButton onDone={refresh} />
        </>
      }
    >
      {data && (
        <div className="flex flex-col gap-5">
          {data.needsReview > 0 && (
            <Link
              href={`/transactions?category=none${month ? `&month=${month}` : ""}`}
              className="card flex items-center justify-between gap-3 border-amber-500/30 bg-amber-500/10 px-5 py-3 transition-colors hover:bg-amber-500/20"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-amber-600">
                <span className="text-base">⚠️</span>
                {data.needsReview} transaction{data.needsReview === 1 ? "" : "s"} need
                {data.needsReview === 1 ? "s" : ""} a category this month
              </span>
              <span className="text-sm font-medium text-amber-600">Review →</span>
            </Link>
          )}

          <Verdict
            data={data}
            isCurrentMonth={month === new Date().toISOString().slice(0, 7)}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat
              label="Income"
              value={usd(data.income, { cents: false })}
              tone="pos"
              href={`/transactions?month=${month}&type=income`}
              sub={
                <DeltaLine
                  cur={data.income}
                  prev={data.prev?.income}
                  prevLabel={prevPeriodLabel(data.prev)}
                  higherIsGood
                />
              }
            />
            <Stat
              label="Expenses"
              value={usd(data.expenses, { cents: false })}
              tone="neutral"
              href={`/transactions?month=${month}&type=expense`}
              sub={
                <DeltaLine
                  cur={data.expenses}
                  prev={data.prev?.expenses}
                  prevLabel={prevPeriodLabel(data.prev)}
                  higherIsGood={false}
                />
              }
            />
            <Stat
              label="Net cash flow"
              value={usd(data.net, { sign: true, cents: false })}
              tone={data.net >= 0 ? "pos" : "neg"}
              href={`/transactions?month=${month}`}
              sub={
                <DeltaLine
                  cur={data.net}
                  prev={data.prev?.net}
                  prevLabel={prevPeriodLabel(data.prev)}
                  higherIsGood
                />
              }
            />
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
            <div className="card flex flex-col p-5 lg:col-span-3">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Spending this month</h3>
                {data.pace.projectedMonthEnd != null && (
                  <span className="text-xs text-[var(--muted)]">
                    Projected month-end{" "}
                    <span className="font-semibold text-[var(--foreground)]">
                      {usd(data.pace.projectedMonthEnd, { cents: false })}
                    </span>
                  </span>
                )}
              </div>
              <ChartLegend
                showProjected={data.pace.projectedMonthEnd != null}
                showPrev={data.prev != null}
              />
              <div className="min-h-[14rem] flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.pace.series} margin={{ left: -8, right: 8, top: 4 }}>
                    <defs>
                      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#6d5efc" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#6d5efc" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="date"
                      tickFormatter={shortDate}
                      tick={{ fontSize: 11, fill: "#9aa0a6" }}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={28}
                    />
                    <YAxis
                      domain={[0, "auto"]}
                      tick={{ fontSize: 11, fill: "#9aa0a6" }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
                      width={44}
                    />
                    <Tooltip
                      formatter={(v, name) =>
                        [
                          usd(Number(v), { cents: false }),
                          name === "projected"
                            ? "Projected"
                            : name === "prev"
                              ? "Last month"
                              : "Spent",
                        ] as [string, string]
                      }
                      labelFormatter={(label) => shortDate(String(label))}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid #e8eaed",
                        fontSize: 12,
                      }}
                    />
                    {/* Faint prior-month curve, drawn first so it sits beneath. */}
                    <Area
                      type="monotone"
                      dataKey="prev"
                      stroke="#c3c6cc"
                      strokeWidth={1.5}
                      fill="none"
                      connectNulls
                      dot={false}
                      activeDot={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="actual"
                      stroke="#6d5efc"
                      strokeWidth={2}
                      fill="url(#g)"
                      connectNulls={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="projected"
                      stroke="#6d5efc"
                      strokeWidth={2}
                      strokeDasharray="5 4"
                      fill="none"
                      connectNulls
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <PaceStrip pace={data.pace} spent={data.expenses} />
            </div>

            <div className="card p-5 lg:col-span-2">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Spending by category</h3>
                <SeeAll href="/categories" />
              </div>
              {data.budget && <BudgetSummary budget={data.budget} />}
              <CategoryBars rows={data.byCategory} month={month} />
            </div>
          </div>

          {data.upcoming.count > 0 && (
            <div className="card p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  Upcoming bills · next {data.upcoming.windowDays} days
                </h3>
                <SeeAll href="/recurrings" />
              </div>
              <ul className="divide-y divide-[var(--border)]">
                {data.upcoming.items.map((u, i) => (
                  <li key={i}>
                    <button
                      data-drawer-row
                      onClick={() => openTx(u.merchant, { onChange: refresh })}
                      className={`group -mx-2 flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors ${
                        shelfActive.isMerchant(u.merchant)
                          ? "bg-[var(--accent)]/10"
                          : "hover:bg-[var(--background)]"
                      }`}
                    >
                      <span
                        className="flex h-9 w-9 items-center justify-center rounded-full text-base"
                        style={{ background: (u.categoryColor ?? "#94a3b8") + "22" }}
                      >
                        {u.categoryIcon ?? "↻"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{u.name}</div>
                        <div className="text-xs text-[var(--muted)]">
                          {shortDate(u.nextDate)}
                        </div>
                      </div>
                      <div className="text-sm font-semibold tabular-nums">
                        {usd(u.amount, { sign: true })}
                      </div>
                      <DrillChevron />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between text-xs text-[var(--muted)]">
                <span>
                  {data.upcoming.count > data.upcoming.items.length
                    ? `+${data.upcoming.count - data.upcoming.items.length} more`
                    : `${data.upcoming.count} total`}
                </span>
                <span className="font-medium">
                  {usd(data.upcoming.total)} due in {data.upcoming.windowDays} days
                </span>
              </div>
            </div>
          )}

          <div className="card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Recent activity</h3>
              <SeeAll href={`/transactions${month ? `?month=${month}` : ""}`} />
            </div>
            <ul className="divide-y divide-[var(--border)]">
              {recent.map((t) => (
                <li key={t.id}>
                  <button
                    data-drawer-row
                    onClick={() => openTx(t.merchant, { onChange: refresh })}
                    className={`group -mx-2 flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors ${
                      shelfActive.isMerchant(t.merchant)
                        ? "bg-[var(--accent)]/10"
                        : "hover:bg-[var(--background)]"
                    }`}
                  >
                    <span
                      className="flex h-9 w-9 items-center justify-center rounded-full text-base"
                      style={{ background: (t.categoryColor ?? "#94a3b8") + "22" }}
                    >
                      {t.categoryIcon ?? "•"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{t.displayName}</div>
                      <div className="text-xs text-[var(--muted)]">
                        {shortDate(t.date)} · {t.categoryName ?? "Uncategorized"}
                      </div>
                    </div>
                    <div
                      className={`text-sm font-semibold ${
                        t.amount >= 0 && !t.categoryExcluded
                          ? "text-emerald-600"
                          : "text-[var(--foreground)]"
                      }`}
                    >
                      {usd(t.amount, { sign: true })}
                    </div>
                    <DrillChevron />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Shell>
  );
}

// Legend for the pace chart's three lines — so the faint "last month" reference
// and the dashed projection are self-explanatory, not mystery lines.
function ChartLegend({
  showProjected,
  showPrev,
}: {
  showProjected: boolean;
  showPrev: boolean;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--muted)]">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-3.5 rounded-full bg-[#6d5efc]" />
        This month
      </span>
      {showProjected && (
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3.5 border-t-2 border-dashed border-[#6d5efc]" />
          Projected
        </span>
      )}
      {showPrev && (
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3.5 rounded-full bg-[#c3c6cc]" />
          Last month
        </span>
      )}
    </div>
  );
}

// Pace metrics under the chart — fills the height the category card forces on this
// card with useful context (and gives the chart card a reason to be this tall).
function PaceStrip({ pace, spent }: { pace: Dash["pace"]; spent: number }) {
  const daysLeft = Math.max(pace.daysInMonth - pace.daysElapsed, 0);
  const avgDay = pace.daysElapsed > 0 ? spent / pace.daysElapsed : 0;
  const inProgress = pace.projectedMonthEnd != null;
  const items: { label: string; value: string }[] = [
    { label: inProgress ? "Spent so far" : "Total spent", value: usd(spent, { cents: false }) },
    { label: "Avg / day", value: usd(avgDay, { cents: false }) },
  ];
  if (inProgress) {
    items.push({ label: "Days left", value: String(daysLeft) });
    items.push({
      label: "Projected",
      value: usd(pace.projectedMonthEnd as number, { cents: false }),
    });
  }
  return (
    <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--border)] pt-3 sm:grid-cols-4">
      {items.map((it) => (
        <div key={it.label}>
          <div className="text-sm font-semibold tabular-nums">{it.value}</div>
          <div className="stat-label">{it.label}</div>
        </div>
      ))}
    </div>
  );
}

// Persistent-but-faint affordance marking a row/card as drillable. Visible at
// rest (so the interaction is discoverable, not hover-only) and strengthens +
// nudges right on hover. Parent must carry `group`.
function DrillChevron({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`h-4 w-4 shrink-0 text-[var(--muted)] opacity-40 transition-all group-hover:opacity-100 group-hover:translate-x-0.5 ${className}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// One consistent "See all →" link for every truncated list on the dashboard.
function SeeAll({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="text-xs font-medium text-[var(--accent)] hover:underline"
    >
      See all →
    </Link>
  );
}

function Stat({
  label,
  value,
  tone,
  sub,
  href,
}: {
  label: string;
  value: string;
  // pos → green (money in / favorable), neg → red (a deficit), neutral → plain
  // (an expense is a fact, not a warning, so it stays in the foreground color).
  tone: "pos" | "neg" | "neutral";
  sub?: React.ReactNode;
  href?: string;
}) {
  const valueColor =
    tone === "pos"
      ? "text-emerald-600"
      : tone === "neg"
        ? "text-rose-600"
        : "text-[var(--foreground)]";
  const inner = (
    <>
      <div className="stat-label">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tracking-tight ${valueColor}`}>
        {value}
      </div>
      {sub}
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        className="card group relative block cursor-pointer p-5 transition-colors hover:border-[var(--accent)]/40"
      >
        <DrillChevron className="absolute right-4 top-4" />
        {inner}
      </Link>
    );
  }
  return <div className="card p-5">{inner}</div>;
}

// One plain-language headline answering "how am I doing this month?" — so the
// dashboard leads with a verdict instead of three co-equal numbers. Leads with
// the budget (the user's own plan); for an in-progress month it speaks in pace
// terms and stays neutral until there's enough data to project. Falls back to
// cash flow when no budgets are set.
function buildVerdict(
  data: Dash,
  isCurrentMonth: boolean
): { tone: "good" | "bad" | "neutral"; text: string } {
  const m = (n: number) => usd(Math.abs(n), { cents: false });
  const b = data.budget;
  if (b && b.total > 0) {
    if (b.projected == null)
      return {
        tone: "neutral",
        text: `${m(b.spent)} of your ${m(b.total)} budget used — too early to project the month`,
      };
    // Mirror BudgetSummary's delta exactly (projected − total, same usd call) so
    // the headline and the budget block can never disagree by a rounding dollar.
    const delta = b.projected - b.total;
    const verb = isCurrentMonth ? "On pace to finish" : "Finished";
    if (Math.round(delta) > 0) return { tone: "bad", text: `${verb} ${m(delta)} over budget` };
    if (Math.round(delta) < 0) return { tone: "good", text: `${verb} ${m(delta)} under budget` };
    return { tone: "good", text: `${verb} right on budget` };
  }
  // No budgets set — fall back to cash flow. Mid-month net is partial, so stay
  // factual rather than calling a verdict on an incomplete month.
  if (isCurrentMonth)
    return { tone: "neutral", text: `${m(data.expenses)} spent so far this month` };
  const net = Math.round(data.net);
  if (net >= 0) return { tone: "good", text: `Net positive — you kept ${m(net)} this month` };
  return { tone: "bad", text: `Net negative — you spent ${m(net)} more than you earned` };
}

function Verdict({ data, isCurrentMonth }: { data: Dash; isCurrentMonth: boolean }) {
  const v = buildVerdict(data, isCurrentMonth);
  const dot =
    v.tone === "good" ? "bg-emerald-500" : v.tone === "bad" ? "bg-rose-500" : "bg-[var(--muted)]";
  const text =
    v.tone === "good"
      ? "text-emerald-600"
      : v.tone === "bad"
        ? "text-rose-600"
        : "text-[var(--muted)]";
  return (
    <div className="flex items-center gap-2.5">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      <p className={`text-base font-semibold tracking-tight sm:text-lg ${text}`}>{v.text}</p>
    </div>
  );
}

function shortMonth(month: string): string {
  return new Date(month + "-01T00:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

// Label for the comparison baseline. When the viewed month is in progress the
// baseline is bounded to the prior month's first `throughDay` days, so say so
// ("May 1–9") rather than implying a full-month comparison ("May").
function prevPeriodLabel(prev: Dash["prev"]): string | null {
  if (!prev) return null;
  const m = shortMonth(prev.month);
  return prev.throughDay != null ? `${m} 1–${prev.throughDay}` : m;
}

// Month-over-month delta shown under a stat, as "$abs (%)" — dollars answer
// "how much", percent answers "how unusual". Color reflects whether the move is
// favorable, which depends on the metric — hence `higherIsGood`. The percent is
// omitted when the base is zero or the sign flips (where a % would mislead);
// that only arises for net cash flow, since income/expenses are non-negative.
function DeltaLine({
  cur,
  prev,
  prevLabel,
  higherIsGood,
}: {
  cur: number;
  prev: number | undefined;
  prevLabel: string | null | undefined;
  higherIsGood: boolean;
}) {
  if (prev === undefined || !prevLabel) return null;
  const change = cur - prev;
  if (Math.round(change) === 0) {
    return (
      <div className="mt-1 text-xs font-medium text-[var(--muted)]">
        No change vs {prevLabel}
      </div>
    );
  }
  const up = change > 0;
  const favorable = up === higherIsGood;
  const dollars = usd(Math.abs(change), { cents: false });
  const showPct = prev !== 0 && Math.sign(cur) === Math.sign(prev);
  const pct = showPct
    ? ` (${Math.abs(Math.round((change / Math.abs(prev)) * 100))}%)`
    : "";
  return (
    <div
      className={`mt-1 flex items-center gap-1 text-xs font-medium ${
        favorable ? "text-emerald-600" : "text-rose-600"
      }`}
    >
      <span>{up ? "▲" : "▼"}</span>
      <span>
        {dollars}
        {pct}
      </span>
      <span className="font-normal text-[var(--muted)]">vs {prevLabel}</span>
    </div>
  );
}

function CategoryBars({
  rows,
  month,
}: {
  rows: {
    name: string;
    categoryId: number | null;
    color: string;
    icon: string;
    total: number;
    budget: number | null;
  }[];
  month: string;
}) {
  const openCategory = useCategoryShelf();
  const shelfActive = useShelfActive();
  if (rows.length === 0)
    return <p className="text-sm text-[var(--muted)]">No spending this month.</p>;
  // Scale to the larger of spend or budget so over-budget bars and budget ticks
  // both fit.
  const max = Math.max(...rows.map((r) => Math.max(r.total, r.budget ?? 0)));
  const pct = (v: number) => `${(v / max) * 100}%`;
  return (
    <div className="flex flex-col gap-3">
      {rows.slice(0, 7).map((r) => {
        const over = r.budget != null && r.total > r.budget;
        const active = r.categoryId != null && shelfActive.isCategory(r.categoryId, month);
        const cls = `group block w-full cursor-pointer rounded-lg text-left transition-opacity hover:opacity-80${
          active ? " -mx-2 -my-1 bg-[var(--accent)]/10 px-2 py-1" : ""
        }`;
        const body = (
          <>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <span>{r.icon}</span>
                <span className="font-medium">{r.name}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className={over ? "font-semibold text-rose-600" : "text-[var(--muted)]"}>
                  {usd(r.total, { cents: false })}
                  {r.budget != null && (
                    <span className="font-normal text-[var(--muted)]">
                      {" "}
                      / {usd(r.budget, { cents: false })}
                    </span>
                  )}
                </span>
                <DrillChevron className="-mr-1 h-3.5 w-3.5" />
              </span>
            </div>
            <div className="relative">
              {/* The bar fills with the category's own color up to budget; only
                  the overage beyond budget is red, so being over reads as a tip
                  whose length is the dollars over — not a whole red row. */}
              <div className="flex h-2 overflow-hidden rounded-full bg-[var(--background)]">
                <div
                  className="h-full"
                  style={{
                    width: pct(Math.min(r.total, r.budget ?? r.total)),
                    background: r.color,
                  }}
                />
                {over && (
                  <div
                    className="h-full"
                    style={{ width: pct(r.total - (r.budget as number)), background: "#e11d48" }}
                  />
                )}
              </div>
              {r.budget != null && (
                <div
                  className="absolute top-0 h-2 w-0.5 rounded bg-[var(--foreground)]/40"
                  style={{ left: pct(Math.min(r.budget, max)) }}
                  title={`Budget ${usd(r.budget, { cents: false })}`}
                />
              )}
            </div>
          </>
        );
        return r.categoryId != null ? (
          <button
            key={r.name}
            data-drawer-row
            onClick={() => openCategory(r.categoryId as number, month)}
            className={cls}
          >
            {body}
          </button>
        ) : (
          <Link key={r.name} href={`/transactions?month=${month}&category=none`} className={cls}>
            {body}
          </Link>
        );
      })}
    </div>
  );
}

// Overall budget status (Phase C): spend vs. the sum of budgeted categories,
// plus a run-rate projection to month-end and whether it lands over/under.
function BudgetSummary({
  budget,
}: {
  budget: { total: number; spent: number; projected: number | null };
}) {
  const pct = budget.total > 0 ? Math.round((budget.spent / budget.total) * 100) : 0;
  const overNow = budget.spent > budget.total;
  const projDelta = budget.projected != null ? budget.projected - budget.total : null;
  return (
    <div className="mb-4 rounded-xl bg-[var(--background)] p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">Budget</span>
        <span>
          <span className={overNow ? "font-semibold text-rose-600" : "font-semibold"}>
            {usd(budget.spent, { cents: false })}
          </span>
          <span className="text-[var(--muted)]"> of {usd(budget.total, { cents: false })}</span>
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(pct, 100)}%`,
            background: overNow ? "#e11d48" : "var(--accent)",
          }}
        />
      </div>
      <div className="mt-1.5 text-xs text-[var(--muted)]">
        {pct}% used
        {budget.projected != null && projDelta != null ? (
          <>
            {" · "}projected {usd(budget.projected, { cents: false })}{" "}
            <span className={projDelta > 0 ? "text-rose-600" : "text-emerald-600"}>
              ({projDelta >= 0 ? "over" : "under"} by{" "}
              {usd(Math.abs(projDelta), { cents: false })})
            </span>
          </>
        ) : (
          " · too early to project"
        )}
      </div>
    </div>
  );
}

