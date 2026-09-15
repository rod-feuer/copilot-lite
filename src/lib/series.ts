// One bank descriptor can carry more than one bill — Netflix on the 23rd and
// the 26th (one account per home), Sofi on the 1st (mortgage) and the 21st
// (loan), two 529 contributions of $200 and $300 on the 18th. The detector
// emits one recurring per bill and keys each as "<vendor> · <qualifier>". Settings, overrides, and aliases hang off that key;
// everything that needs the underlying vendor (the shelf, links, merge
// suggestions) resolves it through seriesVendor(). Import-free on purpose so
// both core.ts and queries.ts can use it without a cycle.
export const SERIES_SEP = " · ";

export function seriesKey(vendor: string, qualifier: string): string {
  return `${vendor}${SERIES_SEP}${qualifier}`;
}

// Qualifiers: the day of the month ("23rd") when plans differ by day; the
// amount ("$200") when two debits share a day; both when a vendor needs both.
export function dayLabel(dayOfMonth: number): string {
  return ordinal(dayOfMonth);
}
export function amountLabel(amount: number): string {
  const mag = Math.abs(amount);
  return "$" + (Number.isInteger(mag) ? mag.toLocaleString("en-US") : mag.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

export function isSeriesKey(merchant: string): boolean {
  return merchant.includes(SERIES_SEP);
}

export function seriesVendor(merchant: string): string {
  const i = merchant.indexOf(SERIES_SEP);
  return i < 0 ? merchant : merchant.slice(0, i);
}

function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

// A series keyed by amount ("In 529 Dir Ach Contrib · $200") in a row that
// already shows its amount: drop the amount qualifier, keep any day qualifier
// ("· 18th · $200" → "· 18th"). For display beside an amount column only.
export function withoutAmountQualifier(key: string): string {
  const i = key.indexOf(SERIES_SEP);
  if (i < 0) return key;
  const parts = key.slice(i + SERIES_SEP.length).split(SERIES_SEP).filter((q) => !q.startsWith("$"));
  return parts.length ? `${key.slice(0, i)}${SERIES_SEP}${parts.join(SERIES_SEP)}` : key.slice(0, i);
}
