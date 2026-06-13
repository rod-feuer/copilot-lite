import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createSplitRule, applySplitRules, type SplitPart } from "@/lib/splits";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Split one transaction into category parts. Reuses the auto-split engine: we
// record a rule keyed on this charge's merchant + magnitude, then apply it now
// (and to any future identical charge — e.g. a combined bill that recurs). The
// parent is excluded so it never double-counts; the parts become child rows.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  const tx = getDb()
    .prepare("SELECT merchant, amount FROM transactions WHERE id = ?")
    .get(Number(id)) as { merchant: string; amount: number } | undefined;
  if (!tx) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Splitting is defined for expenses (the engine inserts negative child rows).
  if (tx.amount >= 0) {
    return NextResponse.json({ error: "only expense charges can be split" }, { status: 400 });
  }

  const raw = Array.isArray(body.parts) ? body.parts : [];
  const parts: SplitPart[] = raw.map((p: { categoryId: unknown; amount: unknown; label: unknown }) => ({
    categoryId: Number(p.categoryId),
    amount: Math.abs(Number(p.amount)),
    label: String(p.label ?? "").trim(),
  }));
  if (parts.length < 2) {
    return NextResponse.json({ error: "need at least two parts" }, { status: 400 });
  }
  if (parts.some((p) => !Number.isFinite(p.amount) || p.amount <= 0 || !Number.isInteger(p.categoryId))) {
    return NextResponse.json({ error: "invalid part" }, { status: 400 });
  }
  const magnitude = Math.abs(tx.amount);
  const sum = parts.reduce((a, p) => a + p.amount, 0);
  if (Math.abs(sum - magnitude) > 0.01) {
    return NextResponse.json(
      { error: `parts must sum to ${magnitude.toFixed(2)} (got ${sum.toFixed(2)})` },
      { status: 400 }
    );
  }

  createSplitRule(tx.merchant, magnitude, parts);
  const split = applySplitRules();
  detectRecurrings(); // the parent left its series; rebuild so stats reflect it
  return NextResponse.json({ ok: true, split });
}
