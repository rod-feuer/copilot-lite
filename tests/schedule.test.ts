import { test } from "node:test";
import assert from "node:assert/strict";
import { launchAgentPlist, SCHEDULE } from "../src/lib/schedule";

const opts = { node: "/Users/me/.nvm/versions/node/v24.8.0/bin/node", repo: "/Users/me/R&D/daybook", path: "/opt/homebrew/bin:/usr/bin:/bin" };
const ints = (xml: string) => Object.fromEntries([...xml.matchAll(/<key>(\w+)<\/key><integer>(\d+)<\/integer>/g)].map((m) => [m[1], Number(m[2])]));

// WHY: the owner chose these times, and they are also a correctness bound: the
// app's "today" is a UTC date, so a run after 19:00 local (in the US) would
// already be reading tomorrow.
test("the daily runs at 7:30 every day and the weekly on Sunday at 18:00, both before the UTC date turns", () => {
  assert.deepEqual(ints(launchAgentPlist("daily", opts)), { Hour: 7, Minute: 30 });
  assert.deepEqual(ints(launchAgentPlist("weekly", opts)), { Weekday: 0, Hour: 18, Minute: 0 });
  for (const k of ["daily", "weekly"] as const) assert.ok(SCHEDULE[k].when.Hour < 19);
});

// WHY: launchd starts a job with a bare PATH and no working directory. The job
// finds the database relative to the repo, reads its secrets from .env.local
// there, and needs the pinned Node (the SQLite module is built for it) and the
// bank CLI's folder. And a plist is world-readable: no secret may ever be in it.
test("the job is pinned to this Node and this checkout, reads its own secrets, and the plist holds none", () => {
  const xml = launchAgentPlist("daily", opts);
  const strings = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(strings.slice(1, 7), [opts.node, "--env-file-if-exists=.env.local", "--import", "tsx", "scripts/digest.ts", "daily"]);
  assert.ok(xml.includes("<key>WorkingDirectory</key><string>/Users/me/R&amp;D/daybook</string>"), "escaped, and the working directory");
  assert.ok(xml.includes("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>"));
  assert.ok(xml.includes("/Users/me/R&amp;D/daybook/data/digest.log"));
  assert.ok(!/SMTP|PASS|DIGEST_|@|\+1/.test(xml), "no setting, address or number");
  assert.ok(!/RunAtLoad|KeepAlive/.test(xml), "it runs on its schedule, not at login and not forever");
});
