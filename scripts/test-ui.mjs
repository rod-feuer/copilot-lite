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
    await measure("recurrings · mark ended", "button::-p-text(mark ended)");
    await measure("recurrings · not recurring", "button::-p-text(not recurring)");
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
    // the inline editor is gone; Edit opens the shelf
    const edit = await page.waitForSelector("[data-drawer-row] button::-p-text(Edit)", { timeout: 8000 });
    await edit.click(); await shelfIs(page, true); await shelfSettled(page);
    const shelf = () => page.evaluate((sel) => document.querySelector(sel).innerText.toLowerCase(), shelfSel);
    let t = await shelf();
    record("shelf settings", "Edit opens the shelf with Next due + Match", t.includes("next due") && t.includes("match"));
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
    ["shelf settings", shelfSettings],
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
