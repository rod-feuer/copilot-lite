// Point every DB access at a throwaway file BEFORE anything opens a connection.
// (getDb reads COPILOT_DB_PATH at call time, so this guarantees the real
// data/copilot.db is never touched by tests.)
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.COPILOT_DB_PATH = path.join(
  os.tmpdir(),
  `copilot-test-${process.pid}-${Date.now()}.db`
);

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getDb, migrateMerchants } from "../src/lib/db";
import { detectRecurrings } from "../src/lib/core";
import {
  recurringsForMonth,
  linkMerchant,
  setRecurringSetting,
  deleteCategory,
  categoriesWithTotals,
} from "../src/lib/queries";
import { applyNameCleanup, undoRenormalizeMerchants } from "../src/lib/db";
import { nameCleanupSuggestions } from "../src/lib/nameCleanup";
import { categorizeSuggestions, applyCategorization, dismissCategorize } from "../src/lib/categorizeSuggest";
import { normalizeMerchant } from "../src/lib/merchant";

type Row = { date: string; amount: number };
function seed(merchant: string, rows: Row[], account = "Checking") {
  const db = getDb();
  const ins = db.prepare(
    "INSERT INTO transactions (date, merchant, amount, account, source, hash) VALUES (?,?,?,?,?,?)"
  );
  rows.forEach((r, i) => ins.run(r.date, merchant, r.amount, account, "test", `${merchant}|${r.date}|${i}`));
}
// 1st..6th of consecutive months starting at `startMonth` (1-based).
function monthly(year: number, startMonth: number, n: number, amounts: number | number[]): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const m = startMonth + i;
    const yy = year + Math.floor((m - 1) / 12);
    const mm = ((m - 1) % 12) + 1;
    const amt = Array.isArray(amounts) ? amounts[i] : amounts;
    return { date: `${yy}-${String(mm).padStart(2, "0")}-15`, amount: amt };
  });
}

beforeEach(() => {
  const db = getDb();
  for (const t of ["transactions", "recurrings", "merchant_links", "recurring_settings", "recurring_overrides"])
    db.exec(`DELETE FROM ${t}`);
});

after(() => {
  const p = process.env.COPILOT_DB_PATH!;
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(p + ext, { force: true });
});

test("detects a regular monthly bill", () => {
  seed("Netflix", monthly(2025, 1, 6, [-19.99, -19.99, -22.99, -22.99, -22.99, -22.99]));
  const recs = detectRecurrings();
  const r = recs.find((x) => x.merchant === "Netflix");
  assert.ok(r, "Netflix should be detected");
  assert.equal(r!.cadence, "monthly");
  assert.equal(r!.count, 6);
});

test("a forced plan-change recurring uses the current cadence and price, not the all-history median/mean", () => {
  // Headspace went monthly $12.99 → annual $69.99. The plan change makes the CV
  // too high for auto-detection, so the user forces it; it must then reflect what
  // the vendor does NOW (yearly, $69.99) — not the median gap (94d → quarterly)
  // or the mean amount ($41.49) dragged down by the old monthly intro charges.
  seed("Headspace", [
    { date: "2023-10-05", amount: -12.99 },
    { date: "2023-11-05", amount: -12.99 },
    { date: "2023-12-05", amount: -12.99 },
    { date: "2024-03-08", amount: -69.99 },
    { date: "2025-03-07", amount: -69.99 },
    { date: "2026-03-07", amount: -69.99 },
  ]);
  getDb().prepare("INSERT INTO recurring_overrides (merchant, status) VALUES (?, 'force')").run("Headspace");
  const r = detectRecurrings().find((x) => x.merchant === "Headspace");
  assert.ok(r, "forced Headspace should be created");
  assert.equal(r!.cadence, "yearly", "current rhythm is annual, not the median quarterly");
  assert.equal(r!.avgAmount, -69.99, "current price, not the $41.49 mean");
  assert.equal(r!.nextDate, "2027-03-07", "next due a year after the last charge");
});

test("budget suggestion is per-active-month, not /12 (a $259 bill seen once suggests $259)", () => {
  const db = getDb();
  const catId = Number(
    db.prepare("INSERT INTO categories (name,color,icon,kind) VALUES ('Premiums','#888','🛡️','expense')").run()
      .lastInsertRowid
  );
  const month = new Date().toISOString().slice(0, 7); // within the trailing window
  db.prepare(
    "INSERT INTO transactions (date,merchant,amount,account,source,hash,categoryId) VALUES (?,?,?,?,?,?,?)"
  ).run(`${month}-15`, "Acme Life", -259, "Checking", "prem1", "prem1", catId);
  const c = categoriesWithTotals(month).find((x) => x.id === catId)!;
  assert.equal(c.suggestedBudget, 259, "one $259 active month suggests $259, not $259/12");
});

test("deleting a category clears a recurring that referenced it (FK no longer blocks the delete)", () => {
  const db = getDb();
  const catId = Number(
    db.prepare("INSERT INTO categories (name,color,icon,kind) VALUES ('Temp Cat','#888','🏷️','expense')").run()
      .lastInsertRowid
  );
  // A recurring pinned to it — the foreign key that used to make the delete fail.
  db.prepare(
    "INSERT INTO recurrings (merchant,categoryId,avgAmount,cadence,lastDate,nextDate,count) VALUES ('X',?,-10,'monthly','2026-01-01','2026-02-01',3)"
  ).run(catId);
  assert.doesNotThrow(() => deleteCategory(catId), "FK no longer blocks the delete");
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM categories WHERE id=?").get(catId) as { c: number }).c,
    0,
    "category is removed"
  );
  assert.equal(
    (db.prepare("SELECT categoryId FROM recurrings WHERE merchant='X'").get() as { categoryId: number | null })
      .categoryId,
    null,
    "the recurring is cleared to uncategorized"
  );
});

test("category suggestions: proposes from the vendor's history, applies (fills + learns), and dismiss hides it", () => {
  const db = getDb();
  const catId = Number(
    db.prepare("INSERT INTO categories (name, color, icon, kind) VALUES ('Books','#888','📚','expense')").run()
      .lastInsertRowid
  );
  const ins = db.prepare(
    "INSERT INTO transactions (date, merchant, amount, account, source, hash, categoryId) VALUES (?,?,?,?,?,?,?)"
  );
  ins.run("2026-01-01", "Powells Books", -20, "Checking", "ps1", "ps1", catId); // history…
  ins.run("2026-02-01", "Powells Books", -22, "Checking", "ps2", "ps2", catId);
  ins.run("2026-03-01", "Powells Books", -25, "Checking", "ps3", "ps3", null); // …and an uncategorized one

  const hit = categorizeSuggestions().suggestions.find((s) => s.merchant === "Powells Books");
  assert.ok(hit, "history yields a proposal");
  assert.equal(hit!.categoryId, catId);
  assert.equal(hit!.source, "history");
  assert.equal(hit!.count, 1, "one uncategorized row to fill");

  assert.equal(applyCategorization("Powells Books", catId), 1, "fills the uncategorized row");
  assert.equal(
    categorizeSuggestions().suggestions.find((s) => s.merchant === "Powells Books"),
    undefined,
    "nothing left to suggest"
  );

  // dismiss should hide a fresh uncategorized one
  ins.run("2026-04-01", "Powells Books", -30, "Checking", "ps4", "ps4", null);
  dismissCategorize("Powells Books");
  assert.equal(
    categorizeSuggestions().suggestions.find((s) => s.merchant === "Powells Books"),
    undefined,
    "dismissed vendor stays hidden"
  );
});

test("name-cleanup: suggests a stale name → its re-normalized form, applies just that pair, and undoes", () => {
  const db = getDb();
  const raw = "SQ *BLUE BOTTLE 0042 SAN FRANCISCO CA";
  const to = normalizeMerchant(raw);
  const ins = db.prepare(
    "INSERT INTO transactions (date, merchant, rawMerchant, amount, account, source, hash) VALUES (?,?,?,?,?,?,?)"
  );
  ins.run("2026-01-01", "Stale Coffee", raw, -5, "Checking", "test", "nc1");
  ins.run("2026-02-01", "Stale Coffee", raw, -5, "Checking", "test", "nc2");

  const hit = nameCleanupSuggestions().find((s) => s.from === "Stale Coffee");
  assert.ok(hit, "the stale name is suggested");
  assert.equal(hit!.to, to, "proposes the re-normalized form");
  assert.equal(hit!.count, 2);

  assert.equal(applyNameCleanup(db, "Stale Coffee", to), 2, "renames both rows");
  assert.equal(
    nameCleanupSuggestions().find((s) => s.from === "Stale Coffee"),
    undefined,
    "suggestion clears once applied"
  );

  assert.equal(undoRenormalizeMerchants(db), 2, "undo restores both");
  assert.ok(nameCleanupSuggestions().some((s) => s.from === "Stale Coffee"), "and the suggestion returns");
});

test("correcting a recurring's cadence re-anchors which months it's due (no second field to fix)", () => {
  seed("Gym", monthly(2026, 1, 6, -40)); // monthly Jan–Jun 2026, last charge June
  detectRecurrings();
  setRecurringSetting("Gym", { cadence: "quarterly" }); // user corrects the rhythm only
  const due = (m: string) => recurringsForMonth(m).find((r) => r.merchant === "Gym")!;
  assert.equal(due("2026-06").cadence, "quarterly", "override applies");
  assert.equal(due("2026-06").expectedThisMonth, true, "anchor month (last charge) is due");
  assert.equal(due("2026-07").expectedThisMonth, false, "1 month from anchor is not a quarter");
  assert.equal(due("2026-09").expectedThisMonth, true, "3 months from anchor is");
});

test("detects a variable-amount utility (CV rule, not every-15%)", () => {
  // 90 is >15% below the mean (~108) — the old strict rule rejected this.
  seed("Duke Energy", monthly(2025, 1, 6, [-100, -130, -90, -115, -95, -120]));
  const r = detectRecurrings().find((x) => x.merchant === "Duke Energy");
  assert.ok(r, "variable-but-consistent monthly utility should detect");
  assert.equal(r!.cadence, "monthly");
});

test("rejects erratic discretionary spend (no cadence)", () => {
  seed("Coffee Shop", [
    { date: "2025-01-01", amount: -5 },
    { date: "2025-01-03", amount: -5 },
    { date: "2025-01-04", amount: -5 },
    { date: "2025-01-08", amount: -5 },
    { date: "2025-01-10", amount: -5 },
  ]);
  assert.equal(detectRecurrings().find((x) => x.merchant === "Coffee Shop"), undefined);
});

test("rejects wildly-variable amounts (high CV) even if monthly", () => {
  seed("Plumber", monthly(2025, 1, 3, [-50, -800, -200]));
  assert.equal(detectRecurrings().find((x) => x.merchant === "Plumber"), undefined);
});

test("recurringsForMonth marks the month's charge paid", () => {
  seed("Acme Sub", monthly(2025, 1, 6, -12.5));
  detectRecurrings();
  const r = recurringsForMonth("2025-06").find((x) => x.merchant === "Acme Sub");
  assert.ok(r);
  assert.equal(r!.paid, true);
  assert.equal(r!.paidAmount, 12.5);
});

test("linking two descriptors merges them into one recurring", () => {
  seed("Gas A", monthly(2025, 1, 4, -60));
  seed("Gas B", monthly(2025, 5, 3, -60)); // continues the same monthly series
  linkMerchant("Gas B", "Gas A");
  const recs = detectRecurrings().filter((x) => /^Gas /.test(x.merchant));
  assert.equal(recs.length, 1, "should be a single combined recurring");
  assert.equal(recs[0].merchant, "Gas A");
  assert.equal(recs[0].count, 7);
});

test("migrateMerchants normalizes merchant and preserves the original", () => {
  seed("ALPHA BETA PPD ID: 999", monthly(2025, 1, 1, -10));
  migrateMerchants(getDb());
  const row = getDb()
    .prepare("SELECT merchant, rawMerchant FROM transactions LIMIT 1")
    .get() as { merchant: string; rawMerchant: string };
  assert.equal(row.merchant, "Alpha Beta");
  assert.equal(row.rawMerchant, "ALPHA BETA PPD ID: 999");
});
