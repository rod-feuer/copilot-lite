import { NextRequest, NextResponse } from "next/server";
import { linkMerchant, unlinkMerchant } from "@/lib/queries";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Link a merchant descriptor (alias) into a primary so they form one recurring,
// or unlink it. Re-runs detection so the grouping takes effect immediately.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const alias = String(body.alias ?? "").trim();
  if (!alias) {
    return NextResponse.json({ error: "alias required" }, { status: 400 });
  }
  if (body.unlink) {
    unlinkMerchant(alias);
  } else {
    const primary = String(body.primary ?? "").trim();
    if (!primary) {
      return NextResponse.json({ error: "primary required" }, { status: 400 });
    }
    if (alias === primary) {
      return NextResponse.json({ error: "cannot link a merchant to itself" }, { status: 400 });
    }
    linkMerchant(alias, primary);
  }
  detectRecurrings();
  return NextResponse.json({ ok: true });
}
