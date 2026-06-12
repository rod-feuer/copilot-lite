import { NextRequest, NextResponse } from "next/server";
import {
  deleteCategory,
  setBudget,
  deleteBudget,
  setCategoryExcluded,
} from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  deleteCategory(Number(id));
  return NextResponse.json({ ok: true });
}

// Set or clear a category's monthly budget. budget === null | "" clears it.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  // Toggle exclude-from-totals.
  if ("excludeFromTotals" in body) {
    setCategoryExcluded(Number(id), Boolean(body.excludeFromTotals));
    return NextResponse.json({ ok: true });
  }

  // Otherwise it's a budget set/clear.
  if (body.budget === null || body.budget === "" || body.budget === undefined) {
    deleteBudget(Number(id));
    return NextResponse.json({ ok: true });
  }
  const amount = Number(body.budget);
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ error: "invalid budget" }, { status: 400 });
  }
  const period = body.period === "annual" ? "annual" : "monthly";
  setBudget(Number(id), amount, period);
  return NextResponse.json({ ok: true });
}
