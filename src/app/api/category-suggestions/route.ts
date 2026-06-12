import { NextRequest, NextResponse } from "next/server";
import {
  categorizeSuggestions,
  categorizeSuggestionsAI,
  applyCategorization,
  dismissCategorize,
} from "@/lib/categorizeSuggest";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Free rule/history proposals + how many remain for the model.
export async function GET() {
  return NextResponse.json(categorizeSuggestions());
}

// suggestAI: model proposals for the rest (one call, not applied). apply /
// applyAll: commit approved proposals (learn the rule, fill rows, re-detect).
// dismiss: stop suggesting this vendor.
export async function POST(req: NextRequest) {
  const body = await req.json();

  if (body.action === "suggestAI") {
    return NextResponse.json({ suggestions: await categorizeSuggestionsAI() });
  }

  if (body.action === "dismiss") {
    const merchant = String(body.merchant ?? "").trim();
    if (!merchant) return NextResponse.json({ error: "merchant required" }, { status: 400 });
    dismissCategorize(merchant);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "apply") {
    const merchant = String(body.merchant ?? "").trim();
    const categoryId = Number(body.categoryId);
    if (!merchant || !Number.isInteger(categoryId)) {
      return NextResponse.json({ error: "merchant and categoryId required" }, { status: 400 });
    }
    const filled = applyCategorization(merchant, categoryId);
    detectRecurrings();
    return NextResponse.json({ ok: true, filled });
  }

  if (body.action === "applyAll") {
    const items = Array.isArray(body.items) ? body.items : [];
    let filled = 0;
    for (const it of items) {
      const merchant = String(it.merchant ?? "").trim();
      const categoryId = Number(it.categoryId);
      if (merchant && Number.isInteger(categoryId)) filled += applyCategorization(merchant, categoryId);
    }
    if (filled > 0) detectRecurrings();
    return NextResponse.json({ ok: true, filled });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
