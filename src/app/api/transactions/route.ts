import { NextRequest, NextResponse } from "next/server";
import { listTransactions } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const catRaw = p.get("category");
  const categoryId =
    catRaw === "none"
      ? ("none" as const)
      : catRaw
      ? Number(catRaw)
      : undefined;
  const typeRaw = p.get("type");
  const sortRaw = p.get("sort");
  const recRaw = p.get("recurring");
  return NextResponse.json(
    listTransactions({
      month: p.get("month") ?? undefined,
      categoryId,
      q: p.get("q") ?? undefined,
      vendor: p.get("vendor") ?? undefined,
      type: typeRaw === "income" || typeRaw === "expense" ? typeRaw : undefined,
      account: p.get("account") ?? undefined,
      minAmount: p.get("minAmount") ? Number(p.get("minAmount")) : undefined,
      maxAmount: p.get("maxAmount") ? Number(p.get("maxAmount")) : undefined,
      recurring: recRaw === "yes" ? true : recRaw === "no" ? false : undefined,
      sort:
        sortRaw === "amount" || sortRaw === "merchant" || sortRaw === "date"
          ? sortRaw
          : undefined,
      dir: p.get("dir") === "asc" ? "asc" : "desc",
      limit: p.get("limit") ? Number(p.get("limit")) : undefined,
    })
  );
}
