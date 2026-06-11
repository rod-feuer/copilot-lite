import { NextRequest, NextResponse } from "next/server";
import { mergePreview } from "@/lib/merges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Recent charges under each descriptor, for inspecting a merge suggestion before
// combining. POST (not GET) because descriptors contain commas/colons/etc.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const merchants = Array.isArray(body.merchants) ? body.merchants.map(String) : [];
  if (!merchants.length) {
    return NextResponse.json({ error: "merchants required" }, { status: 400 });
  }
  return NextResponse.json(mergePreview(merchants));
}
