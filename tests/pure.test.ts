import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMerchant } from "../src/lib/merchant";
import { classifyCadence, addCadence, txHash } from "../src/lib/core";
import { canonicalMerchant } from "../src/lib/queries";

test("normalizeMerchant strips wallet prefixes, ids, dates; title-cases", () => {
  assert.equal(normalizeMerchant("Aplpay Target"), "Target");
  // Any short "LETTERS*" payment-gateway prefix, spaced or glued.
  assert.equal(normalizeMerchant("Mdc*south Central Indiana"), "South Central Indiana");
  assert.equal(normalizeMerchant("Sub*washpost"), "Washpost");
  assert.equal(normalizeMerchant("Ic* Instacart"), "Instacart");
  assert.equal(normalizeMerchant("McDonald's"), "Mcdonald's"); // "Mc" (no *) is not a prefix
  assert.equal(normalizeMerchant("Paypal Inst Xfer Pypl"), "Inst Xfer Pypl"); // word prefix, no *
  assert.equal(
    normalizeMerchant("JPMORGAN CHASE CHASE ACH PPD ID: 1000008113"),
    "Jpmorgan Chase Chase Ach"
  );
  assert.equal(
    normalizeMerchant("Payment to Chase card ending in 2601 06/01"),
    "Payment To Chase Card"
  );
});

test("normalizeMerchant keeps possessives readable and is idempotent", () => {
  assert.equal(normalizeMerchant("McDonald's"), "Mcdonald's");
  assert.equal(normalizeMerchant("MCDONALD'S"), "Mcdonald's");
  for (const m of ["Aplpay Culvers Of Frfranklin In", "Sofi Lending Loan Paymt", "DSW"]) {
    assert.equal(normalizeMerchant(normalizeMerchant(m)), normalizeMerchant(m));
  }
});

test("normalizeMerchant strips a bare trailing ACH channel code, keeps real words", () => {
  // The lone trailing marker is payment-rail noise, not part of the name.
  assert.equal(normalizeMerchant("CARMELCLERKTREAS WATER BILL TEL"), "Carmelclerktreas Water Bill");
  assert.equal(normalizeMerchant("Payment Thank You - Web"), "Payment Thank You");
  // Meaningful words that merely look like codes must survive.
  assert.equal(normalizeMerchant("JPMORGAN CHASE CHASE ACH"), "Jpmorgan Chase Chase Ach");
  assert.equal(normalizeMerchant("Payment to Chase Card"), "Payment To Chase Card");
  // Stacked codes all go, and the result is still idempotent.
  assert.equal(normalizeMerchant("Acme Bill Web Tel"), "Acme Bill");
  assert.equal(normalizeMerchant(normalizeMerchant("Acme Bill Web Tel")), "Acme Bill");
});

test("classifyCadence buckets gaps, rejects off-cadence", () => {
  assert.equal(classifyCadence(7), "weekly");
  assert.equal(classifyCadence(14), "biweekly");
  assert.equal(classifyCadence(30), "monthly");
  assert.equal(classifyCadence(91), "quarterly");
  assert.equal(classifyCadence(182), "semiannual");
  assert.equal(classifyCadence(365), "yearly");
  assert.equal(classifyCadence(50), null); // ~7 weeks: not a recognized cadence
});

test("addCadence advances by the cadence period (UTC)", () => {
  assert.equal(addCadence("2026-01-01", "weekly"), "2026-01-08");
  assert.equal(addCadence("2026-01-01", "monthly"), "2026-02-01");
  assert.equal(addCadence("2026-01-01", "quarterly"), "2026-04-01");
  assert.equal(addCadence("2026-01-01", "semiannual"), "2026-07-01");
  assert.equal(addCadence("2026-01-01", "yearly"), "2027-01-01");
});

test("canonicalMerchant follows the link chain (cycle-safe)", () => {
  assert.equal(canonicalMerchant("A", { A: "B" }), "B");
  assert.equal(canonicalMerchant("B", { A: "B" }), "B");
  assert.equal(canonicalMerchant("A", { A: "B", B: "C" }), "C"); // chain flattens
  assert.equal(canonicalMerchant("X", { X: "X" }), "X"); // self-link doesn't loop
  assert.equal(canonicalMerchant("Z", {}), "Z");
});

test("txHash is stable and case-insensitive on merchant", () => {
  const a = txHash("2026-01-01", "Foo", -10, "Checking");
  assert.equal(a, txHash("2026-01-01", "foo", -10, "Checking"));
  assert.notEqual(a, txHash("2026-01-01", "Foo", -11, "Checking"));
});
