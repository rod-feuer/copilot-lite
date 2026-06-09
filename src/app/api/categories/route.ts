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
    createCategory({
      name: body.name,
      color: body.color ?? "#64748b",
      icon: body.icon ?? "•",
      kind: body.kind === "income" ? "income" : "expense",
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "category already exists" }, { status: 409 });
  }
}
