import { NextRequest, NextResponse } from "next/server";
import { categoriesWithTotals, createCategory } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month") ?? undefined;
  return NextResponse.json(categoriesWithTotals(month));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.name) return NextResponse.json({ error: "name required" }, { status: 400 });
  try {
    const cat = {
      name: String(body.name).trim(),
      color: body.color ?? "#64748b",
      icon: body.icon ?? "•",
      kind: (body.kind === "income" ? "income" : "expense") as "income" | "expense",
    };
    const info = createCategory(cat);
    // The caller may need to use it at once (the recurrings dropdown assigns
    // the new category to the row it was created from).
    return NextResponse.json({
      ok: true,
      category: { id: Number(info.lastInsertRowid), ...cat, excludeFromTotals: 0 },
    });
  } catch {
    return NextResponse.json({ error: "category already exists" }, { status: 409 });
  }
}
