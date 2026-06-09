import { NextResponse } from "next/server";
import {
  fetchPlaidTransactions,
  importPlaidTransactions,
  plaidSyncStartDate,
} from "@/lib/plaid";
import { applySplitRules } from "@/lib/splits";
import { detectRecurrings } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const end = new Date().toISOString().slice(0, 10);
    // Start after existing history so Plaid doesn't duplicate the back-import.
    // Clamp to `end` in case prior data is future-dated (nothing to pull then).
    const startDate = plaidSyncStartDate();
    const start = startDate > end ? end : startDate;

    const items = await fetchPlaidTransactions(start, end);
    const result = importPlaidTransactions(items);
    const splitCount = applySplitRules();
    if (result.inserted > 0 || result.updated > 0) detectRecurrings();

    const total = items.reduce((a, i) => a + i.transactions.length, 0);
    return NextResponse.json({ ok: true, ...result, split: splitCount, total });
  } catch (e) {
    // Surface actionable CLI errors (not installed / not logged in / no items).
    const msg = e instanceof Error ? e.message : "sync failed";
    const hint = /ENOENT/.test(msg)
      ? "Plaid CLI not found on PATH."
      : /not logged in/i.test(msg)
      ? "Plaid CLI not logged in — run `plaid login`."
      : msg;
    return NextResponse.json({ error: hint }, { status: 500 });
  }
}
