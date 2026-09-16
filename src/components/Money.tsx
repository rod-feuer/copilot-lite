import { usd } from "@/lib/format";

// The one way an amount is rendered as text. usd() owns the digits and the sign;
// this owns the colour, with one rule: an inflow is green only when it counts.
// A charge excluded from totals, or in a category excluded from totals (a card
// payment, a transfer), is money moving, not income — neutral. Before this,
// the dashboard applied that rule and the transactions row and shelf did not,
// so the same card payment read green in one place and neutral in another.
export function Money({
  value,
  sign = true,
  cents = true,
  excluded = false,
  className = "",
}: {
  value: number;
  sign?: boolean;
  cents?: boolean;
  excluded?: boolean; // row- or category-level "doesn't count"
  className?: string;
}) {
  const inflow = value >= 0 && !excluded;
  return (
    <span className={`tabular-nums ${inflow ? "text-[var(--good)]" : "text-[var(--foreground)]"} ${className}`.trim()}>
      {usd(value, { sign, cents })}
    </span>
  );
}
