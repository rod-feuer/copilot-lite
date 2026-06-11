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
  key: string; // unique UI id for this card
  dismissKeys: string[]; // keys to remember when the card is dismissed
  variants: { merchant: string; count: number }[];
  total: number;
  note?: string; // why it's suggested (recurring-match only)
  categoryId?: number; // recurring-match: set uncategorized variant charges to this
  lowConfidence?: boolean; // 0.8–0.9 name band — surface for confirmation, not certain
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
      key: "loc:" + canon,
      dismissKeys: [canon], // bare canonical (back-compat with prior dismissals)
      variants,
      total: variants.reduce((s, v) => s + v.count, 0),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// Lowercase, strip to alphanumerics — collapses punctuation/spacing/case so
// "Jimmy John's" and "Jimmy Johns" both become "jimmyjohns".
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// --- Name similarity (the "same vendor" signal) --------------------------
// Bank descriptors for one vendor differ by truncation/junk suffixes ("Upgrade"
// vs "Upgrade Inc Payment"), punctuation/spacing ("Gap Outletcom" vs
// "Gapoutlet.com"), or typos/transpositions. No single metric covers all, so
// nameAffinity returns the MAX (0..1) of three complementary signals — the
// record-linkage best practice of combining matchers rather than picking one:
//   • prefix-containment — one normalized name is a prefix of the other
//     (truncation / appended junk; what plain Jaro-Winkler under-scores)
//   • Jaro-Winkler — typos & transpositions, prefix-weighted (good for names)
//   • token-set overlap — reordered / subset tokens, ignoring legal/noise words
const STOP_TOKENS = new Set([
  "inc", "llc", "co", "corp", "ltd", "the", "com", "payment", "bill", "pay",
]);

function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const md = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array(s1.length).fill(false);
  const m2 = new Array(s2.length).fill(false);
  let m = 0;
  for (let i = 0; i < s1.length; i++) {
    for (let j = Math.max(0, i - md); j < Math.min(i + md + 1, s2.length); j++) {
      if (!m2[j] && s1[i] === s2[j]) {
        m1[i] = m2[j] = true;
        m++;
        break;
      }
    }
  }
  if (!m) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k++]) t++;
  }
  t /= 2;
  return (m / s1.length + m / s2.length + (m - t) / m) / 3;
}

function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let p = 0;
  while (p < 4 && p < a.length && p < b.length && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}

function tokenize(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !STOP_TOKENS.has(t))
  );
}

export function nameAffinity(a: string, b: string): number {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  const [shortS, longS] = na.length <= nb.length ? [na, nb] : [nb, na];

  // 1. prefix-containment: how much of the shorter name leads the longer one.
  let shared = 0;
  while (shared < shortS.length && shortS[shared] === longS[shared]) shared++;
  const prefix = shortS.length >= 5 ? shared / shortS.length : 0;

  // 2. Jaro-Winkler on the normalized strings.
  const jw = jaroWinkler(na, nb);

  // 3. token-set overlap (fraction of the smaller token set that's shared).
  const A = tokenize(a);
  const B = tokenize(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const tokens = A.size && B.size ? inter / Math.min(A.size, B.size) : 0;

  return Math.max(prefix, jw, tokens);
}

// Thresholds for "same vendor". NAME_MATCH = confident (auto-reconcile pending↔
// posted, top of the merge queue). LOW_MATCH = a borderline band surfaced in the
// queue as a "possible match" for the user to confirm — never auto-applied.
export const NAME_MATCH = 0.9;
export const LOW_MATCH = 0.8;

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

  // Match each orphan merchant to its best recurring, then GROUP orphans by that
  // recurring so several stray descriptors of one vendor become a single card.
  const groups = new Map<
    string,
    { rec: (typeof recs)[number]; orphans: string[]; maxAffinity: number }
  >();
  for (const [merchant, cs] of Object.entries(byMerchant)) {
    if (exclude.has(merchant) || dismissed.has("rec:" + merchant)) continue;
    const cm = canonicalMerchant(merchant, links);

    // Best recurring by name affinity (the disambiguator), confirmed by a
    // plausible amount and a charge that posts around the bill's cadence. The
    // LOW_MATCH..NAME_MATCH band is kept but flagged low-confidence below.
    let best: { rec: (typeof recs)[number]; affinity: number } | null = null;
    for (const c of cs) {
      const mag = Math.abs(c.amount);
      for (const r of recs) {
        if (canonicalMerchant(r.merchant, links) === cm) continue; // already same vendor
        const affinity = nameAffinity(merchant, r.merchant);
        if (affinity < LOW_MATCH) continue; // names must at least echo each other
        if (mag < r.lo * 0.5 || mag > r.hi * 1.5) continue; // amount implausible
        const period = PERIOD[r.cadence] ?? 30;
        const gap = (Date.parse(c.d) - Date.parse(r.lastDate)) / 86_400_000;
        if (gap < -period || gap > period * 2) continue; // not a current/forward charge
        if (!best || affinity > best.affinity) best = { rec: r, affinity };
      }
    }
    if (!best) continue;
    const g = groups.get(best.rec.merchant) ?? {
      rec: best.rec,
      orphans: [],
      maxAffinity: 0,
    };
    g.orphans.push(merchant);
    g.maxAffinity = Math.max(g.maxAffinity, best.affinity);
    groups.set(best.rec.merchant, g);
  }

  const out: MergeSuggestion[] = [];
  for (const { rec: r, orphans, maxAffinity } of groups.values()) {
    const lowConfidence = maxAffinity < NAME_MATCH;
    const variants = [
      ...orphans
        .map((m) => ({ merchant: m, count: countOf[m] ?? 0 }))
        .sort((a, b) => b.count - a.count),
      { merchant: r.merchant, count: countOf[r.merchant] ?? 0 },
    ];
    out.push({
      canonical: r.merchant,
      key: "rec:" + r.merchant,
      dismissKeys: orphans.map((m) => "rec:" + m),
      variants,
      total: variants.reduce((s, v) => s + v.count, 0),
      note: lowConfidence
        ? `Possibly the same as your ${r.cadence} “${r.merchant}” bill — similar name, posts in the same slot at a similar amount. Combine only if it's the same vendor.`
        : `Lands in your ${r.cadence} “${r.merchant}” slot at a similar amount — likely the same vendor renamed. Combining makes ${
            orphans.length > 1 ? "them" : "it"
          } recurring${r.categoryId != null ? " and sets the category" : ""}.`,
      categoryId: r.categoryId ?? undefined,
      lowConfidence,
    });
  }
  // Confident matches first, borderline ones last.
  return out.sort((a, b) => Number(a.lowConfidence) - Number(b.lowConfidence) || b.total - a.total);
}

// Normalized-equality detector: distinct descriptors that reduce to the SAME
// string once punctuation/spacing/case is stripped ("Jimmy John's" vs
// "Jimmy Johns") are unambiguously one vendor — the safe, high-precision way to
// catch non-recurring splits the location/behaviour detectors miss. Canonical =
// the most common spelling. `exclude` skips merchants already surfaced above.
// Dismiss key = "eq:<normalized name>".
export function nameEqualityMergeSuggestions(exclude: Set<string>): MergeSuggestion[] {
  const db = getDb();
  const dismissed = dismissedKeys(db);
  const links = getMerchantLinks();
  const groups: Record<string, { merchant: string; count: number }[]> = {};
  for (const m of distinctMerchants()) {
    if (exclude.has(m.merchant)) continue;
    const n = normName(m.merchant);
    if (n.length < 4) continue;
    (groups[n] ??= []).push({ merchant: m.merchant, count: m.count });
  }

  const out: MergeSuggestion[] = [];
  for (const [n, variants] of Object.entries(groups)) {
    const key = "eq:" + n;
    if (variants.length < 2 || dismissed.has(key)) continue;
    // Skip if they already fold into one vendor.
    if (new Set(variants.map((v) => canonicalMerchant(v.merchant, links))).size < 2) continue;
    const sorted = [...variants].sort((a, b) => b.count - a.count);
    out.push({
      canonical: sorted[0].merchant, // the most common spelling wins
      key,
      dismissKeys: [key],
      variants: sorted,
      total: sorted.reduce((s, v) => s + v.count, 0),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// The full review queue: behaviour-based matches first (most time-sensitive),
// then punctuation/spacing twins, then location-suffix groups. A merchant
// surfaced by an earlier detector is not double-suggested by a later one.
export function allMergeSuggestions(): MergeSuggestion[] {
  const loc = mergeSuggestions();
  const covered = new Set(loc.flatMap((g) => g.variants.map((v) => v.merchant)));
  const rec = recurringMatchSuggestions(covered);
  for (const g of rec) for (const v of g.variants) covered.add(v.merchant);
  const eq = nameEqualityMergeSuggestions(covered);
  const all = [...rec, ...eq, ...loc];
  // Confident suggestions keep their natural order; borderline ones sink to the end.
  return [...all.filter((s) => !s.lowConfidence), ...all.filter((s) => s.lowConfidence)];
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

// Recent charges under each given descriptor, so the queue can let the user
// eyeball whether the variants really are one vendor before combining.
export function mergePreview(
  merchants: string[],
  limit = 4
): Record<string, { date: string; amount: number; account: string }[]> {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT COALESCE(effectiveDate, date) AS date, amount, account
     FROM transactions WHERE merchant = ?
     ORDER BY COALESCE(effectiveDate, date) DESC, id DESC LIMIT ?`
  );
  const out: Record<string, { date: string; amount: number; account: string }[]> = {};
  for (const m of merchants)
    out[m] = stmt.all(m, limit) as { date: string; amount: number; account: string }[];
  return out;
}

// Dismiss: remember this suggestion's key so it never resurfaces.
export function dismissMerge(key: string) {
  const db = getDb();
  ensureMergeDismissals(db);
  db.prepare(
    "INSERT INTO merchant_merge_dismissals (canonical) VALUES (?) ON CONFLICT(canonical) DO NOTHING"
  ).run(key);
}
