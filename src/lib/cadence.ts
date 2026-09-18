// The one cadence table. Every place that converts a cadence to a period, an
// annual multiple, or a per-month share reads from here — a cadence the detector
// can emit but a consumer's table lacks silently falls back to the wrong factor
// (quarterly bills were once counted at 12× their real monthly cost).
import type { Recurring } from "./types";

export type Cadence = Recurring["cadence"];

// Approximate days between charges.
export const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  bimonthly: 61, // every two months — a subscription that moved from monthly to a two-month plan
  quarterly: 91,
  semiannual: 182,
  yearly: 365,
};

// Charges per year.
export const PER_YEAR: Record<Cadence, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
  semiannual: 2,
  yearly: 1,
};

// Share of one charge that lands in a typical month. Unknown cadence → monthly.
export function monthlyFactor(cadence: string): number {
  return (PER_YEAR[cadence as Cadence] ?? 12) / 12;
}

// Median gap, not mean — robust to missing occurrences. A skipped month, or a
// payment that landed under a drifted descriptor, would otherwise inflate the
// mean gap and push a genuine monthly bill out of the cadence window. Even
// counts average the two middles; the detector and the suggester must agree.
export function medianGap(gaps: number[]): number {
  if (gaps.length === 0) return 0;
  const s = [...gaps].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
