import type { RecurringForMonth } from "./queries";

// What a bill's row says about itself, in one place: the Recurrings page and
// the digests read a bill the same way. Types only from queries, so a client
// page can import this without pulling in the database.
type Bill = Pick<RecurringForMonth, "paid" | "dueDate" | "paidAmount" | "expectedAmount" | "cadence" | "paidTimes">;

// Paid, overdue (unpaid and due before today), or upcoming. `today` is an ISO date.
export function billStatus(r: Pick<Bill, "paid" | "dueDate">, today: string): "pd" | "od" | "up" {
  return r.paid ? "pd" : r.dueDate < today ? "od" : "up";
}

// A plan charged every week or two is paid more than once a month, and its
// paid amount is the month's sum of those charges.
export function chargedOften(r: Pick<Bill, "cadence">): boolean {
  return r.cadence === "weekly" || r.cadence === "biweekly";
}

// A paid bill that came in at a different amount says by how much (paid −
// expected). Under 50 cents is rounding, not news. A plan charged often is
// held to its expected amount once per charge: Pay In 4's two $369.65
// charges read "+$369.65" against one.
export const BILL_DELTA_MIN = 0.5;
export function billDelta(r: Bill): number | null {
  if (!r.paid || r.paidAmount == null) return null;
  const expected = chargedOften(r) ? r.expectedAmount * r.paidTimes : r.expectedAmount;
  return Math.abs(r.paidAmount - expected) >= BILL_DELTA_MIN ? r.paidAmount - expected : null;
}
