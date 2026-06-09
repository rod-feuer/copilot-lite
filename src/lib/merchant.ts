// Conservative canonicalization of bank-descriptor merchant strings, applied at
// import time. The same real merchant arrives under many descriptors — case
// drift ("JPMORGAN…" vs "Jpmorgan…"), wallet prefixes ("Aplpay …"), and
// volatile per-transaction junk (ACH/PPD reference ids, card "ending in 1234",
// dates, store/account numbers). This strips that noise and standardizes case so
// one merchant lands on one stable string, which lets exact-merchant grouping
// (recurring detection, paid-matching) actually work.
//
// Deliberately conservative: it removes obvious junk, never meaningful words, so
// intentionally-distinct merchants (e.g. "Edelman Payments" vs "Edelman
// Payroll") stay separate. The original descriptor is preserved in
// transactions.rawMerchant, so this is fully reversible. Idempotent:
// normalizeMerchant(normalizeMerchant(x)) === normalizeMerchant(x).
export function normalizeMerchant(raw: string): string {
  const original = (raw ?? "").trim();
  let s = original;

  // Leading wallet / processor prefixes (may stack, e.g. "Aplpay Sp Rothys").
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/^(aplpay|sq ?\*|tst\*?|pp\*|paypal ?\*?|gpc\*?)\s+/i, "");
    if (next === s) break;
    s = next;
  }

  // Volatile suffixes / embedded reference data:
  s = s.replace(/\b(ppd|ccd|web|tel|arc|ipp)\s*id:?.*$/i, ""); // ACH ref-id blocks
  s = s.replace(/\bending in\b.*$/i, ""); // card "ending in 2601 06/01"
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " "); // dates mm/dd(/yy)
  s = s.replace(/\b\d{4,}\b/g, " "); // long digit runs (account/store/ref numbers)

  // Bare trailing ACH channel-code token, e.g. "…Water Bill Tel" or "Payment
  // Thank You Web". The id-form ("tel id: …") is handled above; this catches the
  // lone marker left at the end. Looped so stacked codes ("… Web Tel") all go,
  // which keeps the function idempotent.
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/[\s\-]+(ppd|ccd|web|tel|arc|ipp)\b\s*$/i, "");
    if (next === s) break;
    s = next;
  }

  // Tidy: collapse whitespace, drop dangling separators.
  s = s.replace(/\s{2,}/g, " ").replace(/[\s,#*:.\-]+$/g, "").trim();

  return canonCase(s || original); // never blank out a merchant
}

// Title-case at word starts only (not after apostrophes/hyphens, so "Mcdonald's"
// and "Chick-fil-a" stay readable) so mixed-case variants of one merchant unify.
function canonCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)([a-z])/g, (_, b, c) => b + c.toUpperCase());
}
