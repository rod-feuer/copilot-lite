import { NextRequest, NextResponse } from "next/server";
import { applyRecategorize, merchantVariants } from "@/lib/queries";
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
  // One plan of a vendor with several: move only that plan. A vendor-wide
  // edit over plans in different categories is refused — it would put both
  // houses in one category and teach the next import to keep doing it —
  // unless `force` says the user chose one category for all (Combine).
  // Anything else moves the vendor as a whole, and the rule sticks.
  const recurringId = body.recurringId == null ? null : Number(body.recurringId);
  const applied = applyRecategorize(merchant, categoryId, recurringId, body.force === true);
  if (applied === "refused") {
    return NextResponse.json(
      { error: "These charges don't share a category" },
      { status: 409 }
    );
  }
  if (applied === "vendor" && categoryId != null) {
    for (const v of merchantVariants(merchant)) learnRule(v.toLowerCase(), categoryId, "user");
  }
  detectRecurrings();
  return NextResponse.json({ ok: true });
}
