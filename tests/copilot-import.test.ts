// Throwaway DB before anything opens a connection (this importer wipes the DB,
// so it can't share the invariants suite's fixtures — own file, own DB).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.COPILOT_DB_PATH = path.join(
  os.tmpdir(),
  `copilot-import-${process.pid}-${Date.now()}.db`
);

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { importCopilotCsv } from "../src/lib/copilot-import";

after(() => {
  const p = process.env.COPILOT_DB_PATH!;
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(p + ext, { force: true });
});

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
