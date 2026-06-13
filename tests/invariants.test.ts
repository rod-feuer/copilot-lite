// Throwaway DB before anything opens a connection (see tests/db.test.ts).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.COPILOT_DB_PATH = path.join(
  os.tmpdir(),
  `copilot-inv-${process.pid}-${Date.now()}.db`
);

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  getDb,
  renormalizeMerchants,
  undoRenormalizeMerchants,
  cleanupUndoAvailable,
} from "../src/lib/db";
import { dashboard, detectRecurrings, categorizeByHistory } from "../src/lib/core";
import {
  listTransactions,
  merchantSummary,
  categoriesWithTotals,
  setRecurringSetting,
  setTransactionRecurringExcluded,
  clearRecurringTxExclusionsForMerchant,
  recurringsForMonth,
  recurringMonthlyByCategory,
  isRecurringActive,
  setBudget,
  getBudgets,
  getBudgetsFull,
  setTransactionNote,
  setTransactionExcluded,
  updateCategory,
  recurringEnded,
  transactionsSummary,
  getMerchantLinks,
  canonicalMerchant,
  linkMerchant,
  setRecurringOverride,
  suggestedRecurrings,
} from "../src/lib/queries";
import {
  stripLocationSuffix,
  mergeSuggestions,
  recurringMatchSuggestions,
  nameEqualityMergeSuggestions,
  mergePreview,
  nameAffinity,
  NAME_MATCH,
  approveMerge,
  dismissMerge,
} from "../src/lib/merges";
import { createSplitRule, applySplitRules } from "../src/lib/splits";
import { importPlaidTransactions } from "../src/lib/plaid";

let CAT: number, CAT_INC: number, CAT_EXC: number, CAT_X: number;

function addCat(name: string, kind = "expense", excl = 0): number {
  const info = getDb()
    .prepare(
      "INSERT INTO categories (name, color, icon, kind, excludeFromTotals) VALUES (?,?,?,?,?)"
    )
    .run(name, "#888", "•", kind, excl);
  return Number(info.lastInsertRowid);
}
type TxOpts = {
  amount: number;
  date?: string;
  effectiveDate?: string | null;
  categoryId?: number | null;
  excluded?: 0 | 1;
  account?: string;
  hash?: string;
  recurringId?: number | null;
};
let hashSeq = 0;
function tx(merchant: string, o: TxOpts) {
  getDb()
    .prepare(
      `INSERT INTO transactions (date, effectiveDate, merchant, amount, categoryId, account, excluded, recurringId, source, hash)
       VALUES (@date, @effectiveDate, @merchant, @amount, @categoryId, @account, @excluded, @recurringId, 'test', @hash)`
    )
    .run({
      date: o.date ?? "2025-06-15",
      effectiveDate: o.effectiveDate ?? null,
      merchant,
      amount: o.amount,
      categoryId: o.categoryId ?? null,
      account: o.account ?? "Checking",
      excluded: o.excluded ?? 0,
      recurringId: o.recurringId ?? null,
      hash: o.hash ?? `h${hashSeq++}`,
    });
}

before(() => {
  CAT = addCat("Groceries");
  CAT_INC = addCat("Income", "income");
  CAT_EXC = addCat("Transfers", "expense", 1); // excludeFromTotals
  CAT_X = addCat("Home");
});
beforeEach(() => {
  for (const t of ["transactions", "recurrings", "merchant_links", "recurring_settings", "recurring_overrides", "split_rules", "merchant_cleanup_log", "recurring_tx_exclusions", "merchant_merge_dismissals", "budgets"])
    getDb().exec(`DELETE FROM ${t}`);
});
after(() => {
  const p = process.env.COPILOT_DB_PATH!;
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(p + ext, { force: true });
});

test("merchantSummary lists descriptor names; only linked aliases are unlinkable", () => {
  linkMerchant("South Co", "Main Co");
  tx("Main Co", { amount: -10, categoryId: CAT });
  tx("South Co", { amount: -11, categoryId: CAT });

  const byName = Object.fromEntries(merchantSummary("Main Co").names.map((n) => [n.name, n]));
  assert.ok(byName["Main Co"] && byName["South Co"], "both descriptors are listed");
  assert.equal(byName["South Co"].canUnlink, true, "the linked alias can be split off");
  assert.equal(byName["Main Co"].canUnlink, false, "the primary has no link to remove");
});

test("a vendor's alias reads from the canonical merchant, whichever descriptor opened the shelf", () => {
  // WHY: per-vendor settings (alias, expected amount, cadence) belong to the
  // vendor, not the descriptor. The bug keyed them on whatever descriptor opened
  // the shelf, so opening on a folded-in variant ("Charlest") split the displayed
  // name from the saved alias — the header showed the old name and re-typing the
  // alias was a silent no-op (next === currentAlias).
  tx("Charlestons Carmel", { amount: -50, categoryId: CAT });
  tx("Charlest", { amount: -48, categoryId: CAT });
  linkMerchant("Charlest", "Charlestons Carmel"); // canonical = Charlestons Carmel
  setRecurringSetting("Charlestons Carmel", { alias: "Charleston's" });

  for (const m of ["Charlestons Carmel", "Charlest"]) {
    const s = merchantSummary(m);
    assert.equal(s.displayName, "Charleston's", `displayName must come from the canonical, via ${m}`);
    assert.equal(s.alias, "Charleston's", `alias must come from the canonical, via ${m}`);
  }
});

test("a per-transaction note is trimmed, isolated to its row, and cleared by whitespace", () => {
  // WHY: a generic payment vendor (Venmo) covers many unrelated purchases. A note
  // explaining one charge must attach to THAT transaction only — never bleed to
  // the vendor's other rows (the whole point of a per-transaction memo).
  tx("Venmo", { amount: -40, categoryId: CAT_EXC });
  tx("Venmo", { amount: -25, categoryId: CAT_EXC });
  const rows = listTransactions({});
  const a = rows.find((r) => r.amount === -40)!;
  const b = rows.find((r) => r.amount === -25)!;

  setTransactionNote(a.id, "  basketball coaching for my son  ");
  let after = listTransactions({});
  assert.equal(
    after.find((r) => r.id === a.id)!.note,
    "basketball coaching for my son",
    "note is saved trimmed"
  );
  assert.equal(after.find((r) => r.id === b.id)!.note, null, "the other Venmo row is untouched");

  setTransactionNote(a.id, "   ");
  after = listTransactions({});
  assert.equal(after.find((r) => r.id === a.id)!.note, null, "whitespace-only clears the note");
});

test("updateCategory changes only the attributes given, never clobbering the rest", () => {
  // WHY: setting an icon on an existing category (the only post-creation edit)
  // must not silently reset its color or name — a partial PATCH stays partial.
  const id = addCat("Cody"); // addCat seeds color "#888", icon "•"
  const read = () =>
    getDb().prepare("SELECT name, icon, color FROM categories WHERE id = ?").get(id) as {
      name: string;
      icon: string;
      color: string;
    };

  updateCategory(id, { icon: "🏀" });
  let c = read();
  assert.equal(c.icon, "🏀", "icon updated");
  assert.equal(c.color, "#888", "color untouched when only icon changes");
  assert.equal(c.name, "Cody", "name untouched");

  updateCategory(id, { color: "#ef4444" });
  c = read();
  assert.equal(c.color, "#ef4444", "color updated");
  assert.equal(c.icon, "🏀", "icon retained across a later color edit");

  updateCategory(id, {}); // empty patch is a no-op, not a wipe
  c = read();
  assert.equal(c.icon, "🏀");
  assert.equal(c.color, "#ef4444");
});

test("setTransactionExcluded drops one charge from the net, and re-including restores it", () => {
  // WHY: the per-transaction exclude is a real one-off correction (a reimbursed
  // charge), distinct from a category-wide exclude — so flagging a single row
  // must remove exactly its amount from the summary net, and unflagging must put
  // it back. A toggle that didn't reconcile would silently misstate the total.
  tx("Kroger", { amount: -100, categoryId: CAT, hash: "exA" });
  tx("Refunded Thing", { amount: -60, categoryId: CAT, hash: "exB" });
  const id = (getDb().prepare("SELECT id FROM transactions WHERE hash = 'exB'").get() as { id: number }).id;

  assert.equal(transactionsSummary({ month: "2025-06" }).net, -160, "both charges count before exclusion");
  setTransactionExcluded(id, true);
  assert.equal(transactionsSummary({ month: "2025-06" }).net, -100, "the excluded $60 drops out of net");
  assert.equal(transactionsSummary({ month: "2025-06" }).count, 2, "but it still shows in the list (count unchanged)");
  setTransactionExcluded(id, false);
  assert.equal(transactionsSummary({ month: "2025-06" }).net, -160, "re-including restores it exactly");
});

test("updateCategory kind flips how the category's rows are summed (expense↔income)", () => {
  // WHY: kind is editable as a correction, and it isn't cosmetic — an expense
  // category sums outflows, an income category sums inflows. Changing kind must
  // re-derive the total against the same rows, or the figure would lie.
  const id = addCat("Side Gig"); // seeded as expense
  tx("Client A", { amount: 800, categoryId: id, hash: "kA" }); // inflow
  tx("Stripe Fee", { amount: -20, categoryId: id, hash: "kB" }); // outflow

  const totalFor = () => categoriesWithTotals("2025-06").find((c) => c.id === id)!;
  assert.equal(totalFor().total, 20, "as an expense category it sums the outflow only");
  updateCategory(id, { kind: "income" });
  assert.equal(totalFor().kind, "income", "kind is updated");
  assert.equal(totalFor().total, 800, "as income it now sums the inflow instead");
});

test("display name resolves consistently in drawer and transactions list", () => {
  tx("Jpmorgan Chase Chase Ach", { amount: -4800, categoryId: CAT_X });
  setRecurringSetting("Jpmorgan Chase Chase Ach", { alias: "Chase Mortgage (Lake)" });
  assert.equal(merchantSummary("Jpmorgan Chase Chase Ach").displayName, "Chase Mortgage (Lake)");
  const rows = listTransactions({});
  const r = rows.find((x) => x.merchant === "Jpmorgan Chase Chase Ach");
  assert.equal(r!.displayName, "Chase Mortgage (Lake)");
});

test("paginated list returns disjoint pages; summary spans the full filtered set", () => {
  // WHY: the list is fetched page by page, so the header's count + net total
  // can't be derived from the loaded rows — the server must report them over the
  // whole filtered set, with the same excluded-aware net the dashboard uses.
  for (let i = 1; i <= 5; i++)
    tx(`Shop ${i}`, { amount: -10 * i, date: `2025-06-1${i}`, categoryId: CAT });
  tx("Transfer X", { amount: -1000, date: "2025-06-16", categoryId: CAT_EXC }); // excludeFromTotals

  const s = transactionsSummary({ month: "2025-06" });
  assert.equal(s.count, 6, "count spans every matched row, including the excluded one");
  assert.equal(s.net, -150, "net excludes the excludeFromTotals category (−10−20−30−40−50)");

  const p1 = listTransactions({ month: "2025-06", sort: "date", dir: "desc", limit: 2, offset: 0 });
  const p2 = listTransactions({ month: "2025-06", sort: "date", dir: "desc", limit: 2, offset: 2 });
  assert.equal(p1.length, 2, "first page is one page worth");
  assert.equal(p2.length, 2, "second page continues from the offset");
  assert.equal(new Set([...p1, ...p2].map((r) => r.id)).size, 4, "pages don't overlap");
});

test("excluded rows and excluded categories never count toward totals", () => {
  tx("Kroger", { amount: -100, categoryId: CAT });
  tx("Kroger", { amount: -40, categoryId: CAT, excluded: 1 }); // row-excluded
  tx("Bank Transfer", { amount: -500, categoryId: CAT_EXC }); // excludeFromTotals category
  // categoriesWithTotals filters row-level excluded (so $40 doesn't count)…
  const groceries = categoriesWithTotals("2025-06").find((c) => c.id === CAT)!;
  assert.equal(groceries.total, 100, "row-excluded $40 must not count");
  // …and the dashboard applies excludeFromTotals (so the $500 transfer is out too).
  const d = dashboard("2025-06");
  assert.equal(d.expenses, 100, "dashboard expenses excludes both row + category exclusions");
});

test("dashboard net equals income minus expenses and is finite", () => {
  tx("Paycheck", { amount: 5000, categoryId: CAT_INC });
  tx("Kroger", { amount: -120, categoryId: CAT });
  tx("Home Depot", { amount: -80, categoryId: CAT_X });
  const d = dashboard("2025-06");
  for (const n of [d.income, d.expenses, d.net]) assert.ok(Number.isFinite(n), "finite");
  assert.equal(d.net, Number((d.income - d.expenses).toFixed(2)));
});

test("in-progress month compares like-for-like against the prior month's same days", () => {
  // The viewed month is the *current* month, so its totals are month-to-date.
  // The baseline must be the prior month through the same day-of-month — else a
  // partial month is compared against a full one (the "▼ $33k vs May" bug).
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  const pm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);

  // Current month: data only through the 5th (income + expense).
  tx("Paycheck", { amount: 2000, date: `${cm}-05`, categoryId: CAT_INC });
  tx("Kroger", { amount: -100, date: `${cm}-05`, categoryId: CAT });
  // Prior month: one charge inside the first 5 days, one after — only the first
  // must count toward the baseline.
  tx("Prior Early", { amount: -70, date: `${pm}-03`, categoryId: CAT });
  tx("Prior Late", { amount: -1000, date: `${pm}-25`, categoryId: CAT });
  tx("Prior Pay", { amount: 1500, date: `${pm}-02`, categoryId: CAT_INC });

  const d = dashboard(cm);
  assert.ok(d.prev, "prev baseline exists");
  assert.equal(d.prev!.throughDay, 5, "baseline bounded to the 5th, matching MTD");
  assert.equal(d.prev!.expenses, 70, "only the prior-month charge through the 5th counts");
  assert.equal(d.prev!.income, 1500, "prior income on the 2nd is within the window");
  // The bug would have surfaced $1070 of prior expenses against $100 MTD.
  assert.notEqual(d.prev!.expenses, 1070, "must not compare against the full prior month");
});

test("a complete past month still compares full-vs-full (throughDay null)", () => {
  // 2025-06 is historical, so no MTD bounding — the whole prior month is the
  // baseline. This guards against the partial fix leaking into past months.
  tx("June Spend", { amount: -200, date: "2025-06-15", categoryId: CAT });
  tx("May Early", { amount: -80, date: "2025-05-03", categoryId: CAT });
  tx("May Late", { amount: -300, date: "2025-05-28", categoryId: CAT });

  const d = dashboard("2025-06");
  assert.ok(d.prev);
  assert.equal(d.prev!.throughDay, null, "no day-bounding for a complete month");
  assert.equal(d.prev!.expenses, 380, "full May counts (80 + 300)");
});

test("an annual budget tracks calendar-YTD spend, not a single month, and reads as monthly-equivalent", () => {
  // WHY: a once-a-year-ish bill (e.g. a $259/mo policy paid in lumps) budgeted
  // annually must be judged on the whole year's spend — comparing this month's
  // charge to a $3,108 annual cap would always look wildly under budget. The top
  // summary, which compares a single month, instead needs the annual cap divided
  // back to a monthly-equivalent so every budget sits on one basis.
  const year = new Date().getUTCFullYear();
  const cat = addCat("Life Insurance");
  tx("Northwestern Mutual", { amount: -259, date: `${year}-01-15`, categoryId: cat });
  tx("Northwestern Mutual", { amount: -259, date: `${year}-03-15`, categoryId: cat });
  tx("Northwestern Mutual", { amount: -259, date: `${year - 1}-11-15`, categoryId: cat }); // prior year

  setBudget(cat, 3108, "annual"); // 259 × 12

  assert.deepEqual(getBudgetsFull()[cat], { amount: 3108, period: "annual" }, "full config keeps the period");
  assert.equal(getBudgets()[cat], 259, "single-month consumers see the annual cap ÷ 12");

  const row = categoriesWithTotals(`${year}-03`).find((c) => c.id === cat)!;
  assert.equal(row.budget, 3108, "the row carries the full annual amount");
  assert.equal(row.budgetPeriod, "annual");
  assert.equal(row.total, 259, "month total is still the viewed month's single charge");
  assert.equal(row.ytdSpent, 518, "calendar-YTD sums this year's charges only; last year is excluded");
});

test("recurringEnded: ended only until a charge lands after the end date (auto-heal)", () => {
  assert.equal(recurringEnded(null, "2026-06-10"), false, "no end date set");
  assert.equal(recurringEnded("2026-06-12", "2026-05-10"), true, "last charge before the end date");
  assert.equal(recurringEnded("2026-06-12", "2026-06-12"), true, "charge on the end date still counts as ended");
  assert.equal(
    recurringEnded("2026-06-12", "2026-07-01"),
    false,
    "a charge AFTER the end date reactivates — never hide a real future charge"
  );
});

test("ending a subscription drops it from expected outflow immediately, and reactivates on a later charge", () => {
  // WHY: a canceled subscription keeps inflating expected spend until it ages out
  // (~1.5 cycles). Marking it ended must remove it from the recurring outflow NOW,
  // while keeping history — and a charge after the end date must bring it back.
  const M = "Streamflix";
  for (const d of ["2026-03-10", "2026-04-10", "2026-05-10", "2026-06-10"])
    tx(M, { amount: -16, date: d, categoryId: CAT });
  detectRecurrings();
  const active = recurringMonthlyByCategory()[CAT] ?? 0;
  assert.ok(active >= 16, `expected the bill to count while active, got ${active}`);

  setRecurringSetting(M, { endedDate: "2026-06-11" }); // after the last charge → ended
  assert.equal(
    recurringMonthlyByCategory()[CAT] ?? 0,
    0,
    "an ended subscription stops counting toward expected outflow"
  );

  setRecurringSetting(M, { endedDate: "2026-06-09" }); // before the last (06-10) charge → resubscribed
  assert.ok(
    (recurringMonthlyByCategory()[CAT] ?? 0) >= 16,
    "a charge after the end date reactivates the bill"
  );
});

test("marking a vendor not-recurring clears its per-charge one-off exclusions", () => {
  // WHY: a muted vendor has no series, so a lingering "excluded from the series"
  // flag is a ghost marker on the charge (the Jimmy John's bug). Muting must
  // clear it — which is what the override route now does for each variant.
  tx("Jimmy Johns", { amount: -12, date: "2026-03-03", categoryId: CAT, hash: "jj-x" });
  const id = listTransactions({}).find((r) => r.hash === "jj-x")!.id;
  setTransactionRecurringExcluded(id, true);
  assert.equal(
    listTransactions({}).find((r) => r.id === id)!.recurringExcluded,
    1,
    "charge starts flagged as a one-off"
  );

  clearRecurringTxExclusionsForMerchant("Jimmy Johns");
  assert.equal(
    listTransactions({}).find((r) => r.id === id)!.recurringExcluded,
    0,
    "the stale exclusion is cleared, so no ghost 'excluded' marker remains"
  );
});

test("forcing recurring on a linked alias marks the whole canonical vendor", () => {
  // WHY: overrides are stored under the descriptor the user clicked, but
  // detection groups by canonical merchant. A force set on a linked alias must
  // still create the recurring and link every descriptor's charges — before the
  // fix, byMerchant.get(<alias>) missed the canonical group and silently did
  // nothing (the user's "mark recurring" appeared to fail).
  tx("Jimmy Johns", { amount: -12, date: "2026-01-05", categoryId: CAT });
  tx("Jimmy John's", { amount: -13, date: "2026-02-09", categoryId: CAT }); // alias descriptor
  linkMerchant("Jimmy John's", "Jimmy Johns"); // canonical = "Jimmy Johns"
  setRecurringOverride("Jimmy John's", "force"); // user clicked the ALIAS row

  detectRecurrings();

  const rows = getDb()
    .prepare("SELECT recurringId FROM transactions WHERE merchant IN ('Jimmy Johns', 'Jimmy John''s')")
    .all() as { recurringId: number | null }[];
  assert.equal(rows.length, 2, "both descriptor charges are present");
  assert.ok(
    rows.every((r) => r.recurringId != null),
    "both descriptors' charges link to the forced recurring"
  );
  const recs = getDb()
    .prepare("SELECT COUNT(*) n FROM recurrings WHERE merchant = 'Jimmy Johns'")
    .get() as { n: number };
  assert.equal(recs.n, 1, "exactly one recurring, on the canonical merchant");
});

test("a lumpy recurring bill is not amplified into the budget projection", () => {
  // The classic false-precision bug: a mortgage paid on the 1st, run-rated by a
  // few elapsed days, balloons the month-end projection. The fix projects only
  // *variable* spend and adds scheduled recurring — so the already-paid mortgage
  // is counted once, not multiplied out.
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  setBudget(CAT_X, 4500);
  // A detected recurring whose next charge already fell on the 1st (outside the
  // remaining-days window, so it adds nothing to the projection's scheduled part).
  const recId = Number(
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES ('Mortgage', @cat, -4000, 'monthly', @d, @d, 6)`
      )
      .run({ cat: CAT_X, d: `${cm}-01` }).lastInsertRowid
  );
  tx("Mortgage", { amount: -4000, date: `${cm}-01`, categoryId: CAT_X, recurringId: recId });
  tx("Hardware Store", { amount: -100, date: `${cm}-10`, categoryId: CAT_X });

  const d = dashboard(cm);
  assert.ok(d.budget, "budget summary exists");
  assert.equal(d.budget!.spent, 4100, "spent = mortgage + variable");
  assert.ok(d.budget!.projected != null, "past MIN_ELAPSED_DAYS, a projection is shown");
  // Naive run-rate (4100 × daysInMonth / 10) would project ~$12k and scream "over".
  // Correct: 4100 + run-rate of the $100 variable spend ≈ $4.3k, comfortably under.
  assert.ok(
    d.budget!.projected! < 4400,
    `expected a projection near actuals, got ${d.budget!.projected}`
  );
  assert.ok(d.budget!.projected! < d.budget!.total, "must not falsely project over budget");
});

test("the budget projection is withheld until enough of the month has elapsed", () => {
  // Two days of data can't support a run-rate; show nothing rather than a number
  // the dashboard can't stand behind. (null → UI renders "too early to project".)
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  setBudget(CAT, 1000);
  tx("Kroger", { amount: -50, date: `${cm}-02`, categoryId: CAT });

  const d = dashboard(cm);
  assert.ok(d.budget);
  assert.equal(d.budget!.spent, 50);
  assert.equal(d.budget!.projected, null, "no projection on day 2");
});

test("a complete past month projects to its actuals, not a run-rate", () => {
  setBudget(CAT, 1000);
  tx("Kroger", { amount: -300, date: "2025-06-10", categoryId: CAT });
  const d = dashboard("2025-06");
  assert.ok(d.budget);
  assert.equal(d.budget!.projected, d.budget!.spent, "finished month: projection = actuals");
});

test("a suggestion reflects a user-set name and expected amount", () => {
  const dates = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"];
  [-30, -300, -50, -250].forEach((a, i) => tx("Foo Utility", { amount: a, date: dates[i], categoryId: CAT }));
  setRecurringSetting("Foo Utility", { alias: "Foo", expectedAmount: 120 });

  const s = suggestedRecurrings().find((x) => x.merchant === "Foo Utility");
  assert.ok(s, "still a suggestion");
  assert.equal(s!.displayName, "Foo", "the user's name (alias) is the display name");
  assert.equal(s!.avgAmount, -120, "the expected amount overrides the detected average");
});

test("same-vendor variable-amount suggestions cluster into one with aliases", () => {
  // Two descriptors of one vendor (a renamed seasonal utility), both regular-but-
  // variable so neither auto-confirms — should suggest as ONE entry.
  const dates = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"];
  const amts = [-30, -300, -50, -250]; // high CV → "variable" suggestion
  const mk = (m: string) => amts.forEach((a, i) => tx(m, { amount: a, date: dates[i], categoryId: CAT }));
  mk("Acme Power Bill One");
  mk("Acme Power Bill Two");

  const sugg = suggestedRecurrings().filter((s) => s.merchant.startsWith("Acme Power Bill"));
  assert.equal(sugg.length, 1, "the two descriptors cluster into one suggestion");
  assert.equal(sugg[0].aliases.length, 1, "the other descriptor folds in as an alias");
  assert.equal(sugg[0].count, 8, "counts combine across descriptors");
});

test("an inactive recurring does not claim another vendor's charge by category fallback", () => {
  const cm = new Date().toISOString().slice(0, 7);
  // A long-stale recurring (last charged ~2 years ago) in category CAT.
  getDb()
    .prepare(
      `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
       VALUES ('Old Salon', @cat, -60, 'monthly', '2024-01-15', '2024-02-15', 12)`
    )
    .run({ cat: CAT });
  // A current-month charge: same category + amount, DIFFERENT vendor.
  tx("New Place", { amount: -60, date: `${cm}-15`, categoryId: CAT });

  const old = recurringsForMonth(cm).find((r) => r.merchant === "Old Salon");
  assert.ok(old, "the stale recurring still appears (it'll sit in Inactive)");
  assert.equal(old!.paid, false, "stale recurring is NOT falsely marked paid via category fallback");
});

test("upcoming bills appear on the current month only, never on a past one", () => {
  // "Upcoming · next 14 days" is a today-relative forecast: each recurring has a
  // single forward nextDate, so it must not bleed into a month being reviewed.
  const now = new Date();
  const cm = now.toISOString().slice(0, 7);
  const soon = new Date(now.getTime());
  soon.setUTCDate(soon.getUTCDate() + 3); // within the 14-day window
  const nd = soon.toISOString().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
       VALUES ('Netflix', @cat, -15.99, 'monthly', @nd, @nd, 6)`
    )
    .run({ cat: CAT, nd });

  const cur = dashboard(cm);
  assert.ok(cur.upcoming.count >= 1, "current month surfaces the upcoming bill");

  // A past month is a closed book — the forecast must be empty there, not show
  // next week's bills.
  const past = dashboard("2024-01");
  assert.equal(past.upcoming.count, 0, "past month shows no upcoming bills");
  assert.equal(past.upcoming.items.length, 0);
  assert.equal(past.upcoming.total, 0);
});

test("isRecurringActive: live within ~1.5 cycles of its last charge, dead beyond", () => {
  const now = Date.UTC(2026, 5, 10); // 2026-06-10
  // Monthly window ≈ 30*1.5+5 = 50 days.
  assert.equal(isRecurringActive("2026-06-02", "monthly", now), true, "9 days → active");
  assert.equal(isRecurringActive("2026-02-01", "monthly", now), false, "130 days → inactive");
  // Weekly window ≈ 7*1.5+5 = 15.5 days.
  assert.equal(isRecurringActive("2026-06-05", "weekly", now), true, "5 days → active");
  assert.equal(isRecurringActive("2026-05-20", "weekly", now), false, "21 days → inactive");
});

test("categorizeByHistory reuses a vendor's dominant past category across linked descriptors", () => {
  linkMerchant("Calico Corners Cityindy In", "Calico Corners");
  tx("Calico Corners", { amount: -100, categoryId: CAT });
  tx("Calico Corners Cityindy In", { amount: -200, categoryId: CAT });
  tx("Calico Corners", { amount: -50, categoryId: CAT_X }); // one-off in another category

  // A new uncategorized charge under the same vendor → dominant past category.
  assert.equal(categorizeByHistory("Calico Corners"), CAT, "2 of 3 → dominant category wins");
  assert.equal(categorizeByHistory("Totally New Vendor"), null, "no history → no guess");

  // A 50/50 split is not a confident signal.
  tx("Split Vendor", { amount: -10, categoryId: CAT });
  tx("Split Vendor", { amount: -10, categoryId: CAT_X });
  assert.equal(categorizeByHistory("Split Vendor"), null, "no clear majority → no guess");
});

test("a charge joining a categorized recurring inherits the recurring's modal category", () => {
  const day = 86_400_000;
  const iso = (off: number) => new Date(Date.now() - off * day).toISOString().slice(0, 10);
  // Three categorized monthly charges + a newest one that's uncategorized (e.g.
  // it posted under a new descriptor with no matching rule).
  tx("Acme Utility", { amount: -50, date: iso(90), categoryId: CAT });
  tx("Acme Utility", { amount: -50, date: iso(60), categoryId: CAT });
  tx("Acme Utility", { amount: -50, date: iso(30), categoryId: CAT });
  tx("Acme Utility", { amount: -50, date: iso(0), categoryId: null });

  const r = detectRecurrings().find((x) => x.merchant === "Acme Utility");
  assert.ok(r, "the series is detected");
  assert.equal(r!.categoryId, CAT, "recurring category is the modal, not the latest (null) charge");
  const newest = getDb()
    .prepare("SELECT categoryId FROM transactions WHERE merchant=? ORDER BY date DESC LIMIT 1")
    .get("Acme Utility") as { categoryId: number | null };
  assert.equal(newest.categoryId, CAT, "the uncategorized member inherited the recurring's category");
});

test("a stale (renamed/stopped) recurring stops counting toward the category baseline", () => {
  // When a vendor is renamed its descriptor drifts to a new merchant and the old
  // recurring goes silent. The category recurring baseline must drop the dead
  // series, or it double-counts with its successor — the Better Bodies / Better
  // Bodies Inc gym bug, where one $59 membership read as $145. This is the same
  // active filter the shelf's "upcoming this month" already applies.
  const iso = (offsetDays: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - offsetDays);
    return d.toISOString().slice(0, 10);
  };
  const ins = (merchant: string, amt: number, lastOffset: number) =>
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES (?, ?, ?, 'monthly', ?, ?, 6)`
      )
      .run(merchant, CAT_X, amt, iso(lastOffset), iso(lastOffset));
  ins("Gym Inc", -59, 5); // live: charged 5 days ago
  ins("Gym", -52, 200); // dead: renamed away, silent for 200 days

  const byCat = recurringMonthlyByCategory();
  assert.equal(
    byCat[CAT_X],
    59,
    "only the active recurring counts; the stale duplicate is dropped"
  );
});

test("a recurring spanning linked descriptors dates from the globally latest charge", () => {
  // Canonical is "Zzz Vendor"; the most recent charge posts under the
  // alphabetically EARLIER alias "Aaa Vendor". Detection groups by canonical, and
  // the SELECT is ordered (merchant, date) — so without a per-group date sort the
  // series ends on the alias's older charge and lastDate/gaps are wrong.
  linkMerchant("Aaa Vendor", "Zzz Vendor");
  tx("Zzz Vendor", { amount: -50, date: "2026-01-01", categoryId: CAT });
  tx("Zzz Vendor", { amount: -50, date: "2026-02-01", categoryId: CAT });
  tx("Zzz Vendor", { amount: -50, date: "2026-03-01", categoryId: CAT });
  tx("Aaa Vendor", { amount: -50, date: "2026-04-01", categoryId: CAT });

  const recs = detectRecurrings();
  const r = recs.find((x) => x.merchant === "Zzz Vendor");
  assert.ok(r, "the linked descriptors form one recurring");
  assert.equal(r!.count, 4, "all four charges across both descriptors are counted");
  assert.equal(r!.lastDate, "2026-04-01", "lastDate is the globally latest charge, not the alias's");
});

test("nameAffinity matches vendor renames but rejects distinct same-prefix vendors", () => {
  const same = (a: string, b: string) => nameAffinity(a, b) >= NAME_MATCH;
  // Descriptor drift for one vendor → match (prefix / punctuation / Jaro-Winkler).
  assert.ok(same("Gap Outletcom", "Gapoutlet.com"), "spacing/punctuation twin");
  assert.ok(same("Duke Energy", "Dukeenergy Bill Pay"), "appended junk suffix");
  assert.ok(same("Upgrade", "Upgrade, Inc. Payment"), "subset of tokens");
  assert.ok(same("Netflix", "Netflix.com"));
  // Distinct vendors that merely share a prefix must NOT match — the old 6-char
  // prefix rule wrongly matched these on "carmel".
  assert.ok(!same("Carmel Dental", "Carmel Clay Schools"), "shared city prefix is not a match");
  assert.ok(!same("Jimmy Johns", "Benjamin Franklin Pl"));
  assert.ok(!same("Wendys", "Arbys"));
});

test("recurring-match picks the renamed vendor by name, not a same-amount decoy", () => {
  const day = 86_400_000;
  const isoOff = (d: number) => new Date(Date.now() - d * day).toISOString().slice(0, 10);
  const last = isoOff(28); // recurring's last charge 28 days ago → active monthly
  const mkRec = (merchant: string) =>
    Number(
      getDb()
        .prepare(
          `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run(merchant, CAT, -100, "monthly", last, isoOff(-2), 3).lastInsertRowid
    );
  const rid = mkRec("Acme Power Bill");
  tx("Acme Power Bill", { amount: -100, date: isoOff(88), categoryId: CAT, recurringId: rid });
  tx("Acme Power Bill", { amount: -105, date: isoOff(58), categoryId: CAT, recurringId: rid });
  tx("Acme Power Bill", { amount: -100, date: last, categoryId: CAT, recurringId: rid });
  // A decoy bill: same amount and cadence, unrelated name.
  const did = mkRec("Zeta Water");
  tx("Zeta Water", { amount: -100, date: last, categoryId: CAT, recurringId: did });
  // The orphan: a new descriptor for Acme, uncategorized, posting ~1 month later.
  tx("Acme Power", { amount: -102, date: isoOff(0), categoryId: null });

  const g = recurringMatchSuggestions(new Set()).find((x) =>
    x.variants.some((v) => v.merchant === "Acme Power")
  );
  assert.ok(g, "the orphan charge is matched to a recurring");
  assert.equal(g!.canonical, "Acme Power Bill", "matched by name, not the same-amount Zeta decoy");
  assert.equal(g!.categoryId, CAT, "carries the recurring's category for the approve step");
});

test("a borderline name match surfaces as a low-confidence suggestion", () => {
  const day = 86_400_000;
  const iso = (off: number) => new Date(Date.now() - off * day).toISOString().slice(0, 10);
  const last = iso(28);
  const rid = Number(
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run("Metro Fibernet L Metfibenet", CAT, -93, "monthly", last, iso(-2), 2).lastInsertRowid
  );
  tx("Metro Fibernet L Metfibenet", { amount: -93, date: iso(58), categoryId: CAT, recurringId: rid });
  tx("Metro Fibernet L Metfibenet", { amount: -93, date: last, categoryId: CAT, recurringId: rid });
  // Orphan "Metronet" scores ~0.84 against "Metro Fibernet…" — same vendor to a
  // human, below the 0.9 auto-bar.
  tx("Metronet", { amount: -93, date: iso(0), categoryId: null });

  const g = recurringMatchSuggestions(new Set()).find((x) =>
    x.variants.some((v) => v.merchant === "Metronet")
  );
  assert.ok(g, "the borderline match is still surfaced");
  assert.equal(g!.lowConfidence, true, "0.8–0.9 band → flagged low-confidence, not auto-applied");
});

test("multiple stray descriptors of one vendor collapse into a single suggestion", () => {
  const day = 86_400_000;
  const isoOff = (d: number) => new Date(Date.now() - d * day).toISOString().slice(0, 10);
  const last = isoOff(28);
  const rid = Number(
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run("Upgrade, Inc. Payment", CAT, -100, "monthly", last, isoOff(-2), 3).lastInsertRowid
  );
  tx("Upgrade, Inc. Payment", { amount: -100, date: isoOff(58), categoryId: CAT, recurringId: rid });
  tx("Upgrade, Inc. Payment", { amount: -100, date: last, categoryId: CAT, recurringId: rid });
  // Two different stray descriptors, both Upgrade, both posting this cycle.
  tx("Upgrade", { amount: -100, date: isoOff(1), categoryId: null });
  tx("Upgrade, Inc. Co Entry Descr", { amount: -100, date: isoOff(2), categoryId: null });

  const s = recurringMatchSuggestions(new Set());
  const up = s.filter((g) => g.canonical === "Upgrade, Inc. Payment");
  assert.equal(up.length, 1, "the two strays form ONE card, not two");
  assert.equal(up[0].dismissKeys.length, 2, "dismissing the card remembers both descriptors");
  assert.ok(
    up[0].variants.some((v) => v.merchant === "Upgrade") &&
      up[0].variants.some((v) => v.merchant === "Upgrade, Inc. Co Entry Descr"),
    "both strays are listed as variants to fold in"
  );
});

test("approving a recurring-match links the orphan and fills its missing category", () => {
  tx("Acme Power", { amount: -102, date: "2026-06-10", categoryId: null });
  approveMerge("Acme Power Bill", ["Acme Power", "Acme Power Bill"], CAT);
  assert.equal(
    canonicalMerchant("Acme Power", getMerchantLinks()),
    "Acme Power Bill",
    "orphan descriptor linked to the vendor"
  );
  const row = getDb()
    .prepare("SELECT categoryId FROM transactions WHERE merchant = ?")
    .get("Acme Power") as { categoryId: number | null };
  assert.equal(row.categoryId, CAT, "the uncategorized orphan was tagged with the recurring's category");
});

test("plaid sync reconciles a pending charge against its posted twin, sparing coincidences", () => {
  // Plaid returns both versions of a charge mid-transition (different ids, drifted
  // name). The pending Gap twin should be dropped; two coincidental $11.99 charges
  // from different vendors must both survive.
  const item = {
    accounts: [{ account_id: "a1", name: "Amex Gold" }],
    transactions: [
      { transaction_id: "g-posted", account_id: "a1", date: "2026-06-07", name: "Gapoutlet.com", merchant_name: "Gapoutlet.com", amount: -53.47, pending: false },
      { transaction_id: "g-pending", account_id: "a1", date: "2026-06-07", name: "Gap Outletcom", merchant_name: "Gap Outletcom", amount: -53.47, pending: true },
      { transaction_id: "jj-pending", account_id: "a1", date: "2026-06-09", name: "Jimmy Johns", merchant_name: "Jimmy Johns", amount: 11.99, pending: true },
      { transaction_id: "bf-posted", account_id: "a1", date: "2026-06-10", name: "Benjamin Franklin Pl", merchant_name: "Benjamin Franklin Pl", amount: 11.99, pending: false },
    ],
  };
  const res = importPlaidTransactions([item]);
  const all = getDb()
    .prepare("SELECT amount, pending FROM transactions WHERE source='plaid'")
    .all() as { amount: number; pending: number }[];

  assert.equal(res.reconciled, 1, "the pending Gap twin is reconciled away");
  assert.equal(all.length, 3, "4 pulled, 1 pending duplicate dropped");
  assert.equal(all.filter((r) => r.amount === 53.47).length, 1, "only the posted Gap refund remains");
  assert.equal(all.find((r) => r.amount === 53.47)!.pending, 0, "and it's the posted one");
  assert.equal(all.filter((r) => r.amount === -11.99).length, 2, "both coincidental $11.99 charges survive");
  assert.equal(all.filter((r) => r.pending === 1).length, 1, "only the un-twinned pending remains");
});

test("mergePreview returns each descriptor's recent charges, newest first", () => {
  tx("Foo Bar", { amount: -5, date: "2026-01-01", categoryId: CAT, account: "Visa" });
  tx("Foo Bar", { amount: -6, date: "2026-03-01", categoryId: CAT, account: "Visa" });
  tx("Foo-bar", { amount: -7, date: "2026-02-01", categoryId: CAT, account: "Amex" });

  const pv = mergePreview(["Foo Bar", "Foo-bar"], 5);
  assert.equal(pv["Foo Bar"].length, 2, "each descriptor keyed separately");
  assert.equal(pv["Foo Bar"][0].date, "2026-03-01", "newest charge first");
  assert.equal(pv["Foo-bar"][0].account, "Amex", "carries the account for eyeballing");
});

test("normalized-equality groups punctuation/spacing twins under the common spelling", () => {
  tx("Jimmy Johns", { amount: -10, categoryId: CAT });
  tx("Jimmy Johns", { amount: -10, categoryId: CAT });
  tx("Jimmy John's", { amount: -11, categoryId: CAT });
  tx("Unrelated Cafe", { amount: -5, categoryId: CAT });

  const s = nameEqualityMergeSuggestions(new Set());
  const g = s.find((x) => x.variants.some((v) => v.merchant === "Jimmy John's"));
  assert.ok(g, "the apostrophe/no-apostrophe twins are grouped");
  assert.equal(g!.canonical, "Jimmy Johns", "canonical is the more common spelling");
  assert.equal(g!.variants.length, 2);
  assert.ok(
    !s.some((x) => x.variants.some((v) => v.merchant === "Unrelated Cafe")),
    "a vendor with no twin is never suggested"
  );
});

test("stripLocationSuffix peels a trailing City ST, keeps specific names, rejects the rest", () => {
  assert.equal(stripLocationSuffix("Crew Carwash - Westfcarmel In"), "Crew Carwash");
  assert.equal(stripLocationSuffix("Turf Kings Carmel In"), "Turf Kings");
  assert.equal(stripLocationSuffix("The Gardcarmel In"), null, "prefix too short → no collapse to 'The'");
  assert.equal(stripLocationSuffix("Kroger"), null, "no location suffix");
  assert.equal(stripLocationSuffix("Acme Widgets Go"), null, "trailing token is not a US state");
});

test("merge suggestions group location-suffix variants and honor dismissal", () => {
  tx("Turf Kings Carmel In", { amount: -80, categoryId: CAT });
  tx("Turf Kings Fishers In", { amount: -80, categoryId: CAT });
  tx("Turf Kings", { amount: -80, categoryId: CAT });
  tx("Kroger", { amount: -20, categoryId: CAT });

  const g = mergeSuggestions().find((x) => x.canonical === "Turf Kings");
  assert.ok(g, "a Turf Kings merge is suggested");
  assert.equal(g!.variants.length, 3, "both location descriptors + the clean name grouped");
  assert.ok(
    !mergeSuggestions().some((x) => x.canonical === "Kroger"),
    "a lone merchant is never suggested"
  );

  dismissMerge("Turf Kings");
  assert.ok(
    !mergeSuggestions().some((x) => x.canonical === "Turf Kings"),
    "a dismissed group does not resurface"
  );
});

test("approving a merge folds the descriptors into one vendor and clears the suggestion", () => {
  tx("Turf Kings Carmel In", { amount: -80, categoryId: CAT });
  tx("Turf Kings Fishers In", { amount: -80, categoryId: CAT });
  tx("Turf Kings", { amount: -80, categoryId: CAT });

  approveMerge("Turf Kings", ["Turf Kings Carmel In", "Turf Kings Fishers In", "Turf Kings"]);
  const links = getMerchantLinks();
  assert.equal(canonicalMerchant("Turf Kings Carmel In", links), "Turf Kings");
  assert.equal(canonicalMerchant("Turf Kings Fishers In", links), "Turf Kings");
  assert.ok(
    !mergeSuggestions().some((x) => x.canonical === "Turf Kings"),
    "once linked, the group is no longer suggested"
  );
});

// Simulate already-imported rows: backfill rawMerchant = merchant, as the
// original import-time migration would have, so renormalize (not the first-pass
// backfill) is what re-cleans them.
function backfillRaw() {
  getDb().prepare("UPDATE transactions SET rawMerchant = merchant WHERE rawMerchant IS NULL").run();
}

test("renormalize re-cleans existing rows from their preserved original", () => {
  // A row imported before the normalizer learned to drop a trailing channel code.
  tx("Carmel Water Bill Tel", { amount: -78, categoryId: CAT });
  backfillRaw();
  const changed = renormalizeMerchants(getDb());
  assert.ok(changed >= 1, "the stale name was refreshed");
  const row = getDb()
    .prepare("SELECT merchant, rawMerchant FROM transactions WHERE rawMerchant = 'Carmel Water Bill Tel'")
    .get() as { merchant: string; rawMerchant: string };
  assert.equal(row.merchant, "Carmel Water Bill", "the channel code is gone");
  assert.equal(row.rawMerchant, "Carmel Water Bill Tel", "original is preserved (reversible)");
});

test("renormalize carries a user's alias onto the renamed merchant", () => {
  tx("Acme Bill Web", { amount: -20, categoryId: CAT });
  backfillRaw();
  setRecurringSetting("Acme Bill Web", { alias: "Acme Subscription" }); // aliased pre-cleanup
  renormalizeMerchants(getDb());
  const moved = getDb()
    .prepare("SELECT alias FROM recurring_settings WHERE merchant = 'Acme Bill'")
    .get() as { alias: string } | undefined;
  assert.equal(moved?.alias, "Acme Subscription", "alias followed the rename");
  const orphan = getDb()
    .prepare("SELECT 1 FROM recurring_settings WHERE merchant = 'Acme Bill Web'")
    .get();
  assert.equal(orphan, undefined, "no setting left stranded on the old name");
});

test("undo restores the pre-cleanup names (not the raw descriptor) and aliases", () => {
  // Prior name differs from both the raw descriptor and the cleaned form, so we
  // can prove undo restores the *previous* name, not just merchant = rawMerchant.
  tx("Acme Bill Stale", { amount: -20, categoryId: CAT });
  getDb()
    .prepare("UPDATE transactions SET rawMerchant = 'ACME BILL WEB' WHERE merchant = 'Acme Bill Stale'")
    .run();
  setRecurringSetting("Acme Bill Stale", { alias: "Acme Subscription" });

  const changed = renormalizeMerchants(getDb());
  assert.ok(changed >= 1);
  assert.equal(cleanupUndoAvailable(getDb()), true, "undo available after a cleanup");
  assert.ok(
    getDb().prepare("SELECT 1 FROM transactions WHERE merchant = 'Acme Bill'").get(),
    "cleanup applied"
  );

  const restored = undoRenormalizeMerchants(getDb());
  assert.equal(restored, changed, "every changed row was restored");
  const row = getDb()
    .prepare("SELECT merchant FROM transactions WHERE rawMerchant = 'ACME BILL WEB'")
    .get() as { merchant: string };
  assert.equal(row.merchant, "Acme Bill Stale", "the prior name is back, not the raw descriptor");
  const s = getDb()
    .prepare("SELECT alias FROM recurring_settings WHERE merchant = 'Acme Bill Stale'")
    .get() as { alias: string } | undefined;
  assert.equal(s?.alias, "Acme Subscription", "alias keyed back to the restored name");
  assert.equal(cleanupUndoAvailable(getDb()), false, "undo is consumed once applied");
});

test("a charge can be excluded from its recurring without muting the whole vendor", () => {
  // Five regular monthly charges → one recurring series.
  for (const d of ["2025-01-15", "2025-02-15", "2025-03-15", "2025-04-15", "2025-05-15"])
    tx("Acme Sub", { amount: -100, date: d, categoryId: CAT });
  detectRecurrings();
  const before = getDb()
    .prepare("SELECT id, date, recurringId FROM transactions WHERE merchant='Acme Sub' ORDER BY date")
    .all() as { id: number; date: string; recurringId: number | null }[];
  assert.ok(before.every((r) => r.recurringId != null), "all five start stamped recurring");

  // Flag the last charge as a one-off; the series stays intact for the rest.
  const last = before[before.length - 1];
  setTransactionRecurringExcluded(last.id, true);
  detectRecurrings();
  const after = getDb()
    .prepare("SELECT id, recurringId FROM transactions WHERE merchant='Acme Sub'")
    .all() as { id: number; recurringId: number | null }[];
  assert.equal(after.find((r) => r.id === last.id)!.recurringId, null, "the flagged charge is no longer recurring");
  assert.equal(after.filter((r) => r.recurringId != null).length, 4, "the other four remain recurring");
  const rec = getDb()
    .prepare("SELECT count FROM recurrings WHERE merchant='Acme Sub'")
    .get() as { count: number };
  assert.equal(rec.count, 4, "the series stats reflect only the four kept charges");

  // Add it back; it rejoins the series.
  setTransactionRecurringExcluded(last.id, false);
  detectRecurrings();
  const restored = getDb()
    .prepare("SELECT recurringId FROM transactions WHERE id=?")
    .get(last.id) as { recurringId: number | null };
  assert.ok(restored.recurringId != null, "re-included charge is recurring again");
});

test("auto-split children sum to the parent and the parent is excluded", () => {
  createSplitRule("chubb", 1115.55, [
    { categoryId: CAT_X, amount: 847.75, label: "Home" },
    { categoryId: CAT, amount: 267.8, label: "Other" },
  ]);
  tx("Chubb Insurance", { amount: -1115.55, categoryId: CAT_X });
  applySplitRules();
  const children = getDb()
    .prepare("SELECT amount FROM transactions WHERE hash LIKE '%:s%'")
    .all() as { amount: number }[];
  assert.equal(children.length, 2);
  const sum = children.reduce((a, c) => a + Math.abs(c.amount), 0);
  assert.equal(Number(sum.toFixed(2)), 1115.55);
  const parent = getDb()
    .prepare("SELECT excluded FROM transactions WHERE merchant = 'Chubb Insurance' AND hash NOT LIKE '%:s%'")
    .get() as { excluded: number };
  assert.equal(parent.excluded, 1);
});

test("effectiveDate overrides the accounting month (COALESCE everywhere)", () => {
  // Posted in March, but accounted to April.
  tx("Lake Mortgage", { amount: -4800, date: "2025-03-31", effectiveDate: "2025-04-01", categoryId: CAT_X });
  assert.equal(listTransactions({ month: "2025-04" }).length, 1, "shows in April");
  assert.equal(listTransactions({ month: "2025-03" }).length, 0, "not in March");
});

test("duplicate transaction hash is rejected (dedup invariant)", () => {
  tx("Once", { amount: -10, hash: "dup" });
  assert.throws(() => tx("Again", { amount: -10, hash: "dup" }));
});

test("empty month produces finite figures, not NaN, and never throws", () => {
  tx("Solo", { amount: -10, date: "2025-06-15", categoryId: CAT });
  // A month with no transactions at all.
  const d = dashboard("2030-01");
  for (const n of [d.income, d.expenses, d.net])
    assert.ok(Number.isFinite(n), `expected finite, got ${n}`);
  // projectedMonthEnd is intentionally null when it can't forecast — just never NaN.
  assert.ok(d.pace.projectedMonthEnd === null || Number.isFinite(d.pace.projectedMonthEnd));
  assert.doesNotThrow(() => recurringsForMonth("2030-01"));
  for (const c of categoriesWithTotals("2030-01"))
    assert.ok(Number.isFinite(c.total) && Number.isFinite(c.recurringBaseline));
});
