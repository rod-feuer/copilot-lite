import { NextResponse } from "next/server";
import { detectRecurrings } from "@/lib/core";
import { getDb, migrateMerchants } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  // Apply the merchant-normalization backfill on the live connection (no-op once
  // done), then rebuild recurrings off the normalized names.
  const normalized = migrateMerchants(getDb());
  const recurrings = detectRecurrings();
  return NextResponse.json({ count: recurrings.length, normalized });
}
