// Durable plans, step 6: confirm the plans the owner has already told
// something — a name, an amount, a cadence, a date, a match rule, or a charge
// put in by hand — so that from now on their key, and what was set on it,
// stays with them. `npm run plans:confirm` is a dry run on a copy of
// data/copilot.db: it confirms, rebuilds, and lists every charge whose plan or
// category would change. `npm run plans:confirm -- --apply` backs the real file
// up to data/copilot-before-plans-<time>.db first, then does the same to it.
//
// A single-plan vendor's plan keeps its name as its key, which is already
// stable, so it stays as it is (confirmPlan leaves it). Where a vendor's
// confirmed plans sit in different categories (Ben Franklin's Carmel and Lake
// houses), each plan keeps its own category, so its next charges take it too.
import path from "node:path";
import { LIVE, copyOf, tempCopyPath, removeCopy, snapshot, report } from "./plan-snapshot";

async function main() {
  const apply = process.argv.includes("--apply");
  let target: string;
  if (apply) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const backup = path.join(path.dirname(LIVE), `copilot-before-plans-${stamp}.db`);
    await copyOf(LIVE, backup);
    console.log(`Backed up to ${backup}`);
    target = LIVE;
  } else {
    target = tempCopyPath("confirm-plans");
    await copyOf(LIVE, target);
  }
  process.env.COPILOT_DB_PATH = target;
  const { getDb } = await import("../src/lib/db");
  const { detectRecurrings } = await import("../src/lib/core");
  const { confirmPlan } = await import("../src/lib/queries");
  const db = getDb();

  const before = snapshot(db);
  const told = [
    ...(db.prepare("SELECT merchant AS key FROM recurring_settings").all() as { key: string }[]),
    ...(db.prepare("SELECT DISTINCT plan AS key FROM recurring_tx_inclusions").all() as { key: string }[]),
  ].map((r) => r.key);
  const live = new Set((db.prepare("SELECT merchant FROM recurrings").all() as { merchant: string }[]).map((r) => r.merchant));
  const keys = [...new Set(told)].sort();
  const orphans = keys.filter((k) => !live.has(k));
  const confirmed = db.transaction(() => keys.filter((k) => live.has(k) && confirmPlan(k)))();

  // Houses: a vendor whose confirmed plans sit in different categories.
  const rows = db
    .prepare(
      `SELECT p.key, p.vendor, r.categoryId, c.name AS category FROM plans p
       JOIN recurrings r ON r.merchant = p.key LEFT JOIN categories c ON c.id = r.categoryId`
    )
    .all() as { key: string; vendor: string; categoryId: number | null; category: string | null }[];
  const byVendor = new Map<string, typeof rows>();
  for (const r of rows) byVendor.set(r.vendor, [...(byVendor.get(r.vendor) ?? []), r]);
  const own: string[] = [];
  const setOwn = db.prepare("UPDATE plans SET categoryId = ? WHERE key = ?");
  for (const plans of byVendor.values()) {
    if (plans.length < 2 || new Set(plans.map((p) => p.categoryId)).size < 2) continue;
    for (const p of plans) {
      if (p.categoryId == null) continue;
      setOwn.run(p.categoryId, p.key);
      own.push(`${p.key}: ${p.category}`);
    }
  }
  detectRecurrings();

  console.log(`\nConfirmed (${confirmed.length})`);
  for (const k of confirmed) console.log(`  ${k}`);
  console.log(`\nKept their own category (${own.length})`);
  for (const k of own) console.log(`  ${k}`);
  console.log(`\nLeft as they are: ${keys.length - confirmed.length - orphans.length} single-plan vendors, already keyed by their name`);
  if (orphans.length) {
    console.log(`\nSettings or pins on a plan that no longer exists (${orphans.length}), not confirmed:`);
    for (const k of orphans) console.log(`  ${k}`);
  }
  console.log("");
  report(before, snapshot(db));

  if (!apply) {
    removeCopy(target);
    console.log("\nDry run: the real file is unchanged. Run with -- --apply to do it.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
