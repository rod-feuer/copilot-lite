// Date-rot sweep: run the whole test suite repeatedly against a future wall
// clock and report any test that only passes because of today's date.
//
// `npm test` proves the suite passes NOW. This proves it still passes LATER —
// the failure mode a normal run cannot see, because the clock it depends on is
// the one thing a test never controls.
//
//   npm run test:clock                      # every 7 days out ~19 months
//   CLOCK_MAX=2200 CLOCK_STEP=20 npm run test:clock
//
// Month boundaries (the 1st and the last day of every month in range) are always
// included on top of the step, since month-end and year-end arithmetic is where
// date handling usually breaks.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX = Number(process.env.CLOCK_MAX || 570);
const STEP = Number(process.env.CLOCK_STEP || 7);
const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), "timeshift.mjs");
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

const start = Date.now();
const offsets = new Set();
for (let d = 0; d <= MAX; d += STEP) offsets.add(d);
// First and last day of each month in range.
for (let d = 0; d <= MAX; d++) {
  const day = new Date(start + d * DAY);
  const dom = day.getUTCDate();
  const lastOfMonth =
    new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
  if (dom === 1 || dom === lastOfMonth) offsets.add(d);
}
const sweep = [...offsets].sort((a, b) => a - b);

console.log(
  `Sweeping ${sweep.length} clock offsets: ${iso(start)} → ${iso(start + MAX * DAY)}`
);

const broken = [];
for (const days of sweep) {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", `file://${SHIM}`, "--test", "tests/**/*.test.ts"],
    { env: { ...process.env, SHIFT_DAYS: String(days) }, encoding: "utf8" }
  );
  const out = `${run.stdout}${run.stderr}`;
  if (run.status === 0) continue;
  const names = [
    ...new Set(
      out
        .split("\n")
        .filter((l) => l.startsWith("✖ ") && !l.includes("failing tests"))
        .map((l) => l.replace(/ \([\d.]+ms\)$/, "").slice(2))
    ),
  ];
  broken.push({ days, date: iso(start + days * DAY), names });
  console.log(`✖ ${iso(start + days * DAY)} (+${days}d)`);
  for (const n of names) console.log(`    ${n}`);
}

const secs = ((Date.now() - start) / 1000).toFixed(0);
if (broken.length === 0) {
  console.log(`✔ no date rot across ${sweep.length} clocks (${secs}s)`);
  process.exit(0);
}
const rotted = new Set(broken.flatMap((b) => b.names));
console.log(
  `\n${rotted.size} test(s) rot, first on ${broken[0].date} (${secs}s). ` +
    `Anchor their fixtures to now instead of pinned dates.`
);
process.exit(1);
