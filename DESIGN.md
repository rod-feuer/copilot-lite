# DESIGN.md — Design principles & review

Three layers: **§1 Principles** (portable — copy into any app), **§2 Conventions**
(this app's realization — rewrite per app), **§3 Review checklist** (run per
feature / PR / screen). §1 and §3 travel unchanged; only §2 is app-specific.

> **The rule above the rules — Legibility beats cleverness.**
> A feature that can't be found, understood, or reached doesn't exist. Every
> principle below serves this. Depth is only worth building if it's *visible,
> teachable, and reachable.*

---

## §1 — Principles (portable)

Each principle carries a **test**: a yes/no question to run in review. If the
answer comes out wrong, the design isn't finished — capability is not the bar,
legibility is.

### 1. Anchor, then reveal — *visible*
Every surface has at least one always-visible entry point. Hover and secondary
states may *enhance* an action; they may never *gate* it. Progressive disclosure
layers off the anchor — it doesn't replace it.
- **Why:** hidden affordances don't get used — even by the author months later —
  and vanish entirely on touch.
- **Test:** remove every hover/secondary state — can you still reach every action?

### 2. Teach at the point of use — *understandable*
Name concepts in the user's words. Where the model isn't obvious, explain it in
one sentence where the user meets it — not in a manual.
- **Why:** a powerful concept the user can't parse is friction, not power. If the
  author has to ask "what does this mean?", it isn't self-teaching.
- **Test:** would a capable first-time user know what this does and why?

### 3. Reach is table stakes — or scoped on purpose — *reachable*
Touch, keyboard, and adequate contrast are defaults. Dropping one is a written
decision, not an accident.
- **Why:** an unstated gap is a silent break; "works on my machine" isn't a design.
- **Test:** works on touch and keyboard, with legible contrast? If not, did we
  decide that deliberately and write it down?

### 4. Correct, don't configure
Let users nudge the system's guess on the object itself; show what's *auto* vs.
*edited*. Prefer in-place correction to a settings panel.
- **Why:** people fix what's in front of them; they don't hunt through preferences.
- **Test:** is this a setting in a panel, or a nudge on the thing it affects?

### 5. Honest by default
Never present provisional or partial data as final. Withhold it, qualify it, or
project it — but don't overstate.
- **Why:** in anything numeric, trust is the product; one misleading figure costs it.
- **Test:** could this number mislead someone who reads it mid-process?

### 6. Rank ruthlessly
The single most important element on a surface wins visually. Equal weight is no
hierarchy.
- **Why:** if everything is emphasized, nothing is; the eye needs a place to land.
- **Test:** squint — is the loudest thing the thing that matters most?

### 7. One pattern per job
One paradigm per interaction class — dropdowns, confirmations, vocabulary.
Resist one-off micro-interactions.
- **Why:** every bespoke pattern is a thing to learn and a thing to maintain;
  consistency is a feature.
- **Test:** does this add a new way to do something the app already does another way?

### 8. Finish the states
Design empty, loading, partial, and error — not just the happy path.
- **Why:** the unhappy paths are where trust is won or lost, and they are most of
  real use.
- **Test:** what does this look like with zero items, while loading, and when it fails?

---

## §2 — This app's conventions (copilot-lite)

How the principles above are realized here. **Rewrite this section per app;** §1
and §3 carry over unchanged.

- **The shelf is the control surface.** A vendor or category is edited in the
  right-side shelf, where its evidence (recent charges, totals, history) is on
  screen — not in a modal, not on a separate page. Drill down via the shelf; keep
  the user on the current page. *(serves: Correct-don't-configure, Anchor)*
- **Correction vocabulary.** Plain verbs the user owns: **Combine / Separate**
  (merge or split vendors), **Mark ended / Reactivate** (subscriptions),
  **not recurring** (never was a pattern), **exclude from totals**. No jargon, no
  "configure." *(Teach, One-pattern)*
- **Auto vs. edited is always legible.** A field shows whether it holds the
  system's detected value or one the user set ("Auto · Monthly"; an "edited"
  tag). *(Correct-don't-configure, Honest)*
- **Dropdowns — one rule.** Native `<select>` for simple/keyboard cases (category,
  filters, sort), and it must *look* interactive (visible affordance). Custom
  dropdowns only when the content is rich (the combine picker, the emoji grid).
  No disguised controls. *(One-pattern, Anchor)*
- **Forward-looking figures are qualified.** Mid-month net is shown projected with
  a "so far" actual; income reads "≈ expected"; projections are withheld until
  enough of the month has elapsed. *(Honest)*
- **Review queues** surface low-confidence work (uncategorized, merge / name-cleanup
  candidates) for one-tap confirmation instead of auto-applying it. *(Correct-don't-configure)*
- **Tokens & theme.** One accent, neutral grays, 2xl card / xl control radii, dark
  mode via `data-theme` + CSS variables. New surfaces use the tokens — never
  hard-coded colors. *(One-pattern)*
- **Known gaps, scoped on purpose.** Desktop-first: no mobile navigation, and some
  affordances are hover-gated. *Documented, not accidental* — revisit if touch
  becomes in scope. *(Reach)*

---

## §3 — Design review checklist

Run against any new screen, component, or UI change. Each item maps to a §1
principle; a failed item means the design isn't done.

- [ ] **Visible** — every action reachable without hover; ≥1 always-visible anchor per surface. *(1)*
- [ ] **Teachable** — new concepts named in plain words and explained at the point of use. *(2)*
- [ ] **Reachable** — works on touch + keyboard with legible contrast, or the gap is written down. *(3)*
- [ ] **In-place** — corrections happen on the object, not in a settings panel; auto vs. edited is shown. *(4)*
- [ ] **Honest** — no provisional/partial number shown as final; qualified or withheld. *(5)*
- [ ] **Ranked** — the most important element is visually dominant. *(6)*
- [ ] **Consistent** — reuses the app's existing paradigm for this interaction; no new one-off. *(7)*
- [ ] **Complete states** — empty, loading, partial, and error all designed. *(8)*
