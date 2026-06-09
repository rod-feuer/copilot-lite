import { NextRequest, NextResponse } from "next/server";
import { importCopilotCsv } from "@/lib/copilot-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Full replace: wipes existing data and imports a Copilot Money CSV export.
export async function POST(req: NextRequest) {
  const text = await req.text();
  if (!text.trim())
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  try {
    return NextResponse.json(importCopilotCsv(text));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "import failed" },
      { status: 400 }
    );
  }
}
