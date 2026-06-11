import { getDb, ensureMergeDismissals } from "./db";
import {
  getMerchantLinks,
  canonicalMerchant,
  linkMerchant,
  distinctMerchants,
  isRecurringActive,
} from "./queries";

// US state codes as normalizeMerchant title-cases them (e.g. "IN" -> "In").
const STATES = new Set(
  "Al Ak Az Ar Ca Co Ct De Fl Ga Hi Id Il In Ia Ks Ky La Me Md Ma Mi Mn Ms Mo Mt Ne Nv Nh Nj Nm Ny Nc Nd Oh Ok Or Pa Ri Sc Sd Tn Tx Ut Vt Va Wa Wv Wi Wy".split(
    " "
  )
);

// Approximate days between charges per cadence (for the "lands in the expected
// slot" timing test below).
const PERIOD: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  semiannual: 182,
  yearly: 365,
};

// Strip a trailing location suffix from a bank descriptor — either
// "<name> - <city…> <ST>" or a bare "<name> <city> <ST>". The trailing token
// must be a real US state code, and the surviving prefix must be specific
// enough (≥ 4 chars) so it can't collapse to a generic like "The". Returns the
// stripped prefix, or null when there's no recognizable location suffix.
export function stripLocationSuffix(merchant: string): string | null {
  let m = merchant.match(/^(.+?) - .+ ([A-Z][a-z])$/); // "Name - City ST"
  if (!m) m = merchant.match(/^(.+?) [A-Za-z]+ ([A-Z][a-z])$/); // "Name City ST"
  if (!m || !STATES.has(m[2])) return null;
  const prefix = m[1].trim();
  return prefix.length >= 4 ? prefix : null;
}

export type MergeSuggestion = {
  canonical: string; // the vendor everything folds into (the link target)
  key: string; // stable id used for dismissal
  variants: { merchant: string; count: number }[];
  total: number;
  note?: string; // why it's suggested (recurring-match only)
  categoryId?: number; // recurring-match: set uncategorized variant charges to this
};

function dismissedKeys(db: ReturnType<typeof getDb>): Set<string> {
  ensureMergeDismissals(db);
  return new Set(
    (
      db.prepare("SELECT canonical FROM merchant_merge_dismissals").all() as {
        canonical: string;
      }[]
    ).map((r) => r.canonical)
  );
}

// Candidate merges from location-suffix variants. Liberal by design — it's a
// review queue, so the user is the precision filter. Excludes anything already
// linked or previously dismissed. Dismiss key = the canonical (bare).
export function mergeSuggestions(): MergeSuggestion[] {
  const db = getDb();
  const dismissed = dismissedKeys(db);
  const links = getMerchantLinks();
  const merchants = distinctMerchants();
  const countOf: Record<string, number> = {};
  for (const m of merchants) countOf[m.merchant] = m.count;

  const groups: Record<string, Set<string>> = {};
  for (const { merchant } of merchants) {
    const canon = stripLocationSuffix(merchant);
    if (!canon) continue;
    if (canonicalMerchant(merchant, links) === canonicalMerchant(canon, links)) continue;
    (groups[canon] ??= new Set()).add(merchant);
  }

  const out: MergeSuggestion[] = [];
  for (const [canon, set] of Object.entries(groups)) {
    if (dismissed.has(canon)) continue;
    if (countOf[canon] != null) set.add(canon);
    if (set.size < 2) continue;
    const variants = [...set]
      .map((merchant) => ({ merchant, count: countOf[merchant] ?? 0 }))
      .sort((a, b) => b.count - a.count);
    out.push({
      canonical: canon,
      key: canon,
      variants,
      total: variants.reduce((s, v) => s + v.count, 0),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// Length of the shared leading run of two names once lowercased and stripped to
// alphanumerics. "Duke Energy"/"Dukeenergy Bill Pay" → 10 ("dukeenergy"); it's 0
// against "Carmelclerktreas Water Bill". A strong, cheap "same vendor renamed"
// signal that behaviour (amount + timing) alone can't provide.
function nameAffinity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  let i = 0;
  while (i < na.length && i < nb.length && na[i] === nb[i]) i++;
  return i;
}
const MIN_AFFINITY = 6;

// Behavior + name detector: a rare, non-recurring charge whose name clearly
// echoes an active recurring's vendor (shared ≥6-char prefix) AND that posts
// around that bill's cadence with a plausible amount is almost certainly that
// vendor under a new descriptor — whatever the string change (location, spelling,
// processor prefix). Catches the class the location-suffix rule can't. The name
// filter is what disambiguates two similar monthly bills. `exclude` skips
// merchants already surfaced by the location detector. Dismiss key = "rec:<m>".
export function recurringMatchSuggestions(exclude: Set<string>): MergeSuggestion[] {
  const db = getDb();
  const dismissed = dismissedKeys(db);
  const links = getMerchantLinks();

  const recs = (
    db
      .prepare(
        `SELECT r.id, r.merchant, r.categoryId, r.cadence, r.lastDate, r.avgAmount,
                MIN(ABS(t.amount)) lo, MAX(ABS(t.amount)) hi
         FROM recurrings r JOIN transactions t ON t.recurringId = r.id
         WHERE r.avgAmount < 0
         GROUP BY r.id`
      )
      .all() as {
      merchant: string;
      categoryId: number | null;
      cadence: string;
      lastDate: string;
      lo: number;
      hi: number;
    }[]
  ).filter((r) => isRecurringActive(r.lastDate, r.cadence));

  const merchants = distinctMerchants();
  const countOf: Record<string, number> = {};
  for (const m of merchants) countOf[m.merchant] = m.count;
  const rare = new Set(merchants.filter((m) => m.count <= 2).map((m) => m.merchant));

  // All currently non-recurring expense charges of rare merchants, grouped.
  const charges = db
    .prepare(
      `SELECT merchant, COALESCE(effectiveDate, date) AS d, amount, categoryId
       FROM transactions
       WHERE recurringId IS NULL AND amount < 0 AND excluded = 0`
    )
    .all() as { merchant: string; d: string; amount: number; categoryId: number | null }[];
  const byMerchant: Record<string, typeof charges> = {};
  for (const c of charges) {
    if (!rare.has(c.merchant)) continue;
    (byMerchant[c.merchant] ??= []).push(c);
  }

  const out: MergeSuggestion[] = [];
  for (const [merchant, cs] of Object.entries(byMerchant)) {
    const key = "rec:" + merchant;
    if (exclude.has(merchant) || dismissed.has(key)) continue;
    const cm = canonicalMerchant(merchant, links);

    // Best recurring by name affinity (the disambiguator), confirmed by a
    // plausible amount and a charge that posts around the bill's cadence.
    let best: { rec: (typeof recs)[number]; affinity: number } | null = null;
    for (const c of cs) {
      const mag = Math.abs(c.amount);
      for (const r of recs) {
        if (canonicalMerchant(r.merchant, links) === cm) continue; // already same vendor
        const affinity = nameAffinity(merchant, r.merchant);
        if (affinity < MIN_AFFINITY) continue; // names must echo each other
        if (mag < r.lo * 0.5 || mag > r.hi * 1.5) continue; // amount implausible
        const period = PERIOD[r.cadence] ?? 30;
        const gap = (Date.parse(c.d) - Date.parse(r.lastDate)) / 86_400_000;
        if (gap < -period || gap > period * 2) continue; // not a current/forward charge
        if (!best || affinity > best.affinity) best = { rec: r, affinity };
      }
    }
    if (!best) continue;
    const r = best.rec;
    out.push({
      canonical: r.merchant,
      key,
      variants: [
        { merchant, count: countOf[merchant] ?? 0 },
        { merchant: r.merchant, count: countOf[r.merchant] ?? 0 },
      ],
      total: (countOf[merchant] ?? 0) + (countOf[r.merchant] ?? 0),
      note: `Lands in your ${r.cadence} “${r.merchant}” slot at a similar amount — likely the same vendor renamed. Combining makes it recurring${
        r.categoryId != null ? " and sets its category" : ""
      }.`,
      categoryId: r.categoryId ?? undefined,
    });
  }
  return out;
}

// The full review queue: behaviour-based matches first (more time-sensitive),
// then location-suffix groups. A merchant surfaced by the location detector is
// not double-suggested here.
export function allMergeSuggestions(): MergeSuggestion[] {
  const loc = mergeSuggestions();
  const covered = new Set(loc.flatMap((g) => g.variants.map((v) => v.merchant)));
  return [...recurringMatchSuggestions(covered), ...loc];
}

// Approve: fold every variant into the canonical name; for a recurring-match,
// also tag any still-uncategorized variant charges with the recurring's
// category. The caller re-runs detection so recurrings regroup.
export function approveMerge(canonical: string, variants: string[], categoryId?: number) {
  const db = getDb();
  ensureMergeDismissals(db);
  const others = variants.filter((v) => v !== canonical);
  for (const v of others) linkMerchant(v, canonical);
  if (categoryId != null && others.length) {
    const ph = others.map(() => "?").join(",");
    db.prepare(
      `UPDATE transactions SET categoryId = ? WHERE merchant IN (${ph}) AND categoryId IS NULL`
    ).run(categoryId, ...others);
  }
}

// Dismiss: remember this suggestion's key so it never resurfaces.
export function dismissMerge(key: string) {
  const db = getDb();
  ensureMergeDismissals(db);
  db.prepare(
    "INSERT INTO merchant_merge_dismissals (canonical) VALUES (?) ON CONFLICT(canonical) DO NOTHING"
  ).run(key);
}
