---
name: copilot-lite-playbook
description: Domain procedures for working in copilot-lite — vendor-identity merging, pending/posted reconciliation, recurring detection, merchant normalization, partial-period projection, and UI conventions. Use when touching transaction ingestion, merge/dedup logic, recurring/suggestion detection, dashboard totals, or shared interaction patterns. The full skill list lives in LEARNINGS.md.
user-invocable: true
---

# copilot-lite playbook

How-to rules for this codebase's domain machinery. Underlying facts are in
memory (`MEMORY.md`); this is the procedure layer. The general, cross-project
disciplines behind these are CLAUDE.md Rules 13–16 and `LEARNINGS.md`.

## Vendor-identity triage
Two descriptors might be one vendor? Run the detector stack in precision order:
1. Guarded location-suffix strip
2. Normalized-equality (near-zero false positives)
3. Name-affinity = `max(prefix-containment, Jaro-Winkler, token-set overlap)` — in `src/lib/similarity.ts`

Auto-merge only ≥ `NAME_MATCH` (0.9). Surface the 0.8–0.9 band to the review
queue (sorted last, one-click confirm). Below 0.8 is noise. **Never widen the
auto bar to "fix" a missed match** — add a manual link instead. A single fuzzy
rule under-matches typos and over-matches shared geographic prefixes (bare
prefix affinity let "Carmel" swallow a dozen unrelated businesses).

## Pending → posted is remove + add, not an in-place flip
Import posted rows before pending, then drop any pending row whose posted twin
already exists. Match on **account + amount + near-date AND a name guard** —
never amount+date alone (false-matches coincidental same-amount charges).
Providers return both versions mid-transition with different ids and a drifted
descriptor; the Plaid CLI exposes no `pending_transaction_id`. Cleanup must be
twin-scoped (a real merchant+account match), never a wholesale pending class —
the pending row may be the sole record of a real charge.

## Recurring detection: sort grouped members by date
When the group key (canonical merchant) differs from the SQL `ORDER BY` key (raw
merchant), the SELECT only *looks* sorted. Re-sort each in-memory group by date
before taking first/last (lastDate, nextDate, "latest category"). Route every
"is this entity still active?" check through the single shared
`isRecurringActive()` so all consumers agree. Stale recurrings must not claim
charges via category fallback, and must not inflate the budget baseline.

## Merchant normalization is write-time and reversible
Canonical merchant is normalized at import; `rawMerchant` preserves the
original so any merge/rename is reversible. **Diagnose on raw, display on
canonical.**

## Partial-period totals are projected, never raw partial-vs-full
Lead with a projected figure (recurring / prior-full-period, floored at
actual-so-far); demote the raw partial to "so far." Suppress any delta
comparing two incomplete same-length slices. Paychecks land days 27–31, so
early-month MTD vs last-full-month is pure noise. Past periods use actuals +
full-vs-full. When two valid scopes coexist on screen (all-expenses vs
budgeted-only), keep both, name the narrower scope, and add one reconciling
line that bridges them arithmetically.

## Interaction conventions — uniform across surfaces
An indicator/affordance means and *does* the same thing everywhere the same
entity appears: the ↻ glyph is both indicator and toggle; the whole row is the
click target with interactive children calling `stopPropagation`. Inline edits
(✎ label→input, or click-to-edit value; Enter/blur saves, Esc cancels) sit at
the point of reading, via the reusable `InlineEditField`. Fix inconsistency
toward the established reference — don't add a new variant. Toasts, not
`alert()`; dark mode via `data-theme` + CSS-var tokens.

## Hard constraints (from memory — do not relearn)
- `data/copilot.db` is **real finances** in WAL mode. Never mutate it to test.
  Prove mutating logic on a temp DB (`COPILOT_DB_PATH`); verify only render
  behavior live. (CLAUDE.md Rule 14.)
- Schema changes need a **fresh dev-server boot** (connection cached on
  `globalThis`; migrations run only on cold start).
- This is **not** the Next.js you know — read `node_modules/next/dist/docs/`
  before writing framework code.
- Tests: `npm test` (node:test + tsx, temp DB via `COPILOT_DB_PATH`). Encode
  *why* the behavior matters, not just what it does.
