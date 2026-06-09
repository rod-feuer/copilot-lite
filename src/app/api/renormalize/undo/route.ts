import { NextResponse } from "next/server";
import { detectRecurrings } from "@/lib/core";
import { getDb, undoRenormalizeMerchants } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Revert the most recent "Clean up names" run, restoring the prior merchant names
// and re-keyed settings/links, then rebuild recurrings off the restored names.
export async function POST() {
  const restored = undoRenormalizeMerchants(getDb());
  const recurrings = detectRecurrings();
  return NextResponse.json({ restored, recurrings: recurrings.length });
}
