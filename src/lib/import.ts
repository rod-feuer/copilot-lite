import { getDb } from "./db";
import { txHash, categorizeByRules } from "./core";

// Minimal CSV parser handling quoted fields and embedded commas. Good enough for
// bank/Copilot exports; not a full RFC-4180 implementation.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (field.length || row.length) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// The calendar date a CSV cell names. An ISO date is already one. Anything else
// ("3/1/2026") parses as LOCAL midnight, so it is read back in local parts:
// toISOString() moved it to the previous day anywhere east of UTC.
function calendarDate(raw: string): string | null {
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const pick = (headers: string[], names: string[]): number =>
  headers.findIndex((h) => names.includes(h.trim().toLowerCase()));

export type ImportResult = { inserted: number; duplicates: number; errors: number };

// Accepts flexible headers: date | name/merchant/description | amount | account.
// Amount sign convention: negative = expense (Copilot/most banks export this way).
export function importCsv(text: string, source = "csv"): ImportResult {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length < 2) return { inserted: 0, duplicates: 0, errors: 0 };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const di = pick(headers, ["date"]);
  const mi = pick(headers, ["name", "merchant", "description", "payee"]);
  const ai = pick(headers, ["amount"]);
  const acci = pick(headers, ["account"]);
  if (di < 0 || mi < 0 || ai < 0) {
    throw new Error(
      "CSV must have Date, Name/Merchant/Description, and Amount columns."
    );
  }

  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO transactions (date, merchant, amount, categoryId, account, pending, source, hash)
     VALUES (@date, @merchant, @amount, @categoryId, @account, 0, @source, @hash)`
  );

  let inserted = 0,
    duplicates = 0,
    errors = 0;
  // Two identical charges on one day (two coffees, two tolls) are two charges.
  // The dedupe key alone made the second a "duplicate" and dropped it — 149
  // such pairs exist in real data. The nth identical row in a file gets the
  // nth key, so re-importing the same file is still idempotent.
  const seenInFile = new Map<string, number>();

  const run = db.transaction(() => {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      try {
        const rawDate = r[di]?.trim();
        const merchant = r[mi]?.trim();
        const amount = Number(r[ai]?.replace(/[$,]/g, "").trim());
        const account = acci >= 0 ? r[acci]?.trim() || "Imported" : "Imported";
        if (!rawDate || !merchant || Number.isNaN(amount)) {
          errors++;
          continue;
        }
        const date = calendarDate(rawDate);
        if (!date) {
          errors++;
          continue;
        }
        const base = txHash(date, merchant, amount, account);
        const nth = (seenInFile.get(base) ?? 0) + 1;
        seenInFile.set(base, nth);
        const hash = nth === 1 ? base : `${base}#${nth}`;
        const info = insert.run({
          date,
          merchant,
          amount,
          categoryId: categorizeByRules(merchant),
          account,
          source,
          hash,
        });
        if (info.changes) inserted++;
        else duplicates++;
      } catch {
        errors++;
      }
    }
  });
  run();

  return { inserted, duplicates, errors };
}
