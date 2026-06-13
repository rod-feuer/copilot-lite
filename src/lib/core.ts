import crypto from "node:crypto";
import { getDb } from "./db";
import {
  upcomingRecurringExpenses,
  getBudgets,
  getRecurringOverrides,
  getRecurringTxExclusions,
  getMerchantLinks,
  canonicalMerchant,
  linkedAliases,
} from "./queries";
import type { Category, Recurring } from "./types";

// ---- Dedupe key -----------------------------------------------------------
// A transaction is uniquely identified by date + merchant + amount + account.
// Re-importing the same CSV is therefore idempotent.
export function txHash(
  date: string,
  merchant: string,
  amount: number,
  account: string
): string {
  return crypto
    .createHash("sha1")
    .update(`${date}|${merchant.trim().toLowerCase()}|${amount.toFixed(2)}|${account}`)
    .digest("hex");
}

// ---- Rule-based categorization -------------------------------------------
// Deterministic: a merchant matches a rule if the rule's pattern is a substring
// of the (lowercased) merchant name. This handles every *known* merchant for
// free. Only genuinely-unseen merchants fall through to the model. (Rule 5)
export function categorizeByRules(merchant: string): number | null {
  const db = getDb();
  const m = merchant.toLowerCase();
  const rules = db
    .prepare("SELECT pattern, categoryId FROM rules")
    .all() as { pattern: string; categoryId: number }[];
  for (const r of rules) {
    if (m.includes(r.pattern)) return r.categoryId;
  }
  return null;
}

// Categorize from the user's own history: if this vendor (canonical, across all
// linked descriptors) has been filed under one dominant category before, reuse
// it. Deterministic and free — honors past choices without a model call, and
// catches repeat non-recurring vendors that posted under a new descriptor (e.g.
// Calico Corners → Home Decor). Requires ≥2 prior categorized charges and a
// clear majority (≥60%) so a split or one-off doesn't guess.
export function categorizeByHistory(merchant: string): number | null {
  const db = getDb();
  const aliases = linkedAliases(canonicalMerchant(merchant, getMerchantLinks()), getMerchantLinks());
  const ph = aliases.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT categoryId FROM transactions
       WHERE merchant IN (${ph}) AND categoryId IS NOT NULL AND excluded = 0`
    )
    .all(...aliases) as { categoryId: number }[];
  if (rows.length < 2) return null;
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [c, n] of counts)
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  return bestN / rows.length >= 0.6 ? best : null;
}

export function learnRule(pattern: string, categoryId: number, origin: string) {
  const db = getDb();
  const p = pattern.trim().toLowerCase();
  const exists = db
    .prepare("SELECT id FROM rules WHERE pattern = ?")
    .get(p) as { id: number } | undefined;
  if (exists) {
    db.prepare("UPDATE rules SET categoryId = ?, origin = ? WHERE id = ?").run(
      categoryId,
      origin,
      exists.id
    );
  } else {
    db.prepare(
      "INSERT INTO rules (pattern, categoryId, origin) VALUES (?, ?, ?)"
    ).run(p, categoryId, origin);
  }
}

// ---- Recurring detection --------------------------------------------------
// Pure pattern detection, no model. A merchant is "recurring" if it has >= 3
// charges of similar amount spaced at a regular cadence. (Rule 5: deterministic)
const DAY = 86_400_000;
const PERIOD_DAYS: Record<Recurring["cadence"], number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  semiannual: 182,
  yearly: 365,
};

// Fraction of gaps that sit near an integer multiple of the cadence period. This
// is the timing-regularity test: a missing month (gap ≈ 2×, 3× period) still
// counts as on-grid, so it keeps real bills with skipped periods (e.g. the
// mortgage), but erratic spend whose median merely lands in a cadence window
// (restaurants, coffee) scores low and is rejected.
function onGridFraction(gaps: number[], period: number): number {
  if (!gaps.length) return 0;
  const on = gaps.filter((g) => {
    const k = Math.max(1, Math.round(g / period));
    return Math.abs(g - k * period) <= 0.35 * period;
  }).length;
  return on / gaps.length;
}

// Median gap, not mean — robust to missing occurrences. A skipped month, or a
// payment that landed under a drifted descriptor, would otherwise inflate the
// mean gap and push a genuine monthly bill out of the cadence window.
function medianGap(gaps: number[]): number {
  if (gaps.length === 0) return 0;
  const s = [...gaps].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function classifyCadence(avgGapDays: number): Recurring["cadence"] | null {
  if (Math.abs(avgGapDays - 7) <= 2) return "weekly";
  if (Math.abs(avgGapDays - 14) <= 3) return "biweekly";
  if (avgGapDays >= 26 && avgGapDays <= 35) return "monthly";
  if (avgGapDays >= 80 && avgGapDays <= 100) return "quarterly";
  if (avgGapDays >= 165 && avgGapDays <= 200) return "semiannual";
  if (avgGapDays >= 330 && avgGapDays <= 400) return "yearly";
  return null;
}

// Cadence from the most recent gaps (the vendor's current rhythm), so one that
// switched plans — e.g. monthly → annual — is classified by what it does now,
// not a median dragged down by old history. Used for user-forced recurrings,
// which should honor current behavior (the auto pass still needs all-gap
// regularity via onGridFraction, so it stays median-based there).
function recentCadence(gaps: number[]): Recurring["cadence"] | null {
  if (!gaps.length) return null;
  return classifyCadence(medianGap(gaps.slice(-3)));
}

// The current charge, not the average. A settled price (the last two charges
// agree within 10%) uses the most recent; a genuinely variable bill uses the
// median, a steadier typical than the latest swing. Mirrors the suggestion logic
// so a recurring's amount matches what was suggested, and a price change (intro
// rate that later rose) no longer skews it. Amounts are signed (expenses < 0).
function currentAmount(amounts: number[]): number {
  const n = amounts.length;
  const last = amounts[n - 1];
  const prev = n >= 2 ? amounts[n - 2] : last;
  const stable = Math.abs(last - prev) <= 0.1 * Math.max(Math.abs(last), Math.abs(prev));
  if (n < 3 || stable) return last;
  const s = [...amounts].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function addCadence(date: string, cadence: Recurring["cadence"]): string {
  const d = new Date(date + "T00:00:00Z");
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === "biweekly") d.setUTCDate(d.getUTCDate() + 14);
  else if (cadence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cadence === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (cadence === "semiannual") d.setUTCMonth(d.getUTCMonth() + 6);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

// The most common category among a recurring's charges — robust to a single new
// uncategorized member (unlike "use the latest charge's category", which a fresh
// descriptor with no rule match would null out). Ties broken by first seen.
function modalCategory(txs: { categoryId: number | null }[]): number | null {
  const counts = new Map<number, number>();
  for (const t of txs)
    if (t.categoryId != null) counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [cat, n] of counts)
    if (n > bestN) {
      bestN = n;
      best = cat;
    }
  return best;
}

export function detectRecurrings(): Recurring[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT merchant, date, amount, categoryId, hash
       FROM transactions ORDER BY merchant, date`
    )
    .all() as {
    merchant: string;
    date: string;
    amount: number;
    categoryId: number | null;
    hash: string;
  }[];

  // Group by canonical merchant, so user-linked descriptors (e.g. a gas bill
  // whose payment descriptor changed) form a single recurring.
  const links = getMerchantLinks();
  const byMerchant = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = canonicalMerchant(r.merchant, links);
    const arr = byMerchant.get(key) ?? [];
    arr.push(r);
    byMerchant.set(key, arr);
  }
  // The SELECT is ordered by (merchant, date), but a canonical group can span
  // several descriptor strings — so it arrives ordered by descriptor, then date,
  // NOT globally by date. Re-sort each group so gap math and lastDate/nextDate
  // are correct for merged/linked vendors (e.g. a renamed gym).
  for (const arr of byMerchant.values())
    arr.sort((a, b) => a.date.localeCompare(b.date));

  // Clear child references BEFORE deleting parent rows, so this is safe whether
  // or not SQLite foreign-key enforcement is on.
  db.prepare("UPDATE transactions SET recurringId = NULL").run();
  db.prepare("DELETE FROM recurrings").run();

  // Overrides are stored under the descriptor the user clicked, but detection
  // groups by canonical merchant — so resolve each override to its canonical key.
  // Without this, a force/mute set on a linked alias (e.g. "Jimmy John's", an
  // alias of canonical "Jimmy Johns") never matches its own vendor's group and
  // silently does nothing.
  const rawOverrides = getRecurringOverrides();
  const overrides: Record<string, "force" | "mute"> = {};
  for (const [m, status] of Object.entries(rawOverrides)) {
    const canon = canonicalMerchant(m, links);
    if (overrides[canon] === "force") continue; // force wins a force/mute clash
    overrides[canon] = status;
  }
  const excluded = getRecurringTxExclusions(); // charges flagged as one-offs
  const created = new Set<string>();
  const out: Recurring[] = [];
  const insert = db.prepare(
    `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
     VALUES (@merchant, @categoryId, @avgAmount, @cadence, @lastDate, @nextDate, @count)`
  );
  const link = db.prepare(
    "UPDATE transactions SET recurringId = ? WHERE merchant = ?"
  );
  // Backfill a recurring's category onto its still-uncategorized members (e.g. a
  // charge that posted under a new descriptor with no matching rule). Never
  // overwrites an existing category.
  const backfillCategory = db.prepare(
    "UPDATE transactions SET categoryId = ? WHERE recurringId = ? AND categoryId IS NULL"
  );

  for (const [merchant, all] of byMerchant) {
    if (overrides[merchant] === "mute") continue; // user said: not recurring
    const txs = all.filter((t) => !excluded.has(t.hash)); // drop flagged one-offs
    if (txs.length < 3) continue;

    // Amounts must be roughly consistent — measured by coefficient of variation
    // (stdev / |mean|), not "every charge within 15% of the mean". The strict
    // rule rejected real recurrings: subscriptions that raised prices over the
    // years (a few old cheap charges fall >15% below the multi-year mean) and
    // usage-based bills (utilities). CV is robust to a few outliers yet still
    // rejects wildly-variable spend (e.g. a plumber, CV ~2.4).
    const amounts = txs.map((t) => t.amount);
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    if (mean === 0) continue;
    const sd = Math.sqrt(
      amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length
    );
    if (sd / Math.abs(mean) > 0.6) continue;

    // Gaps between consecutive dates must be regular.
    const dates = txs.map((t) => new Date(t.date + "T00:00:00Z").getTime());
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / DAY);
    const cadence = classifyCadence(medianGap(gaps));
    if (!cadence) continue;
    // Timing must be regular, not just a median that happens to land in range.
    if (onGridFraction(gaps, PERIOD_DAYS[cadence]) < 0.6) continue;

    const lastDate = txs[txs.length - 1].date;
    const categoryId = modalCategory(txs);
    const rec = {
      merchant,
      categoryId,
      avgAmount: Number(currentAmount(amounts).toFixed(2)),
      cadence,
      lastDate,
      nextDate: addCadence(lastDate, cadence),
      count: txs.length,
    };
    const info = insert.run(rec);
    for (const om of new Set(txs.map((t) => t.merchant)))
      link.run(info.lastInsertRowid, om);
    if (categoryId != null) backfillCategory.run(categoryId, info.lastInsertRowid);
    created.add(merchant);
    out.push({ id: Number(info.lastInsertRowid), ...rec });
  }

  // User-forced recurrings: create one for each 'force' merchant the auto pass
  // didn't already catch (cadence/amount inferred from its history).
  for (const [merchant, status] of Object.entries(overrides)) {
    if (status !== "force" || created.has(merchant)) continue;
    const all = byMerchant.get(merchant);
    if (!all || all.length === 0) continue;
    const txs = all.filter((t) => !excluded.has(t.hash));
    if (txs.length === 0) continue;
    const amounts = txs.map((t) => t.amount);
    let cadence: Recurring["cadence"] = "monthly";
    if (txs.length >= 2) {
      const dates = txs.map((t) => new Date(t.date + "T00:00:00Z").getTime());
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / DAY);
      // Current rhythm first (handles a plan change), then median, then monthly.
      cadence = recentCadence(gaps) ?? classifyCadence(medianGap(gaps)) ?? "monthly";
    }
    const lastDate = txs[txs.length - 1].date;
    const categoryId = modalCategory(txs);
    const rec = {
      merchant,
      categoryId,
      avgAmount: Number(currentAmount(amounts).toFixed(2)),
      cadence,
      lastDate,
      nextDate: addCadence(lastDate, cadence),
      count: txs.length,
    };
    const info = insert.run(rec);
    for (const om of new Set(txs.map((t) => t.merchant)))
      link.run(info.lastInsertRowid, om);
    if (categoryId != null) backfillCategory.run(categoryId, info.lastInsertRowid);
    out.push({ id: Number(info.lastInsertRowid), ...rec });
  }

  // Flagged one-offs never belong to a recurring, however their merchant was
  // stamped above (a sibling charge shares the same merchant string).
  db.prepare(
    "UPDATE transactions SET recurringId = NULL WHERE hash IN (SELECT hash FROM recurring_tx_exclusions)"
  ).run();

  return out.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

// ---- Dashboard aggregation ------------------------------------------------
export type DashboardData = {
  monthLabel: string;
  income: number;
  expenses: number;
  net: number;
  // For an in-progress month, income is heavily back-loaded (paychecks post late),
  // so month-to-date income and net are misleading. These project the month-end
  // figures (income ≈ prior full month; net = projected income − projected spend).
  // Null on complete/past months, where the actuals are shown instead.
  projectedIncome: number | null;
  projectedNet: number | null;
  byCategory: {
    name: string;
    categoryId: number | null;
    color: string;
    icon: string;
    total: number;
    budget: number | null;
  }[];
  // `projected` is null when it's too early in an in-progress month to run-rate
  // a meaningful forecast (the UI shows a soft message instead of a false figure).
  budget: { total: number; spent: number; projected: number | null } | null;
  // Cumulative expenses per day (climbs from $0), with a dashed projection to
  // month-end. projectedMonthEnd is null when it's too early/late to forecast.
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
  // Previous month with data, for month-over-month comparison. null if none.
  // throughDay is set when the viewed month is still in progress: the baseline is
  // then bounded to the prior month's first `throughDay` days, so a partial month
  // is compared like-for-like (not month-to-date vs. a full prior month).
  prev: {
    month: string;
    income: number;
    expenses: number;
    net: number;
    throughDay: number | null;
  } | null;
  // Recurring expenses due in the next N days from today. Only populated when the
  // viewed month is the current one; empty otherwise (the card then hides).
  upcoming: {
    windowDays: number;
    total: number;
    count: number;
    items: {
      merchant: string;
      name: string;
      nextDate: string;
      amount: number;
      categoryName: string | null;
      categoryColor: string | null;
      categoryIcon: string | null;
    }[];
  };
};

export function dashboard(month?: string): DashboardData {
  const db = getDb();
  // Default to the most recent month that has data.
  const m =
    month ??
    (
      db
        .prepare("SELECT substr(COALESCE(effectiveDate,date),1,7) AS m FROM transactions ORDER BY COALESCE(effectiveDate,date) DESC LIMIT 1")
        .get() as { m: string } | undefined
    )?.m ??
    new Date().toISOString().slice(0, 7);

  const rows = db
    .prepare(
      `SELECT t.amount, COALESCE(t.effectiveDate, t.date) AS date, t.recurringId, t.categoryId AS cid, c.name AS cname, c.color AS ccolor, c.icon AS cicon, c.kind AS ckind
       FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
       WHERE substr(COALESCE(t.effectiveDate, t.date),1,7) = ? AND t.excluded = 0
         AND COALESCE(c.excludeFromTotals, 0) = 0
       ORDER BY COALESCE(t.effectiveDate, t.date)`
    )
    .all(m) as {
    amount: number;
    date: string;
    recurringId: number | null;
    cid: number | null;
    cname: string | null;
    ccolor: string | null;
    cicon: string | null;
    ckind: string | null;
  }[];

  const budgets = getBudgets();

  let income = 0;
  let expenses = 0;
  const catMap = new Map<
    string,
    { id: number | null; color: string; icon: string; total: number }
  >();
  const spendById = new Map<number, number>();
  // Variable (non-recurring) spend per category, used to run-rate the budget
  // projection without amplifying lumpy recurring bills.
  const variableById = new Map<number, number>();
  for (const r of rows) {
    if (r.amount >= 0) income += r.amount;
    else expenses += -r.amount;
    if (r.amount < 0 && r.cname) {
      const e = catMap.get(r.cname) ?? {
        id: r.cid,
        color: r.ccolor ?? "#999",
        icon: r.cicon ?? "•",
        total: 0,
      };
      e.total += -r.amount;
      catMap.set(r.cname, e);
      if (r.cid != null) {
        spendById.set(r.cid, (spendById.get(r.cid) ?? 0) - r.amount);
        if (r.recurringId == null)
          variableById.set(r.cid, (variableById.get(r.cid) ?? 0) - r.amount);
      }
    }
  }

  // Spending pace: cumulative EXPENSES per day (climbs from $0), plus a
  // projection to month-end. Projection = run-rate of *variable* (non-recurring)
  // spend over the days elapsed, applied to the days remaining, plus any
  // recurring bills actually scheduled in those remaining days. Splitting
  // recurring from variable avoids double-counting (a flat run-rate would both
  // bake in past recurring charges *and* re-add the scheduled future ones).
  const expenseByDate = new Map<string, number>();
  let variableMTD = 0;
  for (const r of rows) {
    if (r.amount >= 0) continue;
    expenseByDate.set(r.date, (expenseByDate.get(r.date) ?? 0) - r.amount);
    if (r.recurringId == null) variableMTD += -r.amount;
  }
  let spendCum = 0;
  const series: {
    date: string;
    actual: number | null;
    projected: number | null;
    prev: number | null; // prior-month cumulative at the same day-of-month (ghost line)
  }[] = [...expenseByDate.keys()].sort().map((date) => {
    spendCum += expenseByDate.get(date)!;
    return { date, actual: Number(spendCum.toFixed(2)), projected: null, prev: null };
  });

  // Only project when we're partway through a month with enough days elapsed to
  // have a stable rate (else a flat or 1-point month yields a nonsense forecast).
  const MIN_ELAPSED_DAYS = 5;
  const [yy, mm] = m.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const lastDataDay = rows.length ? Number(rows[rows.length - 1].date.slice(8, 10)) : 0;
  const remainingDays = daysInMonth - lastDataDay;
  // Like-for-like month-over-month: when the viewed month is the current month
  // and still in progress, the income/expenses above are month-to-date, so the
  // prior-month baseline must be bounded to the same day-of-month — otherwise a
  // 9-day partial gets compared against a full 30-day month. Past/complete
  // months compare full-vs-full (compareThroughDay = null).
  const isCurrentMonth = m === new Date().toISOString().slice(0, 7);
  const compareThroughDay =
    isCurrentMonth && lastDataDay > 0 && lastDataDay < daysInMonth ? lastDataDay : null;

  // Recurring bills scheduled in the month's remaining days — shared by the pace
  // forecast and the budget projection so they rest on the same basis (run-rate
  // the variable spend, then add these known future charges rather than
  // extrapolating past lumpy ones). Empty unless the month is still in progress.
  const pad = (d: number) => `${m}-${String(d).padStart(2, "0")}`;
  const scheduledRemaining =
    remainingDays > 0
      ? upcomingRecurringExpenses(pad(lastDataDay + 1), pad(daysInMonth))
      : [];

  let projectedMonthEnd: number | null = null;
  if (remainingDays > 0 && lastDataDay >= MIN_ELAPSED_DAYS) {
    const scheduled = scheduledRemaining.reduce((a, r) => a + Math.abs(r.avgAmount), 0);
    const projectedExtra = (variableMTD / lastDataDay) * remainingDays + scheduled;
    projectedMonthEnd = Number((expenses + projectedExtra).toFixed(2));
    // Linear ramp for the dashed segment; anchor it to the last actual point.
    if (series.length) series[series.length - 1].projected = series[series.length - 1].actual;
    const perDay = projectedExtra / remainingDays;
    let p = expenses;
    for (let day = lastDataDay + 1; day <= daysInMonth; day++) {
      p += perDay;
      series.push({ date: pad(day), actual: null, projected: Number(p.toFixed(2)), prev: null });
    }
  }
  const pace = { series, projectedMonthEnd, daysElapsed: lastDataDay, daysInMonth };

  const byCategory = [...catMap.entries()]
    .map(([name, v]) => ({
      name,
      categoryId: v.id,
      color: v.color,
      icon: v.icon,
      total: Number(v.total.toFixed(2)),
      budget: v.id != null ? budgets[v.id] ?? null : null,
    }))
    .sort((a, b) => b.total - a.total);

  // Overall budget status (Phase C): compares spend in *budgeted* categories to
  // the sum of their budgets — like-for-like, so unbudgeted spend doesn't make
  // you look over. null when no budgets are set.
  const budgetIds = Object.keys(budgets);
  let budgetSummary: DashboardData["budget"] = null;
  if (budgetIds.length > 0) {
    const budgetedSet = new Set(budgetIds.map(Number));
    let total = 0;
    let spent = 0;
    let variableBudgetedMTD = 0;
    for (const idStr of budgetIds) {
      const id = Number(idStr);
      total += budgets[id];
      spent += spendById.get(id) ?? 0;
      variableBudgetedMTD += variableById.get(id) ?? 0;
    }
    // Projection mirrors the pace forecast (run-rate the variable spend, add
    // scheduled recurring) restricted to budgeted categories — so a lumpy early
    // bill isn't multiplied out to an alarmist figure. Held back as null until
    // enough of an in-progress month has elapsed for a run-rate to mean anything;
    // a complete month simply reports its actuals.
    let projected: number | null;
    if (!isCurrentMonth || remainingDays <= 0) {
      projected = spent;
    } else if (lastDataDay >= MIN_ELAPSED_DAYS) {
      const scheduledBudgeted = scheduledRemaining
        .filter((r) => r.categoryId != null && budgetedSet.has(r.categoryId))
        .reduce((a, r) => a + Math.abs(r.avgAmount), 0);
      projected =
        spent + (variableBudgetedMTD / lastDataDay) * remainingDays + scheduledBudgeted;
    } else {
      projected = null;
    }
    budgetSummary = {
      total: Number(total.toFixed(2)),
      spent: Number(spent.toFixed(2)),
      projected: projected == null ? null : Number(projected.toFixed(2)),
    };
  }

  // Transactions still needing a category — the "you have work to do" signal.
  // Scoped to the viewed month and excludes transfers, matching the rest of the view.
  const needsReview = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE substr(COALESCE(effectiveDate,date),1,7) = ? AND excluded = 0 AND categoryId IS NULL`
      )
      .get(m) as { n: number }
  ).n;

  // Month-over-month baseline: the most recent earlier month that has data.
  // "With data" (not strict calendar-previous) avoids divide-by-zero / bogus
  // swings across gaps. Income/expense math mirrors the current-month logic above.
  const prevMonth = (
    db
      .prepare(
        `SELECT MAX(substr(COALESCE(effectiveDate,date),1,7)) AS m FROM transactions
         WHERE excluded = 0 AND substr(COALESCE(effectiveDate,date),1,7) < ?`
      )
      .get(m) as { m: string | null }
  ).m;

  let prev: DashboardData["prev"] = null;
  let priorFullIncome: number | null = null;
  if (prevMonth) {
    // Full prior-month income (unbounded by day) — the basis for projecting this
    // month's back-loaded income.
    priorFullIncome = (
      db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END), 0) AS income
           FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
           WHERE substr(COALESCE(t.effectiveDate, t.date),1,7) = ? AND t.excluded = 0
             AND COALESCE(c.excludeFromTotals, 0) = 0`
        )
        .get(prevMonth) as { income: number }
    ).income;
    // Bound the baseline to the same first-N days when comparing a partial month.
    const dayClause =
      compareThroughDay != null
        ? "AND CAST(substr(COALESCE(t.effectiveDate, t.date), 9, 2) AS INTEGER) <= ?"
        : "";
    const stmt = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.amount <  0 THEN -t.amount ELSE 0 END), 0) AS expenses
       FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
       WHERE substr(COALESCE(t.effectiveDate, t.date),1,7) = ? AND t.excluded = 0
         AND COALESCE(c.excludeFromTotals, 0) = 0
         ${dayClause}`
    );
    const t = (
      compareThroughDay != null
        ? stmt.get(prevMonth, compareThroughDay)
        : stmt.get(prevMonth)
    ) as { income: number; expenses: number };
    prev = {
      month: prevMonth,
      income: Number(t.income.toFixed(2)),
      expenses: Number(t.expenses.toFixed(2)),
      net: Number((t.income - t.expenses).toFixed(2)),
      throughDay: compareThroughDay,
    };

    // Prior-month cumulative spend by day-of-month, overlaid on the pace chart as
    // a faint "last month" reference so ahead/behind is visible at a glance. Built
    // across the full current month (carried flat past the prior month's last day)
    // and attached to each series point by its day-of-month.
    const prevByDay = db
      .prepare(
        `SELECT CAST(substr(COALESCE(t.effectiveDate, t.date), 9, 2) AS INTEGER) AS day,
                SUM(-t.amount) AS amt
         FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
         WHERE substr(COALESCE(t.effectiveDate, t.date),1,7) = ? AND t.excluded = 0
           AND COALESCE(c.excludeFromTotals, 0) = 0 AND t.amount < 0
         GROUP BY day`
      )
      .all(prevMonth) as { day: number; amt: number }[];
    const dayAmt = new Map(prevByDay.map((r) => [r.day, r.amt]));
    const prevCum: number[] = [];
    let acc = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      acc += dayAmt.get(d) ?? 0;
      prevCum[d] = Number(acc.toFixed(2));
    }
    for (const pt of series) {
      const d = Number(pt.date.slice(8, 10));
      pt.prev = prevCum[d] ?? null;
    }
  }

  // Forward-looking: recurring expenses due in the next N days from *today*.
  // This is a today-relative forecast ("what's about to hit my account"), so it
  // only makes sense on the current month — surfacing it while reviewing a past
  // (or future) month would show bills that have nothing to do with what's on
  // screen. Off-month: empty, and the card hides itself.
  const UPCOMING_WINDOW_DAYS = 14;
  const today = new Date().toISOString().slice(0, 10);
  const toDate = new Date(today + "T00:00:00Z");
  toDate.setUTCDate(toDate.getUTCDate() + UPCOMING_WINDOW_DAYS);
  const due = isCurrentMonth
    ? upcomingRecurringExpenses(today, toDate.toISOString().slice(0, 10))
    : [];
  const upcoming = {
    windowDays: UPCOMING_WINDOW_DAYS,
    total: Number(due.reduce((a, r) => a + Math.abs(r.avgAmount), 0).toFixed(2)),
    count: due.length,
    items: due.slice(0, 6).map((r) => ({
      merchant: r.merchant,
      name: r.displayName,
      nextDate: r.nextDate,
      amount: r.avgAmount,
      categoryName: r.categoryName,
      categoryColor: r.categoryColor,
      categoryIcon: r.categoryIcon,
    })),
  };

  const monthLabel = new Date(m + "-01T00:00:00Z").toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  // Project this month's back-loaded income and net — only while a month is in
  // progress (we're already projecting spend) and we have a prior month to lean
  // on. Income recurs, so prior full-month income is the estimate; never below
  // what's already in.
  let projectedIncome: number | null = null;
  let projectedNet: number | null = null;
  if (projectedMonthEnd != null && priorFullIncome != null) {
    projectedIncome = Number(Math.max(income, priorFullIncome).toFixed(2));
    projectedNet = Number((projectedIncome - projectedMonthEnd).toFixed(2));
  }

  return {
    monthLabel,
    income: Number(income.toFixed(2)),
    expenses: Number(expenses.toFixed(2)),
    net: Number((income - expenses).toFixed(2)),
    projectedIncome,
    projectedNet,
    byCategory,
    budget: budgetSummary,
    pace,
    recentCount: rows.length,
    needsReview,
    prev,
    upcoming,
  };
}

export function allCategories(): Category[] {
  return getDb()
    .prepare("SELECT * FROM categories ORDER BY kind DESC, name")
    .all() as Category[];
}
