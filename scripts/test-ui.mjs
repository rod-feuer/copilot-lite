// UI behaviour checks in a real browser — the guards for what the code review
// shipped: honest load states, keyboard rows, un-gated actions, partial-month
// qualifiers, statement-mode overlays, and split → undo. Self-contained: starts
// its own `next dev` on a spare port against a throwaway DB (seed + a small CSV
// fixture), no login gate, no Plaid, and tears it all down after.
//
// Run: `npm run test:ui` (Chrome via PUPPETEER_EXECUTABLE_PATH, default: Mac
// Google Chrome). Stop `next dev` first — both write to `.next`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const PORT = Number(process.env.UI_PORT || 3100);
const BASE = `http://localhost:${PORT}`;
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DB = path.join(os.tmpdir(), `copilot-ui-${process.pid}-${Date.now()}.db`);
const NEXT = path.join(process.cwd(), "node_modules", ".bin", "next");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date();
const CUR = now.toISOString().slice(0, 7);
const PAST = "2026-03"; // inside the seed's pinned window (Dec 2025 – May 2026)
const day = (offsetMonths, d) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, d)).toISOString().slice(0, 10);

// ---------- server lifecycle ----------
const server = spawn(NEXT, ["dev", "-p", String(PORT)], {
  detached: true, // own process group, so the whole tree can be killed at the end
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    COPILOT_DB_PATH: DB,
    APP_PASSWORD: "", // no login gate (an already-set var wins over .env.local)
    PLAID_CLI_PATH: "/nonexistent/plaid", // launch sync fails fast and stays quiet
    NODE_OPTIONS: "--max-old-space-size=4096",
  },
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stopServer = () => {
  try { process.kill(-server.pid, "SIGTERM"); } catch {}
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(DB + ext, { force: true });
};
process.on("exit", stopServer);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(BASE + "/api/months");
      if (r.status === 401) throw new Error("login gate is on — APP_PASSWORD leaked into the test server");
      if (r.ok) return;
    } catch (e) {
      if (String(e.message).includes("login gate")) throw e;
    }
    await sleep(1000);
  }
  throw new Error(`server did not come up on ${BASE}\n${serverLog.slice(-2000)}`);
}

// ---------- fixture ----------
async function loadFixture() {
  await fetch(BASE + "/api/seed", { method: "POST" });
  // Current-month rows (the seed is pinned to May 2026) + a recent Netflix run so
  // one recurring is ACTIVE, + a Chipotle charge for statement mode.
  const rows = [
    ["Date", "Name", "Amount", "Account"],
    [day(0, 1), "Acme Corp Paycheck", "5200", "Checking"],
    [day(0, 2), "Whole Foods Market", "-54.20", "Credit"],
    [day(0, 3), "Chipotle", "-18.75", "Credit"],
    [day(0, 4), "Shell Gas Station", "-48.10", "Credit"],
    [day(0, 6), "Card Payment Received", "500", "Credit"], // goes into an excluded category below
    [day(-2, 3), "Netflix", "-15.49", "Credit"],
    [day(-1, 3), "Netflix", "-15.49", "Credit"],
    [day(0, 3), "Netflix", "-15.49", "Credit"],
    // A subscription with no charge yet this month, so the recurrings page has
    // an upcoming (or overdue) row, not only paid ones.
    [day(-3, 28), "Spotify", "-9.99", "Credit"],
    [day(-2, 28), "Spotify", "-9.99", "Credit"],
    [day(-1, 28), "Spotify", "-9.99", "Credit"],
  ];
  const csv = rows.map((r) => r.join(",")).join("\n");
  const imp = await (await fetch(BASE + "/api/import", { method: "POST", body: csv })).json();
  if (!imp.inserted) throw new Error("fixture import inserted nothing: " + JSON.stringify(imp));
  const cats = await (await fetch(BASE + "/api/categories")).json();
  const groceries = cats.find((c) => c.name === "Groceries");
  if (!groceries) throw new Error("seed has no Groceries category");
  const b = await fetch(`${BASE}/api/categories/${groceries.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budget: 500, period: "monthly" }),
  });
  if (!b.ok) throw new Error("could not set a budget");
  // An excluded category (a transfer bucket) holding an inflow: must never read as income.
  await fetch(BASE + "/api/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Transfers", icon: "↔", color: "#888888", kind: "expense" }) });
  const transfers = (await (await fetch(BASE + "/api/categories")).json()).find((c) => c.name === "Transfers");
  if (!transfers) throw new Error("could not create the Transfers category");
  await fetch(`${BASE}/api/categories/${transfers.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ excludeFromTotals: true }) });
  const cp = (await (await fetch(BASE + "/api/transactions?q=Card%20Payment&limit=5")).json()).rows?.[0];
  if (!cp) throw new Error("fixture row 'Card Payment Received' not found");
  await fetch(`${BASE}/api/transactions/${cp.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categoryId: transfers.id }) });
}

// ---------- helpers ----------
const results = [];
const record = (group, name, ok, detail = "") => {
  results.push({ group, check: name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${group} · ${name}${detail ? " — " + detail : ""}`);
};
const lowerText = (page) => page.evaluate(() => document.body.innerText.toLowerCase());
const shelfSel = "aside.fixed"; // the drawer; the sidebar is also an <aside>
const shelfIs = (page, open) =>
  page.waitForFunction((sel, want) => {
    const a = document.querySelector(sel);
    return (!!a && a.innerText.trim().length > 0) === want;
  }, { timeout: 8000 }, shelfSel, open);
const shelfSettled = (page) =>
  page.waitForFunction((sel) => { const a = document.querySelector(sel); return !!a && !a.querySelector(".animate-pulse"); }, { timeout: 8000 }, shelfSel);
const pickMonth = async (page, m) => {
  await page.evaluate((m) => {
    const s = [...document.querySelectorAll("select")].find((x) => [...x.options].some((o) => o.value === m));
    if (s) { s.value = m; s.dispatchEvent(new Event("change", { bubbles: true })); }
  }, m);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }); // the month's data, not the old month's
};
async function withPage(browser, fn, { width = 1280, height = 900 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  try { await fn(page, errs); } finally { await page.close(); }
}

// ---------- cases ----------
async function honestLoadStates(browser) {
  const cases = [
    { route: "/", fail: /\/api\/dashboard/, empty: "nothing here yet", what: "the dashboard" },
    { route: "/transactions", fail: /\/api\/transactions\?/, empty: "no transactions match.", what: "transactions" },
    { route: "/categories", fail: /\/api\/categories(\?|$)/, empty: "no categories.", what: "categories" },
    { route: "/recurrings", fail: /\/api\/recurrings\?/, empty: "no recurring patterns", what: "recurring bills" },
  ];
  for (const c of cases) {
    await withPage(browser, async (page, errs) => {
      let failing = true;
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (failing && c.fail.test(req.url())) req.respond({ status: 500, contentType: "application/json", body: '{"error":"forced"}' });
        else req.continue();
      });
      await page.goto(BASE + c.route, { waitUntil: "domcontentloaded" });
      await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t), { timeout: 15000 }, `couldn’t load ${c.what}`);
      const emptyShown = (await lowerText(page)).includes(c.empty);
      failing = false;
      await page.click("button::-p-text(Retry)");
      await page.waitForFunction(() => !document.body.innerText.includes("Couldn’t load"), { timeout: 15000 });
      record("load states", c.route, !emptyShown && errs.length === 0, emptyShown ? "empty state shown during error" : errs[0] || "error → retry → recovered");
    });
  }
  await withPage(browser, async (page, errs) => {
    let failing = false;
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (failing && /\/api\/(merchant|category)\?/.test(req.url())) req.respond({ status: 500, contentType: "application/json", body: '{"error":"forced"}' });
      else req.continue();
    });
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    failing = true;
    await page.click("[data-drawer-row]");
    await page.waitForFunction(() => document.body.innerText.includes("Couldn’t load this"), { timeout: 8000 });
    failing = false;
    await page.click(`${shelfSel} button::-p-text(Retry)`);
    let ok = true;
    try { await page.waitForFunction((sel) => !document.body.innerText.includes("Couldn’t load") && !document.querySelector(sel + " .animate-pulse"), { timeout: 8000 }, shelfSel); } catch { ok = false; }
    record("load states", "shelf", ok && errs.length === 0, ok ? "error → retry → loaded" : "did not recover");
  });
}

async function keyboardRows(browser) {
  await withPage(browser, async (page, errs) => {
    for (const route of ["/transactions", "/categories", "/recurrings"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const f = await page.evaluate(() => { const el = document.querySelector("[data-drawer-row]"); el.focus(); return { focused: document.activeElement === el, role: el.getAttribute("role") }; });
      await page.keyboard.press("Enter");
      let opened = true; try { await shelfIs(page, true); } catch { opened = false; }
      await page.keyboard.press("Escape"); try { await shelfIs(page, false); } catch {}
      record("keyboard rows", route, f.focused && f.role === "button" && opened, `role=${f.role}, Enter opens shelf: ${opened}`);
    }
    // A transaction row opens the CHARGE's shelf (no row menu): the note
    // field and the charge's verbs are there, and Open vendor drills up.
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    await page.evaluate(() => document.querySelector("[data-drawer-row]").focus());
    await page.keyboard.press("Enter"); await shelfIs(page, true); await shelfSettled(page);
    const charge = await page.evaluate((sel) => { const a = document.querySelector(sel); const btns = [...a.querySelectorAll("button")].map((b) => b.textContent.trim()); return { note: !!a.querySelector("input[placeholder='What was this for?']"), verbs: btns.filter((x) => /totals|Split|Open vendor/.test(x)).length, menus: document.querySelectorAll("[data-drawer-row] button[aria-haspopup]").length }; }, shelfSel);
    record("keyboard rows", "Enter on a transaction opens the charge's shelf: note field, its verbs, no row menu", charge.note && charge.verbs >= 2 && charge.menus === 0, `note=${charge.note}, verbs=${charge.verbs}, row menus=${charge.menus}`);
    await page.keyboard.press("Escape");
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    const catRows = await page.$$("[data-drawer-row]");
    let ok = null;
    for (let i = 0; i < Math.min(catRows.length, 8) && ok === null; i++) {
      await catRows[i].click(); await shelfIs(page, true); await shelfSettled(page);
      if (!(await page.$(`${shelfSel} [role='button']`))) continue;
      await page.evaluate((sel) => document.querySelector(sel + " [role='button']").focus(), shelfSel);
      await page.keyboard.press("Enter");
      try { await page.waitForSelector(`${shelfSel} button::-p-text(Combine)`, { timeout: 8000 }); ok = true; } catch { ok = false; }
    }
    record("keyboard rows", "shelf row → vendor", ok === true, ok === null ? "no category with rows" : "");
    if (errs.length) record("keyboard rows", "page errors", false, errs[0]);
  });
}

// One page anatomy (DESIGN.md §2): the month picker is the FIRST control in
// the header's right-hand cluster on every page; search, filters and sort sit
// in a toolbar row under the header, never in it; at most one primary button.
async function pageHeader(browser) {
  await withPage(browser, async (page) => {
    for (const route of ["/", "/transactions", "/categories", "/recurrings"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.waitForSelector("header h1");
      const r = await page.evaluate(() => {
        const header = document.querySelector("header");
        const cluster = header.querySelector("h1").parentElement.nextElementSibling;
        const first = cluster && cluster.querySelector("select, button, input, a");
        const monthFirst = !!first && first.tagName === "SELECT" && [...first.options].some((o) => /^\d{4}-\d{2}$/.test(o.value));
        // Import's hidden file input lives in the header; only a visible text input counts as search.
        const inputsInHeader = header.querySelectorAll("input:not([type=file]):not([type=hidden])").length;
        const primaries = document.querySelectorAll("main .btn-primary, header .btn-primary").length;
        return { monthFirst, inputsInHeader, primaries };
      });
      record("page header", `${route} month picker leads the header's right cluster; no search in the header; ≤1 primary button`, r.monthFirst && r.inputsInHeader === 0 && r.primaries <= 1, `monthFirst=${r.monthFirst}, inputs=${r.inputsInHeader}, primaries=${r.primaries}`);
    }
  });
}

// The dashboard in the app's anatomy: one summary card (as Categories and
// Recurrings), and the uncategorized queue as a section title above a card of
// standard rows — never a card nested in a tinted card.
async function dashboardAnatomy(browser) {
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-summary]");
    const r = await page.evaluate(() => {
      const summary = document.querySelector("[data-summary]");
      const figures = summary ? summary.querySelectorAll(".stat-label").length : 0;
      const bar = !!summary?.querySelector("[role='progressbar']");
      const q = document.querySelector("[data-uncategorized]");
      const nested = document.querySelectorAll(".card .card").length;
      const rows = q ? q.querySelectorAll("[data-drawer-row] [data-category-property]").length : null;
      const summaryFirst = summary && q ? summary.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING : true;
      return { figures, bar, nested, rows, summaryFirst: !!summaryFirst, hasQueue: !!q };
    });
    record("dashboard", "one summary card with net, income and expenses and a bar", r.figures >= 3 && r.bar, `${r.figures} figures, bar=${r.bar}`);
    record("dashboard", "no card nested in a card", r.nested === 0, `${r.nested} nested`);
    record("dashboard", "uncategorized queue is standard rows below the summary (when present)", !r.hasQueue || (r.rows > 0 && r.summaryFirst), r.hasQueue ? `${r.rows} rows, summary first=${r.summaryFirst}` : "no queue in the fixture");
  });
}

async function restingActions(browser) {
  await withPage(browser, async (page) => {
    // The guard is the RESTING value (the control exists without hover). The
    // hover strengthening is only checkable where the browser reports a hover-
    // capable pointer — Tailwind wraps `hover:` in @media (hover: hover), and
    // headless Linux Chrome reports none, so there the hover half is n/a.
    const canHover = await page.evaluate(() => matchMedia("(hover: hover)").matches);
    const measure = async (label, selector) => {
      const h = await page.waitForSelector(selector, { timeout: 8000 });
      const rest = Number(await h.evaluate((el) => getComputedStyle(el).opacity));
      await h.hover(); await sleep(250);
      const hover = Number(await h.evaluate((el) => getComputedStyle(el).opacity));
      await page.mouse.move(0, 0); await sleep(150);
      const ok = rest >= 0.5 && (!canHover || hover >= 0.99);
      record("resting actions", label, ok, `rest ${rest}, hover ${canHover ? hover : "n/a (no hover pointer)"}`);
    };
    // The category's verbs live in its shelf (no verb on the row).
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const rowVerbs = await page.$$eval("[data-drawer-row] button", (bs) => bs.filter((b) => /delete|exclude from totals/i.test(b.textContent || b.getAttribute("aria-label") || "")).length);
    record("resting actions", "categories · no delete or exclude verb on a row", rowVerbs === 0, `${rowVerbs} row verbs`);
    await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
    await measure("shelf · exclude from totals", `${shelfSel} button::-p-text(xclude from totals)`);
    await measure("shelf · delete category", `${shelfSel} button[aria-label^='Delete ']`);
    // No row menu on the category shelf either: its rows carry a pill and an amount.
    const shelfMenus = await page.$$eval(`${shelfSel} button[aria-label='Edit transaction']`, (bs) => bs.length);
    record("resting actions", "shelf · no row menu on the category shelf", shelfMenus === 0, `${shelfMenus} menus`);
    // One shelf anatomy (DESIGN.md §2): at most two property cards, and the
    // way out follows the content rather than sitting in a pinned footer.
    for (const [route, label] of [["/categories", "category shelf"], ["/recurrings", "vendor shelf"]]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
      const a = await page.evaluate((sel) => { const s = document.querySelector(sel); const cards = s.querySelectorAll("[data-property-card]").length; const link = [...s.querySelectorAll("a")].find((x) => /View all transactions/.test(x.textContent)); const inScroll = !!link && !link.closest("footer") && !!link.closest(".overflow-y-auto"); return { cards, inScroll }; }, shelfSel);
      record("resting actions", `${label} · ≤2 property cards; the View-all link follows the content`, a.cards <= 2 && a.inScroll, `${a.cards} cards, link in scroll body=${a.inScroll}`);
      await page.keyboard.press("Escape");
    }
    // One category treatment: the quiet property, no tint, on both list pages.
    for (const route of ["/transactions", "/recurrings"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row] [data-category-property]");
      const r = await page.$$eval("[data-drawer-row] [data-category-property]", (els) => {
        const visible = els.filter((e) => e.offsetParent !== null);
        const tinted = visible.filter((e) => { const bg = getComputedStyle(e).backgroundColor; return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent"; }).length;
        return { n: visible.length, tinted, tints: [...new Set(els.map((e) => e.querySelector("select") ? "select" : "none"))] };
      });
      record("resting actions", `${route} · category is the quiet property (no tint, native select)`, r.n > 0 && r.tinted === 0 && r.tints.join() === "select", `${r.n} properties, ${r.tinted} tinted`);
    }
  });
}

async function partialMonthQualifiers(browser) {
  await withPage(browser, async (page) => {
    const check = async (route, month, needles, expect) => {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await pickMonth(page, month);
      const t = await lowerText(page);
      for (const n of needles) {
        const present = t.includes(n.toLowerCase());
        record("qualifiers", `${route} ${month} "${n}"`, present === expect, expect ? (present ? "present" : "MISSING") : (present ? "SHOWN on a past month" : "absent"));
      }
    };
    await check("/", CUR, ["Expenses so far", "% used so far"], true);
    await check("/categories", CUR, ["spent so far of", "left so far"], true);
    await check("/recurrings", CUR, ["paid so far of"], true);
    await check("/transactions", CUR, ["· net", "so far"], true);
    await check("/", PAST, ["Expenses so far", "% used so far"], false);
    await check("/categories", PAST, ["spent so far of"], false);
    await check("/recurrings", PAST, ["paid so far of"], false);
    await check("/transactions", PAST, ["so far"], false);
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
    const shelf = (await page.evaluate((sel) => document.querySelector(sel).innerText, shelfSel)).toLowerCase();
    // "spent so far" always; the trend line reads "… vs last month so far" when
    // there is a last month to compare with, and "new this month" when not.
    record("qualifiers", "shelf (category, current month)", shelf.includes("spent so far") && (!shelf.includes("vs last month") || shelf.includes("vs last month so far")), shelf.includes("vs last month") ? "trend qualified" : "no prior month in the fixture");
  });
}

async function statementMode(browser) {
  for (const [mode, url] of [["statement", "/transactions?vendor=Chipotle"], ["normal", "/transactions"]]) {
    await withPage(browser, async (page, errs) => {
      await page.goto(BASE + url, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const header = await page.evaluate(() => /\d+ transactions? ·/.test(document.body.innerText));
      await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
      let editor = false; try { await page.waitForSelector(`${shelfSel} input[placeholder='What was this for?']`, { timeout: 3000 }); editor = true; } catch {}
      await page.keyboard.press("Escape"); await shelfIs(page, false);
      await page.setViewport({ width: 400, height: 800 }); await sleep(400);
      const chip = await page.evaluate(() => { const s = document.querySelector("[data-drawer-row] select"); return !!s && s.offsetParent !== null; });
      record("statement mode", mode, editor && chip && (mode !== "statement" || header) && errs.length === 0, `note editor: ${editor}, mobile chip: ${chip}`);
    });
  }
}

async function splitUndo(browser) {
  await withPage(browser, async (page, errs) => {
    const api = await (await fetch(BASE + "/api/transactions?limit=60")).json();
    const cand = (api.rows ?? api).find((r) => r.amount < 0 && !r.excluded && !r.pending && !r.splitParts && !r.merchant.includes(" — "));
    const amtText = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(cand.amount));
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const found = await page.evaluate((name, amt) => {
      for (const li of document.querySelectorAll("[data-drawer-row]"))
        if (li.innerText.includes(name) && li.innerText.includes(amt)) { li.setAttribute("data-ui-target", "1"); return true; }
      return false;
    }, cand.displayName, amtText);
    if (!found) { record("split → undo", "target row", false, `no row for ${cand.displayName} ${amtText}`); return; }
    const row = "[data-drawer-row][data-ui-target]";
    const openShelf = async () => {
      await page.evaluate((sel) => { const el = document.querySelector(sel); el.scrollIntoView({ block: "center" }); el.click(); }, row);
      await shelfIs(page, true); await shelfSettled(page);
    };
    await openShelf();
    await page.click(`${shelfSel} button::-p-text(Split…)`);
    await page.waitForFunction(() => document.body.innerText.includes("Split transaction"));
    const labels = await page.$$eval("input[aria-label='Part label']", (els) => els.length);
    const total = Math.abs(cand.amount);
    const a1 = Math.round((total - 1) * 100) / 100, a2 = Math.round((total - a1) * 100) / 100;
    await page.evaluate((a1, a2) => {
      const dlg = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Split transaction"));
      const sels = dlg.querySelectorAll("select"); const amts = [...dlg.querySelectorAll("input[inputmode='decimal']")]; const lbls = [...dlg.querySelectorAll("input[aria-label='Part label']")];
      const setV = (el, v) => { const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); };
      setV(sels[0], sels[0].options[1].value); setV(sels[1], sels[1].options[2].value);
      setV(amts[0], String(a1)); setV(amts[1], String(a2)); setV(lbls[1], "UI test part");
    }, a1, a2);
    await sleep(300);
    const balanced = (await lowerText(page)).includes("balanced");
    await page.evaluate(() => { const dlg = [...document.querySelectorAll("div")].find((d) => d.innerText.startsWith("Split transaction")); const b = dlg.querySelectorAll("button"); b[b.length - 1].click(); });
    await page.waitForFunction(() => document.body.innerText.includes("split · 2 parts"), { timeout: 10000 });
    await sleep(500);
    const child = await page.evaluate(() => [...document.querySelectorAll("[data-drawer-row]")].some((li) => li.innerText.includes("— UI test part")));
    await page.evaluate(() => { for (const li of document.querySelectorAll("[data-drawer-row]")) if (li.innerText.includes("split · 2 parts")) { li.setAttribute("data-ui-target", "1"); break; } });
    await openShelf();
    const verbs = await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll("button")].map((b) => b.textContent.trim()), shelfSel);
    const hasUndo = verbs.some((v) => v.includes("Undo split (2 parts)")), hidesToggle = !verbs.some((v) => /totals/.test(v));
    await page.click(`${shelfSel} button::-p-text(Undo split)`);
    await page.waitForFunction(() => ![...document.querySelectorAll("[data-drawer-row]")].some((li) => /split · 2 parts|— UI test part/.test(li.innerText)), { timeout: 10000 });
    record("split → undo", "dialog has a label per part", labels === 2, `${labels}`);
    record("split → undo", "parts balanced", balanced);
    record("split → undo", "pill + labelled child after save", child);
    record("split → undo", "shelf: Undo split, no totals toggle on a split parent", hasUndo && hidesToggle);
    record("split → undo", "pill + children gone after undo", true);
    if (errs.length) record("split → undo", "page errors", false, errs[0]);
  });
}

async function shelfSettings(browser) {
  await withPage(browser, async (page, errs) => {
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    // the inline editor is gone; the row itself opens the shelf
    await page.waitForSelector("[data-drawer-row]");
    await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
    const shelf = () => page.evaluate((sel) => document.querySelector(sel).innerText.toLowerCase(), shelfSel);
    let t = await shelf();
    record("shelf settings", "row opens the shelf with Next due + Match", t.includes("next due") && t.includes("match"));
    record("shelf settings", "no Reset all before any override", !t.includes("reset all overrides"));
    const posts = [];
    page.on("response", async (r) => { if (r.url().includes("/api/recurrings/settings")) posts.push({ status: r.status(), body: await r.text().catch(() => "?") }); });
    await page.select(`${shelfSel} select[aria-label='Match rule']`, "contains");
    // a contains rule is complete only with text — type it and commit with Enter
    const txt = await page.waitForSelector(`${shelfSel} input[aria-label='Match text']`, { timeout: 8000 });
    await txt.type("netflix"); await page.keyboard.press("Enter");
    try {
      await page.waitForFunction((sel) => document.querySelector(sel).innerText.toLowerCase().includes("reset all overrides"), { timeout: 8000 }, shelfSel);
    } catch {
      const diag = await page.evaluate((sel) => { const a = document.querySelector(sel); const s = a.querySelector("select[aria-label='Match rule']"); return { selectValue: s && s.value, shelfTail: a.innerText.slice(-400).replace(/\n/g, " | ") }; }, shelfSel);
      record("shelf settings", "DIAG", false, JSON.stringify({ posts, ...diag }).slice(0, 700));
      throw new Error("no Reset all after selecting a match rule");
    }
    t = await shelf();
    const editedTags = await page.$$eval(`${shelfSel} span`, (els) => els.filter((e) => e.textContent === "edited").length);
    record("shelf settings", "setting a match rule → edited tag + Reset all", editedTags >= 1 && t.includes("reset all overrides"), `edited tags: ${editedTags}`);
    await page.click(`${shelfSel} button::-p-text(Reset all overrides)`);
    await page.waitForFunction((sel) => !document.querySelector(sel).innerText.toLowerCase().includes("reset all overrides"), { timeout: 8000 }, shelfSel);
    record("shelf settings", "Reset all → back to auto", true);
    const inline = await page.evaluate(() => document.body.innerText.includes("expected (go-forward; history unchanged)"));
    record("shelf settings", "no inline editor on the page", !inline);
    if (errs.length) record("shelf settings", "page errors", false, errs[0]);
  });
}

async function moneyColour(browser) {
  // The colour of the amount in the row that names `who`, on the current page.
  const colourOf = (page, who) => page.evaluate((who) => {
    const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes(who));
    if (!li) return null;
    const amt = [...li.querySelectorAll("span, div")].find((el) => /^[+−]\$[\d,]+/.test(el.textContent.trim()) && el.children.length === 0);
    return amt ? getComputedStyle(amt).color : null;
  }, who);
  await withPage(browser, async (page) => {
    for (const route of ["/transactions", "/"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const income = await colourOf(page, "Acme Corp Paycheck");
      const transfer = await colourOf(page, "Card Payment Received");
      // Tailwind v4 emits emerald as lab(); older builds as rgb(). Green = negative a* (lab) or g-dominant (rgb).
      const green = (c) => {
        if (!c) return false;
        const n = c.match(/-?\d+(\.\d+)?/g).map(Number);
        if (c.startsWith("lab(")) return n[1] < -10;
        if (c.startsWith("rgb(")) return n[1] > n[0] && n[1] > n[2];
        return false;
      };
      record("money colour", `${route} · income is green`, green(income), income);
      record("money colour", `${route} · excluded-category inflow is not`, transfer !== null && !green(transfer), transfer);
    }
  });
}

async function categoryBadge(browser) {
  // One chip, one shape: every badge on every list page is a full circle of the
  // same size (recurrings used rounded-xl before), and none shows the recurring
  // glyph as a stand-in for a missing icon.
  await withPage(browser, async (page) => {
    for (const route of ["/", "/transactions", "/categories"]) {
      await page.goto(BASE + route, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-category-badge]");
      const r = await page.$$eval("[data-category-badge]", (els) => {
        const radii = new Set(els.map((e) => getComputedStyle(e).borderRadius));
        const sizes = new Set(els.map((e) => Math.round(e.getBoundingClientRect().width)));
        const glyphFallback = els.filter((e) => e.textContent.trim() === "↻").length;
        return { n: els.length, radii: [...radii], sizes: [...sizes], glyphFallback };
      });
      const round = r.radii.every((x) => parseFloat(x) >= 999);
      record("category badge", `${route} · ${r.n} badges, one shape`, round && r.sizes.length <= 2 && r.glyphFallback === 0, `radii ${r.radii.join("/")}, widths ${r.sizes.join("/")}px, ↻ fallbacks ${r.glyphFallback}`);
    }
  });
}

async function recurringGlyph(browser) {
  // Exclude one Netflix charge from its series via the row menu; the glyph must
  // read "out" (struck) on the transactions row AND on the dashboard's recent
  // list — before, only the transactions row knew that state. Then restore.
  await withPage(browser, async (page, errs) => {
    const glyphOn = (page, who) => page.evaluate((who) => {
      const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes(who));
      const g = li && li.querySelector("[data-recurring]"); return g ? g.getAttribute("data-recurring") : null;
    }, who);
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    record("recurring glyph", "transactions · Netflix charge is in its series", (await glyphOn(page, "Netflix")) === "in");
    await page.evaluate(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); li.setAttribute("data-ui-target", "1"); li.scrollIntoView({ block: "center" }); });
    await sleep(300);
    await page.click("[data-drawer-row][data-ui-target]"); await shelfIs(page, true); await shelfSettled(page);
    await page.click(`${shelfSel} button[data-membership='in']`);
    await page.waitForFunction(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); const g = li && li.querySelector("[data-recurring]"); return g && g.getAttribute("data-recurring") === "out"; }, { timeout: 10000 });
    record("recurring glyph", "transactions · a charge taken out of its plan reads out", true);
    await page.keyboard.press("Escape"); await shelfIs(page, false);
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    record("recurring glyph", "dashboard · same charge reads out", (await glyphOn(page, "Netflix")) === "out");
    // restore
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    await page.evaluate(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); li.setAttribute("data-ui-target", "1"); li.scrollIntoView({ block: "center" }); });
    await sleep(300);
    await page.click("[data-drawer-row][data-ui-target]"); await shelfIs(page, true); await shelfSettled(page);
    await page.click(`${shelfSel} button[data-membership='out']`);
    await page.waitForFunction(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); const g = li && li.querySelector("[data-recurring]"); return g && g.getAttribute("data-recurring") === "in"; }, { timeout: 10000 });
    await page.keyboard.press("Escape");
    record("recurring glyph", "transactions · restored to in", true);
    if (errs.length) record("recurring glyph", "page errors", false, errs[0]);
  });
}

async function inlineEdit(browser) {
  // The click-to-edit name is the row button that wraps a truncated span (the
  // editable category badge also carries a ✎ cue, so target by structure).
  const clickName = (page) => page.evaluate(() => {
    const btn = [...document.querySelectorAll("[data-drawer-row] button")].find((b) => b.querySelector("span.truncate"));
    if (!btn) return null; const name = btn.querySelector("span.truncate").textContent; btn.click(); return name;
  });
  const typeIntoFocused = async (page, text) => {
    await page.waitForFunction(() => document.activeElement && document.activeElement.tagName === "INPUT", { timeout: 5000 });
    await page.evaluate(() => document.activeElement.select());
    await page.keyboard.type(text);
  };
  const rowsText = (page) => page.evaluate(() => [...document.querySelectorAll("[data-drawer-row]")].map((r) => r.innerText).join("\n"));
  await withPage(browser, async (page, errs) => {
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const original = await clickName(page);
    await typeIntoFocused(page, "Dining Out"); await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll("[data-drawer-row]")].some((r) => r.innerText.includes("Dining Out")), { timeout: 8000 });
    record("inline edit", "categories · Enter commits a rename", true, `${original} → Dining Out`);
    await clickName(page);
    await typeIntoFocused(page, "Garbage"); await page.keyboard.press("Escape");
    await sleep(600);
    const t = await rowsText(page);
    record("inline edit", "categories · Escape reverts a rename", t.includes("Dining Out") && !t.includes("Garbage"));
    const budget = await page.$("input[aria-label='Monthly budget']");
    const before = await budget.evaluate((el) => el.value);
    await budget.click({ clickCount: 3 }); await budget.type("999999"); await page.keyboard.press("Escape");
    await sleep(600);
    const afterB = await page.evaluate(() => document.querySelector("input[aria-label='Monthly budget']").value);
    record("inline edit", "categories · Escape reverts the budget input", afterB === before, `${before} → ${afterB}`);
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    const rec = await clickName(page);
    await typeIntoFocused(page, "Netflix HD"); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.body.innerText.includes("Netflix HD"), { timeout: 8000 });
    record("inline edit", "recurrings · Enter commits a rename", true, `${rec} → Netflix HD`);
    if (errs.length) record("inline edit", "page errors", false, errs[0]);
  });
}

async function recurringsRow(browser) {
  // Controls sit in fixed columns (same x on every row), read as buttons (a
  // border), use the §2 vocabulary, and the amount is full-weight foreground.
  await withPage(browser, async (page) => {
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row] select");
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-drawer-row]")].filter((li) => li.querySelector("select"));
      const x = (el) => Math.round(el.getBoundingClientRect().left);
      const rowMenus = rows.filter((li) => li.querySelector("button[aria-haspopup]")).length;
      const selects = rows.map((li) => x(li.querySelector("[data-category-caret]") || li.querySelector("select")));
      const caretGaps = rows.map((li) => { const c = li.querySelector("[data-category-caret]"); const t = c && c.previousElementSibling; return c && t ? Math.round(c.getBoundingClientRect().left - t.getBoundingClientRect().right) : null; });
      const amounts = rows.map((li) => { const els = [...li.querySelectorAll("div")]; return els.find((d) => /^\$[\d,]+\.\d\d$/.test(d.textContent.trim())); });
      const fg = getComputedStyle(document.body).color;
      const nameXs = [...new Set(rows.map((li) => x(li.children[1])))]; // date, name…
      const cadenceTags = rows.map((li) => { const t = li.querySelector("[data-cadence]"); return t ? { text: t.textContent.trim(), afterName: t.previousElementSibling != null && t.previousElementSibling.textContent.trim().length > 0 } : null; });
      const dateXs = [...new Set(rows.map((li) => x(li.children[0])))];
      const names = rows.map((li) => li.querySelector("span.truncate")).filter(Boolean);
      const truncated = names.filter((n) => n.scrollWidth > n.clientWidth).length;
      return {
        rows: rows.length,
        rowMenus, selectXs: [...new Set(selects)],
        amountColours: [...new Set(amounts.map((a) => a && getComputedStyle(a).color))], foreground: fg,
        amountStates: rows.map((li) => { const a = li.lastElementChild; return { state: a.getAttribute("data-amount-state"), color: getComputedStyle(a).color, weight: getComputedStyle(a).fontWeight }; }),
        mutedColour: getComputedStyle(document.body).getPropertyValue("--muted").trim(),
        truncated, names: names.length, nameXs, dateXs, cadenceTags,
        dateColours: [...new Set(rows.map((li) => getComputedStyle(li.children[0]).color))],
        marked: document.querySelectorAll("[data-drawer-row] button[aria-haspopup][data-marked], [data-drawer-row] button[aria-haspopup] span[aria-hidden]").length,
        caretGaps: [...new Set(caretGaps)],
        monthlyLabels: rows.filter((li) => /\bMonthly\b/.test(li.textContent)).length,
        leadingGlyphs: rows.filter((li) => li.querySelector("[data-category-badge]")).length,
        gutterSameEdge: (() => { const t = document.querySelector("h1"); const d = rows[0] && rows[0].children[0]; return t && d ? Math.abs(x(t) - x(d)) : null; })(),
        cardInset: (() => { const li = rows[0]; const card = li && li.closest(".card"); return li && card ? Math.round(li.children[0].getBoundingClientRect().left - card.getBoundingClientRect().left) : null; })(),
        // One list in date order with a Today divider: nothing overdue below
        // it, nothing upcoming above it.
        order: (() => { const list = document.querySelector("[data-bill-list]"); if (!list) return null; const items = [...list.querySelectorAll("[data-drawer-row], [data-bill-anchor='up']")]; const dues = items.filter((e) => e.hasAttribute("data-due")).map((e) => e.getAttribute("data-due")); const div = items.findIndex((e) => e.hasAttribute("data-bill-anchor")); const st = (e) => e.getAttribute("data-bill-status"); return { sorted: dues.every((d, i) => i === 0 || dues[i - 1] <= d), divider: div >= 0, odBelow: div >= 0 && items.slice(div + 1).some((e) => st(e) === "od"), upAbove: div >= 0 && items.slice(0, div).some((e) => st(e) === "up"), lists: document.querySelectorAll("[data-bill-list]").length, sections: document.querySelectorAll("[data-bill-section]").length }; })(),
        bar: (() => { const b = document.querySelector("[data-summary] [role='progressbar']"); return !!b && /%/.test(b.getAttribute("aria-label") || "") && b.getAttribute("aria-valuenow") !== null; })(),
        summary: !!document.querySelector("[data-summary] .stat-label") && [...document.querySelectorAll("[data-summary] .stat-label")].some((l) => /paid/i.test(l.textContent)) && /overdue/i.test(document.querySelector("[data-summary]").textContent),
      };
    });
    record("recurrings row", `${r.rows} rows · no row menu (the verbs live in the shelf)`, r.rows >= 2 && r.rowMenus === 0, `row menus: ${r.rowMenus}`);
    record("recurrings row", "category chevrons in one column", r.selectXs.length === 1, `x=${r.selectXs.join("/")}`);
    record("recurrings row", "category chevron sits beside its label", r.caretGaps.every((g) => g !== null && g <= 8), `gaps ${r.caretGaps.join("/")}px`);
    record("recurrings row", "cadence shows only when not monthly, as a tag after the name", r.monthlyLabels === 0 && r.cadenceTags.every((t) => t === null || t.afterName), `"Monthly" rows: ${r.monthlyLabels}; tags: ${r.cadenceTags.filter(Boolean).map((t) => t.text).join("/") || "none"}`);
    record("recurrings row", "one category icon per row (none before the name)", r.leadingGlyphs === 0, `leading glyphs: ${r.leadingGlyphs}`);
    {
      // Paid amounts are settled (foreground, semibold); expected ones are
      // provisional (muted, medium). The fixture has both.
      const hex = (rgb) => { const m = rgb.match(/\d+/g); return m ? "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : rgb; };
      const paid = r.amountStates.filter((a) => a.state === "settled");
      const expected = r.amountStates.filter((a) => a.state === "provisional");
      const paidOk = paid.length > 0 && paid.every((a) => a.color === r.foreground && Number(a.weight) >= 600);
      const expectedOk = expected.length > 0 && expected.every((a) => hex(a.color) === r.mutedColour.toLowerCase() && Number(a.weight) === 500);
      record("recurrings row", "paid amounts read settled, expected amounts read provisional", paidOk && expectedOk, `paid ${paid.length} (fg, ≥600), expected ${expected.length} (muted, 500)`);
    }
    record("recurrings row", "no name truncated at 1280px", r.truncated === 0, `${r.truncated} of ${r.names}`);
    record("recurrings row", "date and name columns share one x each", r.dateXs.length === 1 && r.nameXs.length === 1, `date x=${r.dateXs.join("/")}, name x=${r.nameXs.join("/")}`);
    record("recurrings row", "rows sit in section cards, text inset by the card's border + 16px padding", r.cardInset === 17, `inset ${r.cardInset}px`);
    record("recurrings row", "one list in date order; the Today divider has nothing overdue below it or upcoming above it", !!r.order && r.order.sorted && r.order.sections === 0 && !r.order.odBelow && !r.order.upAbove, r.order ? `sorted=${r.order.sorted}, divider=${r.order.divider}, sections=${r.order.sections}` : "no list");
    record("recurrings row", "summary card shows paid, left to pay, and the status line", r.summary, r.summary ? "present" : "missing");
    record("recurrings row", "summary bar is a labelled progressbar", r.bar, r.bar ? "role + label + value" : "missing");
    // Escape in steps: the first closes the shelf and leaves the row focused
    // (a keyboard user still knows where they are); the second drops focus.
    {
      await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      await page.click("[data-drawer-row]"); await page.waitForSelector("[data-shelf]");
      await page.keyboard.press("Escape"); await new Promise((r) => setTimeout(r, 300));
      const afterOne = await page.evaluate(() => ({ shelf: !!document.querySelector("[data-shelf]"), rowFocused: document.activeElement?.hasAttribute("data-drawer-row") }));
      await page.keyboard.press("Escape"); await new Promise((r) => setTimeout(r, 200));
      const afterTwo = await page.evaluate(() => ({ rowFocused: document.activeElement?.hasAttribute("data-drawer-row"), tag: document.activeElement?.tagName }));
      record("keyboard rows", "Escape closes the shelf, then Escape drops the row's focus", !afterOne.shelf && afterOne.rowFocused && !afterTwo.rowFocused, `after 1: shelf=${afterOne.shelf} row=${afterOne.rowFocused}; after 2: row=${afterTwo.rowFocused} (${afterTwo.tag})`);
    }
    // ↓ with the shelf open moves the shelf to the next row; ↑ moves it back.
    {
      await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const names = await page.$$eval("[data-drawer-row]", (rows) => rows.map((r) => r.children[1].textContent.replace("✎", "").trim()));
      await page.click("[data-drawer-row]"); await page.waitForSelector("[data-shelf]");
      const title = () => page.$eval("[data-shelf] header", (h) => h.innerText.split("\n")[0].replace("✎", "").trim());
      const t0 = await title();
      await page.keyboard.press("ArrowDown"); await new Promise((r) => setTimeout(r, 700));
      const t1 = await title();
      await page.keyboard.press("ArrowUp"); await new Promise((r) => setTimeout(r, 700));
      const t2 = await title();
      record("keyboard rows", "↓ / ↑ move the open shelf to the adjacent row", names.length >= 2 && t0 !== t1 && t1.startsWith(names[1].slice(0, 6)) && t2 === t0, `${t0} → ${t1} → ${t2}`);
      await page.keyboard.press("Escape");
    }
    // The vendor shelf's Recent rows carry one two-state pill: "In plan"
    // flips to "Not in plan" (with an edited tag: the user decided) and back
    // — no menu.
    {
      await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      await page.evaluate(() => { const row = [...document.querySelectorAll("[data-drawer-row]")].find((r) => /Netflix/.test(r.textContent)); row?.click(); });
      await page.waitForSelector("[data-shelf] button[data-membership]");
      const pillText = () => page.$eval("[data-shelf] button[data-membership]", (b) => b.textContent.trim());
      const menus = await page.$$eval("[data-shelf] button[aria-label='Edit transaction']", (bs) => bs.length);
      const pillEdited = () => page.$eval("[data-shelf] button[data-membership]", (b) => b.getAttribute("data-edited") === "1");
      const t1 = await pillText();
      const e1 = await pillEdited();
      // The toggle must not blank the shelf (no skeleton) while it re-reads.
      const flashed = await page.evaluate(async () => { let seen = false; const b = document.querySelector("[data-shelf] button[data-membership]"); b.click(); const t0 = Date.now(); while (Date.now() - t0 < 1200) { if (document.querySelector("[data-shelf] .animate-pulse")) seen = true; await new Promise((r) => setTimeout(r, 30)); } return seen; });
      await page.waitForSelector("[data-shelf] button[data-membership]");
      const t2 = await pillText();
      const e2 = await pillEdited();
      await page.click("[data-shelf] button[data-membership]"); await new Promise((r) => setTimeout(r, 1200));
      await page.waitForSelector("[data-shelf] button[data-membership]");
      const t3 = await pillText();
      record("shelf", "Recent rows: one two-state pill flips a charge out (edited) and back (auto); no row menu", menus === 0 && t1 === "In plan" && !e1 && t2 === "Not in plan" && e2 && t3 === "In plan", `menus ${menus}; ${t1}${e1 ? " (edited)" : ""} → ${t2}${e2 ? " (edited)" : ""} → ${t3}`);
      record("shelf", "toggling a pill re-reads without blanking the shelf", !flashed, flashed ? "skeleton flashed" : "no skeleton");
      await page.keyboard.press("Escape");
    }
    // The inline editor raises no tooltip: hovering a name, or its ✎ cue, shows
    // nothing (the button's aria-label carries "Rename"). Hover media only.
    {
      const canHover = await page.evaluate(() => matchMedia("(hover: hover)").matches);
      if (canHover) {
        const nameText = await page.$("[data-drawer-row] button[aria-label^='Rename'] > span:first-child");
        await nameText.hover(); await new Promise((r) => setTimeout(r, 200));
        const cue = await page.$("[data-drawer-row] button[aria-label^='Rename'] > span:last-child");
        await cue.hover(); await new Promise((r) => setTimeout(r, 200));
        const tip = await page.$("[role='tooltip']");
        const label = await page.$eval("[data-drawer-row] button[aria-label^='Rename']", (b) => b.getAttribute("aria-label"));
        record("inline edit", "no rename bubble; the button is labelled for assistive tech", !tip && /^Rename /.test(label || ""), `tooltip: ${!!tip}; aria-label: ${label}`);
        await page.mouse.move(5, 5);
      }
    }
    // Narrow layouts: with the sidebar up and a ~330px content column, the row
    // must still show its name and keep its amount inside the card.
    for (const w of [700, 900]) {
      await page.setViewport({ width: w, height: 700 });
      await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row]");
      const n = await page.evaluate(() => { const row = document.querySelector("[data-drawer-row]"); const kids = [...row.children]; const name = kids[1].getBoundingClientRect(); const amount = kids[kids.length - 1].getBoundingClientRect(); const rb = row.getBoundingClientRect(); return { name: Math.round(name.width), amountInside: amount.right <= rb.right + 1, overflow: row.scrollWidth - row.clientWidth }; });
      record("recurrings row", `at ${w}px the name has room and the amount stays inside the card`, n.name >= 60 && n.amountInside && n.overflow <= 0, `name ${n.name}px, amount inside=${n.amountInside}, overflow ${n.overflow}px`);
    }
    await page.setViewport({ width: 1280, height: 860 });
    // A hovered row takes the hover token — a wash of the card surface, not the
    // page grey behind it. Hover media is not available in headless Linux CI.
    {
      const canHover = await page.evaluate(() => matchMedia("(hover: hover)").matches);
      if (canHover) {
        const row = await page.$("[data-drawer-row]");
        await row.hover(); await new Promise((r) => setTimeout(r, 150));
        const c = await page.evaluate(() => { const el = document.querySelector("[data-drawer-row]"); const cs = getComputedStyle(el).backgroundColor; const root = getComputedStyle(document.documentElement); return { row: cs, page: root.getPropertyValue("--background").trim(), card: root.getPropertyValue("--card").trim() }; });
        const hex = (rgb) => { const m = rgb.match(/\d+/g); return m ? "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : rgb; };
        const rowHex = hex(c.row);
        record("recurrings row", "hovered row is a wash of the card, not the page grey", rowHex !== c.page.toLowerCase() && rowHex !== c.card.toLowerCase() && rowHex !== "#000000", `row ${rowHex}, page ${c.page}, card ${c.card}`);
      }
    }
    // A count in the status line jumps to its section.
    {
      const target = "[data-bill-anchor='up'], [data-bill-status='up']";
      const before = await page.evaluate((q) => document.querySelector(q)?.getBoundingClientRect().top ?? null, target);
      await page.evaluate(() => window.scrollTo(0, 0));
      const clicked = await page.$("[data-section-link='up']");
      if (clicked) { await clicked.click(); await new Promise((r) => setTimeout(r, 700)); }
      // On a page shorter than the viewport nothing can scroll; the section must
      // simply be in view. On a taller page it must land near the top.
      const after = await page.evaluate((q) => { const el = document.querySelector(q); const top = el ? el.getBoundingClientRect().top : null; return { top, scrollable: document.documentElement.scrollHeight > window.innerHeight + 10, vh: window.innerHeight }; }, target);
      const ok = !!clicked && after.top !== null && after.top >= -2 && (after.scrollable ? after.top <= 120 : after.top <= after.vh);
      record("recurrings row", "'N upcoming' in the summary scrolls to the Today divider (or the first upcoming row)", ok, clicked ? `target top ${before}px → ${after.top}px${after.scrollable ? "" : " (page fits the viewport)"}` : "no link");
    }
    const strayDot = await page.evaluate(() => [...document.querySelectorAll("[data-drawer-row] span[aria-label='Has custom settings']")].length);
    record("recurrings row", "no settings dot anywhere in the row", strayDot === 0 && r.marked === 0, `on ⋯: ${r.marked}, after name: ${strayDot}`);
    // the verbs live in the shelf, in §2 vocabulary, reached from the row
    await page.click("[data-drawer-row]"); await page.waitForSelector("[data-shelf]");
    const shelfText = await page.evaluate(() => document.querySelector("[data-shelf]").innerText);
    record("recurrings row", "the row opens the shelf, which holds Not recurring + Mark as ended", shelfText.includes("Not recurring") && shelfText.includes("Mark as ended"), "both present");
    await page.keyboard.press("Escape");

    // "+ New category…" in a row's dropdown creates the category in place and
    // applies it to that row (DESIGN: correct on the object, not in a panel).
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row] select[aria-label='Category']");
    await page.select("[data-drawer-row] select[aria-label='Category']", "__new__");
    const popover = await page.waitForSelector("[role='dialog'][aria-label='New category'] [data-new-category-form]", { timeout: 5000 }).catch(() => null);
    record("recurrings row", "+ New category… opens the create form under the dropdown", !!popover, popover ? "form shown" : "no form");
    if (popover) {
      await page.type("[data-new-category-form] input[aria-label='New category name']", "Lake Utilities");
      await page.click("[data-new-category-form] button.btn-primary");
      const applied = await page
        .waitForFunction(
          () => document.querySelector("[data-drawer-row] [data-category-caret]")?.previousElementSibling?.textContent?.includes("Lake Utilities"),
          { timeout: 8000 }
        )
        .then(() => true)
        .catch(() => false);
      const gone = await page.$("[role='dialog'][aria-label='New category']");
      record("recurrings row", "created category is applied to that row and the form closes", applied && !gone, `applied=${applied} form open=${!!gone}`);
      const inFilter = await page.$$eval("select[aria-label='Filter by category'] option, select option", (os) => os.some((o) => o.textContent.includes("Lake Utilities")));
      record("recurrings row", "new category appears in the pickers without a reload", inFilter, inFilter ? "listed" : "missing");
    }

    // The same option in the shelf's Category field: the popover is portaled
    // outside the shelf panel, so clicking into it must not close the shelf.
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    await page.click("[data-drawer-row]");
    await page.waitForSelector("aside.fixed select[aria-label='Category']", { timeout: 8000 });
    await page.select("aside.fixed select[aria-label='Category']", "__new__");
    const shelfForm = await page.waitForSelector("[role='dialog'][aria-label='New category'] input[aria-label='New category name']", { timeout: 5000 }).catch(() => null);
    record("shelf", "+ New category… in the shelf's Category field opens the form", !!shelfForm, shelfForm ? "form shown" : "no form");
    if (shelfForm) {
      await shelfForm.click();
      await page.type("[data-new-category-form] input[aria-label='New category name']", "Lake Taxes");
      await page.click("[data-new-category-form] button.btn-primary");
      const applied = await page
        .waitForFunction(() => {
          const sel = document.querySelector("aside.fixed select[aria-label='Category']");
          return !!sel && sel.options[sel.selectedIndex]?.textContent.includes("Lake Taxes");
        }, { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      const shelfOpen = !!(await page.$("aside.fixed"));
      record("shelf", "created category is applied to the vendor and the shelf stays open", applied && shelfOpen, `applied=${applied} shelf open=${shelfOpen}`);
    }
    await page.screenshot({ path: "/tmp/copilot-recurrings-row.png" });
  });
}

// ---------- main ----------
const t0 = Date.now();
let browser;
try {
  await waitForServer();
  await loadFixture();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  for (const [name, fn] of [
    ["load states", honestLoadStates], ["keyboard rows", keyboardRows], ["page header", pageHeader], ["dashboard", dashboardAnatomy], ["resting actions", restingActions],
    ["qualifiers", partialMonthQualifiers], ["statement mode", statementMode], ["split → undo", splitUndo],
    ["shelf settings", shelfSettings], ["money colour", moneyColour], ["category badge", categoryBadge], ["recurring glyph", recurringGlyph], ["inline edit", inlineEdit], ["recurrings row", recurringsRow],
  ]) {
    try { await fn(browser); } catch (e) { record(name, "threw", false, String(e.message).split("\n")[0]); }
  }
} finally {
  if (browser) await browser.close();
  stopServer();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "✖" : "✔"} test:ui — ${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)}s`);
if (failed.length) { console.table(failed); process.exit(1); }
