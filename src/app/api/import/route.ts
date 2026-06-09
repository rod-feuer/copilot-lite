import { NextRequest, NextResponse } from "next/server";
import { importCsv } from "@/lib/import";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const text = await req.text();
  if (!text.trim())
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  try {
    const result = importCsv(text);
    if (result.inserted > 0) detectRecurrings(); // refresh patterns
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "import failed" },
      { status: 400 }
    );
  }
}
