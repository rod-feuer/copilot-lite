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
import { recurringsForMonth, linkMerchant } from "../src/lib/queries";

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
