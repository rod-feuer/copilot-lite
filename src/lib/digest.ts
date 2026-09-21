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
import { buildVerdict } from "./verdict";
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
// earlier charges, and at least this many dollars above it.
export const ABOVE_USUAL_FACTOR = 2;
export const ABOVE_USUAL_MIN = 50;
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
export type Built = { sections: Section[]; keys: string[] };

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
function surprises(today: string): Surprise[] {
  const since = daysBefore(SURPRISE_WINDOW_DAYS);
  const month = today.slice(0, 7);
  const settings = getRecurringSettings();
  const links = getMerchantLinks();
  const out: Surprise[] = [];

  // Bills, this month and last (a bill paid on the 30th is read on the 1st).
  const lastMonth = iso(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1))).slice(0, 7);
  const earlyInMonth = Number(today.slice(8, 10)) <= SURPRISE_WINDOW_DAYS;
  for (const m of earlyInMonth ? [lastMonth, month] : [month]) {
    for (const r of recurringsForMonth(m)) {
      if (r.avgAmount >= 0) continue; // deposits are not bills
      const delta = billDelta(r);
      if (delta != null && !SUMMED_CADENCES.has(r.cadence) && r.lastDate >= since)
        out.push({
          key: `differed:${r.merchant}:${m}`,
          line: `${r.displayName} came in at ${usd(r.paidAmount as number)}, ${usd(Math.abs(delta))} ${delta > 0 ? "more" : "less"} than expected.`,
        });
      const late = m === month && billStatus(r, daysBefore(OVERDUE_GRACE_DAYS)) === "od";
      if (late && r.expectedThisMonth && !r.ended && isRecurringActive(r.lastDate, r.cadence))
        out.push({
          key: `overdue:${r.merchant}:${r.dueDate}`,
          line: `${r.displayName} (${usd(r.expectedAmount)}) was due ${shortDate(r.dueDate)} and hasn't posted.`,
        });
    }
  }

  for (const u of unusualCharges(since)) {
    const name = merchantDisplayName(u.merchant, settings, links);
    const what = `${name}: ${usd(Math.abs(u.amount))} on ${shortDate(u.date)}`;
    out.push({
      key: `unusual:${u.hash}`,
      line:
        u.reason === "large"
          ? `${what}, a large charge.`
          : u.reason === "first"
            ? `${what}, the first charge from this vendor.`
            : `${what}; this vendor is usually about ${usd(u.usual as number, { cents: false })}.`,
    });
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function chores(needsReview: number): string[] {
  const out: string[] = [];
  if (needsReview > 0) out.push(`${plural(needsReview, "charge needs", "charges need")} a category this month`);
  const suggested = categorizeSuggestions().suggestions.length;
  if (suggested > 0) out.push(`${plural(suggested, "category suggestion", "category suggestions")} ready to apply`);
  const merges = allMergeSuggestions().length;
  if (merges > 0) out.push(`${plural(merges, "vendor", "vendors")} to combine`);
  const tidy = nameCleanupSuggestions().length;
  if (tidy > 0) out.push(`${plural(tidy, "vendor name", "vendor names")} to tidy`);
  return out;
}

// null = a quiet day: nothing new, so nothing is sent.
export function dailyDigest(): Built | null {
  const today = iso(new Date());
  const found = surprises(today);
  const sent = alreadySent(found.map((s) => s.key));
  const fresh = found.filter((s) => !sent.has(s.key));
  if (!fresh.length) return null;
  // Always name the month: with none, dashboard() picks the latest month that
  // has data, which can be a future-dated one.
  const dash = dashboard(today.slice(0, 7));
  const sections: Section[] = [
    { title: "New", lines: fresh.map((s) => s.line) },
    { title: "Budget", lines: [`${buildVerdict(dash, true).text}.`] },
  ];
  const todo = chores(dash.needsReview);
  if (todo.length) sections.push({ title: "To do", lines: todo });
  return { sections, keys: fresh.map((s) => s.key) };
}

export function renderText(sections: Section[], note?: string | null): string {
  const head = `Daybook, ${shortDate(iso(new Date()))}`;
  const body = sections.map((s) => [s.title, ...s.lines.map((l) => `• ${l}`)].join("\n"));
  return [head, ...(note ? [note] : []), ...body].join("\n\n");
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
      note = `Bank sync failed. Figures as of ${last ? shortDate(last) : "the last sync"}.`;
    }
  }
  const built = build();
  if (!built) return "quiet";
  const text = renderText(built.sections, note);
  if (deps.dryRun) {
    (deps.print ?? console.log)(text);
    return "dry";
  }
  await deps.send(text);
  markSent(built.keys);
  return "sent";
}
