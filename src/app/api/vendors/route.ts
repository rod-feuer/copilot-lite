import { NextResponse } from "next/server";
import { distinctVendors } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One entry per vendor (canonical) with its friendly display name — powers the
// combine picker, which selects on the canonical merchant but shows the name.
export async function GET() {
  return NextResponse.json(distinctVendors());
}
