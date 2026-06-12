import { NextRequest, NextResponse } from "next/server";
import {
  deleteCategory,
  setBudget,
  deleteBudget,
  setCategoryExcluded,
  updateCategory,
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

  // Edit display attributes (icon / color / name). Only sent keys are changed.
  if ("icon" in body || "color" in body || "name" in body) {
    const patch: { icon?: string; color?: string; name?: string } = {};
    if ("icon" in body) patch.icon = String(body.icon).trim() || "🏷️";
    if ("color" in body) patch.color = String(body.color).trim();
    if ("name" in body) {
      const name = String(body.name).trim();
      if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
      patch.name = name;
    }
    updateCategory(Number(id), patch);
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
