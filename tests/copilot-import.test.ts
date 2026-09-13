import "./helpers"; // first: points the DB at a throwaway file (this importer wipes it itself)
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { importCopilotCsv } from "../src/lib/copilot-import";

test("copilot import skips pending rows so they can't double-count when posted", () => {
  // Pending charges are transient — the posted version arrives later under its
  // own id/descriptor. Persisting pending is what created the DSW/Gap duplicates.
  const csv = [
    "Date,Name,Amount,Status,Account,Parent Category",
    "2026-06-01,Posted Store,12.00,posted,Visa,Shopping",
    "2026-06-02,Pending Store,99.00,pending,Visa,Shopping",
  ].join("\n");

  const res = importCopilotCsv(csv);
  assert.equal(res.skippedPending, 1, "the pending row is counted as skipped");
  assert.equal(res.inserted, 1, "only the posted row is inserted");

  const rows = getDb()
    .prepare("SELECT pending FROM transactions")
    .all() as { pending: number }[];
  assert.equal(rows.length, 1, "no pending row was persisted");
  assert.equal(rows[0].pending, 0);
});
