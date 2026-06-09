import { getDb } from "./db";
import { txHash, learnRule, detectRecurrings } from "./core";
import { normalizeMerchant } from "./merchant";

// Deterministic PRNG so re-seeding produces the same data.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES: { name: string; color: string; icon: string; kind: "expense" | "income" }[] = [
  { name: "Income", color: "#16a34a", icon: "💵", kind: "income" },
  { name: "Housing", color: "#6366f1", icon: "🏠", kind: "expense" },
  { name: "Groceries", color: "#22c55e", icon: "🛒", kind: "expense" },
  { name: "Dining", color: "#f97316", icon: "🍽️", kind: "expense" },
  { name: "Transport", color: "#0ea5e9", icon: "🚗", kind: "expense" },
  { name: "Subscriptions", color: "#a855f7", icon: "📺", kind: "expense" },
  { name: "Utilities", color: "#eab308", icon: "💡", kind: "expense" },
  { name: "Shopping", color: "#ec4899", icon: "🛍️", kind: "expense" },
  { name: "Health", color: "#ef4444", icon: "🏥", kind: "expense" },
  { name: "Entertainment", color: "#14b8a6", icon: "🎬", kind: "expense" },
];

// merchant pattern -> category name. Seeds the rule table (the "known merchant"
// fast path) so seeded data needs no model calls.
const RULES: [string, string][] = [
  ["paycheck", "Income"],
  ["greenfield rent", "Housing"],
  ["whole foods", "Groceries"],
  ["trader joe", "Groceries"],
  ["safeway", "Groceries"],
  ["chipotle", "Dining"],
  ["blue bottle", "Dining"],
  ["sweetgreen", "Dining"],
  ["uber", "Transport"],
  ["shell gas", "Transport"],
  ["netflix", "Subscriptions"],
  ["spotify", "Subscriptions"],
  ["icloud", "Subscriptions"],
  ["pg&e", "Utilities"],
  ["comcast", "Utilities"],
  ["amazon", "Shopping"],
  ["nike", "Shopping"],
  ["cvs pharmacy", "Health"],
  ["equinox gym", "Health"],
  ["amc theatres", "Entertainment"],
  ["steam games", "Entertainment"],
];

type TxDraft = { day: number; merchant: string; amount: number; account: string };

// Recurring fixtures (stable each month) + a pool of random one-offs.
const MONTHLY_RECURRING: TxDraft[] = [
  { day: 1, merchant: "Greenfield Rent", amount: -2400, account: "Checking" },
  { day: 1, merchant: "Acme Corp Paycheck", amount: 5200, account: "Checking" },
  { day: 15, merchant: "Acme Corp Paycheck", amount: 5200, account: "Checking" },
  { day: 3, merchant: "Netflix", amount: -15.49, account: "Credit" },
  { day: 7, merchant: "Spotify", amount: -11.99, account: "Credit" },
  { day: 2, merchant: "iCloud+ Storage", amount: -2.99, account: "Credit" },
  { day: 12, merchant: "PG&E Utilities", amount: -94.5, account: "Checking" },
  { day: 18, merchant: "Comcast Internet", amount: -79.99, account: "Checking" },
  { day: 5, merchant: "Equinox Gym", amount: -185, account: "Credit" },
];

const ONE_OFFS = [
  { merchant: "Whole Foods Market", cat: "Groceries", lo: 40, hi: 160 },
  { merchant: "Trader Joe's", cat: "Groceries", lo: 25, hi: 95 },
  { merchant: "Safeway", cat: "Groceries", lo: 20, hi: 80 },
  { merchant: "Chipotle", cat: "Dining", lo: 11, hi: 28 },
  { merchant: "Blue Bottle Coffee", cat: "Dining", lo: 5, hi: 16 },
  { merchant: "Sweetgreen", cat: "Dining", lo: 13, hi: 22 },
  { merchant: "Uber Trip", cat: "Transport", lo: 9, hi: 38 },
  { merchant: "Shell Gas Station", cat: "Transport", lo: 35, hi: 70 },
  { merchant: "Amazon.com", cat: "Shopping", lo: 12, hi: 180 },
  { merchant: "Nike Store", cat: "Shopping", lo: 45, hi: 220 },
  { merchant: "CVS Pharmacy", cat: "Health", lo: 8, hi: 60 },
  { merchant: "AMC Theatres", cat: "Entertainment", lo: 18, hi: 52 },
  { merchant: "Steam Games", cat: "Entertainment", lo: 10, hi: 60 },
];

export function seed(monthsBack = 6): number {
  const db = getDb();

  // Categories.
  const insertCat = db.prepare(
    "INSERT OR IGNORE INTO categories (name, color, icon, kind) VALUES (?, ?, ?, ?)"
  );
  for (const c of CATEGORIES) insertCat.run(c.name, c.color, c.icon, c.kind);
  const catId = new Map(
    (db.prepare("SELECT id, name FROM categories").all() as { id: number; name: string }[]).map(
      (r) => [r.name, r.id]
    )
  );

  // Rules.
  for (const [pattern, cat] of RULES) learnRule(pattern, catId.get(cat)!, "seed");

  const rand = mulberry32(42);
  const insertTx = db.prepare(
    `INSERT OR IGNORE INTO transactions (date, merchant, rawMerchant, amount, categoryId, account, pending, source, hash)
     VALUES (@date, @merchant, @rawMerchant, @amount, @categoryId, @account, 0, 'seed', @hash)`
  );

  const ruleFor = (merchant: string): number | null => {
    const m = merchant.toLowerCase();
    for (const [pattern, cat] of RULES) if (m.includes(pattern)) return catId.get(cat)!;
    return null;
  };

  const now = new Date("2026-05-30T00:00:00Z");
  let count = 0;
  const addTx = (date: string, merchant: string, amount: number, account: string) => {
    const hash = txHash(date, merchant, amount, account);
    const info = insertTx.run({
      date,
      merchant: normalizeMerchant(merchant),
      rawMerchant: merchant,
      amount,
      categoryId: ruleFor(merchant),
      account,
      hash,
    });
    if (info.changes) count++;
  };

  for (let mb = monthsBack - 1; mb >= 0; mb--) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - mb, 1));
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const iso = (day: number) =>
      `${year}-${String(month + 1).padStart(2, "0")}-${String(
        Math.min(day, daysInMonth)
      ).padStart(2, "0")}`;

    // Recurring fixtures.
    for (const r of MONTHLY_RECURRING) {
      const d = new Date(Date.UTC(year, month, Math.min(r.day, daysInMonth)));
      if (d > now) continue;
      addTx(iso(r.day), r.merchant, r.amount, r.account);
    }

    // Random one-offs: ~22 per month.
    const oneOffCount = 18 + Math.floor(rand() * 8);
    for (let i = 0; i < oneOffCount; i++) {
      const day = 1 + Math.floor(rand() * daysInMonth);
      const d = new Date(Date.UTC(year, month, day));
      if (d > now) continue;
      const pick = ONE_OFFS[Math.floor(rand() * ONE_OFFS.length)];
      const amount = -Number((pick.lo + rand() * (pick.hi - pick.lo)).toFixed(2));
      addTx(iso(day), pick.merchant, amount, rand() > 0.5 ? "Credit" : "Checking");
    }
  }

  detectRecurrings();
  return count;
}
