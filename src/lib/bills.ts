import type { RecurringForMonth } from "./queries";

// What a bill's row says about itself, in one place: the Recurrings page and
// the digests read a bill the same way. Types only from queries, so a client
// page can import this without pulling in the database.
type Bill = Pick<RecurringForMonth, "paid" | "dueDate" | "paidAmount" | "expectedAmount">;

// Paid, overdue (unpaid and due before today), or upcoming. `today` is an ISO date.
export function billStatus(r: Pick<Bill, "paid" | "dueDate">, today: string): "pd" | "od" | "up" {
  return r.paid ? "pd" : r.dueDate < today ? "od" : "up";
}

// A paid bill that came in at a different amount says by how much (paid −
// expected). Under 50 cents is rounding, not news.
export const BILL_DELTA_MIN = 0.5;
export function billDelta(r: Bill): number | null {
  return r.paid && r.paidAmount != null && Math.abs(r.paidAmount - r.expectedAmount) >= BILL_DELTA_MIN
    ? r.paidAmount - r.expectedAmount
    : null;
}

// The "edited" tag on a charge that is IN a plan marks a placement the plan's
// own amount doesn't explain (a $95 pinned into an $80 plan). A pinned charge
// at the plan's amount is where the detector would put it: in a plan the user
// started, every charge is pinned or gathered by amount, and tagging them all
// read as something wrong. A charge taken out is always the user's word.
export function placementEdited(pinned: boolean, amount: number, planAmount: number | null): boolean {
  if (!pinned) return false;
  if (planAmount == null) return true;
  const a = Math.abs(amount), p = Math.abs(planAmount);
  return Math.abs(a - p) > Math.max(0.5, 0.01 * p);
}
