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
        const date = new Date(rawDate).toISOString().slice(0, 10);
        if (date === "Invalid Date" || Number.isNaN(Date.parse(rawDate))) {
          errors++;
          continue;
        }
        const hash = txHash(date, merchant, amount, account);
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
