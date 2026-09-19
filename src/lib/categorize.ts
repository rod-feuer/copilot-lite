import Anthropic from "@anthropic-ai/sdk";
import type { Category } from "./types";

// The only place a model is used: classifying a novel merchant name into an
// existing category is a genuine judgment call (CLAUDE.md Rule 5). Proposals
// go to the review queue (/api/category-suggestions); nothing is applied or
// learned here. With no API key this is a no-op and merchants stay
// uncategorized — surfaced, never silently faked (Rule 12).
//
// Two providers. TypeSafe (TYPESAFE_API_KEY) is preferred: measured on 200 of
// the user's own categorized merchants it tied Haiku on accuracy (59.5% vs
// 61.5%, ±9.6) but returns a probability per category, and that confidence is
// what the queue was missing — at ≥0.8 it was right 80% of the time (half the
// merchants), below 0.5 only 38%. Haiku (ANTHROPIC_API_KEY) answers every
// merchant with equal assurance, so it is the fallback, not the default.
// What leaves the machine, for either: merchant names, category names and
// kinds, and (TypeSafe) up to three already-filed merchant names per category.
// Never amounts, dates, accounts or notes.

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

// ---- TypeSafe (System One): one Choice per merchant over the user's categories.
export type ModelProposal = {
  merchant: string;
  categoryId: number;
  confidence?: number; // TypeSafe only: 0..1, from the probability spread
  alternatives?: number[]; // TypeSafe only: the most probable categories, best first (includes categoryId)
};

// How the queue reads a confidence. Below SHOW the model is guessing (38% right
// in the test): the vendor stays under "need a closer look". Between SHOW and
// SURE it is shown as a possible match, for the user to confirm. Thresholds are
// from the 200-merchant test, not from the docs' examples.
export const CONFIDENCE = { show: 0.5, sure: 0.8 } as const;

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_CONCURRENCY = 8;

export async function proposeCategoriesWithTypeSafe(
  merchants: string[],
  categories: Category[],
  examples: Map<number, string[]> = new Map() // categoryId -> merchants already filed there
): Promise<ModelProposal[]> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key || merchants.length === 0 || categories.length < 2) return [];
  // Option keys are the category names the user sees; the description gives
  // the kind and, where there are any, merchants the user already filed there —
  // "Cody" or "Lake Home" mean nothing to a model on their own.
  const byName = new Map(categories.map((c) => [c.name, c.id]));
  const criteria: Record<string, string> = {};
  for (const c of categories) {
    const ex = examples.get(c.id) ?? [];
    criteria[c.name] = ex.length ? `${c.kind} category. Merchants already filed here: ${ex.join("; ")}` : `${c.kind} category`;
  }
  const question = {
    type: "choice",
    instructions:
      "`merchant` is a merchant name as it appears on a household's bank or card statement. Which of the household's budget categories does a charge from this merchant belong to?",
    criteria,
  };
  const ask = async (merchant: string): Promise<ModelProposal | null> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(TYPESAFE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state: { merchant }, questions: { category: question } }),
      });
      if (res.status === 429 || res.status === 529) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); // back off, as their API asks
        continue;
      }
      if (!res.ok) throw new Error(`TypeSafe ${res.status}`);
      const a = ((await res.json()) as { answers?: { category?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } } }).answers?.category;
      const categoryId = a?.choice != null ? byName.get(a.choice) : undefined;
      if (categoryId == null || typeof a?.confidence !== "number") return null; // an answer outside the options is no answer
      const alternatives = Object.entries(a.probabilities ?? {})
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([name]) => byName.get(name))
        .filter((id): id is number => id != null);
      return { merchant, categoryId, confidence: a.confidence, alternatives };
    }
    return null; // still rate limited: leave this vendor for a later ask
  };
  const out: (ModelProposal | null)[] = new Array(merchants.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(TYPESAFE_CONCURRENCY, merchants.length) }, async () => {
      while (next < merchants.length) {
        const i = next++;
        out[i] = await ask(merchants[i]);
      }
    })
  );
  return out.filter((p): p is ModelProposal => p != null);
}

// Which provider answers. TypeSafe when its key is set; if it cannot be reached
// at all, Haiku answers instead when its key is set (and says nothing about
// confidence). `provider` is reported so the queue can say which one spoke.
export async function proposeCategories(
  merchants: string[],
  categories: Category[],
  examples: Map<number, string[]> = new Map()
): Promise<{ provider: "typesafe" | "haiku" | null; proposals: ModelProposal[] }> {
  if (process.env.TYPESAFE_API_KEY) {
    try {
      return { provider: "typesafe", proposals: await proposeCategoriesWithTypeSafe(merchants, categories, examples) };
    } catch (e) {
      if (!process.env.ANTHROPIC_API_KEY) throw e;
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return { provider: "haiku", proposals: await proposeCategoriesWithModel(merchants, categories) };
  return { provider: null, proposals: [] };
}
