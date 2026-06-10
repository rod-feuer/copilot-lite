import { getDb, ensureMergeDismissals } from "./db";
import {
  getMerchantLinks,
  canonicalMerchant,
  linkMerchant,
  distinctMerchants,
} from "./queries";

// US state codes as normalizeMerchant title-cases them (e.g. "IN" -> "In").
const STATES = new Set(
  "Al Ak Az Ar Ca Co Ct De Fl Ga Hi Id Il In Ia Ks Ky La Me Md Ma Mi Mn Ms Mo Mt Ne Nv Nh Nj Nm Ny Nc Nd Oh Ok Or Pa Ri Sc Sd Tn Tx Ut Vt Va Wa Wv Wi Wy".split(
    " "
  )
);

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
  canonical: string;
  variants: { merchant: string; count: number }[];
  total: number;
};

// Candidate "these descriptors are one vendor" merges, derived from location-
// suffix variants. Liberal by design — it's a review queue, so the user is the
// precision filter. Excludes descriptors already linked or previously dismissed.
export function mergeSuggestions(): MergeSuggestion[] {
  const db = getDb();
  ensureMergeDismissals(db);
  const dismissed = new Set(
    (
      db.prepare("SELECT canonical FROM merchant_merge_dismissals").all() as {
        canonical: string;
      }[]
    ).map((r) => r.canonical)
  );
  const links = getMerchantLinks();
  const merchants = distinctMerchants();
  const countOf: Record<string, number> = {};
  for (const m of merchants) countOf[m.merchant] = m.count;

  const groups: Record<string, Set<string>> = {};
  for (const { merchant } of merchants) {
    const canon = stripLocationSuffix(merchant);
    if (!canon) continue;
    // Skip descriptors already folded into this canonical.
    if (canonicalMerchant(merchant, links) === canonicalMerchant(canon, links)) continue;
    (groups[canon] ??= new Set()).add(merchant);
  }

  const out: MergeSuggestion[] = [];
  for (const [canon, set] of Object.entries(groups)) {
    if (dismissed.has(canon)) continue;
    // If a clean merchant equal to the canonical already exists, it's the target.
    if (countOf[canon] != null) set.add(canon);
    if (set.size < 2) continue; // nothing to merge
    const variants = [...set]
      .map((merchant) => ({ merchant, count: countOf[merchant] ?? 0 }))
      .sort((a, b) => b.count - a.count);
    out.push({
      canonical: canon,
      variants,
      total: variants.reduce((s, v) => s + v.count, 0),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// Approve: fold every variant into the canonical name. The caller re-runs
// detection so recurrings regroup. Clears any stale dismissal of this canonical.
export function approveMerge(canonical: string, variants: string[]) {
  const db = getDb();
  ensureMergeDismissals(db);
  for (const v of variants) if (v !== canonical) linkMerchant(v, canonical);
  db.prepare("DELETE FROM merchant_merge_dismissals WHERE canonical = ?").run(canonical);
}

// Dismiss: remember this canonical so the group never resurfaces in the queue.
export function dismissMerge(canonical: string) {
  const db = getDb();
  ensureMergeDismissals(db);
  db.prepare(
    "INSERT INTO merchant_merge_dismissals (canonical) VALUES (?) ON CONFLICT(canonical) DO NOTHING"
  ).run(canonical);
}
