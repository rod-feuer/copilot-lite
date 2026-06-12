import { NextRequest, NextResponse } from "next/server";
import { getDb, applyNameCleanup, renormalizeMerchants, cleanupUndoAvailable } from "@/lib/db";
import { nameCleanupSuggestions, dismissNameCleanup } from "@/lib/nameCleanup";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The "names to tidy" review queue, plus whether the last apply can be undone
// (so the queue can show an in-context Undo even after a reload).
export async function GET() {
  return NextResponse.json({
    suggestions: nameCleanupSuggestions(),
    canUndo: cleanupUndoAvailable(getDb()),
  });
}

// apply one proposed fix, applyAll (the old bulk cleanup), or dismiss one. Apply
// re-detects recurrings so the refreshed names regroup.
export async function POST(req: NextRequest) {
  const body = await req.json();

  if (body.action === "dismiss") {
    const from = String(body.from ?? "").trim();
    if (!from) return NextResponse.json({ error: "from required" }, { status: 400 });
    dismissNameCleanup(from);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "apply") {
    const from = String(body.from ?? "").trim();
    const to = String(body.to ?? "").trim();
    if (!from || !to) return NextResponse.json({ error: "from and to required" }, { status: 400 });
    const changed = applyNameCleanup(getDb(), from, to);
    detectRecurrings();
    return NextResponse.json({ ok: true, changed, canUndo: changed > 0 });
  }

  if (body.action === "applyAll") {
    const changed = renormalizeMerchants(getDb());
    detectRecurrings();
    return NextResponse.json({ ok: true, changed, canUndo: changed > 0 });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
