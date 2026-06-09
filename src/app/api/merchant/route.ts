import { NextRequest, NextResponse } from "next/server";
import { merchantSummary } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  return NextResponse.json(merchantSummary(name));
}
