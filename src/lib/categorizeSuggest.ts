import { getDb } from "./db";
import { categorizeByRules, categorizeByHistory, learnRule } from "./core";
import { proposeCategoriesWithModel } from "./categorize";
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
  modelEnabled: boolean;
} {
  const db = getDb();
  const { dismissed, byId, uncats } = context(db);
  const suggestions: CategorySuggestion[] = [];
  let needsModelCount = 0;

  for (const u of uncats) {
    if (dismissed.has(u.merchant)) continue;
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
  return { suggestions, needsModelCount, modelEnabled: !!process.env.ANTHROPIC_API_KEY };
}

// Model proposals for the vendors rules/history can't resolve — on demand (one
// model call), returned for review WITHOUT applying or learning a rule.
export async function categorizeSuggestionsAI(): Promise<CategorySuggestion[]> {
  const db = getDb();
  const { dismissed, cats, byId, uncats } = context(db);
  const needsModel = uncats.filter(
    (u) =>
      !dismissed.has(u.merchant) &&
      categorizeByRules(u.merchant) == null &&
      categorizeByHistory(u.merchant) == null
  );
  if (needsModel.length === 0) return [];
  const countByMerchant = new Map(needsModel.map((u) => [u.merchant, u.count]));
  const proposals = await proposeCategoriesWithModel(
    needsModel.map((u) => u.merchant),
    cats
  );
  const out: CategorySuggestion[] = [];
  for (const p of proposals) {
    const count = countByMerchant.get(p.merchant);
    const cat = byId.get(p.categoryId);
    if (count == null || !cat) continue;
    out.push({
      merchant: p.merchant,
      categoryId: p.categoryId,
      categoryName: cat.name,
      categoryIcon: cat.icon,
      count,
      source: "ai",
    });
  }
  return out;
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
