import { NextRequest, NextResponse } from "next/server";
import {
  setTransactionCategory,
  setTransactionEffectiveDate,
} from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  // Set/clear the effective (accounting) date.
  if ("effectiveDate" in body) {
    const raw = body.effectiveDate;
    const val = raw === null || raw === "" ? null : String(raw);
    if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      return NextResponse.json({ error: "invalid date" }, { status: 400 });
    }
    setTransactionEffectiveDate(Number(id), val);
    return NextResponse.json({ ok: true });
  }

  const categoryId =
    body.categoryId === null || body.categoryId === undefined
      ? null
      : Number(body.categoryId);
  setTransactionCategory(Number(id), categoryId);
  return NextResponse.json({ ok: true });
}
