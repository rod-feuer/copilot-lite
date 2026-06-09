import { NextResponse } from "next/server";
import { distinctMerchants } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Distinct merchant strings (with counts) for the merchant-link picker.
export async function GET() {
  return NextResponse.json(distinctMerchants());
}
