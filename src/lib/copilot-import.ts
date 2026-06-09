import crypto from "node:crypto";
import { getDb, wipeAll } from "./db";
import { classifyCadence, addCadence } from "./core";
import { normalizeMerchant } from "./merchant";
import { parseCsv } from "./import";
import type { Recurring } from "./types";

// Importer for Copilot Money's own CSV export. Differs from the generic importer
// in four deliberate ways, per the choices made for this dataset:
//   1. Sign is FLIPPED — Copilot exports positive = expense, negative = income;
//      this app uses negative = expense, positive = income.
//   2. Category = Copilot's `parent category` (~22 groups), not the 138 children.
//   3. Rows with excluded=true OR type=internal transfer are stored but marked
//      `excluded` so they never count toward dashboard/category totals (mirrors
//      how Copilot reports).
//   4. Recurrings come from Copilot's `recurring` column, not local detection.

const PALETTE = [
  "#6366f1", "#22c55e", "#f97316", "#0ea5e9", "#a855f7", "#eab308",
  "#ec4899", "#ef4444", "#14b8a6", "#8b5cf6", "#10b981", "#f43f5e",
  "#3b82f6", "#84cc16", "#06b6d4", "#d946ef", "#f59e0b", "#64748b",
];

// A few recognizable icons; everything else gets a neutral default.
const ICONS: Record<string, string> = {
  restaurants: "🍽️", grocery: "🛒", shopping: "🛍️", subscriptions: "📺",
  cars: "🚗", vacations: "✈️", travel: "✈️", health: "🏥", "health expenses": "🏥",
  kids: "🧸", fitness: "🏋️", "personal care": "🧴", gifts: "🎁", alcohol: "🍷",
  income: "💵", transfers: "🔁", "home decor": "🛋️", boat: "⛵",
  "carmel home": "🏠", "lake home": "🏡", college: "🎓", entertaining: "🎉",
};

function iconFor(name: string): string {
  const key = name.toLowerCase();
  for (const k in ICONS) if (key.includes(k)) return ICONS[k];
  return "•";
}

const idx = (headers: string[], name: string) =>
  headers.findIndex((h) => h.trim().toLowerCase() === name);

export type CopilotImportResult = {
  inserted: number;
  categories: number;
  recurrings: number;
  excludedRows: number;
  transfers: number;
  incomeRows: number;
  errors: number;
  dateRange: [string, string] | null;
};

type Row = {
  date: string;
  name: string;
  amount: number; // already sign-flipped to app convention
  account: string;
  pending: 0 | 1;
  excluded: 0 | 1;
  categoryName: string;
  categoryKind: "income" | "expense";
  recurringName: string;
};

export function importCopilotCsv(text: string): CopilotImportResult {
  const raw = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (raw.length < 2)
    return {
      inserted: 0, categories: 0, recurrings: 0, excludedRows: 0,
      transfers: 0, incomeRows: 0, errors: 0, dateRange: null,
    };

  const h = raw[0].map((x) => x.trim().toLowerCase());
  const ci = {
    date: idx(h, "date"),
    name: idx(h, "name"),
    amount: idx(h, "amount"),
    status: idx(h, "status"),
    parent: idx(h, "parent category"),
    excluded: idx(h, "excluded"),
    type: idx(h, "type"),
    account: idx(h, "account"),
    recurring: idx(h, "recurring"),
  };
  if (ci.date < 0 || ci.name < 0 || ci.amount < 0)
    throw new Error("Not a Copilot export: missing date/name/amount columns.");

  // ---- Pass 1: normalize every row -------------------------------------
  const rows: Row[] = [];
  let errors = 0;
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    try {
      const rawDate = r[ci.date]?.trim();
      const name = r[ci.name]?.trim();
      const rawAmount = Number(r[ci.amount]?.replace(/[$,]/g, "").trim());
      if (!rawDate || !name || Number.isNaN(rawAmount)) {
        errors++;
        continue;
      }
      const date = new Date(rawDate).toISOString().slice(0, 10);
      if (Number.isNaN(Date.parse(rawDate))) {
        errors++;
        continue;
      }
      const type = (ci.type >= 0 ? r[ci.type] : "").trim().toLowerCase();
      const isIncome = type === "income";
      const isTransfer = type === "internal transfer";
      // This user's Copilot marks 100% of income as excluded; we deliberately
      // keep income IN (so Dashboard income/net are meaningful) while still
      // honoring exclusions for transfers and other excluded (e.g. card payments).
      const excludedFlag =
        !isIncome &&
        ((ci.excluded >= 0 && r[ci.excluded].trim().toLowerCase() === "true") ||
          isTransfer);

      let categoryName: string;
      let categoryKind: "income" | "expense";
      if (isTransfer) {
        categoryName = "Transfers";
        categoryKind = "expense";
      } else if (isIncome) {
        categoryName = (ci.parent >= 0 && r[ci.parent].trim()) || "Income";
        categoryKind = "income";
      } else {
        categoryName = (ci.parent >= 0 && r[ci.parent].trim()) || "Uncategorized";
        categoryKind = "expense";
      }

      rows.push({
        date,
        name,
        amount: -rawAmount, // sign flip
        account: (ci.account >= 0 ? r[ci.account]?.trim() : "") || "Imported",
        pending:
          ci.status >= 0 && r[ci.status].trim().toLowerCase() === "pending" ? 1 : 0,
        excluded: excludedFlag ? 1 : 0,
        categoryName,
        categoryKind,
        recurringName: ci.recurring >= 0 ? r[ci.recurring].trim() : "",
      });
    } catch {
      errors++;
    }
  }

  // ---- Determine category kinds by majority vote -----------------------
  const kindVotes = new Map<string, { inc: number; exp: number }>();
  for (const row of rows) {
    const v = kindVotes.get(row.categoryName) ?? { inc: 0, exp: 0 };
    if (row.categoryKind === "income") v.inc++;
    else v.exp++;
    kindVotes.set(row.categoryName, v);
  }

  const db = getDb();
  const result = db.transaction((): CopilotImportResult => {
    wipeAll();

    // ---- Categories ----------------------------------------------------
    const insertCat = db.prepare(
      "INSERT INTO categories (name, color, icon, kind) VALUES (?, ?, ?, ?)"
    );
    const catId = new Map<string, number>();
    let ci2 = 0;
    for (const [name, v] of kindVotes) {
      const kind = v.inc > v.exp ? "income" : "expense";
      const info = insertCat.run(name, PALETTE[ci2 % PALETTE.length], iconFor(name), kind);
      catId.set(name, Number(info.lastInsertRowid));
      ci2++;
    }

    // ---- Recurrings (from Copilot's column) ----------------------------
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      if (!row.recurringName) continue;
      const arr = groups.get(row.recurringName) ?? [];
      arr.push(row);
      groups.set(row.recurringName, arr);
    }
    const insertRec = db.prepare(
      `INSERT INTO recurrings (merchant, categoryId, avgAmount, cadence, lastDate, nextDate, count)
       VALUES (@merchant, @categoryId, @avgAmount, @cadence, @lastDate, @nextDate, @count)`
    );
    const recId = new Map<string, number>();
    const DAY = 86_400_000;
    for (const [name, grp] of groups) {
      const sorted = [...grp].sort((a, b) => a.date.localeCompare(b.date));
      const amounts = sorted.map((g) => g.amount);
      const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      let cadence: Recurring["cadence"] = "monthly";
      if (sorted.length >= 2) {
        const t = sorted.map((g) => new Date(g.date + "T00:00:00Z").getTime());
        const gaps: number[] = [];
        for (let k = 1; k < t.length; k++) gaps.push((t[k] - t[k - 1]) / DAY);
        cadence =
          classifyCadence(gaps.reduce((a, b) => a + b, 0) / gaps.length) ?? "monthly";
      }
      // Most common category among the group's rows.
      const catName = sorted
        .map((g) => g.categoryName)
        .sort(
          (a, b) =>
            sorted.filter((x) => x.categoryName === b).length -
            sorted.filter((x) => x.categoryName === a).length
        )[0];
      const lastDate = sorted[sorted.length - 1].date;
      const info = insertRec.run({
        merchant: name,
        categoryId: catId.get(catName) ?? null,
        avgAmount: Number(avg.toFixed(2)),
        cadence,
        lastDate,
        nextDate: addCadence(lastDate, cadence),
        count: sorted.length,
      });
      recId.set(name, Number(info.lastInsertRowid));
    }

    // ---- Transactions --------------------------------------------------
    const insertTx = db.prepare(
      `INSERT OR IGNORE INTO transactions
        (date, merchant, rawMerchant, amount, categoryId, account, pending, excluded, recurringId, source, hash)
       VALUES (@date, @merchant, @rawMerchant, @amount, @categoryId, @account, @pending, @excluded, @recurringId, 'copilot', @hash)`
    );
    let inserted = 0;
    let excludedRows = 0,
      transfers = 0,
      incomeRows = 0;
    rows.forEach((row, i) => {
      // Include row index so genuinely-identical charges are all preserved
      // (the importer wipes first, so re-import never doubles).
      const hash = crypto
        .createHash("sha1")
        .update(`${row.date}|${row.name}|${row.amount}|${row.account}|${i}`)
        .digest("hex");
      const info = insertTx.run({
        date: row.date,
        // hash stays keyed on the raw name (above) so re-imports still dedup.
        merchant: normalizeMerchant(row.name),
        rawMerchant: row.name,
        amount: row.amount,
        categoryId: catId.get(row.categoryName) ?? null,
        account: row.account,
        pending: row.pending,
        excluded: row.excluded,
        recurringId: row.recurringName ? recId.get(row.recurringName) ?? null : null,
        hash,
      });
      if (info.changes) inserted++;
      if (row.excluded) excludedRows++;
      if (row.categoryName === "Transfers") transfers++;
      if (row.categoryKind === "income") incomeRows++;
    });

    const dates = rows.map((r) => r.date).sort();
    return {
      inserted,
      categories: catId.size,
      recurrings: recId.size,
      excludedRows,
      transfers,
      incomeRows,
      errors,
      dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : null,
    };
  })();

  return result;
}
