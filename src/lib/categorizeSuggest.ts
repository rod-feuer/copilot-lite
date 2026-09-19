import { getDb } from "./db";
import { categorizeByRules, categorizeByHistory, learnRule } from "./core";
import { proposeCategories, CONFIDENCE } from "./categorize";
import type { Category } from "./types";

// A proposed category for an uncategorized vendor, with where it came from so the
// reviewer can weigh it: a deterministic rule, the vendor's own history, or the
// model's guess (the one that most warrants a look).
export type CategorySuggestion = {
  merchant: string;
  categoryId: number;
  categoryName: string;
  categoryIcon: string;
  count: number; // uncategorized transactions this would fill
  source: "rule" | "history" | "ai";
  // A model guess it was not sure of (TypeSafe confidence between "show" and
  // "sure"): shown last, tagged, and left out of Apply all.
  possible?: boolean;
  alternatives?: number[]; // the model's most probable categories, best first — the first choices when redirecting
};

function ensureDismissals(db: ReturnType<typeof getDb>) {
  db.exec("CREATE TABLE IF NOT EXISTS category_suggestion_dismissals (merchant TEXT PRIMARY KEY)");
}

function context(db: ReturnType<typeof getDb>) {
  ensureDismissals(db);
  const dismissed = new Set(
    (db.prepare("SELECT merchant FROM category_suggestion_dismissals").all() as { merchant: string }[]).map(
      (r) => r.merchant
    )
  );
  const cats = db.prepare("SELECT * FROM categories").all() as Category[];
  const byId = new Map(cats.map((c) => [c.id, c]));
  const uncats = db
    .prepare("SELECT merchant, COUNT(*) AS count FROM transactions WHERE categoryId IS NULL GROUP BY merchant")
    .all() as { merchant: string; count: number }[];
  return { dismissed, cats, byId, uncats };
}

// Free, deterministic proposals (rules + the vendor's own history) for every
// uncategorized vendor, plus how many remain that only the model can guess. No
// model call — cheap enough to load with the page.
export function categorizeSuggestions(): {
  suggestions: CategorySuggestion[];
  needsModelCount: number;
  dismissedCount: number; // vendors still uncategorized that a Dismiss keeps out of the queue
  modelEnabled: boolean;
} {
  const db = getDb();
  const { dismissed, byId, uncats } = context(db);
  const suggestions: CategorySuggestion[] = [];
  let needsModelCount = 0;
  let dismissedCount = 0;

  for (const u of uncats) {
    if (dismissed.has(u.merchant)) {
      dismissedCount++;
      continue;
    }
    let categoryId = categorizeByRules(u.merchant);
    let source: CategorySuggestion["source"] = "rule";
    if (categoryId == null) {
      categoryId = categorizeByHistory(u.merchant);
      source = "history";
    }
    if (categoryId == null) {
      needsModelCount++;
      continue;
    }
    const cat = byId.get(categoryId);
    if (!cat) continue;
    suggestions.push({
      merchant: u.merchant,
      categoryId,
      categoryName: cat.name,
      categoryIcon: cat.icon,
      count: u.count,
      source,
    });
  }
  suggestions.sort((a, b) => b.count - a.count || a.merchant.localeCompare(b.merchant));
  return { suggestions, needsModelCount, dismissedCount, modelEnabled: !!(process.env.TYPESAFE_API_KEY || process.env.ANTHROPIC_API_KEY) };
}

// Up to three merchants the user has already filed under each category (its
// busiest, never one being asked about): the context a model needs to tell
// "Lake Home" from "Carmel Home".
function categoryExamples(db: ReturnType<typeof getDb>, asking: Set<string>): Map<number, string[]> {
  const rows = db
    .prepare(
      `SELECT categoryId, merchant, COUNT(*) n FROM transactions
       WHERE categoryId IS NOT NULL AND excluded = 0 AND hash NOT LIKE '%:s%'
       GROUP BY categoryId, merchant ORDER BY n DESC`
    )
    .all() as { categoryId: number; merchant: string; n: number }[];
  const out = new Map<number, string[]>();
  for (const r of rows) {
    if (asking.has(r.merchant)) continue;
    const e = out.get(r.categoryId) ?? out.set(r.categoryId, []).get(r.categoryId)!;
    if (e.length < 3) e.push(r.merchant);
  }
  return out;
}

// Model proposals for the vendors rules/history can't resolve — on demand,
// returned for review WITHOUT applying or learning a rule. `unsure` counts the
// vendors the model answered below the "show" bar or not at all: they stay
// under "need a closer look" rather than appear as a guess.
export async function categorizeSuggestionsAI(): Promise<{ suggestions: CategorySuggestion[]; unsure: number; provider: string | null }> {
  const db = getDb();
  const { dismissed, cats, byId, uncats } = context(db);
  const needsModel = uncats.filter(
    (u) =>
      !dismissed.has(u.merchant) &&
      categorizeByRules(u.merchant) == null &&
      categorizeByHistory(u.merchant) == null
  );
  if (needsModel.length === 0) return { suggestions: [], unsure: 0, provider: null };
  const countByMerchant = new Map(needsModel.map((u) => [u.merchant, u.count]));
  const asking = needsModel.map((u) => u.merchant);
  const { provider, proposals } = await proposeCategories(asking, cats, categoryExamples(db, new Set(asking)));
  const out: CategorySuggestion[] = [];
  for (const p of proposals) {
    const count = countByMerchant.get(p.merchant);
    const cat = byId.get(p.categoryId);
    if (count == null || !cat) continue;
    if (p.confidence != null && p.confidence < CONFIDENCE.show) continue; // a guess: not shown
    out.push({
      merchant: p.merchant,
      categoryId: p.categoryId,
      categoryName: cat.name,
      categoryIcon: cat.icon,
      count,
      source: "ai",
      possible: p.confidence != null && p.confidence < CONFIDENCE.sure ? true : undefined,
      alternatives: p.alternatives,
    });
  }
  // Sure ones first, then possible matches; busiest vendor first within each.
  out.sort((a, b) => Number(!!a.possible) - Number(!!b.possible) || b.count - a.count || a.merchant.localeCompare(b.merchant));
  return { suggestions: out, unsure: needsModel.length - out.length, provider };
}

// Apply an approved suggestion: learn it as a user rule (so it's never asked
// again) and fill the vendor's uncategorized transactions. Returns rows filled.
export function applyCategorization(merchant: string, categoryId: number): number {
  const db = getDb();
  learnRule(merchant, categoryId, "user");
  const res = db
    .prepare("UPDATE transactions SET categoryId = ? WHERE merchant = ? AND categoryId IS NULL")
    .run(categoryId, merchant);
  return res.changes;
}

export function dismissCategorize(merchant: string) {
  const db = getDb();
  ensureDismissals(db);
  db.prepare(
    "INSERT INTO category_suggestion_dismissals (merchant) VALUES (?) ON CONFLICT(merchant) DO NOTHING"
  ).run(merchant);
}

// A Dismiss is not a one-way door: bring every dismissed vendor back into the
// queue (and the model's ask). Declining a wrong guess used to hide the
// vendor for good, so 107 dismissals once left "3 vendors need a closer look"
// over 38 uncategorized.
export function undismissCategorize() {
  const db = getDb();
  ensureDismissals(db);
  return db.prepare("DELETE FROM category_suggestion_dismissals").run().changes;
}
