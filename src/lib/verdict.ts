import { budgetOutlook } from "./budgetOutlook";
import { usd } from "./format";
import type { DashboardData } from "./core";

// One plain-language headline answering "how am I doing this month?" — so the
// dashboard leads with a verdict instead of three co-equal numbers. Leads with
// the budget (the user's own plan); for an in-progress month it speaks in pace
// terms and stays neutral until there's enough data to project. Falls back to
// cash flow when no budgets are set. Shared by the dashboard and the digests,
// so a message can never say something the screen doesn't.
export function buildVerdict(
  data: Pick<DashboardData, "budget" | "expenses" | "net">,
  isCurrentMonth: boolean
): { tone: "good" | "bad" | "neutral"; text: string } {
  const m = (n: number) => usd(Math.abs(n), { cents: false });
  const b = data.budget;
  if (b && b.total > 0) {
    // Only the judgement: the card's own caption says how much of the budget is
    // used, and the sentence with both wrapped to two lines.
    if (b.projected == null) return { tone: "neutral", text: "Too early to project the month" };
    // budgetOutlook is the one rule for over / under / on budget, including
    // what counts as "on".
    const o = budgetOutlook(b.total, b.projected, isCurrentMonth);
    const verb = isCurrentMonth ? "On pace to finish" : "Finished";
    if (o.kind === "over") return { tone: "bad", text: `${verb} ${m(o.delta)} over budget` };
    if (o.kind === "under") return { tone: "good", text: `${verb} ${m(o.delta)} under budget` };
    return { tone: "neutral", text: `${verb} on budget` };
  }
  // No budgets set — fall back to cash flow. Mid-month net is partial, so stay
  // factual rather than calling a verdict on an incomplete month.
  if (isCurrentMonth)
    return { tone: "neutral", text: `${m(data.expenses)} spent so far this month` };
  const net = Math.round(data.net);
  if (net >= 0) return { tone: "good", text: `Net positive — you kept ${m(net)} this month` };
  return { tone: "bad", text: `Net negative — you spent ${m(net)} more than you earned` };
}
