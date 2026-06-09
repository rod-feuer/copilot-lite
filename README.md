# Copilot Lite

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38BDF8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)](https://github.com/WiseLibs/better-sqlite3)

A simplified, local-only personal finance dashboard — a stripped-down Copilot Money
clone with four screens: **Dashboard, Transactions, Categories, Recurrings**.

Built with Next.js 16 + Tailwind v4 + SQLite (better-sqlite3). All data stays on
your machine in `data/copilot.db` (gitignored) — nothing is sent anywhere except the
optional Claude categorization call (see below).

## Prerequisites

- **Node 20+** (tested on Node 24). `better-sqlite3` is a native module, so a working
  C/C++ toolchain is needed — preinstalled on macOS (Xcode CLT) and most Linux setups.
- macOS or Linux. (Windows should work via WSL.)

## Setup

```bash
git clone https://github.com/rod-feuer/copilot-lite.git
cd copilot-lite
npm install
npm run dev            # http://localhost:3000
```

The SQLite database is created automatically on first run under `data/`. To populate
it, open the app and either:

- click **Load sample data** (≈6 months of realistic transactions), or
- click **Import CSV** (see [Data sources](#data-sources)).

No environment variables are required for the core app — everything above works offline.

## Environment variables

All optional. Put them in a `.env.local` file at the repo root (gitignored).

| Variable | Used for | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Auto-categorize** — sends only genuinely unknown merchants to Claude (see below). Without it, unknowns stay uncategorized. | unset |
| `PLAID_CLI_PATH` | **Sync from bank** — path to a `plaid` CLI binary that emits the expected JSON (advanced; the sync shells out to it). | `plaid` on `PATH` |
| `COPILOT_DB_PATH` | Override the SQLite file location. Tests set this to a throwaway file so they never touch `data/copilot.db`. | `data/copilot.db` |

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env.local
```

## Scripts

```bash
npm run dev      # start the dev server (http://localhost:3000)
npm run build    # production build
npm start        # serve the production build
npm run lint     # eslint
npm test         # node:test suite (uses a temp DB via COPILOT_DB_PATH)
npm run smoke    # load every page/route in a real browser and assert no errors
                 # (requires the dev server running + Chrome)
```

## Design principle: code does the math, the model only judges

Per the project's CLAUDE.md (Rule 5), deterministic work is plain code; the model is
used for exactly one thing — classifying a *genuinely unseen* merchant into a category.

| Concern | How it's done |
|---|---|
| Dedupe, import, dashboard totals, cash-flow | Deterministic code (`src/lib/core.ts`) |
| Recurring detection (3+ regular, similar-amount charges) | Deterministic pattern match — **not** the model |
| Known-merchant categorization | Rule table (substring match), applied for free |
| **Unknown**-merchant categorization | One Claude Haiku call, batched; result cached as a rule so it's never re-asked |

Without an `ANTHROPIC_API_KEY`, unknown merchants are simply left uncategorized
(surfaced in the UI, never silently faked).

## Data sources

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

## Maintenance actions

- **Auto-categorize** — applies rules (free), then optionally the model for unknowns.
- **Clean up names** (Recurrings / Transactions) — re-tidies merchant names from their
  preserved original bank descriptors after the normalizer improves. Reversible via
  **Undo cleanup**; the original descriptor is kept in `rawMerchant`.
- **Re-scan** (Recurrings) — rebuilds recurring detection.

## Layout

- `src/lib/` — db, core logic (deterministic), categorize (model), import, queries, seed
- `src/app/api/` — route handlers
- `src/app/*/page.tsx` — the four screens
- `src/components/` — Sidebar, Shell, Actions (import/categorize/seed/month picker), shelf
- `tests/` — `node:test` suite (run with `npm test`)
