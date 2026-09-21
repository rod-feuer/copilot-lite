// `npm run digest:install` / `digest:uninstall` / `digest:install -- --print`.
// Writes the two LaunchAgents for this checkout and this Node, and loads them.
// Re-run it after moving the repo or upgrading Node: both paths are pinned.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCHEDULE, launchAgentPlist, type Kind } from "../src/lib/schedule";

const args = process.argv.slice(2);
const repo = process.cwd();
if (!fs.existsSync(path.join(repo, "scripts/digest.ts"))) throw new Error("run this from the repo root");
const dir = path.join(os.homedir(), "Library/LaunchAgents");
const domain = `gui/${process.getuid?.()}`;
const launchctl = (...a: string[]) => execFileSync("/bin/launchctl", a, { stdio: ["ignore", "pipe", "pipe"] }).toString();
// Where the bank CLI is, ahead of launchd's bare default PATH.
const cli = (process.env.PLAID_CLI_PATH && path.dirname(process.env.PLAID_CLI_PATH)) || "/opt/homebrew/bin";
const opts = { node: process.execPath, repo, path: `${cli}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` };

for (const kind of Object.keys(SCHEDULE) as Kind[]) {
  const { label } = SCHEDULE[kind];
  const file = path.join(dir, `${label}.plist`);
  if (args.includes("--print")) {
    console.log(launchAgentPlist(kind, opts));
    continue;
  }
  try {
    launchctl("bootout", `${domain}/${label}`); // not loaded is fine
  } catch {}
  if (args.includes("--uninstall")) {
    fs.rmSync(file, { force: true });
    console.log(`removed ${label}`);
    continue;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(repo, "data"), { recursive: true });
  fs.writeFileSync(file, launchAgentPlist(kind, opts), { mode: 0o644 });
  launchctl("bootstrap", domain, file);
  console.log(`installed ${label}: ${kind === "daily" ? "every day at 7:30am" : "Sundays at 6:00pm"}, logging to data/digest.log`);
  console.log(`  run it now:  launchctl kickstart -k ${domain}/${label}`);
}
