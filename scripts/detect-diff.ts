// What a change to plan detection would do to the real data, before it ships:
// `npm run detect:diff [-- --keep]`. Snapshots data/copilot.db into a temp copy
// (SQLite's backup, so a running dev server's writes can't tear it), records
// every charge's plan and category, rebuilds plans on the copy with the code
// in this checkout, and lists what moved. The real file is only read.
//
// On main it should say "No changes": the stored plans are what this code
// builds. On a branch that touches detection, the list is the change's effect.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

type Snapshot = {
  charges: Map<string, { plan: string | null; categoryId: number | null; label: string }>;
  plans: Map<string, { count: number; cadence: string }>;
};

function snapshot(db: Database.Database): Snapshot {
  const charges = new Map<string, { plan: string | null; categoryId: number | null; label: string }>();
  const rows = db
    .prepare(
      `SELECT t.hash, t.merchant, COALESCE(t.effectiveDate, t.date) AS date, t.amount, t.categoryId, r.merchant AS plan
       FROM transactions t LEFT JOIN recurrings r ON r.id = t.recurringId`
    )
    .all() as { hash: string; merchant: string; date: string; amount: number; categoryId: number | null; plan: string | null }[];
  for (const r of rows)
    charges.set(r.hash, { plan: r.plan, categoryId: r.categoryId, label: `${r.date} ${r.merchant} ${r.amount.toFixed(2)}` });
  const plans = new Map<string, { count: number; cadence: string }>();
  for (const p of db.prepare("SELECT merchant, count, cadence FROM recurrings").all() as { merchant: string; count: number; cadence: string }[])
    plans.set(p.merchant, { count: p.count, cadence: p.cadence });
  return { charges, plans };
}

async function main() {
  const keep = process.argv.includes("--keep");
  const src = path.join(process.cwd(), "data", "copilot.db");
  if (!fs.existsSync(src)) throw new Error(`no database at ${src}`);
  const copy = path.join(os.tmpdir(), `copilot-detect-diff-${Date.now()}.db`);
  const live = new Database(src, { readonly: true, fileMustExist: true });
  await live.backup(copy);
  live.close();

  // Everything below opens the copy: getDb reads the path at call time.
  process.env.COPILOT_DB_PATH = copy;
  const { getDb } = await import("../src/lib/db");
  const { detectRecurrings } = await import("../src/lib/core");

  const before = snapshot(getDb());
  detectRecurrings();
  const after = snapshot(getDb());

  const gone = [...before.plans.keys()].filter((k) => !after.plans.has(k)).sort();
  const added = [...after.plans.keys()].filter((k) => !before.plans.has(k)).sort();
  const changed = [...before.plans]
    .filter(([k, b]) => {
      const a = after.plans.get(k);
      return a && (a.count !== b.count || a.cadence !== b.cadence);
    })
    .map(([k, b]) => {
      const a = after.plans.get(k)!;
      return `${k}: ${b.count} ${b.cadence} → ${a.count} ${a.cadence}`;
    })
    .sort();
  const moved: string[] = [];
  for (const [hash, b] of before.charges) {
    const a = after.charges.get(hash);
    if (!a) continue;
    if (a.plan !== b.plan) moved.push(`${b.label}: plan ${b.plan ?? "none"} → ${a.plan ?? "none"}`);
    if (a.categoryId !== b.categoryId) moved.push(`${b.label}: category ${b.categoryId ?? "none"} → ${a.categoryId ?? "none"}`);
  }
  moved.sort();

  console.log(`${before.charges.size} charges, ${before.plans.size} plans before, ${after.plans.size} after`);
  if (!gone.length && !added.length && !changed.length && !moved.length) console.log("No changes");
  const list = (title: string, xs: string[]) => {
    if (!xs.length) return;
    console.log(`\n${title} (${xs.length})`);
    for (const x of xs) console.log(`  ${x}`);
  };
  list("Plans gone", gone);
  list("Plans added", added);
  list("Plans changed", changed);
  list("Charges moved", moved);

  if (keep) console.log(`\nkept ${copy}`);
  else for (const ext of ["", "-wal", "-shm"]) fs.rmSync(copy + ext, { force: true });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
