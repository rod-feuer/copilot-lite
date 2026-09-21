// The digest job: `npm run digest -- daily|weekly [--dry-run] [--no-sync]`.
// Wiring only — what a digest says and when it is sent live in
// src/lib/digest.ts, and how it leaves the Mac in src/lib/deliver.ts, where they
// are tested. Runs without the web server, from the repo root (the database
// path is relative to the working directory). Logs say outcomes, never message
// bodies or environment values: under the scheduler, stdout is a log file.
import { dailyDigest, weeklyDigest, runDigest } from "../src/lib/digest";
import { senderFor, notifyFailure } from "../src/lib/deliver";
import { syncFromBank } from "../src/lib/plaid";

async function main() {
  const args = process.argv.slice(2);
  const kind = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (kind !== "daily" && kind !== "weekly") throw new Error("usage: digest daily|weekly [--dry-run] [--no-sync]");

  // Built first: a missing setting fails the run before anything else happens.
  const send = dryRun ? async () => {} : senderFor(kind);
  try {
    const outcome = await runDigest(kind === "daily" ? dailyDigest : weeklyDigest, {
      sync: args.includes("--no-sync") ? async () => {} : syncFromBank,
      send,
      dryRun,
    });
    console.log(`${new Date().toISOString()} ${kind}: ${outcome === "quiet" ? "quiet, nothing new to say" : outcome}`);
  } catch (e) {
    if (!dryRun) await notifyFailure(`The ${kind} digest could not be sent. See data/digest.log.`);
    throw e;
  }
}

main().catch((e) => {
  // An error's message, never the error object: a mail library's error can carry its options.
  console.error(`${new Date().toISOString()} digest failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
