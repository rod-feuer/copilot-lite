import { getDb } from "./db";
import { dashboard } from "./core";
import {
  recurringsForMonth,
  isRecurringActive,
  getMerchantLinks,
  getRecurringSettings,
  canonicalMerchant,
  merchantDisplayName,
} from "./queries";
import { billDelta, billStatus } from "./bills";
import { budgetOutlook } from "./budgetOutlook";
import { categorizeSuggestions } from "./categorizeSuggest";
import { allMergeSuggestions } from "./merges";
import { nameCleanupSuggestions } from "./nameCleanup";
import { merchantKey } from "./merchant";
import { LARGE_CHARGE } from "./forecast";
import { usd, shortDate } from "./format";

// The digests: what changed and what needs you, pushed instead of fetched. Every
// number and sentence here is code — the same functions the screens use — so a
// message can't say something the app doesn't. The daily one is sent only when
// there is a NEW surprise; the budget line and the chores ride along and never
// trigger a send (chore counts are almost never zero, so they would end quiet
// days, and a text that always arrives gets muted).

// Bank data posts one to three days late, so "due yesterday and not here" is
// usually just the bank. The grace is the digest's alone: the Recurrings page
// still shows a bill as overdue the day after it was due.
export const OVERDUE_GRACE_DAYS = 3;
// A first charge from a vendor is news only when it is sizeable: every new
// restaurant is a "first charge".
export const FIRST_VENDOR_FLOOR = 200;
// "Well above usual": at least twice the vendor's median over three or more
// earlier charges, and at least this many dollars above it (at $50 every big
// grocery run was "unusual").
export const ABOVE_USUAL_FACTOR = 2;
export const ABOVE_USUAL_MIN = 100;
// How far back a surprise can be and still be reported, so a first run (or a run
// after a week away) can't dump history.
export const SURPRISE_WINDOW_DAYS = 14;
// A month's paid amount is the SUM of its charges, so a plan that charges more
// than once a month always "differs" from one expected charge.
const SUMMED_CADENCES = new Set(["weekly", "biweekly"]);

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysBefore = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

export type Section = { title: string; lines: string[] };
export type Surprise = { key: string; line: string };

// ---------- what has been said ----------
// One key per thing said, so each is said once. Never keyed on a plan's id (the
// plans are rebuilt on every sync) or a charge's row id (a pending row is
// deleted and re-inserted when it posts): a plan's merchant and a charge's hash
// are what survive.
function ensureDigestSent(db: ReturnType<typeof getDb>) {
  db.exec("CREATE TABLE IF NOT EXISTS digest_sent (key TEXT PRIMARY KEY, sentAt TEXT NOT NULL, value REAL)");
}
export function alreadySent(keys: string[]): Set<string> {
  const db = getDb();
  ensureDigestSent(db);
  if (!keys.length) return new Set();
  const rows = db.prepare(`SELECT key FROM digest_sent WHERE key IN (${keys.map(() => "?").join(",")})`).all(...keys) as { key: string }[];
  return new Set(rows.map((r) => r.key));
}
export function markSent(keys: string[], value: number | null = null): void {
  const db = getDb();
  ensureDigestSent(db);
  const put = db.prepare("INSERT OR IGNORE INTO digest_sent (key, sentAt, value) VALUES (?, ?, ?)");
  const now = new Date().toISOString();
  db.transaction(() => keys.forEach((k) => put.run(k, now, value))).immediate();
}
// A value that is replaced, not said once: what the headline last said.
function setValue(key: string, value: number): void {
  const db = getDb();
  ensureDigestSent(db);
  db.prepare("INSERT OR REPLACE INTO digest_sent (key, sentAt, value) VALUES (?, ?, ?)").run(key, new Date().toISOString(), value);
}

// ---------- the one new calculation ----------
export type UnusualCharge = {
  hash: string;
  merchant: string;
  amount: number; // signed, as stored (an expense is negative)
  date: string;
  reason: "large" | "first" | "above-usual";
  usual?: number; // the vendor's median, for "above-usual"
};
// A posted charge, outside any plan, that counts toward totals, and is one of:
// large; the vendor's first ever and sizeable; well above what that vendor
// usually charges. Pending rows are left out — their amounts move (a gas hold, a
// tip) and the row is replaced when it posts — so notice comes when it settles.
// Plan charges are left out: a bill that came in high is reported as a bill.
export function unusualCharges(sinceIso: string): UnusualCharge[] {
  const rows = getDb()
    .prepare(
      `SELECT t.hash, t.merchant, t.amount, COALESCE(t.effectiveDate, t.date) AS date, t.pending, t.recurringId,
              t.excluded, COALESCE(c.excludeFromTotals, 0) AS catExcluded
       FROM transactions t LEFT JOIN categories c ON c.id = t.categoryId
       WHERE t.amount < 0 ORDER BY COALESCE(t.effectiveDate, t.date), t.id`
    )
    .all() as { hash: string; merchant: string; amount: number; date: string; pending: 0 | 1; recurringId: number | null; excluded: 0 | 1; catExcluded: 0 | 1 }[];
  // A vendor is its combined name, then the coarse key the shelf rolls bank
  // wordings up with — or a drifted descriptor reads as a brand-new vendor.
  const links = getMerchantLinks();
  const vendorOf = (m: string) => {
    const v = canonicalMerchant(m, links);
    return merchantKey(v) || v;
  };
  const earlier = new Map<string, { any: number; amounts: number[] }>(); // per vendor, the charges before this one
  const out: UnusualCharge[] = [];
  for (const r of rows) {
    const vendor = vendorOf(r.merchant);
    const past = earlier.get(vendor) ?? { any: 0, amounts: [] };
    const size = Math.abs(r.amount);
    const counts = r.excluded === 0 && r.catExcluded === 0;
    if (r.date >= sinceIso && r.pending === 0 && r.recurringId == null && counts) {
      const sorted = [...past.amounts].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const median = sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 0;
      const base = { hash: r.hash, merchant: r.merchant, amount: r.amount, date: r.date };
      if (size > LARGE_CHARGE) out.push({ ...base, reason: "large" });
      else if (past.any === 0 && size >= FIRST_VENDOR_FLOOR) out.push({ ...base, reason: "first" });
      else if (sorted.length >= 3 && size >= ABOVE_USUAL_FACTOR * median && size - median >= ABOVE_USUAL_MIN)
        out.push({ ...base, reason: "above-usual", usual: median });
    }
    past.any++;
    if (r.pending === 0 && counts) past.amounts.push(size);
    earlier.set(vendor, past);
  }
  return out;
}

// ---------- the daily message ----------
// One fixed shape, so every text reads the same way:
//
//   Daybook: Still on pace to finish September $4,185 under budget.
//
//   Bills that came in high
//   Duke Energy $368, up $153
//
//   Charges worth a look
//   $288 to Ble Llc on Sep 13, first time
//   $3,365 to Bill.com on Sep 17, large
//
// The verdict leads, as it does on the dashboard: it answers "do I need to
// worry?", and a notification shows enough lines for the first item to follow
// it. Then what happened TO you (a bill that never posted, a bill someone
// changed), then the charges — a large charge last, since you were there when
// you made it. Whole dollars: cents belong on a statement.

// A bill's difference is worth a text only when it is real money and a real
// share of the bill: $8 on a $114 grooming bill is neither.
export const BILL_CHANGE_MIN = 25;
export const BILL_CHANGE_SHARE = 0.1;

type Group = "late" | "bill" | "charge";
type Found = Surprise & { group: Group; rank: number; change?: "up" | "down" | "twice" };
const dollars = (n: number) => usd(Math.abs(n), { cents: false });
const monthName = (month: string) => new Date(month + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

function surprises(today: string): Found[] {
  const since = daysBefore(SURPRISE_WINDOW_DAYS);
  const month = today.slice(0, 7);
  const settings = getRecurringSettings();
  const links = getMerchantLinks();
  const out: Found[] = [];

  // Bills, this month and last (a bill paid on the 30th is read on the 1st).
  const lastMonth = iso(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1))).slice(0, 7);
  const earlyInMonth = Number(today.slice(8, 10)) <= SURPRISE_WINDOW_DAYS;
  for (const m of earlyInMonth ? [lastMonth, month] : [month]) {
    for (const r of recurringsForMonth(m)) {
      if (r.avgAmount >= 0) continue; // deposits are not bills
      const delta = billDelta(r);
      const matters = delta != null && Math.abs(delta) >= BILL_CHANGE_MIN && Math.abs(delta) >= BILL_CHANGE_SHARE * r.expectedAmount;
      if (delta != null && matters && !SUMMED_CADENCES.has(r.cadence) && r.lastDate >= since)
        out.push({
          key: `differed:${r.merchant}:${m}`,
          group: "bill",
          rank: Math.abs(delta),
          change: delta > 0 ? "up" : "down",
          line: `${r.displayName} ${dollars(r.paidAmount as number)}, ${delta > 0 ? "up" : "down"} ${dollars(delta)}`,
        });
      // Charged twice in one month: a duplicate, or next month's payment gone
      // out early. Either way the single paid amount above would hide it.
      if (!SUMMED_CADENCES.has(r.cadence) && r.paidTimes >= 2 && r.lastDate >= since)
        out.push({
          key: `twice:${r.merchant}:${m}`,
          group: "bill",
          rank: r.expectedAmount,
          change: "twice",
          line: `${r.displayName} ${dollars(r.paidAmount as number)}, charged ${r.paidTimes === 2 ? "twice" : `${r.paidTimes} times`} in ${monthName(m)}`,
        });
      const late = m === month && billStatus(r, daysBefore(OVERDUE_GRACE_DAYS)) === "od";
      if (late && r.expectedThisMonth && !r.ended && isRecurringActive(r.lastDate, r.cadence))
        out.push({
          key: `overdue:${r.merchant}:${r.dueDate}`,
          group: "late",
          rank: r.expectedAmount,
          line: `${r.displayName} ${dollars(r.expectedAmount)}, due ${shortDate(r.dueDate)}`,
        });
    }
  }

  // Within the charges: a first-time vendor (it might not be you), then one
  // well above its usual, then a large one (it was probably you).
  const order = { first: 3e9, "above-usual": 2e9, large: 1e9 };
  for (const u of unusualCharges(since)) {
    const what = `${dollars(u.amount)} to ${merchantDisplayName(u.merchant, settings, links)} on ${shortDate(u.date)}`;
    out.push({
      key: `unusual:${u.hash}`,
      group: "charge",
      rank: order[u.reason] + Math.abs(u.amount),
      line: u.reason === "large" ? `${what}, large` : u.reason === "first" ? `${what}, first time` : `${what}, usually ${dollars(u.usual as number)}`,
    });
  }
  return out;
}

// The headline: the dashboard's verdict, by the same rule (budgetOutlook), with
// the month named. "Still" when the last text this month said the same thing,
// "Now" when it has moved, neither when this is the month's first word on it.
const KIND_VALUE = { under: -1, on: 0, over: 1 } as const;
function headline(today: string): { text: string; state: { key: string; value: number } | null; flipped: boolean } {
  const month = today.slice(0, 7);
  const name = monthName(month);
  // Always name the month: with none, dashboard() picks the latest month that
  // has data, which can be a future-dated one.
  const d = dashboard(month);
  const b = d.budget;
  if (!b || b.total <= 0) return { text: `${dollars(d.expenses)} spent so far in ${name}.`, state: null, flipped: false };
  if (b.projected == null)
    return { text: `${dollars(b.spent)} of your ${dollars(b.total)} budget used. Too early to project ${name}.`, state: null, flipped: false };
  const o = budgetOutlook(b.total, b.projected, true);
  const key = `verdict:${month}`;
  const db = getDb();
  ensureDigestSent(db);
  const before = (db.prepare("SELECT value FROM digest_sent WHERE key = ?").get(key) as { value: number | null } | undefined)?.value;
  const moved = before != null && before !== KIND_VALUE[o.kind];
  const lead = before == null ? "On pace" : moved ? "Now on pace" : "Still on pace";
  const tail = o.kind === "on" ? "on budget" : `${dollars(o.delta)} ${o.kind} budget`;
  return { text: `${lead} to finish ${name} ${tail}.`, state: { key, value: KIND_VALUE[o.kind] }, flipped: moved && o.kind === "over" };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function chores(needsReview: number): string[] {
  const out: string[] = [];
  if (needsReview > 0) out.push(`${plural(needsReview, "charge needs", "charges need")} a category`);
  const suggested = categorizeSuggestions().suggestions.length;
  if (suggested > 0) out.push(`${plural(suggested, "category suggestion", "category suggestions")} to apply`);
  const merges = allMergeSuggestions().length;
  if (merges > 0) out.push(`${plural(merges, "vendor", "vendors")} to combine`);
  const tidy = nameCleanupSuggestions().length;
  if (tidy > 0) out.push(`${plural(tidy, "vendor name", "vendor names")} to tidy`);
  return out;
}

export type Built = {
  headline: string;
  sections: Section[];
  todo: string[];
  keys: string[];
  state: { key: string; value: number } | null; // what the headline said, for next time's "Still" or "Now"
};
// null = a quiet day: nothing new, so nothing is sent. The month turning from
// under budget to over is news by itself, once.
export function dailyDigest(): Built | null {
  const today = iso(new Date());
  const found = surprises(today);
  const head = headline(today);
  const flipKey = `flip:${today.slice(0, 7)}:over`;
  const sent = alreadySent([...found.map((s) => s.key), flipKey]);
  const fresh = found.filter((s) => !sent.has(s.key)).sort((a, b) => b.rank - a.rank);
  const flip = head.flipped && !sent.has(flipKey);
  if (!fresh.length && !flip) return null;

  const of = (g: Group) => fresh.filter((s) => s.group === g);
  const bills = of("bill");
  const all = (c: Found["change"]) => bills.every((s) => s.change === c);
  const billsTitle = all("up") ? "Bills that came in high" : all("down") ? "Bills that came in low" : all("twice") ? "Bills charged twice" : "Bills that changed";
  const sections: Section[] = [
    { title: "Bills that haven't posted", lines: of("late").map((s) => s.line) },
    { title: billsTitle, lines: bills.map((s) => s.line) },
    { title: "Charges worth a look", lines: of("charge").map((s) => s.line) },
  ].filter((s) => s.lines.length);
  return {
    headline: head.text,
    sections,
    todo: chores(dashboard(today.slice(0, 7)).needsReview),
    keys: [...fresh.map((s) => s.key), ...(flip ? [flipKey] : [])],
    state: head.state,
  };
}

export function renderText(built: Pick<Built, "headline" | "sections" | "todo">, note?: string | null): string {
  return [
    `Daybook: ${built.headline}`,
    ...(note ? [note] : []),
    ...built.sections.map((s) => [s.title, ...s.lines].join("\n")),
    ...(built.todo.length ? [`To do: ${built.todo.join(", ")}.`] : []),
  ].join("\n\n");
}

// ---------- running one ----------
export type DigestDeps = {
  sync: () => Promise<unknown>;
  send: (text: string) => Promise<void>;
  dryRun: boolean;
  print?: (text: string) => void; // a dry run's output
  retryMs?: number; // a job that fires on wake often runs before Wi-Fi is up
};
// Sync, build, send, and only then record what was said: a send that fails
// records nothing, so the next run says it again. A sync that fails is stated in
// the message with the day the figures run to — but does not by itself make a
// quiet day speak.
export async function runDigest(build: () => Built | null, deps: DigestDeps): Promise<"sent" | "quiet" | "dry"> {
  let note: string | null = null;
  try {
    await deps.sync();
  } catch {
    await new Promise((r) => setTimeout(r, deps.retryMs ?? 15_000));
    try {
      await deps.sync();
    } catch {
      const last = (getDb().prepare("SELECT MAX(date) AS d FROM transactions WHERE source = 'plaid'").get() as { d: string | null }).d;
      note = `Couldn't reach the bank, so this is as of ${last ? shortDate(last) : "the last sync"}.`;
    }
  }
  const built = build();
  if (!built) return "quiet";
  const text = renderText(built, note);
  if (deps.dryRun) {
    (deps.print ?? console.log)(text);
    return "dry";
  }
  await deps.send(text);
  markSent(built.keys);
  if (built.state) setValue(built.state.key, built.state.value);
  return "sent";
}
