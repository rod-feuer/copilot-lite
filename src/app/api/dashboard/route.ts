import { NextRequest, NextResponse } from "next/server";
import { dashboard } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month") ?? undefined;
  return NextResponse.json(dashboard(month));
}
