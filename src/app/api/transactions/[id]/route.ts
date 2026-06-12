import { NextRequest, NextResponse } from "next/server";
import {
  setTransactionCategory,
  setTransactionEffectiveDate,
  setTransactionRecurringExcluded,
  setTransactionNote,
} from "@/lib/queries";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  // Flag/unflag this single charge as a one-off (excluded from its merchant's
  // recurring series), then rebuild so the series stats + recurringId reflect it.
  if ("recurringExcluded" in body) {
    setTransactionRecurringExcluded(Number(id), !!body.recurringExcluded);
    detectRecurrings();
    return NextResponse.json({ ok: true });
  }

  // Set/clear the free-text note.
  if ("note" in body) {
    setTransactionNote(Number(id), body.note == null ? null : String(body.note));
    return NextResponse.json({ ok: true });
  }

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
