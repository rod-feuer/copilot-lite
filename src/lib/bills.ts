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
