// Shared by the plan scripts (detect:diff, plans:confirm): a copy of the real
// database to work on, every charge's plan and category before and after a
// change, and the list of what moved.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

export const LIVE = path.join(process.cwd(), "data", "copilot.db");

type Charge = { plan: string | null; category: string; label: string };
export type Snapshot = {
  charges: Map<string, Charge>;
  plans: Map<string, { count: number; cadence: string }>;
};

// SQLite's backup, so a running dev server's writes can't tear the copy.
export async function copyOf(src: string, dest: string) {
  if (!fs.existsSync(src)) throw new Error(`no database at ${src}`);
  const live = new Database(src, { readonly: true, fileMustExist: true });
  await live.backup(dest);
  live.close();
}

export function tempCopyPath(name: string) {
  return path.join(os.tmpdir(), `copilot-${name}-${Date.now()}.db`);
}

export function removeCopy(p: string) {
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(p + ext, { force: true });
}

export function snapshot(db: Database.Database): Snapshot {
  const charges = new Map<string, Charge>();
  const rows = db
    .prepare(
      `SELECT t.hash, t.merchant, COALESCE(t.effectiveDate, t.date) AS date, t.amount, c.name AS category, r.merchant AS plan
       FROM transactions t LEFT JOIN recurrings r ON r.id = t.recurringId LEFT JOIN categories c ON c.id = t.categoryId`
    )
    .all() as { hash: string; merchant: string; date: string; amount: number; category: string | null; plan: string | null }[];
  for (const r of rows)
    charges.set(r.hash, { plan: r.plan, category: r.category ?? "Uncategorized", label: `${r.date} ${r.merchant} ${r.amount.toFixed(2)}` });
  const plans = new Map<string, { count: number; cadence: string }>();
  for (const p of db.prepare("SELECT merchant, count, cadence FROM recurrings").all() as { merchant: string; count: number; cadence: string }[])
    plans.set(p.merchant, { count: p.count, cadence: p.cadence });
  return { charges, plans };
}

// Prints what moved; true when anything did.
export function report(before: Snapshot, after: Snapshot): boolean {
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
    if (a.category !== b.category) moved.push(`${b.label}: category ${b.category} → ${a.category}`);
  }
  moved.sort();

  console.log(`${before.charges.size} charges, ${before.plans.size} plans before, ${after.plans.size} after`);
  const any = gone.length + added.length + changed.length + moved.length > 0;
  if (!any) console.log("No changes");
  const list = (title: string, xs: string[]) => {
    if (!xs.length) return;
    console.log(`\n${title} (${xs.length})`);
    for (const x of xs) console.log(`  ${x}`);
  };
  list("Plans gone", gone);
  list("Plans added", added);
  list("Plans changed", changed);
  list("Charges moved", moved);
  return any;
}
