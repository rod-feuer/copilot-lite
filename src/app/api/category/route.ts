import { NextRequest, NextResponse } from "next/server";
import { categorySummary } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!id || !month) {
    return NextResponse.json({ error: "id and month required" }, { status: 400 });
  }
  const data = categorySummary(id, month);
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(data);
}
