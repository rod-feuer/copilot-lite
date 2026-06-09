import { NextRequest, NextResponse } from "next/server";
import { setMatchRule, clearMatchRule } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Set or clear a recurring's per-merchant match rule (v1: merchant exact/contains
// + amount tolerance). Keyed by merchant so it survives detection rebuilds.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const merchant = String(body.merchant ?? "").trim();
  if (!merchant) {
    return NextResponse.json({ error: "merchant required" }, { status: 400 });
  }

  if (body.clear) {
    clearMatchRule(merchant);
    return NextResponse.json({ ok: true });
  }

  const matchMode = body.matchMode === "contains" ? "contains" : "exact";
  const matchText =
    matchMode === "contains" ? String(body.matchText ?? "").trim() : null;
  if (matchMode === "contains" && !matchText) {
    return NextResponse.json(
      { error: "matchText required for contains" },
      { status: 400 }
    );
  }
  // null = match any amount; otherwise a fraction (0.05 = ±5%).
  const amountTolerance =
    body.amountTolerance === null || body.amountTolerance === undefined
      ? null
      : Number(body.amountTolerance);

  setMatchRule(merchant, { matchMode, matchText, amountTolerance });
  return NextResponse.json({ ok: true });
}
