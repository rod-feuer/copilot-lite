import { NextResponse } from "next/server";
import { categorizeUnknownMerchants } from "@/lib/categorize";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const result = await categorizeUnknownMerchants();
  if (result.categorized > 0 || result.byRule > 0) detectRecurrings();
  return NextResponse.json(result);
}
