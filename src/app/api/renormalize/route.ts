import { NextResponse } from "next/server";
import { detectRecurrings } from "@/lib/core";
import { getDb, renormalizeMerchants, cleanupUndoAvailable } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Maintenance: re-apply the current normalizer to existing transactions (from
// their preserved rawMerchant), then rebuild recurrings off the refreshed names.
export async function POST() {
  const changed = renormalizeMerchants(getDb());
  const recurrings = detectRecurrings();
  return NextResponse.json({ changed, recurrings: recurrings.length, canUndo: changed > 0 });
}

// Whether the last cleanup can still be undone (so the UI can show the affordance
// even after a reload).
export async function GET() {
  return NextResponse.json({ canUndo: cleanupUndoAvailable(getDb()) });
}
