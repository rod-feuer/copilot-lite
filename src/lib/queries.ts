import {
  getDb,
  ensureRecurringSettings,
  ensureMerchantLinks,
  ensureRecurringTxExclusions,
} from "./db";
import type { TransactionWithCategory, Recurring, Category } from "./types";

// ---- Merchant linking ----------------------------------------------------
// User-declared "these descriptors are the same vendor" (e.g. a gas bill whose
// payment descriptor changed). Folds aliases onto a primary everywhere we group
// by merchant. See canonicalMerchant / linkedAliases.
export function getMerchantLinks(): Record<string, string> {
  const db = getDb();
  ensureMerchantLinks(db);
  const rows = db
    .prepare("SELECT alias, primaryMerchant FROM merchant_links")
    .all() as { alias: string; primaryMerchant: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.alias] = r.primaryMerchant;
  return out;
}

// Resolve a merchant to its canonical (primary) name, following the link chain
// with a guard so a cycle/long chain can't loop forever.
export function canonicalMerchant(m: string, links: Record<string, string>): string {
  let cur = m;
  for (let i = 0; i < 10 && links[cur] && links[cur] !== cur; i++) cur = links[cur];
  return cur;
}

// All merchant strings that resolve to `primary` (the primary itself + aliases).
export function linkedAliases(primary: string, links: Record<string, string>): string[] {
  const out = [primary];
  for (const alias of Object.keys(links))
    if (alias !== primary && canonicalMerchant(alias, links) === primary) out.push(alias);
  return out;
}

export function linkMerchant(alias: string, primary: string) {
  const db = getDb();
  ensureMerchantLinks(db);
  const links = getMerchantLinks();
  const target = canonicalMerchant(primary, links); // flatten chains
  if (!alias || !target || alias === target) return;
  db.prepare(
    `INSERT INTO merchant_links (alias, primaryMerchant) VALUES (?, ?)
     ON CONFLICT(alias) DO UPDATE SET primaryMerchant = excluded.primaryMerchant`
  ).run(alias, target);
}

export function unlinkMerchant(alias: string) {
  const db = getDb();
  ensureMerchantLinks(db);
  db.prepare("DELETE FROM merchant_links WHERE alias = ?").run(alias);
}

// The single source of truth for what a merchant is *called* in the UI: a
// recurring's alias on its canonical vendor, else the raw merchant. Used by the
// drawer, transactions list, and dashboard recent so a rename shows everywhere.
export function merchantDisplayName(
  merchant: string,
  settings: Record<string, RecurringSettings>,
  links: Record<string, string>
): string {
  return settings[canonicalMerchant(merchant, links)]?.alias ?? merchant;
}

// Distinct merchant strings with transaction counts — powers the link picker.
export function distinctMerchants(): { merchant: string; count: number }[] {
  return getDb()
    .prepare(
      "SELECT merchant, COUNT(*) AS count FROM transactions GROUP BY merchant ORDER BY count DESC"
    )
    .all() as { merchant: string; count: number }[];
}

export type MatchRule = {
  matchMode: "exact" | "contains";
  matchText: string | null;
  amountTolerance: number | null; // fraction (0.05 = ±5%); null = any amount
};

// All per-recurring user settings (keyed by merchant). null = unset / use default.
export type RecurringSettings = {
  matchMode: "exact" | "contains" | null;
  matchText: string | null;
  amountTolerance: number | null;
  alias: string | null;
  expectedAmount: number | null; // go-forward expected magnitude (positive)
  cadence: Recurring["cadence"] | null;
  nextDate: string | null;
};
const EMPTY_SETTINGS: RecurringSettings = {
  matchMode: null,
  matchText: null,
  amountTolerance: null,
  alias: null,
  expectedAmount: null,
  cadence: null,
  nextDate: null,
};

export function getRecurringSettings(): Record<string, RecurringSettings> {
  const db = getDb();
  ensureRecurringSettings(db);
  const rows = db
    .prepare(
      "SELECT merchant, matchMode, matchText, amountTolerance, alias, expectedAmount, cadence, nextDate FROM recurring_settings"
    )
    .all() as ({ merchant: string } & RecurringSettings)[];
  const out: Record<string, RecurringSettings> = {};
  for (const r of rows) {
    const { merchant, ...rest } = r;
    out[merchant] = rest;
  }
  return out;
}

// Merge a partial patch into a merchant's settings (upsert). Deletes the row
// once every field is back to null so the table doesn't accrue empty rows.
export function setRecurringSetting(merchant: string, patch: Partial<RecurringSettings>) {
  const db = getDb();
  ensureRecurringSettings(db);
  const cur = (db
    .prepare("SELECT * FROM recurring_settings WHERE merchant = ?")
    .get(merchant) as RecurringSettings | undefined) ?? EMPTY_SETTINGS;
  const merged = { ...EMPTY_SETTINGS, ...cur, ...patch, merchant };
  const allNull = Object.entries(merged).every(([k, v]) => k === "merchant" || v == null);
  if (allNull) {
    db.prepare("DELETE FROM recurring_settings WHERE merchant = ?").run(merchant);
    return;
  }
  db.prepare(
    `INSERT INTO recurring_settings
       (merchant, matchMode, matchText, amountTolerance, alias, expectedAmount, cadence, nextDate)
     VALUES (@merchant, @matchMode, @matchText, @amountTolerance, @alias, @expectedAmount, @cadence, @nextDate)
     ON CONFLICT(merchant) DO UPDATE SET
       matchMode = excluded.matchMode, matchText = excluded.matchText,
       amountTolerance = excluded.amountTolerance, alias = excluded.alias,
       expectedAmount = excluded.expectedAmount, cadence = excluded.cadence,
       nextDate = excluded.nextDate`
  ).run(merged);
}

// Back-compat helpers for the match-rule API route.
export function setMatchRule(merchant: string, rule: MatchRule) {
  setRecurringSetting(merchant, {
    matchMode: rule.matchMode,
    matchText: rule.matchText,
    amountTolerance: rule.amountTolerance,
  });
}
export function clearMatchRule(merchant: string) {
  setRecurringSetting(merchant, { matchMode: null, matchText: null, amountTolerance: null });
}

// Merchant strings to match for a text search: every descriptor of any vendor
// whose own name, original bank descriptor (rawMerchant), canonical name, or
// user alias contains the query — then expanded across linked variants so a
// combined vendor matches as one unit (and you can search by the friendly name
// you set, not just the raw descriptor).
function vendorSearchMerchants(ql: string): string[] {
  const db = getDb();
  const links = getMerchantLinks();
  const settings = getRecurringSettings();
  const rows = db
    .prepare("SELECT DISTINCT merchant, rawMerchant FROM transactions")
    .all() as { merchant: string; rawMerchant: string | null }[];
  const matched = new Set<string>();
  for (const r of rows) {
    const canon = canonicalMerchant(r.merchant, links);
    const alias = settings[canon]?.alias ?? "";
    if (
      r.merchant.toLowerCase().includes(ql) ||
      (r.rawMerchant ?? "").toLowerCase().includes(ql) ||
      canon.toLowerCase().includes(ql) ||
      alias.toLowerCase().includes(ql)
    )
      matched.add(canon);
  }
  if (matched.size === 0) return [];
  const out: string[] = [];
  for (const r of rows)
    if (matched.has(canonicalMerchant(r.merchant, links))) out.push(r.merchant);
  return out;
}

export function listTransactions(opts: {
  month?: string;
  categoryId?: number | "none";
  q?: string;
  vendor?: string;
  type?: "income" | "expense";
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  recurring?: boolean;
  sort?: "date" | "amount" | "merchant";
  dir?: "asc" | "desc";
  limit?: number;
}): TransactionWithCategory[] {
  const db = getDb();
  ensureRecurringTxExclusions(db);
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.month) {
    where.push("substr(COALESCE(t.effectiveDate, t.date),1,7) = @month");
    params.month = opts.month;
  }
  if (opts.categoryId === "none") where.push("t.categoryId IS NULL");
  else if (typeof opts.categoryId === "number") {
    where.push("t.categoryId = @cat");
    params.cat = opts.categoryId;
  }
  if (opts.q) {
    // Vendor-aware text match: include transactions whose vendor matches the
    // query by any of its descriptor variants, its canonical name, or the
    // alias/display name you've set — expanded across linked descriptors, so a
    // combined vendor (e.g. AT&T's several descriptors folded into one) matches
    // as a whole. An amount match is added when the query contains digits.
    const digits = opts.q.replace(/[^0-9.]/g, "");
    const hasText = /[a-z]/i.test(opts.q);
    const clauses: string[] = [];
    if (hasText) {
      const merchants = vendorSearchMerchants(opts.q.toLowerCase());
      if (merchants.length) {
        const ph = merchants.map((_, i) => `@sm${i}`);
        merchants.forEach((m, i) => (params[`sm${i}`] = m));
        clauses.push(`t.merchant IN (${ph.join(",")})`);
      } else {
        clauses.push("0"); // text was given but matched no vendor
      }
    }
    if (digits) {
      clauses.push("CAST(ABS(t.amount) AS TEXT) LIKE @qn");
      params.qn = `%${digits}%`;
    }
    if (clauses.length) where.push(`(${clauses.join(" OR ")})`);
  }
  if (opts.vendor) {
    // Match every descriptor variant of the vendor, so this shows the same set
    // the drawer rolled up (not just a substring of the clicked name).
    const vs = merchantVariants(opts.vendor);
    where.push(`t.merchant IN (${vs.map((_, i) => `@v${i}`).join(",")})`);
    vs.forEach((v, i) => {
      params[`v${i}`] = v;
    });
  }
  if (opts.type === "income") where.push("t.amount >= 0");
  else if (opts.type === "expense") where.push("t.amount < 0");
  if (opts.account) {
    where.push("t.account = @account");
    params.account = opts.account;
  }
  if (opts.minAmount != null) {
    where.push("ABS(t.amount) >= @minA");
    params.minA = opts.minAmount;
  }
  if (opts.maxAmount != null) {
    where.push("ABS(t.amount) <= @maxA");
    params.maxA = opts.maxAmount;
  }
  if (opts.recurring === true) where.push("t.recurringId IS NOT NULL");
  else if (opts.recurring === false) where.push("t.recurringId IS NULL");
  // Whitelisted sort column + direction (never interpolate user strings).
  const sortCol =
    opts.sort === "amount"
      ? "ABS(t.amount)"
      : opts.sort === "merchant"
      ? "LOWER(t.merchant)"
      : "COALESCE(t.effectiveDate, t.date)";
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  const sql = `
    SELECT t.*, c.name AS categoryName, c.color AS categoryColor, c.icon AS categoryIcon,
           COALESCE(c.excludeFromTotals, 0) AS categoryExcluded,
           (t.hash IN (SELECT hash FROM recurring_tx_exclusions)) AS recurringExcluded
    FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ${sortCol} ${dir}, t.id DESC
    ${opts.limit ? "LIMIT " + opts.limit : ""}`;
  const rows = db.prepare(sql).all(params) as (TransactionWithCategory & {
    recurringExcluded: number;
  })[];
  const settings = getRecurringSettings();
  const links = getMerchantLinks();
  return rows.map((r) => ({ ...r, displayName: merchantDisplayName(r.merchant, settings, links) }));
}

// Recurring-detection overrides (merchant -> 'force' | 'mute'), applied by
// detectRecurrings so user choices survive its rebuilds.
export function getRecurringOverrides(): Record<string, "force" | "mute"> {
  const rows = getDb()
    .prepare("SELECT merchant, status FROM recurring_overrides")
    .all() as { merchant: string; status: "force" | "mute" }[];
  const out: Record<string, "force" | "mute"> = {};
  for (const r of rows) out[r.merchant] = r.status;
  return out;
}

export function setRecurringOverride(merchant: string, status: "force" | "mute") {
  getDb()
    .prepare(
      `INSERT INTO recurring_overrides (merchant, status) VALUES (?, ?)
       ON CONFLICT(merchant) DO UPDATE SET status = excluded.status`
    )
    .run(merchant, status);
}

export function clearRecurringOverride(merchant: string) {
  getDb().prepare("DELETE FROM recurring_overrides WHERE merchant = ?").run(merchant);
}

// Transaction hashes flagged as one-offs (excluded from their merchant's
// recurring series). Read by detectRecurrings so the exclusion survives rebuilds.
export function getRecurringTxExclusions(): Set<string> {
  const db = getDb();
  ensureRecurringTxExclusions(db);
  const rows = db.prepare("SELECT hash FROM recurring_tx_exclusions").all() as {
    hash: string;
  }[];
  return new Set(rows.map((r) => r.hash));
}

// Flag/unflag a single transaction as a one-off. Keyed by the transaction's
// stable hash so it persists across re-imports. Callers re-run detectRecurrings
// to recompute the series (and clear/restore this charge's recurringId).
export function setTransactionRecurringExcluded(id: number, excluded: boolean) {
  const db = getDb();
  ensureRecurringTxExclusions(db);
  const row = db.prepare("SELECT hash FROM transactions WHERE id = ?").get(id) as
    | { hash: string }
    | undefined;
  if (!row) return;
  if (excluded)
    db.prepare("INSERT OR IGNORE INTO recurring_tx_exclusions (hash) VALUES (?)").run(row.hash);
  else db.prepare("DELETE FROM recurring_tx_exclusions WHERE hash = ?").run(row.hash);
}

// Normalize a bank-descriptor merchant string to a coarse vendor key so the
// drawer can roll up descriptor drift — e.g. "Benjamin Franklin",
// "Benjamin Franklin Plindianapolis In", "Benjamin Franklin Plumbin" all share
// one vendor, as do "Culvers Of Franklin" and "Aplpay Culvers Of Frfranklin In".
// Strips common wallet/processor prefixes, drops punctuation and pure-number
// tokens, and keys on the first two significant tokens. Heuristic by design: it
// under-merges (won't unify "Ben" vs "Benjamin") rather than risk lumping
// distinct vendors together.
function merchantKey(name: string): string {
  let s = name.toLowerCase().trim();
  s = s.replace(/^(aplpay |sq ?\*|tst\* ?|sp |pp\*|paypal \*|gpc\*|pos )/, "");
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  const tokens = s.split(/\s+/).filter((t) => t && !/^\d+$/.test(t));
  return tokens.slice(0, 2).join(" ");
}

// All distinct stored merchant strings that normalize to the same vendor as
// `merchant`. Falls back to the exact name when the key is empty (e.g. all
// digits) so we never group unrelated rows. Exported so write/navigation paths
// (recategorize, recurring override, transactions vendor filter) operate on the
// whole vendor, consistent with the drawer's read rollup.
export function merchantVariants(merchant: string): string[] {
  // Resolve through user links first so a linked vendor is treated as one.
  const links = getMerchantLinks();
  const canonical = canonicalMerchant(merchant, links);
  const linked = new Set(linkedAliases(canonical, links));
  const key = merchantKey(canonical);
  if (key) {
    const all = (
      getDb().prepare("SELECT DISTINCT merchant FROM transactions").all() as {
        merchant: string;
      }[]
    ).map((r) => r.merchant);
    // Include normalized-key matches of the canonical, and key-matches of any
    // linked alias, so the whole vendor rolls up.
    for (const m of all)
      if (merchantKey(m) === key || linked.has(canonicalMerchant(m, links))) linked.add(m);
  }
  linked.add(merchant);
  return [...linked];
}

// Roll a recurring's projected charge date forward by whole cadence steps until
// it lands on/after today, so the drawer's "next due" never shows a past date
// when a charge is late or the series has paused. Display-only: the stored
// nextDate is left alone (the dashboard's "upcoming" filter relies on it).
function nextDueFromToday(nextDate: string, cadence: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (nextDate >= today) return nextDate;
  const d = new Date(nextDate + "T00:00:00Z");
  let guard = 0;
  while (d.toISOString().slice(0, 10) < today && guard++ < 600) {
    if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
    else if (cadence === "biweekly") d.setUTCDate(d.getUTCDate() + 14);
    else if (cadence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
    else if (cadence === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
    else if (cadence === "semiannual") d.setUTCMonth(d.getUTCMonth() + 6);
    else d.setUTCFullYear(d.getUTCFullYear() + 1);
  }
  return d.toISOString().slice(0, 10);
}

// Whether a recurring of `cadence` anchored in `anchorMonth` (1-12) is expected
// in calendar month `mm` (1-12). Weekly/biweekly/monthly land every month;
// periodic cadences only when the month distance is a whole number of periods.
function expectedInMonth(cadence: string, anchorMonth: number, mm: number): boolean {
  const period =
    cadence === "yearly" ? 12 : cadence === "semiannual" ? 6 : cadence === "quarterly" ? 3 : 0;
  if (period === 0) return true;
  return ((((mm - anchorMonth) % period) + period) % period) === 0;
}

// Vendor-centric summary for the detail drawer: spend, frequency, dominant
// category, recurring status, and recent transactions. Aggregates across all
// descriptor variants of the vendor (see merchantVariants) so a sparse variant
// no longer shows an empty history.
export function merchantSummary(merchant: string) {
  const db = getDb();
  const variants = merchantVariants(merchant);
  const ph = variants.map(() => "?").join(",");
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS n,
         COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent,
         COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS received,
         COUNT(DISTINCT substr(COALESCE(effectiveDate, date),1,7)) AS months,
         MAX(CASE WHEN recurringId IS NOT NULL THEN 1 ELSE 0 END) AS recurring
       FROM transactions WHERE merchant IN (${ph}) AND excluded = 0`
    )
    .get(...variants) as {
    n: number;
    spent: number;
    received: number;
    months: number;
    recurring: number | null;
  };
  const cat = db
    .prepare(
      `SELECT c.id, c.name, c.color, c.icon, COUNT(*) AS n
       FROM transactions t JOIN categories c ON t.categoryId = c.id
       WHERE t.merchant IN (${ph}) GROUP BY t.categoryId ORDER BY n DESC LIMIT 1`
    )
    .get(...variants) as
    | { id: number; name: string; color: string; icon: string }
    | undefined;
  const recent = db
    .prepare(
      `SELECT t.id, COALESCE(t.effectiveDate, t.date) AS date, t.amount, t.account, t.excluded,
         c.name AS categoryName
       FROM transactions t LEFT JOIN categories c ON t.categoryId = c.id
       WHERE t.merchant IN (${ph}) ORDER BY COALESCE(t.effectiveDate, t.date) DESC LIMIT 8`
    )
    .all(...variants);

  // Trailing-12-months spend + count (the drawer's box row uses this window).
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const t12 = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS t,
         COUNT(*) AS n
       FROM transactions WHERE merchant IN (${ph}) AND excluded = 0
         AND COALESCE(effectiveDate, date) >= ?`
    )
    .get(...variants, cutoff.toISOString().slice(0, 10)) as { t: number; n: number };
  const trailing12 = t12.t;
  const count12 = t12.n;

  // First time we ever saw this merchant (clarifies the all-time count's scope).
  const firstSeen =
    (
      db
        .prepare(
          `SELECT MIN(COALESCE(effectiveDate, date)) AS f
           FROM transactions WHERE merchant IN (${ph}) AND excluded = 0`
        )
        .get(...variants) as { f: string | null }
    ).f ?? null;

  // Spend by calendar year (current year reads as YTD).
  const byYear = (
    db
      .prepare(
        `SELECT substr(COALESCE(effectiveDate, date),1,4) AS year,
           COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent
         FROM transactions WHERE merchant IN (${ph}) AND excluded = 0
         GROUP BY year ORDER BY year DESC LIMIT 4`
      )
      .all(...variants) as { year: string; spent: number }[]
  ).map((r) => ({ year: r.year, spent: Number(r.spent.toFixed(2)) }));

  // Recurring detail (via the linked recurring, even if its name drifted).
  const rec = db
    .prepare(
      `SELECT cadence, avgAmount, nextDate FROM recurrings
       WHERE id = (SELECT recurringId FROM transactions
                   WHERE merchant IN (${ph}) AND recurringId IS NOT NULL LIMIT 1)`
    )
    .get(...variants) as
    | { cadence: string; avgAmount: number; nextDate: string }
    | undefined;
  const PER_YEAR: Record<string, number> = {
    weekly: 52,
    biweekly: 26,
    monthly: 12,
    quarterly: 4,
    semiannual: 2,
    yearly: 1,
  };
  const recurringDetail = rec
    ? {
        cadence: rec.cadence,
        perCharge: Number(Math.abs(rec.avgAmount).toFixed(2)),
        annualized: Number((Math.abs(rec.avgAmount) * (PER_YEAR[rec.cadence] ?? 12)).toFixed(2)),
        nextDate: nextDueFromToday(rec.nextDate, rec.cadence),
      }
    : null;

  // Price-change detection — only meaningful for recurring fixed-price vendors
  // (variable merchants like coffee shops would flag spurious "changes").
  // Walk charges oldest→newest, find where the current amount run began.
  const charges = recurringDetail
    ? (db
        .prepare(
          `SELECT COALESCE(effectiveDate, date) AS date, amount FROM transactions
           WHERE merchant IN (${ph}) AND amount < 0 AND excluded = 0
           ORDER BY COALESCE(effectiveDate, date) ASC`
        )
        .all(...variants) as { date: string; amount: number }[])
    : [];
  let priceChange: { from: number; to: number; since: string } | null = null;
  if (charges.length >= 2) {
    const latest = Math.abs(charges[charges.length - 1].amount);
    let i = charges.length - 1;
    while (
      i > 0 &&
      Math.abs(Math.abs(charges[i - 1].amount) - latest) <= Math.max(0.5, latest * 0.01)
    )
      i--;
    if (i > 0)
      priceChange = {
        from: Number(Math.abs(charges[i - 1].amount).toFixed(2)),
        to: Number(latest.toFixed(2)),
        since: charges[i].date,
      };
  }

  return {
    merchant,
    displayName: merchantDisplayName(merchant, getRecurringSettings(), getMerchantLinks()),
    nameVariants: variants.length,
    count: agg.n,
    spent: Number(agg.spent.toFixed(2)),
    received: Number(agg.received.toFixed(2)),
    months: agg.months,
    monthlyAvg: agg.months ? Number((agg.spent / agg.months).toFixed(2)) : 0,
    trailing12: Number(trailing12.toFixed(2)),
    count12,
    firstSeen,
    recurring: !!recurringDetail,
    recurringDetail,
    byYear,
    priceChange,
    categoryId: cat?.id ?? null,
    categoryName: cat?.name ?? null,
    categoryColor: cat?.color ?? null,
    categoryIcon: cat?.icon ?? null,
    recent,
  };
}

export function distinctAccounts(): string[] {
  return (
    getDb()
      .prepare("SELECT DISTINCT account FROM transactions ORDER BY account")
      .all() as { account: string }[]
  ).map((r) => r.account);
}

export function setTransactionCategory(id: number, categoryId: number | null) {
  getDb()
    .prepare("UPDATE transactions SET categoryId = ? WHERE id = ?")
    .run(categoryId, id);
}

// Recategorize every transaction of a merchant (used when editing a recurring's
// category on the Recurrings page). Returns the rows changed.
export function setMerchantCategory(merchant: string, categoryId: number | null) {
  return getDb()
    .prepare("UPDATE transactions SET categoryId = ? WHERE merchant = ?")
    .run(categoryId, merchant).changes;
}

// Override the accounting month/day of a transaction (e.g. a mortgage that
// posts a day early). null reverts to the bank's posted date. Survives Plaid
// re-sync because the upsert never touches effectiveDate.
export function setTransactionEffectiveDate(
  id: number,
  effectiveDate: string | null
) {
  getDb()
    .prepare("UPDATE transactions SET effectiveDate = ? WHERE id = ?")
    .run(effectiveDate, id);
}

export function availableMonths(): string[] {
  return (
    getDb()
      .prepare(
        "SELECT DISTINCT substr(COALESCE(effectiveDate,date),1,7) AS m FROM transactions ORDER BY m DESC"
      )
      .all() as { m: string }[]
  ).map((r) => r.m);
}

export function listRecurrings(): (Recurring & {
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
})[] {
  return getDb()
    .prepare(
      `SELECT r.*, c.name AS categoryName, c.color AS categoryColor, c.icon AS categoryIcon
       FROM recurrings r LEFT JOIN categories c ON r.categoryId = c.id
       ORDER BY r.nextDate`
    )
    .all() as never;
}

// Recurrings enriched for a specific month: did the expected charge already post
// (paid + actual amount), and on what day is it due. Powers the Copilot-style
// "paid so far / left to pay" monthly bills view. Matches by merchant (the same
// key detection groups on, so it's consistent for true recurrings).
export type RecurringForMonth = Recurring & {
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  expectedThisMonth: boolean;
  paid: boolean;
  paidAmount: number | null;
  dueDate: string;
  matchRule: MatchRule | null;
  linkedMerchants: string[]; // descriptor aliases folded into this recurring
  displayName: string;
  expectedAmount: number; // effective expected magnitude (override or detected)
  settings: RecurringSettings | null;
};
export function recurringsForMonth(month: string): RecurringForMonth[] {
  const db = getDb();

  // 1. De-duplicate near-identical recurrings. Bank descriptor drift (e.g. a
  // mortgage labeled 3 different ways month to month) makes the detector create
  // clones; collapse them by category + cadence + ~amount, keeping the one with
  // the most history.
  // Greedy grouping: same category + cadence + amount within ~2% (or $5) are
  // treated as one bill; keep the variant with the most history as the face.
  const recs: RecurringForMonth[] = [];
  const sorted = (listRecurrings() as RecurringForMonth[])
    .slice()
    .sort((a, b) => b.count - a.count);
  for (const r of sorted) {
    const dup = recs.find(
      (p) =>
        p.categoryId === r.categoryId &&
        p.cadence === r.cadence &&
        Math.abs(Math.abs(p.avgAmount) - Math.abs(r.avgAmount)) <=
          Math.max(5, Math.abs(p.avgAmount) * 0.02)
    );
    if (!dup) recs.push(r);
  }

  // 2. This month's transactions, matched to recurrings: exact merchant first,
  // then a category + amount-within-5% fallback so a paid bill is recognized
  // even when the bank relabels it. Each transaction is attributed once.
  const txns = db
    .prepare(
      `SELECT merchant, categoryId, amount FROM transactions
       WHERE substr(COALESCE(effectiveDate,date),1,7) = ? AND excluded = 0`
    )
    .all(month) as { merchant: string; categoryId: number | null; amount: number }[];

  const consumed = new Set<number>();
  const actual = new Array(recs.length).fill(0);
  const matched = new Array(recs.length).fill(false);
  const settings = getRecurringSettings();
  const links = getMerchantLinks();
  const canon = (m: string) => canonicalMerchant(m, links);
  const matchRuleFor = (m: string): MatchRule | null => {
    const s = settings[m];
    return s && s.matchMode
      ? { matchMode: s.matchMode, matchText: s.matchText, amountTolerance: s.amountTolerance }
      : null;
  };
  // Presentation overrides: effective cadence / next-due replace the detected
  // values on the rec (amount/alias are applied in the return map below).
  recs.forEach((r) => {
    const s = settings[r.merchant];
    if (s?.cadence) r.cadence = s.cadence;
    if (s?.nextDate) r.nextDate = s.nextDate;
  });

  // Pass 0 — recurrings with a user match rule: the rule fully governs (merchant
  // exact/contains + amount tolerance, or any). No fallback applies to these.
  recs.forEach((r, ri) => {
    const rule = matchRuleFor(r.merchant);
    if (!rule) return;
    const expense = r.avgAmount < 0;
    const needle = (rule.matchText ?? "").toLowerCase();
    txns.forEach((t, i) => {
      if (consumed.has(i)) return;
      if (expense ? t.amount >= 0 : t.amount <= 0) return;
      const merchOk =
        rule.matchMode === "contains"
          ? needle !== "" && t.merchant.toLowerCase().includes(needle)
          : canon(t.merchant) === r.merchant;
      if (!merchOk) return;
      const amtOk =
        rule.amountTolerance == null ||
        Math.abs(Math.abs(t.amount) - Math.abs(r.avgAmount)) <=
          rule.amountTolerance * Math.abs(r.avgAmount);
      if (!amtOk) return;
      consumed.add(i);
      actual[ri] += Math.abs(t.amount);
      matched[ri] = true;
    });
  });

  // Pass 1 — exact merchant (recurrings without a custom rule).
  recs.forEach((r, ri) => {
    if (matchRuleFor(r.merchant)) return;
    const expense = r.avgAmount < 0;
    txns.forEach((t, i) => {
      if (consumed.has(i)) return;
      if (canon(t.merchant) === r.merchant && (expense ? t.amount < 0 : t.amount > 0)) {
        consumed.add(i);
        actual[ri] += Math.abs(t.amount);
        matched[ri] = true;
      }
    });
  });
  // Pass 2 — category + amount-within-5% fallback (no custom rule, still unmatched).
  recs.forEach((r, ri) => {
    if (matched[ri] || matchRuleFor(r.merchant)) return;
    const expense = r.avgAmount < 0;
    const tol = Math.max(1, Math.abs(r.avgAmount) * 0.05);
    let bestIdx = -1;
    let bestDiff = Infinity;
    txns.forEach((t, i) => {
      if (consumed.has(i) || t.categoryId !== r.categoryId) return;
      if (expense ? t.amount >= 0 : t.amount <= 0) return;
      const diff = Math.abs(Math.abs(t.amount) - Math.abs(r.avgAmount));
      if (diff <= tol && diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) {
      consumed.add(bestIdx);
      actual[ri] = Math.abs(txns[bestIdx].amount);
      matched[ri] = true;
    }
  });

  const [yy, mm] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return recs.map((r, ri) => {
    const s = settings[r.merchant] ?? null;
    const dayBasis = s?.nextDate ?? r.lastDate;
    const day = Math.min(Number(dayBasis.slice(8, 10)) || 1, daysInMonth);
    return {
      ...r,
      // Weekly/biweekly/monthly recur every month. Periodic cadences only land
      // in months whose distance from the anchor month is a whole number of
      // periods (quarterly every 3, semiannual every 6, yearly every 12).
      expectedThisMonth: expectedInMonth(r.cadence, Number(dayBasis.slice(5, 7)), mm),
      paid: actual[ri] > 0.005,
      paidAmount: actual[ri] > 0.005 ? Number(actual[ri].toFixed(2)) : null,
      dueDate: `${month}-${String(day).padStart(2, "0")}`,
      matchRule: matchRuleFor(r.merchant),
      linkedMerchants: linkedAliases(r.merchant, links).filter((m) => m !== r.merchant),
      displayName: s?.alias ?? r.merchant,
      expectedAmount: s?.expectedAmount ?? Number(Math.abs(r.avgAmount).toFixed(2)),
      settings: s,
    };
  });
}

// Recurring expenses due within [from, to] (inclusive ISO dates), soonest first.
// Drives the dashboard's forward-looking "upcoming bills" summary. Applies
// per-recurring overrides: effective next-due (filter/sort) and expected amount
// (avgAmount is returned as the effective magnitude, so callers see the override).
export function upcomingRecurringExpenses(
  from: string,
  to: string
): (Recurring & {
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  displayName: string;
})[] {
  const settings = getRecurringSettings();
  const rows = getDb()
    .prepare(
      `SELECT r.*, c.name AS categoryName, c.color AS categoryColor, c.icon AS categoryIcon
       FROM recurrings r LEFT JOIN categories c ON r.categoryId = c.id
       WHERE r.avgAmount < 0`
    )
    .all() as (Recurring & {
    categoryName: string | null;
    categoryColor: string | null;
    categoryIcon: string | null;
  })[];
  return rows
    .map((r) => {
      const s = settings[r.merchant];
      const nextDate = s?.nextDate ?? r.nextDate;
      const mag = s?.expectedAmount ?? Math.abs(r.avgAmount);
      return { ...r, nextDate, avgAmount: -mag, displayName: s?.alias ?? r.merchant };
    })
    .filter((r) => r.nextDate >= from && r.nextDate <= to)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

// Monthly limit per category, keyed by categoryId. Flat (applies to every
// month); a per-month/override model can layer on later.
export function getBudgets(): Record<number, number> {
  const rows = getDb()
    .prepare("SELECT categoryId, amount FROM budgets")
    .all() as { categoryId: number; amount: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.categoryId] = r.amount;
  return out;
}

export function setBudget(categoryId: number, amount: number) {
  getDb()
    .prepare(
      `INSERT INTO budgets (categoryId, amount) VALUES (?, ?)
       ON CONFLICT(categoryId) DO UPDATE SET amount = excluded.amount`
    )
    .run(categoryId, amount);
}

export function deleteBudget(categoryId: number) {
  getDb().prepare("DELETE FROM budgets WHERE categoryId = ?").run(categoryId);
}

// Toggle whether a category's transactions are omitted from all totals (e.g. a
// "Work Expenses" reimbursement category). Respected at query time by the
// dashboard aggregation and the transactions-page net.
export function setCategoryExcluded(categoryId: number, excluded: boolean) {
  getDb()
    .prepare("UPDATE categories SET excludeFromTotals = ? WHERE id = ?")
    .run(excluded ? 1 : 0, categoryId);
}

// Detected recurring expenses normalized to a monthly figure, summed per
// category. This is the "known recurring" baseline shown when setting a budget,
// so the user can size the discretionary (ad-hoc) portion. Same cadence factors
// as the Recurrings screen.
const MONTHLY_FACTOR: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  yearly: 1 / 12,
};
export function recurringMonthlyByCategory(): Record<number, number> {
  const rows = getDb()
    .prepare(
      "SELECT categoryId, cadence, avgAmount FROM recurrings WHERE avgAmount < 0 AND categoryId IS NOT NULL"
    )
    .all() as { categoryId: number; cadence: string; avgAmount: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) {
    out[r.categoryId] =
      (out[r.categoryId] ?? 0) + Math.abs(r.avgAmount) * (MONTHLY_FACTOR[r.cadence] ?? 1);
  }
  return out;
}

export function categoriesWithTotals(month?: string): (Category & {
  total: number;
  txCount: number;
  budget: number | null;
  recurringBaseline: number;
})[] {
  const db = getDb();
  const monthFilter = month ? "AND substr(COALESCE(t.effectiveDate, t.date),1,7) = @month" : "";
  const rows = db
    .prepare(
      // Total = spending magnitude, consistent with the dashboard breakdown:
      // expense categories count outflows (amount < 0); income categories count
      // inflows (amount > 0). This keeps the two screens in agreement even when a
      // category holds mixed-sign rows (e.g. large transfers parked in "Other").
      `SELECT c.*,
        COALESCE(SUM(
          CASE
            WHEN c.kind = 'expense' AND t.amount < 0 THEN -t.amount
            WHEN c.kind = 'income'  AND t.amount > 0 THEN  t.amount
            ELSE 0
          END), 0) AS total,
        COUNT(t.id) AS txCount
       FROM categories c
       LEFT JOIN transactions t ON t.categoryId = c.id AND t.excluded = 0 ${monthFilter}
       GROUP BY c.id
       -- Excluded-from-totals categories (e.g. Transfers) sink to the bottom of
       -- their section instead of floating to the top on their large raw total.
       ORDER BY c.kind DESC, COALESCE(c.excludeFromTotals, 0) ASC, total DESC`
    )
    .all({ month }) as (Category & { total: number; txCount: number })[];
  const budgets = getBudgets();
  const baseline = recurringMonthlyByCategory();
  return rows.map((c) => ({
    ...c,
    budget: budgets[c.id] ?? null,
    recurringBaseline: Number((baseline[c.id] ?? 0).toFixed(2)),
  }));
}

export function createCategory(c: {
  name: string;
  color: string;
  icon: string;
  kind: "expense" | "income";
}) {
  return getDb()
    .prepare(
      "INSERT INTO categories (name, color, icon, kind) VALUES (@name, @color, @icon, @kind)"
    )
    .run(c);
}

export function deleteCategory(id: number) {
  const db = getDb();
  db.prepare("UPDATE transactions SET categoryId = NULL WHERE categoryId = ?").run(id);
  db.prepare("DELETE FROM rules WHERE categoryId = ?").run(id);
  db.prepare("DELETE FROM budgets WHERE categoryId = ?").run(id);
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);
}

// Common subscription / bill name signals — used only to suggest brand-new
// merchants (1-2 charges) that have no timing pattern yet (e.g. a first Roku
// charge). Deterministic and intentionally generous; the user confirms each.
const SUBSCRIPTION_HINT =
  /\b(netflix|hulu|disney|spotify|hbo|max|paramount|peacock|youtube|roku|appletv|apple\.com|icloud|prime video|audible|patreon|substack|medium|nyt|nytimes|wsj|economist|peloton|gym|fitness|membership|subscription|insurance|premium|energy|electric|electricity|water|sewer|gas|utility|utilities|internet|wireless|mobile|fiber|wifi|broadband|cloud|storage|vpn|chatgpt|openai|anthropic|claude|adobe|dropbox|notion|github|linkedin|hosting|domain)\b/i;

// Recurrings the strict auto-detector won't claim, surfaced for one-tap
// confirmation (Rule 5: code finds candidates; the user adjudicates):
//   - "variable": regular timing but amounts too variable for auto (CV > 0.6) —
//     usage-based bills like gas/phone (e.g. Vectren, Ooma).
//   - "new": only 1-2 charges so far but the name reads like a subscription/bill
//     and it charged recently — too little history to detect a cadence.
// Excludes anything already recurring, force-d, or previously dismissed (muted).
export function suggestedRecurrings() {
  const db = getDb();
  const overrides = getRecurringOverrides();
  const cats = new Map(
    (db.prepare("SELECT id, name, color, icon FROM categories").all() as Category[]).map(
      (c) => [c.id, c]
    )
  );
  const rows = db
    .prepare(
      `SELECT merchant, COALESCE(effectiveDate, date) AS d, amount, categoryId
       FROM transactions
       WHERE amount < 0 AND excluded = 0 AND recurringId IS NULL
       ORDER BY merchant, d`
    )
    .all() as { merchant: string; d: string; amount: number; categoryId: number | null }[];

  // Group by canonical merchant so user-linked descriptors suggest as one.
  const links = getMerchantLinks();
  const byMerchant = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = canonicalMerchant(r.merchant, links);
    const a = byMerchant.get(key) ?? [];
    a.push(r);
    byMerchant.set(key, a);
  }

  const PERIOD: Record<string, number> = {
    weekly: 7,
    biweekly: 14,
    monthly: 30,
    quarterly: 91,
    semiannual: 182,
    yearly: 365,
  };
  const cadenceOf = (g: number): string | null =>
    Math.abs(g - 7) <= 2
      ? "weekly"
      : Math.abs(g - 14) <= 3
      ? "biweekly"
      : g >= 26 && g <= 35
      ? "monthly"
      : g >= 80 && g <= 100
      ? "quarterly"
      : g >= 165 && g <= 200
      ? "semiannual"
      : g >= 330 && g <= 400
      ? "yearly"
      : null;
  const todayMs = new Date().getTime();

  type Suggestion = {
    merchant: string;
    reason: "variable" | "new";
    cadence: string | null;
    avgAmount: number;
    count: number;
    lastDate: string;
    category: { name: string; color: string; icon: string } | null;
  };
  const out: Suggestion[] = [];

  for (const [merchant, txs] of byMerchant) {
    if (overrides[merchant]) continue; // already forced or dismissed
    const lastDate = txs[txs.length - 1].d;
    const amounts = txs.map((t) => Math.abs(t.amount));
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const cId = txs[txs.length - 1].categoryId;
    const category = (cId && cats.get(cId)) || null;
    const base = {
      merchant,
      avgAmount: -Number(mean.toFixed(2)),
      count: txs.length,
      lastDate,
      category: category ? { name: category.name, color: category.color, icon: category.icon } : null,
    };

    if (txs.length >= 3) {
      const dates = txs.map((t) => new Date(t.d + "T00:00:00Z").getTime());
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86_400_000);
      const sorted = [...gaps].sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      const cadence = cadenceOf(med);
      if (!cadence) continue;
      const period = PERIOD[cadence];
      const onGrid =
        gaps.filter((g) => Math.abs(g - Math.max(1, Math.round(g / period)) * period) <= 0.35 * period)
          .length / gaps.length;
      const sd = Math.sqrt(amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length);
      const cv = mean ? sd / mean : 0;
      // Regular timing, but amount too variable for auto (and not absurd).
      if (onGrid >= 0.6 && cv > 0.6 && cv <= 1.5) {
        out.push({ ...base, reason: "variable", cadence });
      }
    } else if (
      SUBSCRIPTION_HINT.test(merchant) &&
      (todayMs - new Date(lastDate + "T00:00:00Z").getTime()) / 86_400_000 <= 120
    ) {
      out.push({ ...base, reason: "new", cadence: null });
    }
  }

  // Variable (regular, confident) first, then recent new subs; richer history wins.
  return out.sort(
    (a, b) =>
      (a.reason === b.reason ? 0 : a.reason === "variable" ? -1 : 1) ||
      b.count - a.count ||
      b.lastDate.localeCompare(a.lastDate)
  );
}

// ---- Category shelf -------------------------------------------------------
// Month adjacent-helpers (UTC, "YYYY-MM").
function shiftMonth(month: string, deltaMonths: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + deltaMonths, 1)).toISOString().slice(0, 7);
}

export type CategorySummary = {
  id: number;
  name: string;
  icon: string;
  color: string;
  kind: "expense" | "income";
  excludeFromTotals: 0 | 1;
  month: string;
  spent: number; // magnitude this month (outflow for expense, inflow for income)
  txCount: number;
  prevSpent: number; // same, prior month (for the MoM card)
  monthlyAvg: number; // trailing-12 average magnitude (the "typical month" benchmark)
  budget: number | null;
  upcoming: { merchant: string; displayName: string; dueDate: string; amount: number }[];
  transactions: {
    id: number;
    date: string;
    merchant: string;
    displayName: string;
    amount: number;
    account: string;
    recurringId: number | null;
  }[];
};

// Everything the category shelf needs for a category in a given month. Mirrors
// merchantSummary; magnitude is sign-aware (expense=outflow, income=inflow),
// consistent with categoriesWithTotals and the dashboard.
export function categorySummary(categoryId: number, month: string): CategorySummary | null {
  const db = getDb();
  const cat = db
    .prepare(
      "SELECT id, name, icon, color, kind, COALESCE(excludeFromTotals,0) AS excludeFromTotals FROM categories WHERE id = ?"
    )
    .get(categoryId) as
    | { id: number; name: string; icon: string; color: string; kind: "expense" | "income"; excludeFromTotals: 0 | 1 }
    | undefined;
  if (!cat) return null;

  const magExpr =
    cat.kind === "income"
      ? "CASE WHEN amount > 0 THEN amount ELSE 0 END"
      : "CASE WHEN amount < 0 THEN -amount ELSE 0 END";

  const monthAgg = (m: string) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(${magExpr}), 0) AS s, COUNT(*) AS n
         FROM transactions
         WHERE categoryId = ? AND excluded = 0
           AND substr(COALESCE(effectiveDate, date),1,7) = ?`
      )
      .get(categoryId, m) as { s: number; n: number };

  const cur = monthAgg(month);
  const prev = monthAgg(shiftMonth(month, -1));
  const t12 = (
    db
      .prepare(
        `SELECT COALESCE(SUM(${magExpr}), 0) AS s
         FROM transactions
         WHERE categoryId = ? AND excluded = 0
           AND substr(COALESCE(effectiveDate, date),1,7) BETWEEN ? AND ?`
      )
      .get(categoryId, shiftMonth(month, -11), month) as { s: number }
  ).s;

  const settings = getRecurringSettings();
  const links = getMerchantLinks();
  const txns = db
    .prepare(
      `SELECT id, COALESCE(effectiveDate, date) AS date, merchant, amount, account, recurringId
       FROM transactions
       WHERE categoryId = ? AND substr(COALESCE(effectiveDate, date),1,7) = ?
       ORDER BY COALESCE(effectiveDate, date) DESC, id DESC`
    )
    .all(categoryId, month) as {
    id: number;
    date: string;
    merchant: string;
    amount: number;
    account: string;
    recurringId: number | null;
  }[];

  // Recurrings tied to this category still expected this month (unpaid) — only
  // for the current month, and only ACTIVE ones (a stale/stopped recurring that
  // hasn't charged within ~1.5 cycles isn't "upcoming"; it's inactive).
  const currentMonth = new Date().toISOString().slice(0, 7);
  const PERIOD: Record<string, number> = {
    weekly: 7,
    biweekly: 14,
    monthly: 30,
    quarterly: 91,
    semiannual: 182,
    yearly: 365,
  };
  const now = Date.now();
  const isActiveRec = (r: { lastDate: string; cadence: string }) =>
    (now - new Date(r.lastDate + "T00:00:00Z").getTime()) / 86_400_000 <=
    (PERIOD[r.cadence] ?? 30) * 1.5 + 5;
  const upcoming =
    month !== currentMonth
      ? []
      : recurringsForMonth(month)
          .filter(
            (r) =>
              r.categoryId === categoryId &&
              r.avgAmount < 0 &&
              r.expectedThisMonth &&
              !r.paid &&
              isActiveRec(r)
          )
          .map((r) => ({
            merchant: r.merchant,
            displayName: r.displayName,
            dueDate: r.dueDate,
            amount: r.expectedAmount,
          }))
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate)); // soonest first

  return {
    ...cat,
    month,
    spent: Number(cur.s.toFixed(2)),
    txCount: cur.n,
    prevSpent: Number(prev.s.toFixed(2)),
    monthlyAvg: Number((t12 / 12).toFixed(2)),
    budget: getBudgets()[cat.id] ?? null,
    upcoming,
    transactions: txns.map((t) => ({
      ...t,
      displayName: merchantDisplayName(t.merchant, settings, links),
    })),
  };
}
