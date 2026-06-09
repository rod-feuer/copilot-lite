import { getDb } from "./db";

export type SplitPart = { categoryId: number; amount: number; label: string };

// Define an auto-split: any transaction whose merchant contains `pattern` and
// whose magnitude equals `amount` gets split into `parts` on the next sync.
export function createSplitRule(
  pattern: string,
  amount: number,
  parts: SplitPart[]
) {
  getDb()
    .prepare("INSERT INTO split_rules (pattern, amount, parts) VALUES (?, ?, ?)")
    .run(pattern.toLowerCase(), amount, JSON.stringify(parts));
}

// Apply all split rules to matching, not-yet-split transactions. Idempotent:
// a parent is "already split" once child rows (hash `<parent>:s*`) exist, and a
// split parent is marked excluded so it never double-counts or re-matches.
export function applySplitRules(): number {
  const db = getDb();
  const rules = db
    .prepare("SELECT pattern, amount, parts FROM split_rules")
    .all() as { pattern: string; amount: number; parts: string }[];
  if (rules.length === 0) return 0;

  const findMatches = db.prepare(
    `SELECT id, date, merchant, amount, account, source, hash
     FROM transactions
     WHERE LOWER(merchant) LIKE ? AND ABS(ABS(amount) - ?) < 0.01 AND excluded = 0`
  );
  const hasChildren = db.prepare(
    "SELECT 1 FROM transactions WHERE hash LIKE ? LIMIT 1"
  );
  const excludeParent = db.prepare(
    "UPDATE transactions SET excluded = 1 WHERE id = ?"
  );
  const insertChild = db.prepare(
    `INSERT OR IGNORE INTO transactions
       (date, merchant, rawMerchant, amount, categoryId, account, pending, excluded, source, hash)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  );

  let split = 0;
  const tx = db.transaction(() => {
    for (const rule of rules) {
      const parts = JSON.parse(rule.parts) as SplitPart[];
      const matches = findMatches.all(
        `%${rule.pattern}%`,
        rule.amount
      ) as {
        id: number;
        date: string;
        merchant: string;
        amount: number;
        account: string;
        source: string;
        hash: string;
      }[];
      for (const t of matches) {
        if (hasChildren.get(`${t.hash}:%`)) continue; // already split
        excludeParent.run(t.id);
        parts.forEach((p, i) => {
          const childMerchant = `${t.merchant} — ${p.label}`;
          insertChild.run(
            t.date,
            childMerchant,
            childMerchant,
            -Math.abs(p.amount),
            p.categoryId,
            t.account,
            t.source,
            `${t.hash}:s${i}`
          );
        });
        split++;
      }
    }
  });
  tx();
  return split;
}
