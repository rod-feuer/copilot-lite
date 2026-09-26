import { NextRequest, NextResponse } from "next/server";
import { confirmPlan } from "@/lib/queries";

export const runtime = "nodejs";

// Add on a plan the detector found: confirm it, so it counts as a bill (or a
// deposit) from now on. Nothing to rebuild: the plan and its charges are
// already there, only whether it counts changes.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const key = String(body.key ?? "").trim();
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });
  if (!confirmPlan(key)) return NextResponse.json({ error: "no such plan" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
