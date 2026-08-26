// Clock shim for `npm run test:clock` — preloaded ahead of the test files so the
// suite runs against a wall clock shifted SHIFT_DAYS into the future.
//
// Why this exists: a test that pins its fixture to absolute dates ("2026-03-10")
// while asserting now-relative behaviour passes on the day it is written and
// fails months later on a date nobody chose. That is exactly how the
// ended-subscription invariant broke — its last charge aged past the ~50-day
// window isRecurringActive() allows a monthly bill, two months after it landed.
//
// Only the zero-argument forms are shifted. `new Date("2025-06-15")` must keep
// meaning that date, or every fixture in the suite would slide with the clock
// and nothing would be tested at all.
const SHIFT = Number(process.env.SHIFT_DAYS || 0) * 86_400_000;
const Real = Date;

class Shifted extends Real {
  constructor(...args) {
    if (args.length === 0) super(Real.now() + SHIFT);
    else super(...args);
  }
  static now() {
    return Real.now() + SHIFT;
  }
}

globalThis.Date = Shifted;
