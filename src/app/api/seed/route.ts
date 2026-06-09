import { NextResponse } from "next/server";
import { seed } from "@/lib/seed";
import { isSeeded } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const already = isSeeded();
  const inserted = seed();
  return NextResponse.json({ alreadyHadData: already, inserted });
}
