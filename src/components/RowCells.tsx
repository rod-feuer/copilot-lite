"use client";

import { usd } from "@/lib/format";
import { Money } from "@/components/Money";
import { NEW_CATEGORY, NewCategoryOption } from "@/components/NewCategoryOption";
import type { Category } from "@/lib/types";

// The cells every list row shares (DESIGN.md §2, "Row anatomy"). Three rows
// carry them — the Transactions row, the Recurrings row, the shelf row — and
// they differ in what leads (a glyph where the vendor is the subject, a date
// where time is) and in their editors, so the anatomy is shared as cells,
// not as one wrapper that would have to know every editor.

// The category as a quiet property: icon + name in the muted text colour, a
// chevron beside it (a visible affordance), and the real native <select> laid
// transparently over the label — still native, still keyboard. No tint: the
// row's badge already carries the category's colour where there is one.
// Before, Transactions drew the same control as a tinted pill on desktop and
// a chip on a phone, and the category shelf as a ⋯ menu.
export function CategoryProperty({
  categoryId,
  categoryName,
  categoryIcon,
  cats,
  onChange,
  onNewCategory,
  active = true,
  onActivate,
  onDeactivate,
  ariaLabel = "Category",
  className = "",
}: {
  categoryId: number | null;
  categoryName: string | null;
  categoryIcon: string | null;
  cats: Category[];
  onChange: (categoryId: number | null) => void;
  onNewCategory?: (anchor: HTMLSelectElement) => void; // "+ New category…" in the list
  // Long lists mount the full option list only while the control is in use.
  active?: boolean;
  onActivate?: () => void;
  onDeactivate?: () => void;
  ariaLabel?: string;
  className?: string;
}) {
  const set = categoryId != null;
  const label = set ? `${categoryIcon ?? ""} ${categoryName ?? ""}`.trim() : "Uncategorized";
  return (
    <span
      data-category-property
      className={`group/cat relative inline-flex max-w-full items-center gap-1 rounded-lg py-1 pl-2 pr-1 text-xs text-[var(--muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]/40 ${className}`}
    >
      <span className={`truncate ${set ? "" : "italic"}`}>{label}</span>
      <svg
        data-category-caret
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
        aria-hidden
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
      <select
        value={categoryId ?? ""}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={onActivate}
        onFocus={onActivate}
        onBlur={onDeactivate}
        onChange={(e) => {
          if (e.target.value === NEW_CATEGORY) {
            onNewCategory?.(e.currentTarget);
            return;
          }
          onChange(e.target.value ? Number(e.target.value) : null);
        }}
        aria-label={ariaLabel}
        className="tap-native absolute inset-0 w-full cursor-pointer opacity-0"
      >
        {active ? (
          <>
            <option value="">Uncategorized</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon} {c.name}
              </option>
            ))}
            {onNewCategory && <NewCategoryOption />}
          </>
        ) : set ? (
          <option value={categoryId as number}>{label}</option>
        ) : (
          <option value="">Uncategorized</option>
        )}
      </select>
    </span>
  );
}

// The amount says what kind of number it is: settled (a posted charge: 600,
// foreground — green only for an inflow that counts), provisional (an expected
// one: 500, muted — the app's qualifier colour), overdue (600, warn). A paid
// row that differed from its expected shows the difference — the one fact a
// paid row can tell you that you didn't already know.
export type AmountState = "settled" | "provisional" | "overdue";
export function AmountCell({
  value,
  state = "settled",
  excluded = false,
  delta = null,
  unsigned = false,
  sign = true,
  quiet = false,
  className = "",
}: {
  value: number;
  state?: AmountState;
  excluded?: boolean; // doesn't count toward totals → an inflow is not green
  delta?: number | null; // paid − expected, when it differs
  unsigned?: boolean; // a bill's amount: magnitude only — no sign, and never green
  sign?: boolean;
  quiet?: boolean; // a list where every amount is settled: medium, not semibold
  className?: string;
}) {
  const shown = unsigned ? Math.abs(value) : value;
  const tone =
    state === "overdue"
      ? "font-semibold text-[var(--warn)]"
      : state === "provisional"
        ? "font-medium text-[var(--muted)]"
        : quiet
          ? "font-medium"
          : "font-semibold";
  return (
    // An amount never wraps: the line-breaker treats the minus and the dollar
    // sign as two prefixes and may break between them ("−" / "$12,748.12").
    <span data-amount-state={state} className={`inline-flex items-baseline justify-end whitespace-nowrap tabular-nums ${tone} ${className}`}>
      {delta != null && (
        <span className="mr-2 text-[11px] font-medium text-[var(--muted)]">
          {delta > 0 ? "+" : "−"}
          {usd(Math.abs(delta))}
        </span>
      )}
      {state === "settled" && !unsigned ? (
        <Money value={shown} sign={sign} excluded={excluded} />
      ) : (
        <span className={state === "settled" ? "text-[var(--foreground)]" : ""}>{usd(shown, { sign: sign && !unsigned })}</span>
      )}
    </span>
  );
}
