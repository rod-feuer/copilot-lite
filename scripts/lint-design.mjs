// Design lint: the scales in DESIGN.md §2 ("The one page"), checked against
// the source. Three rules — text size, radius, spacing step — each counted
// per file. The codebase predates the scales, so this is a RATCHET, not a
// gate: the count of off-scale uses may fall or hold, never rise. When it
// falls, `npm run lint:design -- --update` writes the new floor.
//   exit 1 when any rule's count exceeds scripts/design-baseline.json
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const BASELINE = join(ROOT, "scripts/design-baseline.json");

// The type scale: 11 tags and uppercase labels · 12 captions · 13 rows and
// body · 15 card and section titles · 18 page title · 24 summary figures.
const TEXT_OK = new Set(["text-[11px]", "text-xs", "text-[13px]", "text-[15px]", "text-lg", "text-2xl"]);
// One radius for cards and controls (8px, `lg`), full for pills, none.
const RADIUS_OK = new Set(["rounded-lg", "rounded-full", "rounded-none"]);
// Spacing steps 4 8 12 16 24 32 → Tailwind 1 2 3 4 6 8 (and 0).
const SPACE_OK = new Set(["0", "1", "2", "3", "4", "6", "8"]);

const RULES = {
  "text size off the scale": {
    re: /(?<![\w-])(?:[a-z-]+:)*text-(?:\[\d+(?:\.\d+)?px\]|xs|sm|base|lg|xl|2xl|3xl|4xl)(?![\w-])/g,
    bad: (m) => !TEXT_OK.has(m.replace(/^(?:[a-z-]+:)*/, "")),
  },
  "radius off the scale": {
    re: /(?<![\w-])(?:[a-z-]+:)*rounded(?:-(?:sm|md|lg|xl|2xl|3xl|full|none|\[[^\]]+\]))?(?![\w-])/g,
    bad: (m) => !RADIUS_OK.has(m.replace(/^(?:[a-z-]+:)*/, "")),
  },
  "spacing off the scale": {
    re: /(?<![\w-])(?:[a-z-]+:)*(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.\d+)?)(?![\w-])/g,
    bad: (m) => !SPACE_OK.has(m.match(/-(\d+(?:\.\d+)?)$/)[1]),
  },
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts|css)$/.test(name)) out.push(p);
  }
  return out;
}

const counts = Object.fromEntries(Object.keys(RULES).map((k) => [k, 0]));
const offenders = Object.fromEntries(Object.keys(RULES).map((k) => [k, new Map()]));
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  for (const [rule, { re, bad }] of Object.entries(RULES)) {
    for (const m of text.match(re) ?? []) {
      if (!bad(m)) continue;
      counts[rule]++;
      const byFile = offenders[rule];
      byFile.set(rel, [...(byFile.get(rel) ?? []), m]);
    }
  }
}

// The baseline is per rule AND per file, so a failure names the file that
// grew — not every old offender in the tree.
const snapshot = Object.fromEntries(
  Object.entries(offenders).map(([rule, byFile]) => [
    rule,
    { total: counts[rule], files: Object.fromEntries([...byFile].map(([f, uses]) => [f, uses.length]).sort()) },
  ])
);
if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2) + "\n");
  console.log("design baseline written:", JSON.stringify(counts));
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error(`✖ no baseline at ${relative(ROOT, BASELINE)} — run: npm run lint:design -- --update`);
  process.exit(1);
}

let failed = false;
for (const [rule, n] of Object.entries(counts)) {
  const floor = baseline[rule]?.total ?? 0;
  const mark = n > floor ? "✖" : n < floor ? "↓" : "=";
  console.log(`${mark} ${rule}: ${n} (baseline ${floor})`);
  if (n > floor) {
    failed = true;
    for (const [file, uses] of offenders[rule]) {
      const had = baseline[rule]?.files?.[file] ?? 0;
      if (uses.length > had) console.log(`    ${file}: ${uses.length - had} new — ${[...new Set(uses)].join(" ")}`);
    }
  }
  if (n < floor) console.log(`    lower than the baseline — run \`npm run lint:design -- --update\` to keep the gain`);
}
if (failed) {
  console.error("✖ design lint: off-scale uses rose above the baseline. Use the scales in DESIGN.md §2, or if a value is a deliberate exception, say why in a comment and raise the baseline in the same commit.");
  process.exit(1);
}
console.log("✔ design lint: no new off-scale uses");
