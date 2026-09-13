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
// Pending charges are never split: a sync replaces a pending row (remove + add),
// which would bring the parent back un-excluded while its children survive.
export function applySplitRules(): number {
  const db = getDb();
  const rules = db
    .prepare("SELECT pattern, amount, parts FROM split_rules")
    .all() as { pattern: string; amount: number; parts: string }[];
  if (rules.length === 0) return 0;

  const findMatches = db.prepare(
    `SELECT id, date, merchant, amount, account, source, hash
     FROM transactions
     WHERE LOWER(merchant) LIKE ? AND ABS(ABS(amount) - ?) < 0.01 AND excluded = 0 AND pending = 0`
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

// Undo a split from one of its parents: delete the rule that produced it, remove
// every child row that rule created (for every parent it matched, not just this
// one — a rule that is gone must not leave half its work behind), and restore
// each parent to counting. Returns how many parents were restored; 0 means
// there was no split to undo.
export function undoSplit(parentId: number): number {
  const db = getDb();
  const parent = db
    .prepare("SELECT merchant, amount FROM transactions WHERE id = ?")
    .get(parentId) as { merchant: string; amount: number } | undefined;
  if (!parent) return 0;
  const rule = (
    db
      .prepare("SELECT id, pattern, amount FROM split_rules WHERE ABS(amount - ?) < 0.01")
      .all(Math.abs(parent.amount)) as { id: number; pattern: string; amount: number }[]
  ).find((r) => parent.merchant.toLowerCase().includes(r.pattern));
  if (!rule) return 0;

  const parents = db
    .prepare(
      `SELECT id, hash FROM transactions
       WHERE LOWER(merchant) LIKE ? AND ABS(ABS(amount) - ?) < 0.01
         AND excluded = 1 AND hash NOT LIKE '%:s%'`
    )
    .all(`%${rule.pattern}%`, rule.amount) as { id: number; hash: string }[];
  const deleteChildren = db.prepare("DELETE FROM transactions WHERE hash LIKE ?");
  const restoreParent = db.prepare("UPDATE transactions SET excluded = 0 WHERE id = ?");

  return db.transaction(() => {
    let restored = 0;
    for (const p of parents) {
      // A parent excluded by hand (not by this rule) has no children — leave it.
      if (deleteChildren.run(`${p.hash}:s%`).changes === 0) continue;
      restoreParent.run(p.id);
      restored++;
    }
    db.prepare("DELETE FROM split_rules WHERE id = ?").run(rule.id);
    return restored;
  })();
}
