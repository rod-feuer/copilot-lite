import { NextRequest, NextResponse } from "next/server";
import { mergeSuggestions, approveMerge, dismissMerge } from "@/lib/merges";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The "possible duplicate vendors" review queue.
export async function GET() {
  return NextResponse.json(mergeSuggestions());
}

// Approve folds the variants into one vendor (then re-detects so recurrings
// regroup); dismiss remembers the rejection so the group never reappears.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const canonical = String(body.canonical ?? "").trim();
  if (!canonical) {
    return NextResponse.json({ error: "canonical required" }, { status: 400 });
  }
  if (body.action === "dismiss") {
    dismissMerge(canonical);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "approve") {
    const variants = Array.isArray(body.variants) ? body.variants.map(String) : [];
    if (variants.length < 2) {
      return NextResponse.json({ error: "variants required" }, { status: 400 });
    }
    approveMerge(canonical, variants);
    detectRecurrings();
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
