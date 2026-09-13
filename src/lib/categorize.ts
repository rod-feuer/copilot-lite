import Anthropic from "@anthropic-ai/sdk";
import type { Category } from "./types";

// The only place the model is used: classifying a novel merchant name into an
// existing category is a genuine judgment call (CLAUDE.md Rule 5). Proposals
// go to the review queue (/api/category-suggestions); nothing is applied or
// learned here. If ANTHROPIC_API_KEY is absent this is a no-op and merchants
// stay uncategorized — surfaced, never silently faked (Rule 12).

// Ask the model to classify novel merchants into existing categories. Returns
// validated {merchant, categoryId} proposals (empty on no key / unparseable
// output). Does NOT apply or learn a rule — the caller decides, so a review
// queue can show the guesses before they're committed (CLAUDE.md Rule 5).
export async function proposeCategoriesWithModel(
  merchants: string[],
  categories: Category[]
): Promise<{ merchant: string; categoryId: number }[]> {
  if (!process.env.ANTHROPIC_API_KEY || merchants.length === 0) return [];
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
    parsed = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  } catch {
    return [];
  }
  const validIds = new Set(categories.map((c) => c.id));
  return parsed.filter((r) => validIds.has(r.categoryId));
}
