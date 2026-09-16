import { cleanDbBeforeEach, addCat, tx, daysAgo, daysFromNow } from "./helpers"; // first: points the DB at a throwaway file
import { test, before } from "node:test";
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
  setSeriesCategory,
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
  resetRecurringOverrides,
  getRecurringSettings,
  merchantVariants,
  upcomingRecurringExpenses,
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
import { createSplitRule, applySplitRules, undoSplit } from "../src/lib/splits";
import { importPlaidTransactions } from "../src/lib/plaid";

let CAT: number, CAT_INC: number, CAT_EXC: number, CAT_X: number;

before(() => {
  CAT = addCat("Groceries");
  CAT_INC = addCat("Income", "income");
  CAT_EXC = addCat("Transfers", "expense", 1); // excludeFromTotals
  CAT_X = addCat("Home");
});
cleanDbBeforeEach(["categories"]); // categories are created once in before()

test("merchantSummary carries next-due and match-rule overrides, and whether any override exists", () => {
  // WHY: the recurrings page's inline editor was the only place next-due and
  // matching could be edited. Moving them to the shelf means the shelf's data
  // must say what is set (auto vs edited) and whether "Reset all" applies.
  for (const d of ["2025-03-15", "2025-04-15", "2025-05-15"]) tx("Water Co", { amount: -40, date: d, categoryId: CAT });
  detectRecurrings();
  let s = merchantSummary("Water Co");
  assert.equal(s.nextDate, null); assert.equal(s.matchRule, null); assert.equal(s.hasSettings, false);
  setRecurringSetting("Water Co", { nextDate: "2025-06-20", matchMode: "contains", matchText: "water", amountTolerance: 0.1 });
  s = merchantSummary("Water Co");
  assert.equal(s.nextDate, "2025-06-20");
  assert.deepEqual(s.matchRule, { matchMode: "contains", matchText: "water", amountTolerance: 0.1 });
  assert.equal(s.hasSettings, true);
  setRecurringSetting("Water Co", { endedDate: "2025-06-01" });
  resetRecurringOverrides("Water Co");
  s = merchantSummary("Water Co");
  assert.equal(s.hasSettings, false, "ended is not an override; nothing else is left");
  assert.equal(s.endedDate, "2025-06-01", "and it survives the reset");
});

test("vendor variants: a payment-rail prefix is not the vendor", () => {
  // WHY: the variant key is the first two words after known prefixes. "Zelle
  // Payment To <payee>" keyed every payee to "zelle payment", so the shelf,
  // the vendor filter, recategorize, and "Not recurring" all treated 38 payees
  // as one vendor — muting one muted them all (real data, 2026-09-13). The
  // payee is what follows the rail; descriptor drift within a payee still rolls up.
  for (const m of [
    "Zelle Payment To Indy K-9 Llc",
    "Zelle Payment To Indy K-9",
    "Zelle Payment To Rosy's Cleaning",
    "Zelle Payment To Aurelio Juarez Jpm99abh1tph",
    "Zelle Payment To Aurelio Juarez Jpm99a9hjnaf",
    "Plan Fee - Ticketmast",
    "Plan Fee - Surroundings",
  ])
    tx(m, { amount: -50 });
  const sorted = (a: string[]) => [...a].sort();
  assert.deepEqual(
    sorted(merchantVariants("Zelle Payment To Indy K-9 Llc")),
    ["Zelle Payment To Indy K-9", "Zelle Payment To Indy K-9 Llc"],
    "K-9's two descriptors, and no other Zelle payee"
  );
  assert.deepEqual(
    sorted(merchantVariants("Zelle Payment To Aurelio Juarez Jpm99abh1tph")),
    ["Zelle Payment To Aurelio Juarez Jpm99a9hjnaf", "Zelle Payment To Aurelio Juarez Jpm99abh1tph"],
    "reference-suffix drift within one payee still rolls up"
  );
  assert.deepEqual(merchantVariants("Plan Fee - Ticketmast"), ["Plan Fee - Ticketmast"], "a fee is keyed by its merchant, not 'plan fee'");
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

test("dashboard income, expenses, net, prior net and category totals are the fixture's figures", () => {
  // WHY: `net === income − expenses` recomputed from the same object only proves
  // the net formula. A fault on the income side (say `> 0` instead of `>= 0`), a
  // sign flip in prev.net, or a category keyed wrong would all survive it. Pin
  // every figure to the fixture so each has exactly one way to be right.
  tx("Paycheck", { amount: 5000, categoryId: CAT_INC });
  tx("Kroger", { amount: -120, categoryId: CAT });
  tx("Home Depot", { amount: -80, categoryId: CAT_X });
  tx("May Pay", { amount: 1000, date: "2025-05-10", categoryId: CAT_INC });
  tx("May Spend", { amount: -300, date: "2025-05-12", categoryId: CAT });
  const d = dashboard("2025-06");
  assert.equal(d.income, 5000);
  assert.equal(d.expenses, 200);
  assert.equal(d.net, 4800);
  assert.equal(d.prev!.income, 1000);
  assert.equal(d.prev!.expenses, 300);
  assert.equal(d.prev!.net, 700, "prior month net keeps its sign");
  const cat = (id: number) => d.byCategory.find((c) => c.categoryId === id)!.total;
  assert.equal(cat(CAT), 120, "groceries total keyed by category id");
  assert.equal(cat(CAT_X), 80);
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
  // Dates are relative to now, not pinned: the first assertion only means
  // something while the bill is still active, and pinned dates age past that
  // window and start failing on a date nobody chose.
  const lastCharge = daysAgo(5);
  for (const d of [daysAgo(95), daysAgo(65), daysAgo(35), lastCharge])
    tx(M, { amount: -16, date: d, categoryId: CAT });
  detectRecurrings();
  const active = recurringMonthlyByCategory()[CAT] ?? 0;
  assert.ok(active >= 16, `expected the bill to count while active, got ${active}`);

  setRecurringSetting(M, { endedDate: daysAgo(4) }); // after the last charge → ended
  assert.equal(
    recurringMonthlyByCategory()[CAT] ?? 0,
    0,
    "an ended subscription stops counting toward expected outflow"
  );

  setRecurringSetting(M, { endedDate: daysAgo(6) }); // before the last charge → resubscribed
  assert.ok(
    (recurringMonthlyByCategory()[CAT] ?? 0) >= 16,
    "a charge after the end date reactivates the bill"
  );
});

test("Reset all clears overrides but keeps a subscription ended", () => {
  // WHY: "Reset all" on the recurrings page means "forget my tuning" — rename,
  // amount, cadence, matching. It used to send every field to null, including
  // endedDate, so resetting a canceled subscription silently reactivated it and
  // its amount reappeared in expected outflow. Ended is a fact, not a tuning.
  const M = "Streamflix";
  for (const d of [daysAgo(95), daysAgo(65), daysAgo(35), daysAgo(5)])
    tx(M, { amount: -16, date: d, categoryId: CAT });
  detectRecurrings();
  setRecurringSetting(M, { alias: "Stream Flix", expectedAmount: 18, endedDate: daysAgo(4) });
  assert.equal(recurringMonthlyByCategory()[CAT] ?? 0, 0, "ended → not counted");

  resetRecurringOverrides(M);
  const s = getRecurringSettings()[M];
  assert.equal(s.alias, null, "rename cleared");
  assert.equal(s.expectedAmount, null, "expected amount cleared");
  assert.equal(s.endedDate, daysAgo(4), "ended date survives a reset");
  assert.equal(
    recurringMonthlyByCategory()[CAT] ?? 0,
    0,
    "a reset must not reactivate a canceled subscription"
  );
});

test("an excluded charge is not evidence of a bill and never joins a series", () => {
  // WHY: split parents are excluded (their parts count) and land on the same
  // day as their children. Fed to the detector, the zero-day gaps pulled the
  // median down and a monthly bill read as biweekly — 2.17× its real monthly
  // share in the category baseline (Chubb, real data). Transfers and reimbursed
  // one-offs the user excluded are the same class: not spending, not a bill.
  for (const d of [daysAgo(95), daysAgo(65), daysAgo(35), daysAgo(5)]) {
    tx("Gym", { amount: -50, date: d, categoryId: CAT });
    tx("Gym", { amount: -120, date: d, categoryId: CAT, excluded: 1 }); // same-day excluded twin
  }
  detectRecurrings();
  const rec = getDb().prepare("SELECT cadence, avgAmount FROM recurrings WHERE merchant = 'Gym'").get() as { cadence: string; avgAmount: number };
  assert.equal(rec.cadence, "monthly", "same-day excluded rows must not halve the gaps");
  assert.equal(rec.avgAmount, -50, "the excluded amounts are not part of the bill");
  const members = getDb().prepare("SELECT excluded, recurringId FROM transactions WHERE merchant = 'Gym'").all() as { excluded: number; recurringId: number | null }[];
  assert.ok(members.filter((m) => m.excluded).every((m) => m.recurringId == null), "excluded rows are not series members");
  assert.ok(members.filter((m) => !m.excluded).every((m) => m.recurringId != null), "posted rows are");
});

test("a series' last and next due follow the effective date, like every reader of it", () => {
  // WHY: the user moves a charge that posts on the 31st into the next month on
  // purpose. Paid-matching and the month views judge it there; the detector
  // alone used the posted date, so "last charge" and "next due" sat on a
  // different calendar from the months the bill was counted in.
  tx("Lake Mortgage", { amount: -4800, date: "2025-03-31", effectiveDate: "2025-04-01", categoryId: CAT_X });
  tx("Lake Mortgage", { amount: -4800, date: "2025-04-30", effectiveDate: "2025-05-01", categoryId: CAT_X });
  tx("Lake Mortgage", { amount: -4800, date: "2025-05-31", effectiveDate: "2025-06-01", categoryId: CAT_X });
  detectRecurrings();
  const rec = getDb().prepare("SELECT cadence, lastDate, nextDate FROM recurrings WHERE merchant = 'Lake Mortgage'").get() as { cadence: string; lastDate: string; nextDate: string };
  assert.equal(rec.cadence, "monthly");
  assert.equal(rec.lastDate, "2025-06-01", "last charge on the effective calendar");
  assert.equal(rec.nextDate, "2025-07-01", "next due one period on from it");
});

test("a series that has gone quiet is not an upcoming bill, even with a next-due override", () => {
  // WHY: the category baseline, the shelf, and the recurrings page all apply
  // isRecurringActive; the dashboard's upcoming list (and the month-end spend
  // projection it feeds) did not. A stale series normally falls out of the
  // window on its own, but a user-set next-due or cadence override could put
  // it back — so the projection counted a bill that had stopped.
  // Live: monthly, last charged 5 days ago. Quiet: monthly, last charged 200 days ago.
  for (const d of [95, 65, 35, 5]) tx("Power Co", { amount: -100, date: daysAgo(d), categoryId: CAT });
  for (const d of [290, 260, 230, 200]) tx("Old Box", { amount: -30, date: daysAgo(d), categoryId: CAT });
  detectRecurrings();
  // Both get a next-due override 10 days from now, inside the window.
  setRecurringSetting("Power Co", { nextDate: daysFromNow(10) });
  setRecurringSetting("Old Box", { nextDate: daysFromNow(10) });
  const names = upcomingRecurringExpenses(daysFromNow(1), daysFromNow(30)).map((u) => u.merchant);
  assert.ok(names.includes("Power Co"), "a live series with a due date in the window is upcoming");
  assert.ok(!names.includes("Old Box"), "a quiet series is not, whatever its override says");
});

test("a quarterly bill counts one third per month toward the category baseline", () => {
  // WHY: the baseline feeds the dashboard bar marker and the budget suggestion.
  // A cadence missing from the monthly-factor table silently fell back to 1×,
  // so a $300 quarterly bill was counted as $300 every month (3× too high)
  // and a semiannual one 6× too high. Every cadence the detector can emit must
  // have an explicit per-month factor.
  for (const d of [daysAgo(275), daysAgo(184), daysAgo(93), daysAgo(2)]) // 91-day gaps → quarterly
    tx("Water District", { amount: -300, date: d, categoryId: CAT });
  for (const d of [daysAgo(366), daysAgo(184), daysAgo(2)]) // 182-day gaps → semiannual
    tx("Car Insurance", { amount: -600, date: d, categoryId: CAT_X });
  detectRecurrings();
  const byCat = recurringMonthlyByCategory();
  assert.equal(byCat[CAT], 100, "quarterly $300 → $100/month, not $300");
  assert.equal(byCat[CAT_X], 100, "semiannual $600 → $100/month, not $600");
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
  // WHY: the window is `period × 1.5 + 5` days. Fixtures far from the edge
  // (9d, 130d) let the constants drift — 1.0×, 2.0×, +0 all passed. Bracket
  // each edge by one day so a changed multiplier or grace fails here.
  const now = Date.UTC(2026, 5, 10); // 2026-06-10
  // Monthly window = 30*1.5+5 = 50 days.
  assert.equal(isRecurringActive("2026-06-02", "monthly", now), true, "9 days → active");
  assert.equal(isRecurringActive("2026-04-22", "monthly", now), true, "49 days → still active");
  assert.equal(isRecurringActive("2026-04-20", "monthly", now), false, "51 days → inactive");
  assert.equal(isRecurringActive("2026-02-01", "monthly", now), false, "130 days → inactive");
  // Weekly window = 7*1.5+5 = 15.5 days.
  assert.equal(isRecurringActive("2026-06-05", "weekly", now), true, "5 days → active");
  assert.equal(isRecurringActive("2026-05-26", "weekly", now), true, "15 days → still active");
  assert.equal(isRecurringActive("2026-05-25", "weekly", now), false, "16 days → inactive");
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
  // Three categorized monthly charges + a newest one that's uncategorized (e.g.
  // it posted under a new descriptor with no matching rule).
  tx("Acme Utility", { amount: -50, date: daysAgo(90), categoryId: CAT });
  tx("Acme Utility", { amount: -50, date: daysAgo(60), categoryId: CAT });
  tx("Acme Utility", { amount: -50, date: daysAgo(30), categoryId: CAT });
  tx("Acme Utility", { amount: -50, date: daysAgo(0), categoryId: null });

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
  const ins = (merchant: string, amt: number, lastOffset: number) =>
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES (?, ?, ?, 'monthly', ?, ?, 6)`
      )
      .run(merchant, CAT_X, amt, daysAgo(lastOffset), daysAgo(lastOffset));
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
  const last = daysAgo(28); // recurring's last charge 28 days ago → active monthly
  const mkRec = (merchant: string) =>
    Number(
      getDb()
        .prepare(
          `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run(merchant, CAT, -100, "monthly", last, daysAgo(-2), 3).lastInsertRowid
    );
  const rid = mkRec("Acme Power Bill");
  tx("Acme Power Bill", { amount: -100, date: daysAgo(88), categoryId: CAT, recurringId: rid });
  tx("Acme Power Bill", { amount: -105, date: daysAgo(58), categoryId: CAT, recurringId: rid });
  tx("Acme Power Bill", { amount: -100, date: last, categoryId: CAT, recurringId: rid });
  // A decoy bill: same amount and cadence, unrelated name.
  const did = mkRec("Zeta Water");
  tx("Zeta Water", { amount: -100, date: last, categoryId: CAT, recurringId: did });
  // The orphan: a new descriptor for Acme, uncategorized, posting ~1 month later.
  tx("Acme Power", { amount: -102, date: daysAgo(0), categoryId: null });

  const g = recurringMatchSuggestions(new Set()).find((x) =>
    x.variants.some((v) => v.merchant === "Acme Power")
  );
  assert.ok(g, "the orphan charge is matched to a recurring");
  assert.equal(g!.canonical, "Acme Power Bill", "matched by name, not the same-amount Zeta decoy");
  assert.equal(g!.categoryId, CAT, "carries the recurring's category for the approve step");
});

test("a borderline name match surfaces as a low-confidence suggestion", () => {
  const last = daysAgo(28);
  const rid = Number(
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run("Metro Fibernet L Metfibenet", CAT, -93, "monthly", last, daysAgo(-2), 2).lastInsertRowid
  );
  tx("Metro Fibernet L Metfibenet", { amount: -93, date: daysAgo(58), categoryId: CAT, recurringId: rid });
  tx("Metro Fibernet L Metfibenet", { amount: -93, date: last, categoryId: CAT, recurringId: rid });
  // Orphan "Metronet" scores ~0.84 against "Metro Fibernet…" — same vendor to a
  // human, below the 0.9 auto-bar.
  tx("Metronet", { amount: -93, date: daysAgo(0), categoryId: null });

  const g = recurringMatchSuggestions(new Set()).find((x) =>
    x.variants.some((v) => v.merchant === "Metronet")
  );
  assert.ok(g, "the borderline match is still surfaced");
  assert.equal(g!.lowConfidence, true, "0.8–0.9 band → flagged low-confidence, not auto-applied");
});

test("multiple stray descriptors of one vendor collapse into a single suggestion", () => {
  const last = daysAgo(28);
  const rid = Number(
    getDb()
      .prepare(
        `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run("Upgrade, Inc. Payment", CAT, -100, "monthly", last, daysAgo(-2), 3).lastInsertRowid
  );
  tx("Upgrade, Inc. Payment", { amount: -100, date: daysAgo(58), categoryId: CAT, recurringId: rid });
  tx("Upgrade, Inc. Payment", { amount: -100, date: last, categoryId: CAT, recurringId: rid });
  // Two different stray descriptors, both Upgrade, both posting this cycle.
  tx("Upgrade", { amount: -100, date: daysAgo(1), categoryId: null });
  tx("Upgrade, Inc. Co Entry Descr", { amount: -100, date: daysAgo(2), categoryId: null });

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

test("a category set on a pending Plaid charge survives the next sync and follows it to posted", () => {
  // WHY: a pending Plaid row is wiped + recreated on every sync, so a category the
  // user set on a still-pending charge must be preserved by transaction_id — else
  // it silently reverts next sync (the "Asymmetrically won't keep its category"
  // bug). And it must follow the charge onto its posted twin (a new id) so the
  // edit isn't lost again at the pending→posted transition.
  const pendingPull = {
    accounts: [{ account_id: "a1", name: "Checking" }],
    transactions: [
      { transaction_id: "asym-pending", account_id: "a1", date: "2026-06-12", name: "Asymmetrically", merchant_name: "Asymmetrically", amount: 10, pending: true },
    ],
  };
  importPlaidTransactions([pendingPull]);
  // User categorizes the pending charge.
  getDb().prepare("UPDATE transactions SET categoryId = ? WHERE hash = 'asym-pending'").run(CAT);

  // Sync again — the still-pending charge comes back and is re-wiped/re-imported.
  importPlaidTransactions([pendingPull]);
  const resync = getDb()
    .prepare("SELECT categoryId, pending FROM transactions WHERE hash = 'asym-pending'")
    .get() as { categoryId: number; pending: number };
  assert.equal(resync.categoryId, CAT, "category is retained across the pending wipe");
  assert.equal(resync.pending, 1, "and the charge is still pending");

  // The charge posts: Plaid returns the posted version (new id) alongside the
  // still-pending one mid-transition; the pending twin reconciles away.
  const postedPull = {
    accounts: [{ account_id: "a1", name: "Checking" }],
    transactions: [
      { transaction_id: "asym-posted", account_id: "a1", date: "2026-06-13", name: "Asymmetrically", merchant_name: "Asymmetrically", amount: 10, pending: false },
      { transaction_id: "asym-pending", account_id: "a1", date: "2026-06-12", name: "Asymmetrically", merchant_name: "Asymmetrically", amount: 10, pending: true },
    ],
  };
  importPlaidTransactions([postedPull]);
  const posted = getDb()
    .prepare("SELECT categoryId FROM transactions WHERE hash = 'asym-posted'")
    .get() as { categoryId: number };
  const pendingGone = getDb()
    .prepare("SELECT COUNT(*) n FROM transactions WHERE hash = 'asym-pending'")
    .get() as { n: number };
  assert.equal(posted.categoryId, CAT, "category follows the charge onto its posted twin");
  assert.equal(pendingGone.n, 0, "the pending row is reconciled away");
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

test("auto-split children carry the rule's exact signed amounts and categories; the parent is excluded", () => {
  // WHY: summing |amount| would pass even if the children came out as inflows
  // (a dropped minus at the insert), and a wrong categoryId would move money
  // to the wrong bar with the total still reconciling. Assert each child
  // exactly: sign, amount, category, in rule order.
  createSplitRule("chubb", 1115.55, [
    { categoryId: CAT_X, amount: 847.75, label: "Home" },
    { categoryId: CAT, amount: 267.8, label: "Other" },
  ]);
  tx("Chubb Insurance", { amount: -1115.55, categoryId: CAT_X });
  applySplitRules();
  const children = getDb()
    .prepare("SELECT amount, categoryId, merchant FROM transactions WHERE hash LIKE '%:s%' ORDER BY hash")
    .all() as { amount: number; categoryId: number; merchant: string }[];
  assert.deepEqual(
    children.map((c) => [c.amount, c.categoryId, c.merchant]),
    [
      [-847.75, CAT_X, "Chubb Insurance — Home"],
      [-267.8, CAT, "Chubb Insurance — Other"],
    ]
  );
  const parent = getDb()
    .prepare("SELECT excluded FROM transactions WHERE merchant = 'Chubb Insurance' AND hash NOT LIKE '%:s%'")
    .get() as { excluded: number };
  assert.equal(parent.excluded, 1);
});

test("a pending charge is not split until it posts", () => {
  // WHY: a sync replaces a pending row (remove + add). If the pending row had
  // been split, it comes back un-excluded while its child rows survive, and
  // the charge counts twice. Found by splitting the newest row in a real DB
  // copy and letting the launch sync run. Rules wait for the posted row.
  createSplitRule("chubb", 1115.55, [
    { categoryId: CAT_X, amount: 847.75, label: "Home" },
    { categoryId: CAT, amount: 267.8, label: "Other" },
  ]);
  tx("Chubb Insurance", { amount: -1115.55, categoryId: CAT_X });
  getDb().prepare("UPDATE transactions SET pending = 1 WHERE merchant = 'Chubb Insurance'").run();
  assert.equal(applySplitRules(), 0, "pending: left alone");
  getDb().prepare("UPDATE transactions SET pending = 0 WHERE merchant = 'Chubb Insurance'").run();
  assert.equal(applySplitRules(), 1, "posted: split");
});

test("undo split removes the children, restores the parent, and deletes the rule", () => {
  // WHY: a split persists a rule that re-splits every future matching charge.
  // Without an inverse, one mistaken split is permanent. Undo must reverse all
  // three effects — otherwise the parent double-counts (excluded + children
  // gone), or the next sync silently re-splits it from the surviving rule.
  createSplitRule("chubb", 1115.55, [
    { categoryId: CAT_X, amount: 847.75, label: "Home" },
    { categoryId: CAT, amount: 267.8, label: "Other" },
  ]);
  tx("Chubb Insurance", { amount: -1115.55, categoryId: CAT_X });
  const before = dashboard("2025-06").expenses;
  applySplitRules();
  assert.equal(dashboard("2025-06").expenses, before, "a split moves money between categories, not the total");
  const parent = listTransactions({ month: "2025-06" }).find((r) => r.merchant === "Chubb Insurance")!;
  assert.equal(parent.splitParts, 2, "the list knows the parent is split");
  assert.equal(parent.excluded, 1);
  const children = () =>
    getDb().prepare("SELECT amount FROM transactions WHERE hash LIKE '%:s%'").all() as { amount: number }[];
  assert.ok(children().every((c) => c.amount < 0), "children are outflows like their parent");

  assert.equal(undoSplit(parent.id), 1, "one parent restored");
  assert.equal(children().length, 0, "child rows gone");
  const after = listTransactions({ month: "2025-06" }).find((r) => r.id === parent.id)!;
  assert.equal(after.excluded, 0, "parent counts again");
  assert.equal(after.splitParts, 0);
  const rules = getDb().prepare("SELECT COUNT(*) AS n FROM split_rules").get() as { n: number };
  assert.equal(rules.n, 0, "rule gone");
  assert.equal(dashboard("2025-06").expenses, before, "total unchanged through split and undo");
  assert.equal(applySplitRules(), 0, "nothing re-splits on the next sync");
  assert.equal(undoSplit(parent.id), 0, "nothing left to undo");
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

// The month view folds descriptor-drift clones of ONE bill into a single row.
// It must never fold two different vendors that merely share a category and a
// price band: on real data Hulu ($19.99) swallowed 27 other $15–$20
// subscriptions, and X Corp ($40) swallowed the $38.99 WSJ the moment it was
// categorized Subscriptions — the bill vanished from the page and its charge
// then "paid" X Corp. A fold requires the same vendor: a shared coarse vendor
// key, or a user Combine (merchant link).
test("recurrings dedupe folds only clones of the same vendor, not same-price neighbours", () => {
  const subs = addCat("Subscriptions");
  const ins = getDb().prepare(
    `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
     VALUES (?, ?, ?, 'monthly', ?, ?, ?)`
  );
  ins.run("X Corp. Paid Featurebastrop", subs, -40, "2026-08-31", "2026-09-30", 20);
  ins.run("D J*wsj", subs, -38.99, "2026-05-25", "2026-06-25", 19); // WSJ, the bank's old descriptor
  ins.run("D J", subs, -38.99, "2026-08-18", "2026-09-18", 3); // WSJ since the bank changed it
  ins.run("Michaeljburry.substasaratoga", subs, -39, "2026-08-11", "2026-09-11", 10);
  ins.run("Willywoo.substack.cocentral Hk", subs, -39, "2026-08-26", "2026-09-26", 7);
  ins.run("Chase Mortgage", subs, -40, "2026-08-01", "2026-09-01", 6); // distinct name, Combined below
  ins.run("Chase Home Lending", subs, -40, "2026-08-01", "2026-09-01", 4);
  linkMerchant("Chase Home Lending", "Chase Mortgage");

  const rows = recurringsForMonth("2026-09");
  assert.deepEqual(
    rows.map((r) => r.merchant).sort(),
    ["Chase Mortgage", "D J*wsj", "Michaeljburry.substasaratoga", "Willywoo.substack.cocentral Hk", "X Corp. Paid Featurebastrop"],
    "same-vendor clones fold (D J → D J*wsj by key, Chase by link); different vendors in the same price band all stay"
  );

  // The fold is a merge: the face keeps its key but takes the newest clone's
  // last/next charge and the combined count — otherwise the face's own stale
  // lastDate (May) files a bill that charged in August under "Inactive".
  const wsj = rows.find((r) => r.merchant === "D J*wsj")!;
  assert.equal(wsj.lastDate, "2026-08-18", "face carries the newest clone's last charge");
  assert.equal(wsj.dueDate, "2026-09-18", "due day follows the live descriptor's charges");
  assert.equal(wsj.count, 22, "history is the sum of the clones");
  assert.equal(wsj.paid, false);

  // A charge on the newer key pays the face (exact match through the fold, not
  // the loose category+amount fallback).
  tx("D J", { amount: -38.99, date: "2026-09-18", categoryId: subs });
  const paid = recurringsForMonth("2026-09").find((r) => r.merchant === "D J*wsj")!;
  assert.equal(paid.paid, true, "the clone's charge counts as the face's payment");
  assert.equal(paid.paidAmount, 38.99);
});

// One bank descriptor, two monthly bills. Netflix charges $26.99 on the 23rd
// and on the 26th (one account per home); grouped by descriptor the detector
// read that as one bill, so the page showed one Netflix and counted the second
// charge as an overpayment. Sofi is the same shape with different amounts (the
// mortgage on the 1st, a loan on the 21st) and came out as a "$2,902 biweekly"
// that is neither payment. Two monthly plans keep their days of the month;
// that is what separates them from one true biweekly bill, which drifts.
test("detector splits a descriptor that carries two monthly bills into one series per day", () => {
  const subs = addCat("Streaming");
  const home = addCat("Lake House");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 8; m++) {
    tx("Netflix", { amount: -26.99, date: `${ym(m)}-23`, categoryId: subs });
    tx("Netflix", { amount: -26.99, date: `${ym(m)}-26`, categoryId: home });
  }
  for (let m = 1; m <= 8; m++) {
    tx("Sofi", { amount: -4453.91, date: `${ym(m)}-01`, categoryId: home });
    if (m >= 4) tx("Sofi", { amount: -1350.95, date: `${ym(m)}-21`, categoryId: subs });
  }
  // A true biweekly plan: 14-day steps drift through the month — one series.
  const start = Date.UTC(2026, 0, 3);
  for (let i = 0; i < 12; i++)
    tx("Gym", { amount: -25, date: new Date(start + i * 14 * 86_400_000).toISOString().slice(0, 10), categoryId: subs });
  // A bill whose day moved (8th, then 22nd) never overlaps itself — one series.
  for (let m = 1; m <= 4; m++) tx("Water", { amount: -40, date: `${ym(m)}-08`, categoryId: home });
  for (let m = 5; m <= 8; m++) tx("Water", { amount: -40, date: `${ym(m)}-22`, categoryId: home });
  // Two policies billed the same day are one bill (one event, summed); the
  // 17th policy is another. A weekend slip (1st → 3rd) stays in its cluster.
  for (let m = 1; m <= 6; m++) {
    const d = m === 3 ? "03" : "01";
    tx("Chubb", { amount: -494.75, date: `${ym(m)}-${d}`, categoryId: home });
    tx("Chubb", { amount: -494.75, date: `${ym(m)}-${d}`, categoryId: home, account: "Savings" });
    tx("Chubb", { amount: -544.94, date: `${ym(m)}-17`, categoryId: home });
  }

  // Two 529 contributions, $200 and $300, on the 18th each month (one per
  // account) — same day, different amounts: two bills, keyed by amount. July's
  // pair posted on the 20th (weekend slip, within the cluster's two days). Two
  // deposits of different amounts on a payday are two paychecks, split alike.
  // Real posting days: 16th, 17th, 18th, 18th, 20th … — the 20th is a weekend
  // slip two days past a cluster that began on the 16th; it must still join.
  for (let m = 1; m <= 8; m++) {
    const d = m === 1 ? "16" : m === 2 ? "17" : m === 7 ? "20" : "18";
    tx("In 529 Dir Ach Contrib", { amount: -200, date: `${ym(m)}-${d}`, categoryId: home });
    tx("In 529 Dir Ach Contrib", { amount: -300, date: `${ym(m)}-${d}`, categoryId: home, account: "Savings" });
    tx("Payroll", { amount: 9738.55, date: `${ym(m)}-15`, categoryId: home });
    tx("Payroll", { amount: 7553.94, date: `${ym(m)}-15`, categoryId: home, account: "Savings" });
  }

  // Two policies of different amounts on the 1st, three months, plus a pair
  // that posted a month early on the 31st: two same-day plans that together
  // hold most of the charges are the bills; the early pair stays unlinked.
  for (const d of ["2026-01-31", "2026-03-01", "2026-04-01", "2026-05-03"]) {
    tx("Chubb Prs", { amount: -259.75, date: d, categoryId: home });
    tx("Chubb Prs", { amount: -729.75, date: d, categoryId: home, account: "Savings" });
  }

  // A grocery store visited every few days lands in every day-bucket month
  // after month; that is one variable vendor, not a stack of monthly bills.
  const g0 = Date.UTC(2026, 0, 2);
  for (let i = 0; i < 60; i++)
    tx("Market District", { amount: -(40 + ((i * 37) % 90)), date: new Date(g0 + i * 4 * 86_400_000).toISOString().slice(0, 10), categoryId: home });

  const recs = detectRecurrings();
  const by = (m: string) => recs.find((r) => r.merchant === m);
  assert.ok(!recs.some((r) => r.merchant.startsWith("Market District · ")), "a weekly store never splits into monthly bills");
  assert.deepEqual(
    recs.map((r) => r.merchant).filter((m) => !m.startsWith("Market District")).sort(),
    ["Chubb Prs · $259.75", "Chubb Prs · $729.75", "Chubb · 17th", "Chubb · 1st", "Gym", "In 529 Dir Ach Contrib · $200", "In 529 Dir Ach Contrib · $300", "Netflix · 23rd", "Netflix · 26th", "Payroll · $7,553.94", "Payroll · $9,738.55", "Sofi · 1st", "Sofi · 21st", "Water"],
    "two bills per descriptor become two series; a drifting biweekly and a bill that changed its day stay one"
  );
  assert.equal(by("Chubb · 1st")!.avgAmount, -989.5, "same-day charges are one event, summed");
  assert.equal(by("Chubb · 1st")!.count, 6, "count is events (months), not charges");
  assert.equal(by("Chubb · 17th")!.avgAmount, -544.94);
  assert.equal(by("In 529 Dir Ach Contrib · $200")!.count, 8, "the weekend slip on the 20th is a member");
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE merchant = 'In 529 Dir Ach Contrib' AND recurringId IS NULL").get() as { n: number }).n,
    0,
    "no 529 charge is left unlinked"
  );
  assert.equal(by("In 529 Dir Ach Contrib · $300")!.avgAmount, -300);
  assert.equal(by("Payroll · $9,738.55")!.count, 8, "two deposits of different amounts on a payday are two paychecks");
  assert.equal(by("Payroll · $7,553.94")!.avgAmount, 7553.94);

  assert.equal(by("Chubb Prs · $729.75")!.count, 3, "the early pair on the 31st is not a member");
  assert.equal(by("Gym")!.cadence, "biweekly");
  assert.equal(by("Water")!.cadence, "monthly");
  assert.equal(by("Netflix · 23rd")!.count, 8);
  assert.equal(by("Netflix · 26th")!.categoryId, home, "each series carries its own charges' category");
  assert.equal(by("Sofi · 1st")!.avgAmount, -4453.91, "each series has its own amount, not the blend");
  assert.equal(by("Sofi · 21st")!.avgAmount, -1350.95);
  assert.equal(by("Sofi · 21st")!.count, 5);

  // Charges link to the series they belong to (by row, not by descriptor).
  const linked = getDb()
    .prepare("SELECT date, recurringId FROM transactions WHERE merchant = 'Netflix' ORDER BY date")
    .all() as { date: string; recurringId: number }[];
  for (const t of linked)
    assert.equal(
      t.recurringId,
      t.date.endsWith("-23") ? by("Netflix · 23rd")!.id : by("Netflix · 26th")!.id,
      `${t.date} links to its own series`
    );

  // The month view: each series is paid by its own charge, once.
  const aug = recurringsForMonth("2026-08").filter((r) => r.vendor === "Netflix");
  assert.equal(aug.length, 2);
  for (const r of aug) {
    assert.equal(r.paid, true, `${r.merchant} paid`);
    assert.equal(r.paidAmount, 26.99, `${r.merchant} paid once, not both charges`);
    assert.equal(r.vendor, "Netflix", "the shelf opens on the descriptor, not the series key");
  }
  // Recategorizing one series moves only its charges.
  const boat = addCat("Boat (split)");
  setSeriesCategory(by("Netflix · 26th")!.id, boat);
  const cats = getDb()
    .prepare("SELECT date, categoryId FROM transactions WHERE merchant = 'Netflix' ORDER BY date")
    .all() as { date: string; categoryId: number }[];
  assert.ok(cats.filter((t) => t.date.endsWith("-26")).every((t) => t.categoryId === boat), "the 26th moved");
  assert.ok(cats.filter((t) => t.date.endsWith("-23")).every((t) => t.categoryId === subs), "the 23rd stayed");

  // Two people's raises cross in amount: A 8,854 → 9,738 in June; B 7,480 →
  // 8,295 → 8,177. Amount bands can't cut that into two; rank can — the
  // larger deposit each payday is one paycheck, the smaller the other.
  const A = [8854.62, 8854.62, 8854.62, 9738.55, 9738.55, 9738.55, 9738.55, 9738.55];
  const B = [7480.78, 7480.78, 7480.78, 7480.78, 8295.23, 8177.01, 8177.01, 8177.01];
  for (let m = 1; m <= 8; m++) {
    tx("Acme Payroll", { amount: A[m - 1], date: `${ym(m)}-28`, categoryId: home });
    tx("Acme Payroll", { amount: B[m - 1], date: `${ym(m)}-28`, categoryId: home, account: "Savings" });
  }
  const acme = detectRecurrings().filter((r) => r.merchant.startsWith("Acme Payroll"));
  assert.deepEqual(acme.map((r) => r.merchant).sort(), ["Acme Payroll · larger", "Acme Payroll · smaller"], "ranked, not banded — the keys survive raises");
  assert.equal(acme.find((r) => r.merchant.endsWith("larger"))!.avgAmount, 9738.55);
  assert.equal(acme.find((r) => r.merchant.endsWith("smaller"))!.count, 8);
});

// One monthly plan plus strays. Benjamin Franklin bills $11.99 on the 8th; in
// August a $89.95 service call posted on the 21st and a second plan's first
// $11.99 on the 22nd. Gap math over the whole descriptor read "biweekly"; the
// 8th plan holds most of the charges and IS the bill — the strays stay
// unlinked until the second plan has three charges, when the descriptor
// splits and the vendor's name stays with the established plan.
test("detector keeps the dominant monthly plan when strays break the rhythm, then splits and keeps the name", () => {
  const home = addCat("Lake House (bf)");
  const bf = "Benjamin Franklin Pl";
  for (const m of ["06", "07", "08", "09"]) tx(bf, { amount: -11.99, date: `2026-${m}-08`, categoryId: home });
  tx(bf, { amount: -89.95, date: "2026-08-21", categoryId: home });
  tx(bf, { amount: -11.99, date: "2026-08-22", categoryId: home });
  setRecurringSetting(bf, { alias: "Benjamin Franklin Plumbing" });

  let recs = detectRecurrings().filter((r) => r.merchant.startsWith(bf));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].merchant, bf, "one plan keeps the bare descriptor as its key");
  assert.equal(recs[0].cadence, "monthly", "not biweekly");
  assert.equal(recs[0].count, 4);
  const linked = getDb().prepare("SELECT date FROM transactions WHERE merchant = ? AND recurringId IS NOT NULL ORDER BY date").all(bf) as { date: string }[];
  assert.deepEqual(linked.map((t) => t.date), ["2026-06-08", "2026-07-08", "2026-08-08", "2026-09-08"], "the strays are not members");

  // Two more months: the second plan reaches three charges and the descriptor splits.
  tx(bf, { amount: -11.99, date: "2026-09-22", categoryId: home });
  tx(bf, { amount: -11.99, date: "2026-10-08", categoryId: home });
  tx(bf, { amount: -11.99, date: "2026-10-22", categoryId: home });
  setTransactionRecurringExcluded(
    (getDb().prepare("SELECT id FROM transactions WHERE merchant = ? AND amount = -89.95").get(bf) as { id: number }).id,
    true
  ); // the service call, flagged as a one-off
  recs = detectRecurrings().filter((r) => r.merchant.startsWith(bf));
  assert.deepEqual(recs.map((r) => r.merchant).sort(), [`${bf} · 22nd`, `${bf} · 8th`]);
  const s = getRecurringSettings();
  assert.equal(s[`${bf} · 8th`]?.alias, "Benjamin Franklin Plumbing", "the name follows the established plan");
  assert.equal(s[`${bf} · 22nd`], undefined, "the new plan is unnamed until the user names it");
});

// Two jobs taking turns under one descriptor. Rosy's Cleaning is paid every
// two weeks — $240, then $270, then $240 — two homes alternating. Read as one
// biweekly bill it expects $270 every time. The amounts interleave, and each
// runs on its own four-week grid: two bills, keyed by amount, the odd $480
// double-payment left unlinked. A price change never interleaves (six $240s
// then six $270s) and stays one biweekly bill.
test("detector splits amounts that take turns into their own series; a price change stays one bill", () => {
  const home = addCat("Lake House (rosy)");
  const rosy = "Zelle Payment To Rosy's Cleaning";
  const d0 = Date.UTC(2026, 0, 9);
  const day = (i: number) => new Date(d0 + i * 14 * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < 14; i++) tx(rosy, { amount: i % 2 ? -270 : -240, date: day(i), categoryId: home });
  tx(rosy, { amount: -480, date: "2026-04-01", categoryId: home });
  for (let i = 0; i < 12; i++) tx("Window Washer", { amount: i < 6 ? -240 : -270, date: day(i), categoryId: home });

  const recs = detectRecurrings();
  const by = (m: string) => recs.find((r) => r.merchant === m);
  assert.deepEqual(
    recs.map((r) => r.merchant).filter((m) => m.startsWith(rosy)).sort(),
    [`${rosy} · $240`, `${rosy} · $270`]
  );
  assert.equal(by(`${rosy} · $240`)!.count, 7);
  assert.equal(by(`${rosy} · $270`)!.avgAmount, -270);
  assert.equal(by(`${rosy} · $240`)!.cadence, "monthly", "a 28-day turn reads as monthly");
  const orphan = getDb().prepare("SELECT recurringId FROM transactions WHERE merchant = ? AND amount = -480").get(rosy) as { recurringId: number | null };
  assert.equal(orphan.recurringId, null, "the double payment is nobody's member");
  const ww = recs.filter((r) => r.merchant.startsWith("Window Washer"));
  assert.equal(ww.length, 1, "a price change is one bill");
  assert.equal(ww[0].merchant, "Window Washer");
  assert.equal(ww[0].cadence, "biweekly");
});

// The shelf on ONE plan of a vendor that carries two: figures, next due, the
// price-change check, and the charge list come from that plan's own charges,
// and overrides live under the plan's key. The vendor-level summary is
// unchanged for a vendor with one plan.
test("merchantSummary scoped to a series answers for that plan only", () => {
  const home = addCat("Lake House (529)");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 8; m++) {
    tx("In 529 Dir Ach Contrib", { amount: -200, date: `${ym(m)}-18`, categoryId: home });
    tx("In 529 Dir Ach Contrib", { amount: -300, date: `${ym(m)}-18`, categoryId: home, account: "Savings" });
  }
  detectRecurrings();
  const key200 = "In 529 Dir Ach Contrib · $200";
  const plan = merchantSummary("In 529 Dir Ach Contrib", key200);
  assert.equal(plan.series, key200);
  assert.equal(plan.settingsKey, key200, "overrides from this shelf land on the plan");
  assert.equal(plan.plans, 2);
  assert.equal(plan.count, 8, "only this plan's charges");
  assert.equal(plan.recurringDetail?.perCharge, 200);
  assert.equal(plan.recurringDetail?.annualized, 2400);
  assert.equal(plan.priceChange, null, "two plans alternating is not a price change");
  assert.ok(plan.recent.every((r) => r.amount === -200), "Recent lists the plan's charges");
  assert.equal(plan.displayName, key200);
  // The plan's list also carries the vendor's charges in no plan, so one can
  // be pulled in or flagged out — but never a charge excluded from totals,
  // which can't join. A split parent is off every shelf, plan or vendor: it
  // is not a charge any more, its parts are (Chubb's $1,115.55 parents sat on
  // the Lake Home shelf as "not counted" noise between the plan's charges).
  tx("In 529 Dir Ach Contrib", { amount: -500, date: "2026-09-02", categoryId: home, excluded: 1, hash: "p529" });
  tx("In 529 Dir Ach Contrib — A", { amount: -250, date: "2026-09-02", categoryId: home, hash: "p529:s1" });
  tx("In 529 Dir Ach Contrib — B", { amount: -250, date: "2026-09-02", categoryId: home, hash: "p529:s2" });
  tx("In 529 Dir Ach Contrib", { amount: -90, date: "2026-09-04", categoryId: home, excluded: 1 });
  tx("In 529 Dir Ach Contrib", { amount: -75, date: "2026-09-03", categoryId: home });
  const again = merchantSummary("In 529 Dir Ach Contrib", key200);
  assert.ok(!again.recent.some((r) => r.excluded === 1), "nothing excluded from totals sits on a plan's shelf");
  assert.ok(again.recent.some((r) => r.amount === -75 && r.recurringId == null), "a stray in no plan does, so it can be pulled in");
  const vendor = merchantSummary("In 529 Dir Ach Contrib");
  assert.equal(vendor.series, null);
  assert.ok(!vendor.recent.some((r) => r.amount === -500), "a split parent is off the vendor shelf too");
  assert.ok(vendor.recent.some((r) => r.amount === -90 && r.excluded === 1), "a charge the user excluded from totals stays, as 'not counted'");
  assert.equal(vendor.settingsKey, "In 529 Dir Ach Contrib");
});

// A vendor whose descriptor changed carries two series. The page folds them
// and takes the newer one's dates; the shelf must agree — the most recently
// charged series speaks for the vendor, not whichever row is found first.
// And a price change is news, not history: the banner leaves after three
// charges at the new price.
test("the vendor shelf follows the newer series of a folded vendor, and a price change expires", () => {
  const subs = addCat("Subscriptions (wsj)");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 5; m++) tx("D J*wsj", { amount: -38.99, date: `${ym(m)}-25`, categoryId: subs });
  for (let m = 6; m <= 8; m++) tx("D J", { amount: -38.99, date: `${ym(m)}-18`, categoryId: subs });
  detectRecurrings();
  const shelf = merchantSummary("D J*wsj");
  // Next due rolls forward from today (the clock sweep runs this at many
  // dates), so assert the day it lands on and that it is not in the past.
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(shelf.recurringDetail?.nextDate.slice(8), "18", "next due follows the newer descriptor's charges (the 18th), not the stale series (the 25th)");
  assert.ok((shelf.recurringDetail?.nextDate ?? "") >= "2026-09-18" && (shelf.recurringDetail?.nextDate ?? "") >= today.slice(0, 8) + "01", "never in the past");
  assert.equal(shelf.priceChange, null, "no change to report");

  // A promo price then five charges at the real price: the change is old news.
  for (let m = 1; m <= 6; m++) tx("Paper", { amount: m === 1 ? -4 : -38.99, date: `${ym(m)}-05`, categoryId: subs });
  detectRecurrings();
  assert.equal(merchantSummary("Paper").priceChange, null, "five charges at the new price: the banner has expired");
  // Two charges at the new price: still news.
  for (let m = 1; m <= 5; m++) tx("Mag", { amount: m <= 3 ? -10 : -12, date: `${ym(m)}-05`, categoryId: subs });
  detectRecurrings();
  assert.deepEqual(merchantSummary("Mag").priceChange, { from: 10, to: 12, since: "2026-04-05" });
});

// A fixed bill with usage on top. Anthropic: $20 on the 17th every month plus
// $15-ish API top-ups on random days. The bill is the $20 group; the top-ups
// stay unlinked. A variable utility whose amounts wander but whose every
// charge sits on the monthly grid stays one whole series.
test("detector keeps the regular amount group and leaves irregular usage charges unlinked", () => {
  const subs = addCat("Subscriptions (core)");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 8; m++) tx("Anthropic", { amount: -20, date: `${ym(m)}-17`, categoryId: subs });
  // Usage top-ups land whenever the balance runs low: 3 days apart, then 40.
  for (const [m, d, amt] of [[1, 4, 15.01], [1, 7, 15.14], [1, 9, 15.34], [2, 26, 15.06], [3, 2, 100], [3, 3, 15.0], [5, 26, 107.59], [5, 29, 15.01], [7, 30, 15.2]] as [number, number, number][])
    tx("Anthropic", { amount: -amt, date: `${ym(m)}-${String(d).padStart(2, "0")}`, categoryId: subs });
  for (let m = 1; m <= 8; m++) tx("Duke Energy", { amount: -[31, 44, 58, 72, 65, 49, 38, 33][m - 1], date: `${ym(m)}-11`, categoryId: subs });

  const recs = detectRecurrings();
  const a = recs.find((r) => r.merchant === "Anthropic")!;
  assert.equal(a.cadence, "monthly");
  assert.equal(a.count, 8, "the eight $20 charges");
  assert.equal(a.avgAmount, -20);
  const unlinked = (getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE merchant = 'Anthropic' AND recurringId IS NULL").get() as { n: number }).n;
  assert.equal(unlinked, 9, "every top-up is left out of the series");
  const shelf = merchantSummary("Anthropic");
  assert.equal(shelf.recurringDetail?.perCharge, 20);
  assert.equal(shelf.priceChange, null, "the price walk is over the series' charges, not the top-ups");
  const duke = recs.find((r) => r.merchant === "Duke Energy")!;
  assert.equal(duke.count, 8, "a variable bill on one grid stays whole");

  // A plan that changed price: ten $20 months in 2024, then $100 months in
  // 2026 with usage around them. The core is the CURRENT plan, not the
  // largest group — the series must not end in 2024.
  const ym25 = (i: number) => `2025-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 10; m++) tx("Claude", { amount: -20, date: `${ym25(m)}-18`, categoryId: subs });
  for (let m = 3; m <= 8; m++) tx("Claude", { amount: -100, date: `${ym(m)}-18`, categoryId: subs });
  for (const [m, d, amt] of [[3, 2, 15.06], [3, 5, 15.14], [5, 26, 107.59], [5, 29, 15.01], [7, 30, 15.2]] as [number, number, number][])
    tx("Claude", { amount: -amt, date: `${ym(m)}-${String(d).padStart(2, "0")}`, categoryId: subs });
  const claude = detectRecurrings().find((r) => r.merchant === "Claude")!;
  assert.equal(claude.avgAmount, -100, "the current plan sets the price");
  assert.equal(claude.lastDate, "2026-08-18");
  assert.equal(claude.count, 16, "the $20 era is the same bill at an old price — history, not usage");
  const claudeUnlinked = (getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE merchant = 'Claude' AND recurringId IS NULL").get() as { n: number }).n;
  assert.equal(claudeUnlinked, 5, "only the usage leaves");

  // Six similar-priced lunches that happen to skip months are not a bill.
  for (const [ym2, amt] of [["2025-01-10", 26.65], ["2025-02-04", 26.65], ["2025-04-01", 27.3], ["2025-04-22", 26.65], ["2025-06-30", 27.63], ["2025-10-20", 25.89], ["2025-03-03", 10.66], ["2025-05-15", 1.84], ["2025-08-01", 11.31], ["2025-09-09", 6.21]])
    tx("Potbelly", { amount: -(amt as number), date: ym2 as string, categoryId: subs });
  // A monthly $25 credit sometimes posted as $21 + $4 is one credit, not a core plus usage.
  for (let m = 1; m <= 8; m++) {
    if (m === 3 || m === 6) { tx("Amex Credit", { amount: 21, date: `${ym(m)}-10`, categoryId: subs }); tx("Amex Credit", { amount: 4, date: `${ym(m)}-10`, categoryId: subs }); }
    else tx("Amex Credit", { amount: 25, date: `${ym(m)}-10`, categoryId: subs });
  }
  const again = detectRecurrings();
  // The core rule must decline (a core would be the six lunches); whatever
  // the ordinary whole-vendor path makes of the ten charges is its business.
  const potbelly = again.find((r) => r.merchant === "Potbelly");
  assert.ok(!potbelly || potbelly.count === 10, "skipping the grid is a coincidence, not a core");
  const credit = again.find((r) => r.merchant === "Amex Credit");
  assert.ok(!credit || credit.count === 10, "a credit is never split into a core plus usage (all ten postings, or none)");
});

// A bank rename is not a new vendor. Cursor billed $20 on the 20th as "Cursor
// Ai Powered" for three months, then as "Cursor, Ai Powered Isan Francisco";
// grouped by descriptor, the new charge was a one-charge vendor the shelf
// showed as "not detected" while the old series read as stopped. Descriptors
// that share the shelf's vendor key are also planned together, and the merge
// wins only when it links charges the descriptors alone could not, without
// losing a series. Chubb is the counter-case: descriptors that each carry
// their own policy link nothing more together, so they stay apart (merged on
// the real data, its eight policies read as one "biweekly" bill).
test("detector joins a renamed descriptor to its vendor only when the merge earns it", () => {
  const tools = addCat("Dev Tools");
  const ym = (i: number) => `2026-${String(i).padStart(2, "0")}`;
  for (let m = 1; m <= 3; m++) tx("Cursor Ai Powered", { amount: -20, date: `${ym(m)}-20`, categoryId: tools });
  tx("Cursor, Ai Powered Isan Francisco", { amount: -20, date: "2026-04-20", categoryId: tools });
  for (let m = 1; m <= 6; m++) {
    tx("Chubb Prs Debitpmt", { amount: -163.75, date: `${ym(m)}-05`, categoryId: tools });
    tx("Chubb-prs Direct Deb Prs", { amount: -903.48, date: `${ym(m)}-20`, categoryId: tools });
  }
  const recs = detectRecurrings();
  const cursor = recs.filter((r) => /cursor/i.test(r.merchant));
  assert.deepEqual(
    cursor.map((r) => [r.merchant, r.count]),
    [["Cursor Ai Powered", 4]],
    "the renamed charge continues the series under the vendor's busiest descriptor"
  );
  const renamed = getDb()
    .prepare("SELECT recurringId FROM transactions WHERE merchant = ?")
    .get("Cursor, Ai Powered Isan Francisco") as { recurringId: number | null };
  assert.equal(renamed.recurringId, cursor[0].id, "the renamed charge is a member, not 'not detected'");
  assert.equal(cursor[0].lastDate, "2026-04-20", "the vendor's charges are read in date order across descriptors");
  // The month view pays the series with the renamed charge, not only with
  // charges on the series' own descriptor.
  const april = recurringsForMonth("2026-04").find((r) => r.merchant === "Cursor Ai Powered");
  assert.equal(april?.paid, true);
  assert.equal(april?.paidAmount, 20);
  const chubb = recs
    .filter((r) => /chubb/i.test(r.merchant))
    .map((r) => [r.merchant, r.count])
    .sort();
  assert.deepEqual(
    chubb,
    [
      ["Chubb Prs Debitpmt", 6],
      ["Chubb-prs Direct Deb Prs", 6],
    ],
    "a merge that links no more charges than the descriptors alone does not happen"
  );
});

// The month view's last-resort match pays a bill only with a charge on its own
// vendor key. It used to accept any charge of the same category within 5% of
// the amount: Rosy's $240 cleaning read as paid — "$249, +$9" — by a $249
// irrigation bill filed under the same home, while Rosy's own charge was still
// two weeks out. A relabeled descriptor on the same key ("Sp Liquid I.v" billed
// as "Liquid I.v") still pays.
test("month view pays a bill only with its own vendor's charge", () => {
  const home = addCat("Carmel Home Bills");
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
     VALUES (?, ?, ?, 'monthly', ?, ?, 9)`
  );
  const last = daysAgo(20);
  const next = daysFromNow(10);
  const month = next.slice(0, 7);
  ins.run("Zelle Payment To Rosy's Cleaning · $240", home, -240, last, next);
  ins.run("Sp Liquid I.v", home, -52.48, last, next);
  tx("Barthuly Irrigat", { amount: -249, date: next, categoryId: home });
  tx("Liquid I.v", { amount: -52.48, date: next, categoryId: home });
  const rows = recurringsForMonth(month);
  const rosy = rows.find((r) => r.merchant.startsWith("Zelle Payment To Rosy"));
  assert.equal(rosy?.paid, false, "another vendor's charge of the same category and amount is not this bill");
  const liquid = rows.find((r) => r.merchant === "Sp Liquid I.v");
  assert.equal(liquid?.paid, true, "the same vendor under a relabeled descriptor is");
  assert.equal(liquid?.paidAmount, 52.48);
});
