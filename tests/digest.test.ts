import { cleanDbBeforeEach, addCat, tx, daysAgo } from "./helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { detectRecurrings } from "../src/lib/core";
import { linkMerchant, setBudget, setRecurringSetting } from "../src/lib/queries";
import { LARGE_CHARGE } from "../src/lib/forecast";
import {
  dailyDigest,
  runDigest,
  unusualCharges,
  alreadySent,
  FIRST_VENDOR_FLOOR,
  OVERDUE_GRACE_DAYS,
  SURPRISE_WINDOW_DAYS,
  type DigestDeps,
} from "../src/lib/digest";

cleanDbBeforeEach();

const since = () => daysAgo(SURPRISE_WINDOW_DAYS);
const reasons = () => Object.fromEntries(unusualCharges(since()).map((u) => [u.merchant, u.reason]));
const sentKeys = () => {
  alreadySent([]); // makes sure the table exists
  return (getDb().prepare("SELECT key FROM digest_sent ORDER BY key").all() as { key: string }[]).map((r) => r.key);
};
// A run with nothing real behind it: the sync and the send are stand-ins, so a
// test never reaches a bank or a phone.
function deps(over: Partial<DigestDeps> = {}) {
  const sent: string[] = [];
  const d: DigestDeps = { sync: async () => {}, send: async (t) => void sent.push(t), dryRun: false, retryMs: 0, ...over };
  return { d, sent };
}
const LARGE = -(LARGE_CHARGE + 500);
// The same day `n` calendar months earlier (the 28th at the latest, so the day exists).
const monthsBefore = (isoDate: string, n: number) => {
  const d = new Date(isoDate + "T00:00:00Z");
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, Math.min(d.getUTCDate(), 28))).toISOString().slice(0, 10);
};

// WHY: this is the one new judgement the digest makes, and each clause guards
// against a way it would cry wolf. A text that is wrong twice gets muted.
test("unusualCharges: large, a sizeable first charge, or well above the vendor's usual — and nothing else", () => {
  const cat = addCat("Shopping");
  const transfers = addCat("Transfers", "expense", 1);
  tx("Roof Co", { amount: LARGE, date: daysAgo(2), categoryId: cat });
  tx("New Dentist", { amount: -FIRST_VENDOR_FLOOR, date: daysAgo(2), categoryId: cat });
  tx("New Cafe", { amount: -(FIRST_VENDOR_FLOOR - 1), date: daysAgo(2), categoryId: cat }); // every new restaurant is a "first"
  for (const d of [90, 60, 30]) tx("Grocer", { amount: -80, date: daysAgo(d), categoryId: cat });
  tx("Grocer", { amount: -170, date: daysAgo(1), categoryId: cat }); // 2x the usual and $50 above it
  for (const d of [60, 30]) tx("Florist", { amount: -40, date: daysAgo(d), categoryId: cat });
  tx("Florist", { amount: -200, date: daysAgo(1), categoryId: cat }); // only two earlier charges: no "usual" yet
  tx("Old Roof Co", { amount: LARGE, date: daysAgo(SURPRISE_WINDOW_DAYS + 1), categoryId: cat }); // outside the window
  tx("Card Payment", { amount: LARGE, date: daysAgo(1), categoryId: transfers }); // does not count toward totals
  tx("Reimbursed Trip", { amount: LARGE, date: daysAgo(1), categoryId: cat, excluded: 1 });
  tx("Hotel Hold", { amount: LARGE, date: daysAgo(1), categoryId: cat, hash: "hold" });
  getDb().prepare("UPDATE transactions SET pending = 1 WHERE hash = 'hold'").run(); // a pending amount still moves

  assert.deepEqual(reasons(), { "Roof Co": "large", "New Dentist": "first", Grocer: "above-usual" });
  assert.equal(unusualCharges(since()).find((u) => u.merchant === "Grocer")!.usual, 80);
});

// WHY: a bank relabel ("Ymca" arriving as "Young Mens Chris") or a drifted
// descriptor is the same vendor. Read as a new one, every relabel is a false
// "first charge from this vendor".
test("unusualCharges: a combined name or a drifted descriptor is not a new vendor", () => {
  const cat = addCat("Kids");
  tx("Ymca", { amount: -250, date: daysAgo(60), categoryId: cat });
  tx("Young Mens Chris", { amount: -250, date: daysAgo(1), categoryId: cat });
  linkMerchant("Young Mens Chris", "Ymca");
  tx("Benjamin Franklin Plumbing", { amount: -300, date: daysAgo(60), categoryId: cat });
  tx("Benjamin Franklin Plindianapolis In", { amount: -300, date: daysAgo(1), categoryId: cat });
  assert.deepEqual(reasons(), {});
});

// WHY: a bill that came in high is news once, as a bill. The same charge is
// also large and outside nothing — reported twice, the message reads as two
// problems.
test("a bill that differed is reported once, as a bill, and never again as an unusual charge", async () => {
  const cat = addCat("Insurance");
  // One charge per calendar month: a month's paid amount is a sum, so two
  // charges 30 days apart that land in one month (the 1st and the 31st) would
  // read as one doubled bill.
  for (const back of [3, 2, 1]) tx("Acme Insurance", { amount: LARGE, date: monthsBefore(daysAgo(2), back), categoryId: cat });
  tx("Acme Insurance", { amount: LARGE - 400, date: daysAgo(2), categoryId: cat });
  detectRecurrings();
  setRecurringSetting("Acme Insurance", { expectedAmount: Math.abs(LARGE) });

  const built = dailyDigest()!;
  assert.deepEqual(built.keys.map((k) => k.split(":")[0]), ["differed"]);
  assert.match(built.sections[0].lines[0], /Acme Insurance came in at \$1,900\.00, \$400\.00 more than expected\./);
});

// WHY: `paidAmount` is a month's SUM. A weekly plan paid four times is four
// times one expected charge, every month — a standing false alarm.
test("a plan that charges more than once a month is never reported as differed", () => {
  const cat = addCat("Help");
  for (const d of [36, 29, 22, 15, 8, 1]) tx("Lawn Crew", { amount: -60, date: daysAgo(d), categoryId: cat });
  const plan = detectRecurrings().find((r) => r.merchant === "Lawn Crew");
  assert.equal(plan?.cadence, "weekly", "fixture: a weekly plan");
  assert.equal(dailyDigest(), null);
});

// WHY: bank data posts one to three days late. Without a grace, "due yesterday"
// would text most mornings about a bill that is merely in transit.
test("an overdue bill is reported only after the bank has had time to post it", { skip: overdueSkip() }, () => {
  const cat = addCat("Utilities");
  const seedBill = (name: string, dueDaysAgo: number) => {
    for (const back of [3, 2, 1]) tx(name, { amount: -90, date: monthsBefore(daysAgo(dueDaysAgo), back), categoryId: cat });
  };
  seedBill("Water Co", OVERDUE_GRACE_DAYS + 1);
  seedBill("Gas Co", OVERDUE_GRACE_DAYS - 1);
  detectRecurrings();
  const lines = dailyDigest()?.sections[0].lines ?? [];
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Water Co \(\$90\.00\) was due .* and hasn't posted\.$/);
});
// The fixture needs "due four days ago" to be a day of THIS month that also
// exists in the three months before it; on the 1st to 4th, or for a day past
// the 28th, it doesn't. The clock sweep runs this on every other day.
function overdueSkip(): string | false {
  const due = daysAgo(OVERDUE_GRACE_DAYS + 1);
  if (due.slice(0, 7) !== daysAgo(0).slice(0, 7)) return "the due day falls in last month";
  return Number(due.slice(8, 10)) > 28 ? "the due day does not exist in every month" : false;
}

// WHY: the daily text is worth reading only because it is rare. Chores are
// almost never zero, so if they could trigger a send there would be no quiet
// days, and the text would be muted within a week.
test("a quiet day sends nothing, even with chores waiting", async () => {
  tx("Corner Store", { amount: -12, date: daysAgo(1), categoryId: null }); // an uncategorized charge: a chore
  const { d, sent } = deps();
  assert.equal(await runDigest(dailyDigest, d), "quiet");
  assert.deepEqual(sent, []);
});

// WHY: a thing said twice is noise, and the owner asked for each thing once.
// Plaid re-posting the same charge with a corrected date is still the same thing.
test("nothing is said twice, including when the bank re-posts a charge with a new date", async () => {
  const cat = addCat("Home");
  tx("Roof Co", { amount: LARGE, date: daysAgo(3), categoryId: cat, hash: "roof" });
  const first = deps();
  assert.equal(await runDigest(dailyDigest, first.d), "sent");
  assert.match(first.sent[0], /Roof Co: \$1,500\.00 on .*, a large charge\./);
  assert.match(first.sent[0], /^Daybook, /);

  const second = deps();
  assert.equal(await runDigest(dailyDigest, second.d), "quiet");
  getDb().prepare("UPDATE transactions SET date = ? WHERE hash = 'roof'").run(daysAgo(1));
  assert.equal(await runDigest(dailyDigest, second.d), "quiet");
  assert.deepEqual(second.sent, []);
});

// WHY: "said" must mean "delivered". If the send fails and the item is recorded
// anyway, the owner never hears about it. A dry run is a look, not a send.
test("an item is recorded only after a successful send: a failed send retries, a dry run records nothing", async () => {
  const cat = addCat("Home");
  tx("Roof Co", { amount: LARGE, date: daysAgo(3), categoryId: cat, hash: "roof" });

  const printed: string[] = [];
  assert.equal(await runDigest(dailyDigest, deps({ dryRun: true, print: (t) => printed.push(t) }).d), "dry");
  assert.match(printed[0], /Roof Co/);
  assert.deepEqual(sentKeys(), []);

  await assert.rejects(runDigest(dailyDigest, deps({ send: async () => Promise.reject(new Error("Messages is signed out")) }).d), /signed out/);
  assert.deepEqual(sentKeys(), []);

  const ok = deps();
  assert.equal(await runDigest(dailyDigest, ok.d), "sent");
  assert.match(ok.sent[0], /Roof Co/);
  assert.deepEqual(sentKeys(), ["unusual:roof"]);
});

// WHY: a digest built on stale figures must say so (the honesty rule), with the
// day the figures run to. But "the bank was unreachable" is not news on its own:
// a laptop waking before Wi-Fi is up would text every morning.
test("a failed sync is stated with the last data day, and does not by itself break a quiet day", async () => {
  const failing = { sync: async () => Promise.reject(new Error("offline")) };
  const quiet = deps(failing);
  assert.equal(await runDigest(dailyDigest, quiet.d), "quiet");
  assert.deepEqual(quiet.sent, []);

  const cat = addCat("Home");
  tx("Roof Co", { amount: LARGE, date: daysAgo(3), categoryId: cat });
  getDb().prepare("INSERT INTO transactions (date, merchant, amount, account, source, hash) VALUES (?, 'Cafe', -5, 'Visa', 'plaid', 'p1')").run(daysAgo(5));
  const loud = deps(failing);
  assert.equal(await runDigest(dailyDigest, loud.d), "sent");
  assert.match(loud.sent[0], /Bank sync failed\. Figures as of [A-Z][a-z]{2} \d+\./);

  let calls = 0;
  const flaky = deps({ sync: async () => (++calls === 1 ? Promise.reject(new Error("no wifi yet")) : undefined) });
  getDb().exec("DELETE FROM digest_sent");
  await runDigest(dailyDigest, flaky.d);
  assert.equal(calls, 2, "one retry: a job that fires on wake often runs before the network is up");
  assert.doesNotMatch(flaky.sent[0], /sync failed/);
});

// WHY: the app never shows a month-end projection it doesn't have (before day
// 5), and qualifies the one it does. The message carries the same sentence, so
// it must keep the same promise.
test("the budget line withholds a projection early in the month and qualifies it after", async () => {
  const cat = addCat("Groceries");
  setBudget(cat, 5000);
  const month = daysAgo(0).slice(0, 7);
  tx("Grocer", { amount: -120, date: `${month}-01`, categoryId: cat });
  tx("Roof Co", { amount: LARGE, date: daysAgo(1), categoryId: null, hash: "trigger" }); // something to report, outside the budget
  const budgetLine = () => dailyDigest()!.sections.find((s) => s.title === "Budget")!.lines[0];
  if (daysAgo(1) <= `${month}-04`) assert.match(budgetLine(), /too early to project the month\.$/);

  for (const day of ["03", "06", "10"]) tx("Grocer", { amount: -150, date: `${month}-${day}`, categoryId: cat });
  assert.match(budgetLine(), /^On pace to finish .*(under|over|on) budget\.$/);
});
