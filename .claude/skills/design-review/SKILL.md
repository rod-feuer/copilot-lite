---
name: design-review
description: Review a screen, component, or UI change against the project's DESIGN.md rubric (legibility-first — the §3 checklist). Use when evaluating new or changed UI — a page, a component, a PR, or the current branch's UI diff. Produces a per-principle verdict with specific file:line findings and a prioritized fix list.
user-invocable: true
---

# /design-review

Review UI against the project's design rubric in **DESIGN.md** — the source of
truth. Master rule: **Legibility beats cleverness — a feature that can't be found,
understood, or reached doesn't exist.** Be the exacting design reviewer, not a
rubber stamp.

## Scope (from `args`)
- `design-review <page|component>` — review that surface (e.g. `transactions`, `CategoryBadge`, `the shelf`).
- `design-review <PR#>` — review the UI in that PR's diff.
- `design-review` (no arg) — review the current branch's UI changes
  (`git diff main...HEAD` limited to `src/app/**` + `src/components/**`). If the
  branch is `main` or clean, ask what to review rather than guessing.

## Procedure
1. **Read DESIGN.md first.** The rubric evolves — pull the live §1 principles,
   §2 this-app conventions, and §3 checklist; don't rely on memory alone.
2. **Resolve the target → files.** Map the arg to the actual page/component files
   *and the components they render*. For a PR/branch, get the diff and **read the
   changed UI files in full** — hierarchy and state checks need surrounding context,
   not just hunks.
3. **Evaluate each §3 item against the real code**, citing specifics as `file:line`:
   - **Visible (1)** — every action reachable without hover? Flag `opacity-0
     group-hover` gating, hover-only buttons, and disguised controls (a `<select>`
     with `appearance-none` and no visible caret), or any action with no
     always-visible anchor.
   - **Teachable (2)** — a new concept? Named in plain words and explained at the
     point of use? Flag jargon and unexplained models.
   - **Reachable (3)** — touch + keyboard + contrast. Flag hover-gated affordances
     (dead on touch), icon-only buttons leaning on `title` for their accessible
     name, custom dropdowns/menus without keyboard handling, and `--muted`-on-
     `--background` low contrast. A gap is acceptable **only** if §2 records it as
     a deliberate scope decision.
   - **In-place (4)** — corrections happen on the object, not a settings panel;
     auto-vs-edited is shown.
   - **Honest (5)** — any provisional/partial number shown as final? Should it be
     qualified, projected, or withheld?
   - **Ranked (6)** — squint test: is the most important element visually
     dominant? Flag equal-weight clusters that bury the key figure.
   - **Consistent (7)** — reuses an existing paradigm? Flag a new one-off
     dropdown / confirmation / vocabulary where the app already has one.
     Cross-check §2: tokens (not hard-coded colors), the dropdown rule, the
     correction vocabulary.
   - **Complete states (8)** — empty, loading, partial, and error all designed?
   - **Capable (9)** — for the object(s) this surface touches, is every expected
     operation reachable (create / edit *each* attribute / delete), or is the
     omission a written decision (§2)? **Cross-check the API/data model against
     the UI** — a field accepted by a route but never surfaced is the classic
     "wired but not exposed" gap a presentation-only review misses.
4. **Capability matrix (for a page or whole-app review).** When the scope is a
   page or the app (not a single component), build a small objects × operations
   matrix and read the **blanks** — that's how absent capabilities (which no
   screenshot can show) get caught. List API routes/methods and the data model's
   editable fields, then mark which are reachable in the UI.
5. **Verify, don't assume.** When a check depends on runtime behavior (does the
   dropdown open with its options? does a loading state flash?), check it against
   the running dev server or label it unverified — never assert what you didn't
   confirm.

## Output
A scannable report:
- **One verdict line per principle** — ✅ pass / ⚠️ partial / ❌ fail / — n/a —
  each with a one-line finding and `file:line`. Keep n/a items terse.
- **Fix first (ranked)** — the 2–5 highest-impact issues, ordered by
  perceived-quality-per-effort, each tied to its principle and to the master
  legibility rule, with a concrete suggested fix.
- **Missing verbs** (page/app scope) — capabilities that are absent or wired-but-
  unsurfaced, split into *gaps* vs *deliberate read-only scopes*.
- If nothing material is wrong, **say so plainly** — don't manufacture findings to
  look thorough.

Default to an honest, specific, prioritized critique over a long flat list. The
goal is to surface what's hidden, unteachable, or unreachable — and propose the
smallest change that makes the built depth legible.
