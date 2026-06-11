import { NextRequest, NextResponse } from "next/server";
import { allMergeSuggestions, approveMerge, dismissMerge } from "@/lib/merges";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The "possible duplicate vendors" review queue (location-suffix variants +
// behaviour-based recurring matches).
export async function GET() {
  return NextResponse.json(allMergeSuggestions());
}

// Approve folds the variants into one vendor (then re-detects so recurrings
// regroup); dismiss remembers the rejection so the suggestion never reappears.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const key = String(body.key ?? "").trim();

  if (body.action === "dismiss") {
    if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });
    dismissMerge(key);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "approve") {
    const canonical = String(body.canonical ?? "").trim();
    const variants = Array.isArray(body.variants) ? body.variants.map(String) : [];
    if (!canonical || variants.length < 2) {
      return NextResponse.json({ error: "canonical and variants required" }, { status: 400 });
    }
    const categoryId = typeof body.categoryId === "number" ? body.categoryId : undefined;
    approveMerge(canonical, variants, categoryId);
    detectRecurrings();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
