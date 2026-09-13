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
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row] button[aria-haspopup]");
    await page.evaluate(() => document.querySelector("[data-drawer-row] button[aria-haspopup]").focus());
    await page.keyboard.press("Enter"); await sleep(400);
    const menu = await page.evaluate(() => !!document.querySelector("[role='menu']"));
    const shelf = await page.evaluate((sel) => { const a = document.querySelector(sel); return !!a && a.innerText.trim().length > 0; }, shelfSel);
    record("keyboard rows", "nested ⋯ does not open the shelf", menu && !shelf, `menu: ${menu}, shelf: ${shelf}`);
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
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await measure("categories · exclude from totals", "button::-p-text(exclude from totals)");
    await measure("categories · delete", "button[aria-label^='Delete ']");
    await page.goto(BASE + "/recurrings", { waitUntil: "networkidle2" });
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
    await measure("shelf · row ⋯", `${shelfSel} button[aria-label='Edit transaction']`);
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
    await check("/recurrings", CUR, ["left to pay (expected)"], true);
    await check("/transactions", CUR, ["· net", "so far"], true);
    await check("/", PAST, ["Expenses so far", "% used so far"], false);
    await check("/categories", PAST, ["spent so far of"], false);
    await check("/recurrings", PAST, ["left to pay (expected)"], false);
    await check("/transactions", PAST, ["so far"], false);
    await page.goto(BASE + "/categories", { waitUntil: "networkidle2" });
    await page.click("[data-drawer-row]"); await shelfIs(page, true); await shelfSettled(page);
    const shelf = (await page.evaluate((sel) => document.querySelector(sel).innerText, shelfSel)).toLowerCase();
    record("qualifiers", "shelf (category, current month)", shelf.includes("spent so far") && shelf.includes("so far vs last mo"));
  });
}

async function statementMode(browser) {
  for (const [mode, url] of [["statement", "/transactions?vendor=Chipotle"], ["normal", "/transactions"]]) {
    await withPage(browser, async (page, errs) => {
      await page.goto(BASE + url, { waitUntil: "networkidle2" });
      await page.waitForSelector("[data-drawer-row] button[aria-haspopup]");
      const header = await page.evaluate(() => /\d+ transactions? ·/.test(document.body.innerText));
      await page.click("[data-drawer-row] button[aria-haspopup]");
      await page.waitForSelector("[role='menu']");
      await page.click("[role='menu'] button::-p-text(note)");
      let editor = false; try { await page.waitForSelector("input[placeholder='What was this for?']", { timeout: 3000 }); editor = true; } catch {}
      await page.keyboard.press("Escape");
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
    const openMenu = async () => {
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "center" }), row);
      await sleep(400);
      await page.click(`${row} button[aria-haspopup]`); await page.waitForSelector("[role='menu']", { timeout: 8000 });
    };
    await openMenu();
    await page.click("[role='menu'] button::-p-text(Split…)");
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
    await openMenu();
    const menuText = await page.evaluate(() => document.querySelector("[role='menu']").innerText);
    const hasUndo = menuText.includes("Undo split (2 parts)"), hidesToggle = !/totals/.test(menuText);
    await page.click("[role='menu'] button::-p-text(Undo split)");
    await page.waitForFunction(() => ![...document.querySelectorAll("[data-drawer-row]")].some((li) => /split · 2 parts|— UI test part/.test(li.innerText)), { timeout: 10000 });
    record("split → undo", "dialog has a label per part", labels === 2, `${labels}`);
    record("split → undo", "parts balanced", balanced);
    record("split → undo", "pill + labelled child after save", child);
    record("split → undo", "menu: Undo split, no totals toggle", hasUndo && hidesToggle);
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
    for (const route of ["/", "/transactions", "/recurrings", "/categories"]) {
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
    await page.click("[data-drawer-row][data-ui-target] button[aria-haspopup]"); await page.waitForSelector("[role='menu']");
    await page.click("[role='menu'] button::-p-text(Exclude this charge)");
    await page.waitForFunction(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); const g = li && li.querySelector("[data-recurring]"); return g && g.getAttribute("data-recurring") === "out"; }, { timeout: 10000 });
    record("recurring glyph", "transactions · excluded charge reads out", true);
    await page.goto(BASE + "/", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    record("recurring glyph", "dashboard · same charge reads out", (await glyphOn(page, "Netflix")) === "out");
    // restore
    await page.goto(BASE + "/transactions", { waitUntil: "networkidle2" });
    await page.waitForSelector("[data-drawer-row]");
    await page.evaluate(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); li.setAttribute("data-ui-target", "1"); li.scrollIntoView({ block: "center" }); });
    await sleep(300);
    await page.click("[data-drawer-row][data-ui-target] button[aria-haspopup]"); await page.waitForSelector("[role='menu']");
    await page.click("[role='menu'] button::-p-text(Add charge to series)");
    await page.waitForFunction(() => { const li = [...document.querySelectorAll("[data-drawer-row]")].find((el) => el.innerText.includes("Netflix")); const g = li && li.querySelector("[data-recurring]"); return g && g.getAttribute("data-recurring") === "in"; }, { timeout: 10000 });
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
    await page.waitForSelector("[data-drawer-row] button[aria-haspopup]");
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-drawer-row]")].filter((li) => li.querySelector("select"));
      const x = (el) => Math.round(el.getBoundingClientRect().left);
      const edits = rows.map((li) => x(li.querySelector("button[aria-haspopup]")));
      const selects = rows.map((li) => x(li.querySelector("select")));
      const amounts = rows.map((li) => { const els = [...li.querySelectorAll("div")]; return els.find((d) => /^\$[\d,]+\.\d\d$/.test(d.textContent.trim())); });
      const fg = getComputedStyle(document.body).color;
      const cadXs = [...new Set(rows.map((li) => x(li.children[1])))]; // date, cadence, glyph, name…
      const dateXs = [...new Set(rows.map((li) => x(li.children[0])))];
      const names = rows.map((li) => li.querySelector("span.truncate")).filter(Boolean);
      const truncated = names.filter((n) => n.scrollWidth > n.clientWidth).length;
      return {
        rows: rows.length,
        editXs: [...new Set(edits)], selectXs: [...new Set(selects)],
        amountColours: [...new Set(amounts.map((a) => a && getComputedStyle(a).color))], foreground: fg,
        truncated, names: names.length, cadXs, dateXs,
        dateColours: [...new Set(rows.map((li) => getComputedStyle(li.children[0]).color))],
        marked: document.querySelectorAll("[data-drawer-row] button[aria-haspopup][data-marked]").length,
        gutterSameEdge: (() => { const t = document.querySelector("h1"); const d = rows[0] && rows[0].children[0]; return t && d ? Math.abs(x(t) - x(d)) : null; })(),
      };
    });
    record("recurrings row", `${r.rows} rows · ⋯ menus in one column`, r.rows >= 2 && r.editXs.length === 1, `x=${r.editXs.join("/")}`);
    record("recurrings row", "category selects in one column", r.selectXs.length === 1, `x=${r.selectXs.join("/")}`);
    record("recurrings row", "amounts are full-weight foreground", r.amountColours.length === 1 && r.amountColours[0] === r.foreground, `${r.amountColours.join("/")} vs ${r.foreground}`);
    record("recurrings row", "no name truncated at 1280px", r.truncated === 0, `${r.truncated} of ${r.names}`);
    record("recurrings row", "date and cadence columns share one x each", r.dateXs.length === 1 && r.cadXs.length === 1, `date x=${r.dateXs.join("/")}, cadence x=${r.cadXs.join("/")}`);
    record("recurrings row", "row text starts on the title's left edge", r.gutterSameEdge !== null && r.gutterSameEdge <= 1, `Δ ${r.gutterSameEdge}px`);
    const strayDot = await page.evaluate(() => [...document.querySelectorAll("[data-drawer-row] span[aria-label='Has custom settings']")].length);
    record("recurrings row", "settings mark rides the ⋯ (no dot after the name)", strayDot === 0, `marked ⋯: ${r.marked}, stray dots: ${strayDot}`);
    // the verbs live in the row's ⋯ menu, in §2 vocabulary
    await page.click("[data-drawer-row] button[aria-haspopup]"); await page.waitForSelector("[role='menu']");
    const menu = await page.evaluate(() => document.querySelector("[role='menu']").innerText);
    record("recurrings row", "⋯ menu holds Mark ended + Not recurring", menu.includes("Mark ended") && menu.includes("Not recurring"), menu.replace(/\n/g, " · "));
    await page.keyboard.press("Escape");
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
    ["load states", honestLoadStates], ["keyboard rows", keyboardRows], ["resting actions", restingActions],
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
