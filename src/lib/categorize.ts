import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";
import { categorizeByRules, learnRule } from "./core";
import type { Category } from "./types";

// Categorize a batch of unknown merchants in ONE model call, then persist each
// answer as a rule so the same merchant is never sent to the model again.
// This is the only place the model is used: classifying a novel merchant name
// into an existing category is a genuine judgment call (CLAUDE.md Rule 5).
//
// If ANTHROPIC_API_KEY is absent, this is a no-op and merchants stay
// uncategorized — surfaced loudly to the caller, never silently faked (Rule 12).

export type CategorizeResult = {
  enabled: boolean;
  byRule: number; // uncategorized rows fixed for free via existing rules
  categorized: number; // resolved by the model
  skipped: number;
  reason?: string;
};

export async function categorizeUnknownMerchants(): Promise<CategorizeResult> {
  const db = getDb();
  const categories = db
    .prepare("SELECT * FROM categories")
    .all() as Category[];

  // Free pass first: apply existing rules to any uncategorized rows. This heals
  // data imported before a rule existed, with zero model calls. (Rule 5/6)
  let byRule = 0;
  const uncategorized = db
    .prepare("SELECT id, merchant FROM transactions WHERE categoryId IS NULL")
    .all() as { id: number; merchant: string }[];
  const applyRule = db.prepare(
    "UPDATE transactions SET categoryId = ? WHERE id = ?"
  );
  const ruleTxn = db.transaction((rows: typeof uncategorized) => {
    for (const r of rows) {
      const cat = categorizeByRules(r.merchant);
      if (cat !== null) {
        applyRule.run(cat, r.id);
        byRule++;
      }
    }
  });
  ruleTxn(uncategorized);

  // Distinct uncategorized merchants that no rule already covers.
  const merchants = (
    db
      .prepare(
        "SELECT DISTINCT merchant FROM transactions WHERE categoryId IS NULL"
      )
      .all() as { merchant: string }[]
  )
    .map((r) => r.merchant)
    .filter((m) => categorizeByRules(m) === null);

  if (merchants.length === 0)
    return { enabled: true, byRule, categorized: 0, skipped: 0 };

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      enabled: false,
      byRule,
      categorized: 0,
      skipped: merchants.length,
      reason: "ANTHROPIC_API_KEY not set — left uncategorized.",
    };
  }

  const client = new Anthropic();
  const catList = categories.map((c) => `${c.id}: ${c.name} (${c.kind})`).join("\n");

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001", // cheap classifier — Rule 6 token budget
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Assign each merchant to the single best category id from this list:
${catList}

Merchants:
${merchants.map((m, i) => `${i + 1}. ${m}`).join("\n")}

Respond with ONLY a JSON array of {"merchant": string, "categoryId": number}. No prose.`,
      },
    ],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  let parsed: { merchant: string; categoryId: number }[];
  try {
    const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    parsed = JSON.parse(json);
  } catch {
    return {
      enabled: true,
      byRule,
      categorized: 0,
      skipped: merchants.length,
      reason: "Model returned unparseable output.",
    };
  }

  const validIds = new Set(categories.map((c) => c.id));
  const apply = db.transaction((rows: typeof parsed) => {
    let n = 0;
    for (const r of rows) {
      if (!validIds.has(r.categoryId)) continue;
      learnRule(r.merchant, r.categoryId, "claude");
      db.prepare(
        "UPDATE transactions SET categoryId = ? WHERE merchant = ? AND categoryId IS NULL"
      ).run(r.categoryId, r.merchant);
      n++;
    }
    return n;
  });

  const categorized = apply(parsed);
  return {
    enabled: true,
    byRule,
    categorized,
    skipped: merchants.length - categorized,
  };
}
