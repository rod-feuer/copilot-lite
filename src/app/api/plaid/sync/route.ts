import { NextResponse } from "next/server";
import { syncFromBank } from "@/lib/plaid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return NextResponse.json({ ok: true, ...(await syncFromBank()) });
  } catch (e) {
    // Surface actionable CLI errors (not installed / not logged in / no items).
    const msg = e instanceof Error ? e.message : "sync failed";
    const hint = /ENOENT/.test(msg)
      ? "Plaid CLI not found on PATH."
      : /not logged in/i.test(msg)
      ? "Plaid CLI not logged in — run `plaid login`."
      : msg;
    return NextResponse.json({ error: hint }, { status: 500 });
  }
}
