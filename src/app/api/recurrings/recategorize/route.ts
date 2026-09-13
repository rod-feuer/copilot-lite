import { NextRequest, NextResponse } from "next/server";
import { setMerchantCategory, merchantVariants, setSeriesCategory } from "@/lib/queries";
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
  // One series of a shared descriptor (a split "Netflix · 26th"): move only its
  // charges. No rule is learned — a rule is per descriptor and would drag the
  // sibling's future charges along.
  const recurringId = body.recurringId == null ? null : Number(body.recurringId);
  if (recurringId != null) {
    setSeriesCategory(recurringId, categoryId);
  } else {
    for (const v of merchantVariants(merchant)) {
      setMerchantCategory(v, categoryId);
      if (categoryId != null) learnRule(v.toLowerCase(), categoryId, "user");
    }
  }
  detectRecurrings();
  return NextResponse.json({ ok: true });
}
