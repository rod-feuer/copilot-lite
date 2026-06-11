# LEARNINGS — skills distilled from building copilot-lite

Reusable skills mined from this project's commit history, memory, and session
transcript (a 29-agent harvest → adversarial prune → synthesis). Each is a
**Trigger → Move → Why** rule; *Why* cites the real moment it was earned.
**Home** notes where the skill is promoted to: a CLAUDE.md rule (always-on),
this playbook, or memory (a project fact).

Bar for inclusion: generalizable, non-obvious, actionable, and evidence-backed.
Project facts (schema, gotchas) live in memory, not here — unless phrased as a
rule you can act on.

---

## General (any project)

### Verification & data safety

**1. Diagnose before fixing** · *Home: CLAUDE.md rule*
Trigger: A user reports a data anomaly ("X should be categorized", "June is missing") and you're tempted to explain or patch from code alone.
Move: Query that exact entity's real history/linkage keyed on a **stable** attribute (amount, account, id) — not a drift-prone name — before blaming code. Treat "found nothing" as "my predicate is wrong," not "the data is absent."
Why: Vectren's "two descriptors" were two real bills (gas + electric); `LIKE '%Metronet%'` missed `Metro Fibernet L Metfibenet` and fabricated an "11-month gap" until re-searching by the −$92.95 amount surfaced the charges.

**2. Re-read before concluding** · *Home: CLAUDE.md rule*
Trigger: About to report a conclusion built on a screenshot, query, or file read captured earlier — especially against a store the user is also touching.
Move: Re-capture the artifact now. If current state contradicts the old read, assume the data changed and re-derive — don't defend the stale finding.
Why: A critique started from a screenshot that "predates the current code"; the Metronet diagnosis was overturned when "a sync pulled in the Feb–May charges" since the original query.

**3. Prove it with a number** · *Home: CLAUDE.md rule*
Trigger: You've identified a suspected logic bug and have a fix in mind.
Move: Find a concrete impossibility in the live numbers it produces (a subset exceeding its superset, a flipped sign) and state it as proof; after the fix, show those same numbers reconciling. A fix without a before/after number isn't verified.
Why: Projected budgeted spend ($68,795) exceeded projected total spend ($36,012) — impossible; post-fix it read $35,753, consistent.

**4. Verify before mutating, not after** · *Home: CLAUDE.md rule*
Trigger: About to run a rule-based bulk UPDATE / DELETE / exclude over real data — especially a rule derived from how *new* data arrives.
Move: A heuristic about the forward stream ("the posted version always comes later") does **not** license backfilling history. Back up first (`VACUUM INTO`), prove per-row each candidate truly meets the criterion, scope the write to confirmed rows only, prefer a reversible `excluded=1` over DELETE, dry-run the exact rows + net effect, and verify **before** mutating.
Why: A "skip all pending" rule (correct for future imports) applied to existing data hid ~$5,465 of real charges (Sofi −$4,397, Dance Ensemble −$832) whose pending row was the sole record — verification ran *after* the exclude, so it shipped wrong then had to be reverted.

**5. Don't mutate real data to verify** · *Home: playbook*
Trigger: A fix's verification would require running a destructive/mutating action (cleanup, merge, import) against the user's real store.
Move: Prove the mutating logic with a unit test on a throwaway DB; verify only read-only/render behavior against the live app; and explicitly state you did **not** run the mutation.
Why: The model refused to click "Clean up names" on the live finance DB, proved the round-trip on a temp DB, and verified only that the button rendered and the GET returned `{canUndo:false}`.

**6. Pause on irreversible / outward-facing actions** · *Home: playbook (reinforces the built-in)*
Trigger: An action publishes or exposes content beyond the local machine — first push, creating a remote repo, committing a screenshot/fixture — especially with personal data.
Move: Stop and confirm exactly what would be exposed; for demo artifacts of a data-heavy app, render the live app in an **isolated worktree against a throwaway seeded DB** rather than scrubbing real data.
Why: A README screenshot showed real finances ($16,311, real merchant names); the model instead rendered against `/tmp/copilot-demo.db` on port 3100 and halted before first push to confirm `.env.local` / `data/` were gitignored.

**7. Tests encode WHY, on a throwaway DB** · *Home: CLAUDE.md rule 9 (reinforce) + playbook*
Trigger: Shipping any fix to business logic.
Move: Add a `node:test` + `tsx` test seeded via a temp DB (`COPILOT_DB_PATH`) that would **fail if the business reason changes**, not merely if the mechanics do — name the invariant, not the function.
Why: 61 tests accreted this way; each new bug (date-sort, inactive-recurring, override) got a test that locks the *intent*, which is why later refactors stayed safe. (Closes the harvest's "testing discipline is thin" gap.)

### Heuristics, matching & UI honesty

**8. Auto-act only at high precision; review-tier the borderline** · *Home: CLAUDE.md rule*
Trigger: A similarity/match detector's confidence sits in the ambiguous band — below the auto bar, above noise — and you're tempted to auto-apply or silently drop it.
Move: Keep auto-apply (especially destructive) strict and never widen it; never silently drop the borderline band — emit it to a flagged "possible match" review queue, sorted last, one-click confirm, so the human is the precision filter. Don't collapse the three bands into one threshold.
Why: Metronet → `Metro Fibernet L Metfibenet` scored 0.842, below the 0.9 auto bar, was silently skipped, and a real rename was lost until a manual link (commit 7414791).

**9. Layer complementary detectors, never one fuzzy rule** · *Home: CLAUDE.md rule (principle); recipe in playbook*
Trigger: Reconciling drifted descriptors of one entity ("Duke Energy" vs "Dukeenergy Bill Pay").
Move: One fuzzy-prefix rule under-matches typos and over-matches shared prefixes. Layer detectors with different failure modes — a guarded suffix strip, a near-zero-false-positive equality check, and a blended affinity score — so each covers the others' blind spots.
Why: Bare shared-prefix affinity let "Carmel" swallow a dozen unrelated businesses (commits 6f602ab, e0eca17); the layered score matched every known rename and still rejected the Carmel pair at 0.802.

**10. Project partial-period totals; never show partial-vs-full deltas** · *Home: playbook*
Trigger: Month-to-date figures or period-over-period deltas where inputs are lumpy/back-loaded (income posts late, quarterly bills) and the period is in progress.
Move: Lead with a **projected** figure (recurring / prior-full-period value, floored at actual-so-far; raw partial demoted to "so far"); suppress any delta comparing two incomplete same-length slices, or compare like-for-like by bounding the prior baseline to the same elapsed days. Past periods use actuals + full-vs-full.
Why: On June 9 the dashboard showed income down $33,802 and expenses down 69% vs May — pure noise, since paychecks land days 27–31 with 70% of the month left; the user noted that once a money app "lies," they distrust every delta (commit 75ced13).

**11. Reconcile two on-screen number universes** · *Home: playbook*
Trigger: A screen shows two figures measuring "the same thing" by different valid scopes (all-expenses vs budgeted-only, projected vs actual) and they don't match.
Move: Keep both, rename the narrower one to name its scope ("Budgeted spend"), and add one reconciling line that bridges them arithmetically (narrow + remainder = total).
Why: The dashboard showed Expenses $19,421 vs a budget card $19,162 with no link — "two unexplained spent figures"; the reconciling line removed the mystery (commit 790e9ac).

**12. Surface buried edits as an inline hover affordance** · *Home: playbook*
Trigger: A user can't find how to change something ("no way to change the name") even though the capability exists inside an Edit/settings panel.
Move: Add a hover-revealed inline edit at the point of reading (✎ label→input, or click-to-edit value; Enter/blur saves, Esc cancels) while keeping the panel; extract a reusable field that `stopPropagation` so the row's own click still fires.
Why: Renaming was "buried" in the Edit panel (commit 672ed7f); the shared `InlineEditField` had to `stopPropagation` to coexist with whole-row click (fdac231).

---

## copilot-lite playbook (project-specific procedures)

The domain machinery, as decision rules. Most underlying *facts* are in memory
(see `MEMORY.md`); these are the *how-to* layered on top.

**Vendor-identity triage.** When two descriptors might be one vendor, run the detector stack in precision order: guarded location-suffix strip → normalized-equality → name-affinity = `max(prefix-containment, Jaro-Winkler, token-set overlap)`. Auto-merge only ≥ `NAME_MATCH` (0.9); surface the 0.8–0.9 band to the review queue; below 0.8 is noise. Never widen the auto bar to "fix" a missed match — add a manual link instead. (Skills 8–9 are the general form.)

**Pending → posted is remove + add, not an in-place flip.** Import posted rows before pending, then drop any pending row whose posted twin already exists — match on **account + amount + near-date AND a name guard** (never amount+date alone, which false-matches coincidental same-amount charges). Providers return both versions mid-transition with different ids and a drifted descriptor; the Plaid CLI exposes no `pending_transaction_id`. (commit 428b5b5; memory: pending-transactions.)

**Recurring detection: sort grouped members by date.** When the group key (canonical merchant) differs from the SQL `ORDER BY` key (raw merchant), the SELECT only *looks* sorted — re-sort each in-memory group by date before taking first/last (lastDate, nextDate, "latest category"). Route every "is this entity still active?" check through the single shared `isRecurringActive()` so all consumers agree. (commits afad7e9, 844e1c5, 05ce5a1.)

**Merchant normalization is write-time and reversible.** Canonical merchant is normalized at import; `rawMerchant` preserves the original so any merge/rename is reversible. Diagnose on raw, display on canonical. (memory: merchant-normalization. Closes the harvest's "write-time normalization under-represented" gap.)

**Schema changes need a fresh dev-server boot.** The better-sqlite3 connection is cached on `globalThis`; `init()` migrations only run on a cold start. After any schema change, restart the dev server before verifying. (memory: schema-changes-need-restart.)

**Keep interaction conventions uniform across surfaces.** An indicator/affordance must mean and *do* the same thing everywhere the same entity appears — the ↻ glyph is both indicator and toggle; the whole row is the click target with interactive children `stopPropagation`. Fix inconsistency toward the established reference; don't add a new variant. (commits d1643c7, 1d97eaa, 062c6d1; memory: ui-conventions.)

---

## Provenance & open gaps

Harvested 2026-06 from commits + memory + transcript. The completeness critic
flagged two residual veins worth a future pass if we extend this: deeper
**test-authoring heuristics** beyond skill 7, and whether each "general" skill
*truly* transfers off copilot-lite or is a finance-specific rule in disguise
(skills 10–11 lean finance; treat as provisional-general).
