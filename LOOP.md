# Iterate-until-good-enough loop

The finish line + rules for an autonomous improvement loop. Kick off with:
`/loop work through LOOP.md until the rubric is complete`

## Verification gate
Run **every iteration** (fast):
1. `npx tsc --noEmit` — clean
2. `npx eslint src` — clean
3. `npm test` — green (`node --import tsx --test`; uses a temp DB via `COPILOT_DB_PATH`)
4. `npm run smoke` — pages load in a real browser with **no console errors**, APIs 200
   (needs the dev server up on :3000; catches client-side crashes tests can't)

Run **before declaring the rubric done** (heavier / disruptive):
5. `npm run build` (`next build`) — **stop `next dev` first** (they share `.next`).
   Catches RSC / server-client boundary errors `tsc` misses.

**Real data is sacred:** never run destructive ops on `data/copilot.db`. Tests point at
a temp file via `COPILOT_DB_PATH`; detection/migration/split helpers wipe + rebuild and
must only ever run against a temp DB.

## Loop protocol
- Each iteration: top unchecked rubric item → **minimal** change → run the gate → if green,
  check it off + one-line the diff → next.
- **Stop** when: rubric complete, OR token budget reached, OR a money-semantics decision is
  the user's (ask, don't guess), OR a change can't pass the gate after a reasonable attempt.
- No speculative features — only items below. New ideas go under "Backlog (needs user OK)".
- Anything only verifiable by eye goes on the **Human-review list**, not silently passed.

## Definition of done (rubric)

### A. Correctness — money math has tests (Rule 9: test intent)
- [x] detection: cadence / CV amount / on-grid / median
- [x] merchant normalization + migration (reversible)
- [x] paid-matching (exact + canonical/linked)
- [x] merchant linking merges into one recurring
- [x] exclude-by-row + excludeFromTotals category (categoriesWithTotals + dashboard)
- [x] auto-split: children sum to parent, parent excluded
- [x] effective-date routes a charge to the right month (COALESCE)
- [x] dashboard net == income − expenses, all figures finite
- [x] duplicate hash rejected (dedup invariant)
- [x] display name resolves consistently (drawer + transactions list)  ← was the alias bug
- [x] match rules (contains + amount tolerance) — paid-matching pass 0
- [x] recurring overrides: alias / expected-amount / cadence applied in `recurringsForMonth`
- [x] budgets surfaced correctly (`categoriesWithTotals.budget`)
- [x] suggestedRecurrings tiers (variable + new) group by canonical
- [x] empty month → finite figures, no NaN, no throw

### B. Display consistency (structural — Tier 3)
- [x] one resolver `merchantDisplayName()` is the single source of truth; drawer,
      transactions list, dashboard recent + upcoming all use it
- [ ] category icon/color + recurring ↻ status consistent across drawer / list / recurrings

### C. Robustness
- [x] No silent write `fetch()` — `postJson`/`patchJson` helpers (tested) surface failures via error toast across Recurrings, Transactions, and the drawer (no more false-success toasts).
- [~] Empty / loading / error states — dashboard `load` no longer hangs the spinner on a failed/empty read (try/finally). Remaining (visual empty/error state design per page) → Human-review.
- [x] No NaN/Infinity in computed figures (dashboard/categories guarded + tested; progress bar already gated on totalBills>0)

### D. UX / a11y / hygiene
- [ ] Interactive rows keyboard-accessible (button semantics / aria)
- [ ] Formatting consistent with conventions (decimals, signs, dark-mode tokens)
- [ ] Gate clean (tsc / eslint / tests / smoke) — standing requirement
- [ ] No dead code / unused exports introduced

## Loop status (paused 2026-06-08)
The **gate-verifiable** rubric is essentially complete: 27 tests (`npm test`) cover the
money math (detection, normalization, paid-matching, linking, exclude/split, effective-
date, budgets, dedup, suggestions, overrides) + the http helper; display name is one
resolver everywhere; all write-fetches surface failures; NaN/empty-month guarded; the
dashboard spinner can't hang. The remaining items below are **eye-verifiable** and need a
human at the screen — the loop stopped here rather than autonomously pass them.

## Human-review list (loop can't self-verify — flag, don't pass)
- **Visual empty / error states** per page (e.g. dashboard when a read fails → currently
  shows skeleton; design a real "couldn't load" state). Loading states exist; error UI doesn't.
- **a11y:** Recurrings rows AND Transactions rows are clickable `<div>`/`<li onClick>` (not
  keyboard-focusable). Needs role/tabindex/keydown or a rethink (they contain nested controls,
  so can't be a plain `<button>`).
- Drawer / panel visual layout + spacing; dark-mode appearance of new UI.
- Formatting consistency (decimals/signs) — spot-check across pages.
- That an alias/rename *looks* right in every surface (screenshot).
- Subjective "does this read clearly" calls.

## Backlog (needs user OK before building — do NOT auto-build)
- Auto expected-amount (recent-weighted + charges-per-period, e.g. 2× Netflix).
- ⌘K command palette / keyboard shortcuts.
- Transactions phase 3: per-tx exclude toggle, bulk actions, manual split.
- Mutation testing on `src/lib` money math (Tier 2 — proves tests fail when logic breaks).
- pending→posted dedup test (Plaid-specific; needs a Plaid fixture).
- account filter on match rules (intentionally skipped).
