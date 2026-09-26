// What a change to plan detection would do to the real data, before it ships:
// `npm run detect:diff [-- --keep]`. Snapshots data/copilot.db into a temp copy
// (SQLite's backup, so a running dev server's writes can't tear it), records
// every charge's plan and category, rebuilds plans on the copy with the code
// in this checkout, and lists what moved. The real file is only read.
//
// On main it should say "No changes": the stored plans are what this code
// builds. On a branch that touches detection, the list is the change's effect.
import { LIVE, copyOf, tempCopyPath, removeCopy, snapshot, report } from "./plan-snapshot";

async function main() {
  const keep = process.argv.includes("--keep");
  const copy = tempCopyPath("detect-diff");
  await copyOf(LIVE, copy);

  // Everything below opens the copy: getDb reads the path at call time.
  process.env.COPILOT_DB_PATH = copy;
  const { getDb } = await import("../src/lib/db");
  const { detectRecurrings } = await import("../src/lib/core");

  const before = snapshot(getDb());
  detectRecurrings();
  report(before, snapshot(getDb()));

  if (keep) console.log(`\nkept ${copy}`);
  else removeCopy(copy);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
