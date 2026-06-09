# Copilot Lite

A simplified, local-only personal finance dashboard — a stripped-down Copilot Money
clone with four screens: **Dashboard, Transactions, Categories, Recurrings**.

Built with Next.js 16 + Tailwind v4 + SQLite (better-sqlite3). All data stays on
your machine in `data/copilot.db` (gitignored).

## Run

```bash
npm run dev      # http://localhost:3000
```

On first load, click **Load sample data** (≈6 months of realistic transactions) or
**Import CSV**.

## Design principle: code does the math, the model only judges

Per the project's CLAUDE.md (Rule 5), deterministic work is plain code; the model is
used for exactly one thing — classifying a *genuinely unseen* merchant into a category.

| Concern | How it's done |
|---|---|
| Dedupe, import, dashboard totals, cash-flow | Deterministic code (`src/lib/core.ts`) |
| Recurring detection (3+ regular, similar-amount charges) | Deterministic pattern match — **not** the model |
| Known-merchant categorization | Rule table (substring match), applied for free |
| **Unknown**-merchant categorization | One Claude Haiku call, batched; result cached as a rule so it's never re-asked |

### Data sources
- **Copilot export** (recommended): `POST /api/import-copilot` with the raw CSV from
  Copilot's "Export your transactions." Full-replace import. See `src/lib/copilot-import.ts`.
  It handles the Copilot-specific quirks:
  - **Sign flip** — Copilot exports positive = expense; this app uses negative = expense.
  - **Parent categories** (~22) instead of the 138 child categories.
  - **Exclusions** — `type=internal transfer` and `excluded=true` rows are stored but
    kept out of totals. **Exception:** income rows are kept IN even when Copilot marks
    them excluded (this account excludes 100% of income), so Income/Net stay meaningful.
  - **Recurrings** come from Copilot's `recurring` column, not local detection.
- **Generic CSV**: headers `Date, Name/Merchant/Description, Amount[, Account]`, negative =
  expense. Idempotent (`POST /api/import`). See `src/lib/import.ts`.
- **Sample data**: `POST /api/seed`.

### Optional: model categorization
Auto-categorize first applies existing rules (free), then sends any remaining unknown
merchants to the model. To enable the model step, set an API key:

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env.local
```

Without a key, unknown merchants are simply left uncategorized (surfaced in the UI,
never silently faked).

## Layout
- `src/lib/` — db, core logic (deterministic), categorize (model), import, queries, seed
- `src/app/api/` — route handlers
- `src/app/*/page.tsx` — the four screens
- `src/components/` — Sidebar, Shell, Actions (import/categorize/seed/month picker)
