import { NextRequest, NextResponse } from "next/server";
import {
  setTransactionCategory,
  setTransactionEffectiveDate,
  setTransactionRecurringExcluded,
  setTransactionRecurringIncluded,
  setTransactionExcluded,
  setTransactionNote,
} from "@/lib/queries";
import { detectRecurrings } from "@/lib/core";
import { getDb } from "@/lib/db";

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

  // Put this single charge into a plan. First just lift any one-off flag and
  // let the detector decide; if its rules still leave the charge out, pin it
  // (the "edited" state). `pinned` tells the caller which happened.
  if ("recurringIncluded" in body) {
    const plan = body.recurringIncluded == null ? null : String(body.recurringIncluded);
    if (plan === null) {
      setTransactionRecurringIncluded(Number(id), null);
      detectRecurrings();
      return NextResponse.json({ ok: true, pinned: false });
    }
    setTransactionRecurringExcluded(Number(id), false);
    detectRecurrings();
    const row = getDb().prepare("SELECT recurringId FROM transactions WHERE id = ?").get(Number(id)) as
      | { recurringId: number | null }
      | undefined;
    if (row?.recurringId != null) return NextResponse.json({ ok: true, pinned: false });
    setTransactionRecurringIncluded(Number(id), plan);
    detectRecurrings();
    return NextResponse.json({ ok: true, pinned: true });
  }

  // Exclude/include this single charge from all totals (a manual one-off, the
  // per-transaction counterpart to a category's excludeFromTotals).
  if ("excluded" in body) {
    setTransactionExcluded(Number(id), !!body.excluded);
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
