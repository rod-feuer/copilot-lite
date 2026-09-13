// One bank descriptor can carry more than one bill — Netflix on the 23rd and
// the 26th (one account per home), Sofi on the 1st (mortgage) and the 21st
// (loan). The detector emits one recurring per bill and keys the extra series
// as "<vendor> · <day>". Settings, overrides, and aliases hang off that key;
// everything that needs the underlying vendor (the shelf, links, merge
// suggestions) resolves it through seriesVendor(). Import-free on purpose so
// both core.ts and queries.ts can use it without a cycle.
export const SERIES_SEP = " · ";

export function seriesKey(vendor: string, dayOfMonth: number): string {
  return `${vendor}${SERIES_SEP}${ordinal(dayOfMonth)}`;
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
