import { NextRequest, NextResponse } from "next/server";
import { listTransactions, transactionsSummary, type TxFilter } from "@/lib/queries";

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

  // The filter shared by the paged rows and the summary (count + net total).
  const filter: TxFilter = {
    month: p.get("month") ?? undefined,
    categoryId,
    q: p.get("q") ?? undefined,
    vendor: p.get("vendor") ?? undefined,
    type: typeRaw === "income" || typeRaw === "expense" ? typeRaw : undefined,
    account: p.get("account") ?? undefined,
    minAmount: p.get("minAmount") ? Number(p.get("minAmount")) : undefined,
    maxAmount: p.get("maxAmount") ? Number(p.get("maxAmount")) : undefined,
    recurring: recRaw === "yes" ? true : recRaw === "no" ? false : undefined,
  };

  // Pagination: coerce to non-negative integers so they're safe to interpolate.
  const limRaw = p.get("limit");
  const limit = limRaw ? Math.max(1, Math.floor(Number(limRaw))) : undefined;
  const offset = Math.max(0, Math.floor(Number(p.get("offset") ?? 0)) || 0);

  const rows = listTransactions({
    ...filter,
    sort:
      sortRaw === "amount" || sortRaw === "merchant" || sortRaw === "date"
        ? sortRaw
        : undefined,
    dir: p.get("dir") === "asc" ? "asc" : "desc",
    limit,
    offset,
  });

  // The summary spans the whole filtered set; only recompute it on the first
  // page (offset 0) — later pages reuse the count/net the client already has.
  const summary = offset === 0 ? transactionsSummary(filter) : null;
  return NextResponse.json({ rows, ...(summary ?? {}) });
}
