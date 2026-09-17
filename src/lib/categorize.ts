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
// How many merchants one call takes, and how much room its answer gets. Each
// proposal is ~30 output tokens; 40 merchants fit comfortably in 2,048. One
// call for 143 merchants at a 1,024-token cap came back cut off mid-array,
// failed to parse, and read as "no confident suggestions" — it was no
// suggestions at all, silently.
const BATCH = 40;
const MAX_TOKENS = 2048;

// The proposals in a model reply, tolerating a reply cut off mid-array: every
// complete {"merchant", "categoryId"} object counts, a half-written last one
// does not. Exported for the test.
export function parseProposals(text: string): { merchant: string; categoryId: number }[] {
  const start = text.indexOf("[");
  if (start < 0) return [];
  const body = text.slice(start);
  try {
    const whole = JSON.parse(body.slice(0, body.lastIndexOf("]") + 1));
    if (Array.isArray(whole)) return whole;
  } catch {
    // fall through: salvage the complete objects
  }
  const out: { merchant: string; categoryId: number }[] = [];
  for (const m of body.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]);
      if (typeof o.merchant === "string" && Number.isInteger(o.categoryId)) out.push(o);
    } catch {
      // an incomplete object at the cut
    }
  }
  return out;
}

export async function proposeCategoriesWithModel(
  merchants: string[],
  categories: Category[]
): Promise<{ merchant: string; categoryId: number }[]> {
  if (!process.env.ANTHROPIC_API_KEY || merchants.length === 0) return [];
  const client = new Anthropic();
  const catList = categories.map((c) => `${c.id}: ${c.name} (${c.kind})`).join("\n");
  const validIds = new Set(categories.map((c) => c.id));
  const out: { merchant: string; categoryId: number }[] = [];
  for (let i = 0; i < merchants.length; i += BATCH) {
    const batch = merchants.slice(i, i + BATCH);
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001", // cheap classifier — Rule 6 token budget
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: `Assign each merchant to the single best category id from this list:
${catList}

Merchants:
${batch.map((m, j) => `${j + 1}. ${m}`).join("\n")}

Respond with ONLY a JSON array of {"merchant": string, "categoryId": number}. No prose.`,
        },
      ],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    for (const r of parseProposals(text)) if (validIds.has(r.categoryId)) out.push(r);
  }
  return out;
}
