// How much spending outside any plan is still to come this month.
//
// The old rule was one line: this month's variable spend per day, times the days
// left. Backtested on 32 finished months of real data it missed the remaining
// spend by a median $7,500 at day 10 and $3,300 at day 20, because it treats a
// $975 Best Buy trip as $51 a day for the rest of the month.
//
// But large purchases are not rare events to be ignored either. In that data
// there were a median of three a month over $1,000, about $10,000 a month, 55%
// of all variable spend — dropping them under-forecast every month. They are a
// monthly amount that arrives in lumps. So the two are forecast separately:
//
//   everyday  — charges up to LARGE_CHARGE: this month's pace, times days left.
//   large     — the SMALLER of (a) the recent months' large-purchase pace for the
//               days left, and (b) what is left of a typical month's large
//               purchases after the ones already seen. (a) stops a quiet start
//               from promising a whole month's worth in the last week; (b)
//               stops a month that has already had its share from expecting
//               another.
//
// Same data, same months: median miss $3,600 at day 10, $1,900 at day 20, $1,100
// at day 25 — 45–55% better — with the bias near zero where the old rule ran
// $1,700–$2,800 off. Every line from $750 to $2,000 and window from 3 to 12
// months beat the old rule; $1,000 and six months are round numbers, not tuned.
//
// A charge over EXTRAORDINARY (a down payment, a tax bill) is neither
// extrapolated nor taught to the forecast: nothing predicts those.
export const LARGE_CHARGE = 1000;
export const EXTRAORDINARY = 20000;
export const HISTORY_MONTHS = 6;

export function variableStillToCome(input: {
  seen: number[]; // magnitudes of this month's charges outside any plan, so far
  daysElapsed: number;
  daysRemaining: number;
  history: { large: number; days: number }[]; // recent finished months: their large-purchase total, and length
}): number {
  const { seen, daysElapsed, daysRemaining, history } = input;
  if (daysElapsed <= 0 || daysRemaining <= 0) return 0;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const everyday = (sum(seen.filter((x) => x <= LARGE_CHARGE)) / daysElapsed) * daysRemaining;
  const largeSeen = sum(seen.filter((x) => x > LARGE_CHARGE && x <= EXTRAORDINARY));
  // No history to lean on (a new database): the old rule, for the large ones too.
  if (history.length === 0) return everyday + (largeSeen / daysElapsed) * daysRemaining;
  const typicalMonth = sum(history.map((h) => h.large)) / history.length;
  const typicalPace = sum(history.map((h) => h.large / h.days)) / history.length;
  return everyday + Math.min(typicalPace * daysRemaining, Math.max(0, typicalMonth - largeSeen));
}
