import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "./db";
import { categorizeByRules, categorizeByHistory } from "./core";
import { normalizeMerchant } from "./merchant";
import { nameAffinity, NAME_MATCH } from "./merges";

const run = promisify(execFile);
const CLI = process.env.PLAID_CLI_PATH || "plaid";

type PlaidTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number; // Plaid sign: positive = money out (our expenses)
  pending: boolean;
};
type PlaidAccount = { account_id: string; name: string };
export type PlaidItem = { accounts: PlaidAccount[]; transactions: PlaidTxn[] };

// Pull transactions for a date range via the Plaid CLI. We use `transactions
// list` (not `sync`) on purpose: it's idempotent and cursor-free, so manual CLI
// use and the app's "Sync now" can't corrupt a shared cursor. Dedup happens on
// transaction_id downstream. Returns one entry per linked item.
export async function fetchPlaidTransactions(
  startDate: string,
  endDate: string
): Promise<PlaidItem[]> {
  const PAGE = 500;
  const byItem = new Map<string, PlaidItem>();
  let offset = 0;
  // Paginate until a page yields fewer than a full page of transactions.
  // (Per-item offset; fine for the single-/few-item personal case.)
  for (;;) {
    const { stdout } = await run(
      CLI,
      [
        "transactions", "list", "--all", "--json",
        "--start-date", startDate, "--end-date", endDate,
        "--count", String(PAGE), "--offset", String(offset),
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout) as {
      items?: { item?: { item_id?: string }; accounts?: PlaidAccount[]; transactions?: PlaidTxn[] }[];
    };
    let pageCount = 0;
    for (const it of data.items ?? []) {
      const id = it.item?.item_id ?? "default";
      const acc = byItem.get(id) ?? { accounts: it.accounts ?? [], transactions: [] };
      acc.transactions.push(...(it.transactions ?? []));
      pageCount += it.transactions?.length ?? 0;
      byItem.set(id, acc);
    }
    if (pageCount < PAGE) break;
    offset += PAGE;
  }
  return [...byItem.values()];
}

// Where to start the Plaid pull. To avoid duplicating imported back-history
// (Copilot/CSV rows dedup on a different key than Plaid's transaction_id), begin
// the day AFTER our latest non-Plaid transaction — Plaid then only contributes
// genuinely new, forward-going data. Falls back to a 2-year backfill if there's
// no prior history at all.
export function plaidSyncStartDate(): string {
  const db = getDb();
  const row = db
    .prepare("SELECT MAX(date) d FROM transactions WHERE source != 'plaid'")
    .get() as { d: string | null };
  if (row?.d) {
    const dt = new Date(row.d + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }
  const back = new Date();
  back.setUTCFullYear(back.getUTCFullYear() - 2);
  return back.toISOString().slice(0, 10);
}

// Upsert Plaid transactions into our store. Dedup key is the Plaid
// transaction_id (stored as `hash`), so re-syncing is idempotent and `modified`
// transactions (pending -> posted, amount finalized) update in place. We flip
// the amount sign (Plaid: + = outflow; ours: - = expense) and never overwrite an
// existing categoryId on update, preserving rule/manual categorization.
export function importPlaidTransactions(items: PlaidItem[]): {
  inserted: number;
  updated: number;
  reconciled: number;
} {
  const db = getDb();
  // Hashes we already have, captured BEFORE the pending wipe so counts are
  // accurate (a re-pulled still-pending row counts as updated, not new).
  const seen = new Set(
    (db.prepare("SELECT hash FROM transactions WHERE source = 'plaid'").all() as {
      hash: string;
    }[]).map((r) => r.hash)
  );
  // Clear transient pending Plaid rows before re-importing the window — this
  // drops a pending charge that has fully posted (Plaid stops returning it).
  // Posted rows are stable and keep their categoryId via the upsert below.
  const clearPending = db.prepare(
    "DELETE FROM transactions WHERE source = 'plaid' AND pending = 1"
  );
  const upsert = db.prepare(
    `INSERT INTO transactions (date, merchant, rawMerchant, amount, categoryId, account, pending, source, hash)
     VALUES (@date, @merchant, @rawMerchant, @amount, @categoryId, @account, @pending, 'plaid', @hash)
     ON CONFLICT(hash) DO UPDATE SET
       date = excluded.date,
       merchant = excluded.merchant,
       rawMerchant = excluded.rawMerchant,
       amount = excluded.amount,
       account = excluded.account,
       pending = excluded.pending`
  );
  // A posted twin for a pending charge: same account + amount, within 3 days.
  // Name affinity (checked in JS) then confirms it's the same vendor.
  const findPosted = db.prepare(
    `SELECT merchant FROM transactions
     WHERE source = 'plaid' AND pending = 0 AND account = @account AND amount = @amount
       AND ABS(julianday(COALESCE(effectiveDate, date)) - julianday(@date)) <= 3`
  );

  let inserted = 0;
  let updated = 0;
  let reconciled = 0;
  const tx = db.transaction((rows: PlaidItem[]) => {
    clearPending.run();

    // Flatten + normalize, then import POSTED before PENDING so a pending row
    // can see its posted twin already in the table.
    const flat = rows.flatMap((item) => {
      const acctName = new Map(item.accounts.map((a) => [a.account_id, a.name]));
      return item.transactions.map((t) => {
        const rawMerchant = t.merchant_name || t.name;
        return {
          date: t.date,
          merchant: normalizeMerchant(rawMerchant),
          rawMerchant,
          amount: -t.amount,
          account: acctName.get(t.account_id) ?? t.account_id,
          pending: t.pending ? 1 : 0,
          hash: t.transaction_id,
        };
      });
    });
    flat.sort((a, b) => a.pending - b.pending); // posted (0) first

    for (const r of flat) {
      // In-pull pending→posted reconciliation: Plaid returns BOTH versions of a
      // charge during the transition (different transaction_ids) and
      // `transactions list` omits pending_transaction_id — so skip a pending row
      // whose posted twin is already present. Same account+amount+near-date AND
      // a matching name (so a coincidental same-amount charge from another
      // vendor is spared). This approximates Plaid's pending_transaction_id link.
      if (r.pending) {
        const twin = (findPosted.all({
          account: r.account,
          amount: r.amount,
          date: r.date,
        }) as { merchant: string }[]).some((q) => nameAffinity(r.merchant, q.merchant) >= NAME_MATCH);
        if (twin) {
          reconciled++;
          continue;
        }
      }
      upsert.run({
        ...r,
        // Ignored on conflict (existing categoryId preserved); applied on
        // fresh inserts. Rules first, then the vendor's own categorization
        // history (a repeat vendor under a new descriptor).
        categoryId: categorizeByRules(r.merchant) ?? categorizeByHistory(r.merchant),
      });
      if (seen.has(r.hash)) updated++;
      else {
        inserted++;
        seen.add(r.hash);
      }
    }
  });
  tx(items);
  return { inserted, updated, reconciled };
}
