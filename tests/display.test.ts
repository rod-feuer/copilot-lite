import { test } from "node:test";
import assert from "node:assert/strict";
import { displayMerchant } from "../src/lib/merchant";
import { withoutAmountQualifier, seriesKey, amountLabel, dayLabel } from "../src/lib/series";

// A payment rail is not the payee. "Zelle Payment To Rosy's Cleaning" is
// Rosy's Cleaning on screen; the stored merchant keeps the rail so grouping,
// links, and settings are unaffected.
test("displayMerchant strips a Zelle rail for display and nothing else", () => {
  assert.equal(displayMerchant("Zelle Payment To Rosy's Cleaning"), "Rosy's Cleaning");
  assert.equal(displayMerchant("Zelle Payment From Jane Doe"), "Jane Doe");
  assert.equal(displayMerchant("Plan Fee - Ticketmaster"), "Plan Fee - Ticketmaster", "a fee is meaningful, not a rail");
  assert.equal(displayMerchant("Netflix"), "Netflix");
  assert.equal(displayMerchant("Zelle Payment To "), "Zelle Payment To ", "never blank out a name");
  // The rail is stripped ahead of a series qualifier, so split series read cleanly too.
  assert.equal(displayMerchant(seriesKey("Zelle Payment To Rosy's Cleaning", amountLabel(240))), "Rosy's Cleaning · $240");
});

// Beside an amount column the amount qualifier is redundant; a day qualifier
// still tells two same-vendor plans apart.
test("withoutAmountQualifier drops only the amount part of a series key", () => {
  assert.equal(withoutAmountQualifier("In 529 Dir Ach Contrib · $200"), "In 529 Dir Ach Contrib");
  assert.equal(withoutAmountQualifier(seriesKey("Youtube Tv", `${dayLabel(28)} · ${amountLabel(9.99)}`)), "Youtube Tv · 28th");
  assert.equal(withoutAmountQualifier("Netflix · 23rd"), "Netflix · 23rd");
  assert.equal(withoutAmountQualifier("Netflix"), "Netflix");
});
