// The digest job: `npm run digest -- daily --dry-run`. Wiring only — what a
// digest says and when it is sent live in src/lib/digest.ts, where they are
// tested. Runs without the web server, from the repo root (the database path is
// relative to the working directory). Logs say outcomes, never message bodies
// or environment values: under the scheduler, stdout is a log file.
import { dailyDigest, runDigest } from "../src/lib/digest";
import { syncFromBank } from "../src/lib/plaid";

async function main() {
  const args = process.argv.slice(2);
  const kind = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (kind !== "daily") throw new Error("usage: digest daily --dry-run [--no-sync]");
  if (!dryRun) throw new Error("sending is not built yet: run with --dry-run");

  const outcome = await runDigest(dailyDigest, {
    sync: args.includes("--no-sync") ? async () => {} : syncFromBank,
    send: async () => {
      throw new Error("sending is not built yet");
    },
    dryRun,
  });
  console.log(outcome === "quiet" ? `${kind}: quiet, nothing new to say` : `${kind}: ${outcome}`);
}

main().catch((e) => {
  console.error(`digest failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
