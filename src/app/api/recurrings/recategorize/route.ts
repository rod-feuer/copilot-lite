import { NextRequest, NextResponse } from "next/server";
import { setMerchantCategory, merchantVariants } from "@/lib/queries";
import { learnRule, detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Recategorize a vendor: applies to every descriptor variant of the merchant
// (so the whole vendor moves, matching the drawer's rollup) and learns a rule
// per variant so re-imports stay categorized, then rebuilds recurrings.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const merchant = String(body.merchant ?? "").trim();
  const categoryId =
    body.categoryId === null || body.categoryId === undefined
      ? null
      : Number(body.categoryId);
  if (!merchant) {
    return NextResponse.json({ error: "merchant required" }, { status: 400 });
  }
  for (const v of merchantVariants(merchant)) {
    setMerchantCategory(v, categoryId);
    if (categoryId != null) learnRule(v.toLowerCase(), categoryId, "user");
  }
  detectRecurrings();
  return NextResponse.json({ ok: true });
}
