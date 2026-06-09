// Smoke test: load every page in a real browser and assert no console errors /
// uncaught exceptions (catches client-side crashes a status check would miss),
// and hit every API route for a 200 + valid JSON. Requires the dev server up.
//   BASE_URL (default http://localhost:3000)
//   PUPPETEER_EXECUTABLE_PATH (default: system Chrome on macOS)
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const month = new Date().toISOString().slice(0, 7);
const PAGES = ["/", "/transactions", "/categories", "/recurrings"];
const APIS = [
  "/api/dashboard",
  "/api/transactions?limit=5",
  `/api/recurrings?month=${month}`,
  "/api/recurrings/suggested",
  "/api/categories",
  "/api/accounts",
  "/api/months",
  "/api/merchants",
  "/api/merchant?name=Starbucks",
];
const IGNORE = [/favicon/i, /Download the React DevTools/i];

const failures = [];

// Fail fast if the server isn't up.
try {
  const r = await fetch(BASE + "/api/months");
  if (!r.ok) throw new Error(`status ${r.status}`);
} catch (e) {
  console.error(`✖ dev server not reachable at ${BASE} (${e.message}). Start it first.`);
  process.exit(1);
}

for (const route of APIS) {
  try {
    const r = await fetch(BASE + route);
    if (!r.ok) failures.push(`API ${route} → HTTP ${r.status}`);
    else await r.json();
  } catch (e) {
    failures.push(`API ${route} → ${e.message}`);
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  for (const route of PAGES) {
    const page = await browser.newPage();
    const errs = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !IGNORE.some((re) => re.test(m.text()))) errs.push(m.text());
    });
    page.on("pageerror", (e) => errs.push(`uncaught: ${e.message}`));
    const resp = await page.goto(BASE + route, { waitUntil: "networkidle2", timeout: 20000 });
    if (!resp || !resp.ok()) failures.push(`PAGE ${route} → HTTP ${resp ? resp.status() : "no response"}`);
    await new Promise((r) => setTimeout(r, 400)); // let late errors surface
    for (const e of errs) failures.push(`PAGE ${route} console: ${e}`);
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`✖ smoke failed (${failures.length}):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✔ smoke passed — ${PAGES.length} pages, ${APIS.length} APIs, no console errors`);
