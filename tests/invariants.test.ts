// Throwaway DB before anything opens a connection (see tests/db.test.ts).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.COPILOT_DB_PATH = path.join(
  os.tmpdir(),
  `copilot-inv-${process.pid}-${Date.now()}.db`
);

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  getDb,
  renormalizeMerchants,
  undoRenormalizeMerchants,
  cleanupUndoAvailable,
} from "../src/lib/db";
import { dashboard } from "../src/lib/core";
import {
  listTransactions,
  merchantSummary,
  categoriesWithTotals,
  setRecurringSetting,
  recurringsForMonth,
  setBudget,
} from "../src/lib/queries";
import { createSplitRule, applySplitRules } from "../src/lib/splits";

let CAT: number, CAT_INC: number, CAT_EXC: number, CAT_X: number;

function addCat(name: string, kind = "expense", excl = 0): number {
  const info = getDb()
    .prepare(
      "INSERT INTO categories (name, color, icon, kind, excludeFromTotals) VALUES (?,?,?,?,?)"
    )
    .run(name, "#888", "•", kind, excl);
  return Number(info.lastInsertRowid);
}
type TxOpts = {
  amount: number;
  date?: string;
  effectiveDate?: string | null;
  categoryId?: number | null;
  excluded?: 0 | 1;
  account?: string;
  hash?: string;
  recurringId?: number | null;
};
let hashSeq = 0;
function tx(merchant: string, o: TxOpts) {
  getDb()
    .prepare(
      `INSERT INTO transactions (date, effectiveDate, merchant, amount, categoryId, account, excluded, recurringId, source, hash)
       VALUES (@date, @effectiveDate, @merchant, @amount, @categoryId, @account, @excluded, @recurringId, 'test', @hash)`
    )
    .run({
      date: o.date ?? "2025-06-15",
      effectiveDate: o.effectiveDate ?? null,
      merchant,
      amount: o.amount,
      categoryId: o.categoryId ?? null,
      account: o.account ?? "Checking",
      excluded: o.excluded ?? 0,
      recurringId: o.recurringId ?? null,
      hash: o.hash ?? `h${hashSeq++}`,
    });
}

before(() => {
  CAT = addCat("Groceries");
  CAT_INC = addCat("Income", "income");
  CAT_EXC = addCat("Transfers", "expense", 1); // excludeFromTotals
  CAT_X = addCat("Home");
});
beforeEach(() => {
  for (const t of ["transactions", "recurrings", "merchant_links", "recurring_settings", "recurring_overrides", "split_rules", "merchant_cleanup_log"])
    getDb().exec(`DELETE FROM ${t}`);
});
after(() => {
  const p = process.env.COPILOT_DB_PATH!;
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(p + ext, { force: true });
});

test("display name resolves consistently in drawer and transactions list", () => {
  tx("Jpmorgan Chase Chase Ach", { amount: -4800, categoryId: CAT_X });
  setRecurringSetting("Jpmorgan Chase Chase Ach", { alias: "Chase Mortgage (Lake)" });
  assert.equal(merchantSummary("Jpmorgan Chase Chase Ach").displayName, "Chase Mortgage (Lake)");
  const rows = listTransactions({});
  const r = rows.find((x) => x.merchant === "Jpmorgan Chase Chase Ach");
  assert.equal(r!.displayName, "Chase Mortgage (Lake)");
});

test("excluded rows and excluded categories never count toward totals", () => {
  tx("Kroger", { amount: -100, categoryId: CAT });
  tx("Kroger", { amount: -40, categoryId: CAT, excluded: 1 }); // row-excluded
  tx("Bank Transfer", { amount: -500, categoryId: CAT_EXC }); // excludeFromTotals category
  // categoriesWithTotals filters row-level excluded (so $40 doesn't count)…
  const groceries = categoriesWithTotals("2025-06").find((c) => c.id === CAT)!;
  assert.equal(groceries.total, 100, "row-excluded $40 must not count");
  // …and the dashboard applies excludeFromTotals (so the $500 transfer is out too).
  const d = dashboard("2025-06");
  assert.equal(d.expenses, 100, "dashboard expenses excludes both row + category exclusions");
});

test("dashboard net equals income minus expenses and is finite", () => {
  tx("Paycheck", { amount: 5000, categoryId: CAT_INC });
  tx("Kroger", { amount: -120, categoryId: CAT });
  tx("Home Depot", { amount: -80, categoryId: CAT_X });
  const d = dashboard("2025-06");
  for (const n of [d.income, d.expenses, d.net]) assert.ok(Number.isFinite(n), "finite");
  assert.equal(d.net, Number((d.income - d.expenses).toFixed(2)));
});

test("in-progress month compares like-for-like against the prior month's same days", () => {
  // The viewed month is the *current* month, so its totals are month-to-date.
  // The baseline must be the prior month through the same day-of-month — else a
  // partial month is compared against a full one (the "▼ $33k vs May" bug).
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  const pm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);

  // Current month: data only through the 5th (income + expense).
  tx("Paycheck", { amount: 2000, date: `${cm}-05`, categoryId: CAT_INC });
  tx("Kroger", { amount: -100, date: `${cm}-05`, categoryId: CAT });
  // Prior month: one charge inside the first 5 days, one after — only the first
  // must count toward the baseline.
  tx("Prior Early", { amount: -70, date: `${pm}-03`, categoryId: CAT });
  tx("Prior Late", { amount: -1000, date: `${pm}-25`, categoryId: CAT });
  tx("Prior Pay", { amount: 1500, date: `${pm}-02`, categoryId: CAT_INC });

  const d = dashboard(cm);
  assert.ok(d.prev, "prev baseline exists");
  assert.equal(d.prev!.throughDay, 5, "baseline bounded to the 5th, matching MTD");
  assert.equal(d.prev!.expenses, 70, "only the prior-month charge through the 5th counts");
  assert.equal(d.prev!.income, 1500, "prior income on the 2nd is within the window");
  // The bug would have surfaced $1070 of prior expenses against $100 MTD.
  assert.notEqual(d.prev!.expenses, 1070, "must not compare against the full prior month");
});

test("a complete past month still compares full-vs-full (throughDay null)", () => {
  // 2025-06 is historical, so no MTD bounding — the whole prior month is the
  // baseline. This guards against the partial fix leaking into past months.
  tx("June Spend", { amount: -200, date: "2025-06-15", categoryId: CAT });
  tx("May Early", { amount: -80, date: "2025-05-03", categoryId: CAT });
  tx("May Late", { amount: -300, date: "2025-05-28", categoryId: CAT });

  const d = dashboard("2025-06");
  assert.ok(d.prev);
  assert.equal(d.prev!.throughDay, null, "no day-bounding for a complete month");
  assert.equal(d.prev!.expenses, 380, "full May counts (80 + 300)");
});

test("a lumpy recurring bill is not amplified into the budget projection", () => {
  // The classic false-precision bug: a mortgage paid on the 1st, run-rated by a
  // few elapsed days, balloons the month-end projection. The fix projects only
  // *variable* spend and adds scheduled recurring — so the already-paid mortgage
  // is counted once, not multiplied out.
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  setBudget(CAT_X, 4500);
  // A detected recurring whose next charge already fell on the 1st (outside the
  // remaining-days window, so it adds nothing to the projection's scheduled part).
  const recId = Number(
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES ('Mortgage', @cat, -4000, 'monthly', @d, @d, 6)`
      )
      .run({ cat: CAT_X, d: `${cm}-01` }).lastInsertRowid
  );
  tx("Mortgage", { amount: -4000, date: `${cm}-01`, categoryId: CAT_X, recurringId: recId });
  tx("Hardware Store", { amount: -100, date: `${cm}-10`, categoryId: CAT_X });

  const d = dashboard(cm);
  assert.ok(d.budget, "budget summary exists");
  assert.equal(d.budget!.spent, 4100, "spent = mortgage + variable");
  assert.ok(d.budget!.projected != null, "past MIN_ELAPSED_DAYS, a projection is shown");
  // Naive run-rate (4100 × daysInMonth / 10) would project ~$12k and scream "over".
  // Correct: 4100 + run-rate of the $100 variable spend ≈ $4.3k, comfortably under.
  assert.ok(
    d.budget!.projected! < 4400,
    `expected a projection near actuals, got ${d.budget!.projected}`
  );
  assert.ok(d.budget!.projected! < d.budget!.total, "must not falsely project over budget");
});

test("the budget projection is withheld until enough of the month has elapsed", () => {
  // Two days of data can't support a run-rate; show nothing rather than a number
  // the dashboard can't stand behind. (null → UI renders "too early to project".)
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  setBudget(CAT, 1000);
  tx("Kroger", { amount: -50, date: `${cm}-02`, categoryId: CAT });

  const d = dashboard(cm);
  assert.ok(d.budget);
  assert.equal(d.budget!.spent, 50);
  assert.equal(d.budget!.projected, null, "no projection on day 2");
});

test("a complete past month projects to its actuals, not a run-rate", () => {
  setBudget(CAT, 1000);
  tx("Kroger", { amount: -300, date: "2025-06-10", categoryId: CAT });
  const d = dashboard("2025-06");
  assert.ok(d.budget);
  assert.equal(d.budget!.projected, d.budget!.spent, "finished month: projection = actuals");
});

test("upcoming bills appear on the current month only, never on a past one", () => {
  // "Upcoming · next 14 days" is a today-relative forecast: each recurring has a
  // single forward nextDate, so it must not bleed into a month being reviewed.
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  const soon = new Date(now.getTime());
  soon.setUTCDate(soon.getUTCDate() + 3); // within the 14-day window
  const nd = soon.toISOString().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
       VALUES ('Netflix', @cat, -15.99, 'monthly', @nd, @nd, 6)`
    )
    .run({ cat: CAT, nd });

  const cur = dashboard(cm);
  assert.ok(cur.upcoming.count >= 1, "current month surfaces the upcoming bill");

  // A past month is a closed book — the forecast must be empty there, not show
  // next week's bills.
  const past = dashboard("2024-01");
  assert.equal(past.upcoming.count, 0, "past month shows no upcoming bills");
  assert.equal(past.upcoming.items.length, 0);
  assert.equal(past.upcoming.total, 0);
});

// Simulate already-imported rows: backfill rawMerchant = merchant, as the
// original import-time migration would have, so renormalize (not the first-pass
// backfill) is what re-cleans them.
function backfillRaw() {
  getDb().prepare("UPDATE transactions SET rawMerchant = merchant WHERE rawMerchant IS NULL").run();
}

test("renormalize re-cleans existing rows from their preserved original", () => {
  // A row imported before the normalizer learned to drop a trailing channel code.
  tx("Carmel Water Bill Tel", { amount: -78, categoryId: CAT });
  backfillRaw();
  const changed = renormalizeMerchants(getDb());
  assert.ok(changed >= 1, "the stale name was refreshed");
  const row = getDb()
    .prepare("SELECT merchant, rawMerchant FROM transactions WHERE rawMerchant = 'Carmel Water Bill Tel'")
    .get() as { merchant: string; rawMerchant: string };
  assert.equal(row.merchant, "Carmel Water Bill", "the channel code is gone");
  assert.equal(row.rawMerchant, "Carmel Water Bill Tel", "original is preserved (reversible)");
});

test("renormalize carries a user's alias onto the renamed merchant", () => {
  tx("Acme Bill Web", { amount: -20, categoryId: CAT });
  backfillRaw();
  setRecurringSetting("Acme Bill Web", { alias: "Acme Subscription" }); // aliased pre-cleanup
  renormalizeMerchants(getDb());
  const moved = getDb()
    .prepare("SELECT alias FROM recurring_settings WHERE merchant = 'Acme Bill'")
    .get() as { alias: string } | undefined;
  assert.equal(moved?.alias, "Acme Subscription", "alias followed the rename");
  const orphan = getDb()
    .prepare("SELECT 1 FROM recurring_settings WHERE merchant = 'Acme Bill Web'")
    .get();
  assert.equal(orphan, undefined, "no setting left stranded on the old name");
});

test("undo restores the pre-cleanup names (not the raw descriptor) and aliases", () => {
  // Prior name differs from both the raw descriptor and the cleaned form, so we
  // can prove undo restores the *previous* name, not just merchant = rawMerchant.
  tx("Acme Bill Stale", { amount: -20, categoryId: CAT });
  getDb()
    .prepare("UPDATE transactions SET rawMerchant = 'ACME BILL WEB' WHERE merchant = 'Acme Bill Stale'")
    .run();
  setRecurringSetting("Acme Bill Stale", { alias: "Acme Subscription" });

  const changed = renormalizeMerchants(getDb());
  assert.ok(changed >= 1);
  assert.equal(cleanupUndoAvailable(getDb()), true, "undo available after a cleanup");
  assert.ok(
    getDb().prepare("SELECT 1 FROM transactions WHERE merchant = 'Acme Bill'").get(),
    "cleanup applied"
  );

  const restored = undoRenormalizeMerchants(getDb());
  assert.equal(restored, changed, "every changed row was restored");
  const row = getDb()
    .prepare("SELECT merchant FROM transactions WHERE rawMerchant = 'ACME BILL WEB'")
    .get() as { merchant: string };
  assert.equal(row.merchant, "Acme Bill Stale", "the prior name is back, not the raw descriptor");
  const s = getDb()
    .prepare("SELECT alias FROM recurring_settings WHERE merchant = 'Acme Bill Stale'")
    .get() as { alias: string } | undefined;
  assert.equal(s?.alias, "Acme Subscription", "alias keyed back to the restored name");
  assert.equal(cleanupUndoAvailable(getDb()), false, "undo is consumed once applied");
});

test("auto-split children sum to the parent and the parent is excluded", () => {
  createSplitRule("chubb", 1115.55, [
    { categoryId: CAT_X, amount: 847.75, label: "Home" },
    { categoryId: CAT, amount: 267.8, label: "Other" },
  ]);
  tx("Chubb Insurance", { amount: -1115.55, categoryId: CAT_X });
  applySplitRules();
  const children = getDb()
    .prepare("SELECT amount FROM transactions WHERE hash LIKE '%:s%'")
    .all() as { amount: number }[];
  assert.equal(children.length, 2);
  const sum = children.reduce((a, c) => a + Math.abs(c.amount), 0);
  assert.equal(Number(sum.toFixed(2)), 1115.55);
  const parent = getDb()
    .prepare("SELECT excluded FROM transactions WHERE merchant = 'Chubb Insurance' AND hash NOT LIKE '%:s%'")
    .get() as { excluded: number };
  assert.equal(parent.excluded, 1);
});

test("effectiveDate overrides the accounting month (COALESCE everywhere)", () => {
  // Posted in March, but accounted to April.
  tx("Lake Mortgage", { amount: -4800, date: "2025-03-31", effectiveDate: "2025-04-01", categoryId: CAT_X });
  assert.equal(listTransactions({ month: "2025-04" }).length, 1, "shows in April");
  assert.equal(listTransactions({ month: "2025-03" }).length, 0, "not in March");
});

test("duplicate transaction hash is rejected (dedup invariant)", () => {
  tx("Once", { amount: -10, hash: "dup" });
  assert.throws(() => tx("Again", { amount: -10, hash: "dup" }));
});

test("empty month produces finite figures, not NaN, and never throws", () => {
  tx("Solo", { amount: -10, date: "2025-06-15", categoryId: CAT });
  // A month with no transactions at all.
  const d = dashboard("2030-01");
  for (const n of [d.income, d.expenses, d.net])
    assert.ok(Number.isFinite(n), `expected finite, got ${n}`);
  // projectedMonthEnd is intentionally null when it can't forecast — just never NaN.
  assert.ok(d.pace.projectedMonthEnd === null || Number.isFinite(d.pace.projectedMonthEnd));
  assert.doesNotThrow(() => recurringsForMonth("2030-01"));
  for (const c of categoriesWithTotals("2030-01"))
    assert.ok(Number.isFinite(c.total) && Number.isFinite(c.recurringBaseline));
});
