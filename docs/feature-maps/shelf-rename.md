# Feature: rename a vendor from the shelf

## Intent
The user clicks a vendor's name in the shelf, types a new one, and leaves by any
route (Enter, clicking elsewhere, closing the shelf). The new name then shows
everywhere that vendor appears. Typing the bank's own name back clears the alias.

## Launch
- Throwaway app: `npm run test:ui` starts `next dev` on :3100 against a temp DB
  (never `data/copilot.db`). To poke by hand, run it with `UI_KEEP_DB=1` and
  start `COPILOT_DB_PATH=<kept path> npx next dev -p 3100`.
- Open `/recurrings`, click any `[data-drawer-row]`. The shelf is `aside.fixed`.

## Drive
1. Click `aside.fixed button[aria-label^='Rename ']`. An input takes focus.
2. Select all, type the new name.
3. Leave by one of: Enter; Escape (must revert); mousedown on a heading outside
   the shelf (closes the shelf and unmounts the input before blur).

## Evidence
- Enter or click-outside: a `[data-drawer-row]` on the page shows the new name
  without a reload, and the shelf is gone after click-outside.
- Escape: the old name remains, and no write lands.
- Automated: `scripts/test-ui.mjs`, group "inline edit" (the checks "Enter
  commits", "Escape reverts", and "clicking outside … still saves the rename").

## Cleanup
Nothing. The suite deletes its temp DB unless `UI_KEEP_DB` is set.

## Blast radius
- `src/components/InlineEdit.tsx` and `useCommitInput.ts`. Every rename in the
  app shares these, so a change here touches the categories and recurrings
  rows too.
- `src/components/shelf/MerchantShelf.tsx`, which maps the edit to an alias or null.
- `src/components/TransactionDrawer.tsx`, which owns the outside-mousedown close.
- The alias shows up through `merchantDisplayName()`. Check the transactions list and the dashboard's recent list.
