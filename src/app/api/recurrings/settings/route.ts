import { NextRequest, NextResponse } from "next/server";
import { setRecurringSetting, type RecurringSettings } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "semiannual", "yearly"];

// Update a recurring's per-merchant settings. Only keys present in the body are
// changed; send a key as null to clear it. `clear: true` removes all settings.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const merchant = String(body.merchant ?? "").trim();
  if (!merchant) {
    return NextResponse.json({ error: "merchant required" }, { status: 400 });
  }

  if (body.clear) {
    setRecurringSetting(merchant, {
      matchMode: null,
      matchText: null,
      amountTolerance: null,
      alias: null,
      expectedAmount: null,
      cadence: null,
      nextDate: null,
    });
    return NextResponse.json({ ok: true });
  }

  const patch: Partial<RecurringSettings> = {};
  if ("alias" in body) patch.alias = body.alias ? String(body.alias).trim() : null;
  if ("expectedAmount" in body)
    patch.expectedAmount =
      body.expectedAmount == null || body.expectedAmount === ""
        ? null
        : Math.abs(Number(body.expectedAmount));
  if ("cadence" in body)
    patch.cadence = CADENCES.includes(body.cadence) ? body.cadence : null;
  if ("nextDate" in body)
    patch.nextDate = body.nextDate ? String(body.nextDate).slice(0, 10) : null;
  if ("matchMode" in body)
    patch.matchMode = body.matchMode === "contains" ? "contains" : body.matchMode === "exact" ? "exact" : null;
  if ("matchText" in body)
    patch.matchText = body.matchText ? String(body.matchText).trim() : null;
  if ("amountTolerance" in body)
    patch.amountTolerance =
      body.amountTolerance == null ? null : Number(body.amountTolerance);

  // A "contains" rule needs text; drop the rule if text is missing.
  if (patch.matchMode === "contains" && !patch.matchText) {
    patch.matchMode = null;
  }

  setRecurringSetting(merchant, patch);
  return NextResponse.json({ ok: true });
}
