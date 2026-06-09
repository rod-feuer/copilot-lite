// Throwaway DB before any connection opens (see tests/db.test.ts).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.COPILOT_DB_PATH = path.join(
  os.tmpdir(),
  `copilot-cov-${process.pid}-${Date.now()}.db`
);

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { detectRecurrings } from "../src/lib/core";
import {
  recurringsForMonth,
  setRecurringSetting,
  linkMerchant,
  suggestedRecurrings,
  setBudget,
  categoriesWithTotals,
  categorySummary,
} from "../src/lib/queries";

let seq = 0;
function seed(merchant: string, rows: { date: string; amount: number }[], categoryId: number | null = null) {
  const ins = getDb().prepare(
    "INSERT INTO transactions (date, merchant, amount, account, categoryId, source, hash) VALUES (?,?,?,?,?,?,?)"
  );
  for (const r of rows) ins.run(r.date, merchant, r.amount, "Checking", categoryId, "test", `h${seq++}`);
}
function months(startMonth: number, n: number, amounts: number | number[]) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2025-${String(startMonth + i).padStart(2, "0")}-15`,
    amount: Array.isArray(amounts) ? amounts[i] : amounts,
  }));
}
function addCat(name: string): number {
  return Number(
    getDb()
      .prepare("INSERT INTO categories (name, color, icon, kind) VALUES (?,?,?,'expense')")
      .run(name, "#888", "•").lastInsertRowid
  );
}

beforeEach(() => {
  for (const t of ["transactions", "recurrings", "merchant_links", "recurring_settings", "recurring_overrides", "split_rules", "budgets", "categories"])
    getDb().exec(`DELETE FROM ${t}`);
});
after(() => {
  const p = process.env.COPILOT_DB_PATH!;
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(p + ext, { force: true });
});

test("match rule (contains) claims a differently-named charge as paid", () => {
  seed("Acme", months(1, 5, -10)); // Jan–May → detected monthly
  detectRecurrings();
  // June charge: different string AND different amount, so neither the exact pass
  // nor the category+amount fallback claims it — only a contains/any-amount rule can.
  seed("ACME PAYMENT 12", [{ date: "2025-06-15", amount: -50 }]);
  assert.equal(recurringsForMonth("2025-06").find((r) => r.merchant === "Acme")!.paid, false);
  setRecurringSetting("Acme", { matchMode: "contains", matchText: "acme", amountTolerance: null });
  assert.equal(recurringsForMonth("2025-06").find((r) => r.merchant === "Acme")!.paid, true);
});

test("alias + expected-amount overrides flow into recurringsForMonth", () => {
  seed("Sub", months(1, 6, -10));
  detectRecurrings();
  setRecurringSetting("Sub", { alias: "My Sub", expectedAmount: 25 });
  const r = recurringsForMonth("2025-07").find((x) => x.merchant === "Sub")!;
  assert.equal(r.displayName, "My Sub");
  assert.equal(r.expectedAmount, 25);
  assert.equal(r.paid, false); // no July charge
});

test("cadence override changes which months a bill is expected", () => {
  seed("Annual Thing", months(1, 6, -10)); // detected monthly, lastDate June
  detectRecurrings();
  setRecurringSetting("Annual Thing", { cadence: "yearly" });
  assert.equal(recurringsForMonth("2025-06").find((r) => r.merchant === "Annual Thing")!.expectedThisMonth, true);
  assert.equal(recurringsForMonth("2025-08").find((r) => r.merchant === "Annual Thing")!.expectedThisMonth, false);
});

test("suggestedRecurrings surfaces variable + new tiers and groups by canonical link", () => {
  seed("Gas Co", months(1, 6, [-30, -300, -50, -280, -40, -260])); // regular timing, high CV → variable
  const recent = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  seed("Netflix", [{ date: recent, amount: -19.99 }]); // 1 charge, sub-name → new
  detectRecurrings();
  const s = suggestedRecurrings();
  assert.ok(s.find((x) => x.merchant === "Gas Co" && x.reason === "variable"));
  assert.ok(s.find((x) => x.merchant === "Netflix" && x.reason === "new"));

  // Linking two variable descriptors collapses them to one suggestion.
  seed("Vec A", months(1, 3, [-30, -300, -50]));
  seed("Vec B", months(4, 3, [-280, -40, -260]));
  linkMerchant("Vec B", "Vec A");
  detectRecurrings();
  const vec = suggestedRecurrings().filter((x) => /^Vec /.test(x.merchant));
  assert.equal(vec.length, 1);
  assert.equal(vec[0].count, 6);
});

test("categorySummary reports month spend, prior month, trailing-12 avg, budget, txns", () => {
  const cat = addCat("Dining");
  setBudget(cat, 300);
  seed("Restaurant A", [{ date: "2025-05-10", amount: -100 }], cat); // prior month
  seed("Restaurant B", months(6, 1, -120).concat(months(6, 1, -80)), cat); // this month, 2 txns
  const s = categorySummary(cat, "2025-06")!;
  assert.equal(s.spent, 200);
  assert.equal(s.txCount, 2);
  assert.equal(s.prevSpent, 100); // May
  assert.equal(s.monthlyAvg, 25); // (100 + 200) / 12
  assert.equal(s.budget, 300);
  assert.equal(s.transactions.length, 2);
  assert.equal(s.upcoming.length, 0); // no recurrings here
});

test("categorySummary upcoming shows ACTIVE recurrings only (not stale/inactive)", () => {
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const day15 = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 15)).toISOString().slice(0, 10);
  const cat = addCat("Utilities");
  // Active: monthly charges over the last 5 months (last ~1 month ago).
  seed("Power Co", [-5, -4, -3, -2, -1].map((o) => ({ date: day15(o), amount: -100 })), cat);
  // Inactive: monthly charges that stopped over a year ago.
  seed("Old Gym", [-18, -17, -16, -15, -14].map((o) => ({ date: day15(o), amount: -50 })), cat);
  detectRecurrings();
  const names = categorySummary(cat, thisMonth)!.upcoming.map((u) => u.merchant);
  assert.ok(names.includes("Power Co"), "active recurring should be upcoming");
  assert.ok(!names.includes("Old Gym"), "inactive recurring must not be upcoming");
});

test("budget surfaces on the category total", () => {
  const cat = addCat("Groceries");
  setBudget(cat, 200);
  seed("Kroger", [{ date: "2025-06-15", amount: -120 }], cat);
  const c = categoriesWithTotals("2025-06").find((x) => x.id === cat)!;
  assert.equal(c.budget, 200);
  assert.equal(c.total, 120);
});
