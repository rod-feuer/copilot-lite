import { NextRequest, NextResponse } from "next/server";
import { removeSplitRule } from "@/lib/splits";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Remove a split rule from the vendor's shelf. Same meaning as "Undo split" on
// a charge: the rule goes, and so does everything it did — its parts are
// deleted and the charges it split count whole again.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const restored = removeSplitRule(Number(id));
  if (restored === null) return NextResponse.json({ error: "no such split" }, { status: 404 });
  detectRecurrings(); // the restored charges rejoin their plans; the parts' plans go
  return NextResponse.json({ ok: true, restored });
}
