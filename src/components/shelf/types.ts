import type { CategorySummary, MatchRule, MerchantSummary } from "@/lib/queries";
import type { Category } from "@/lib/types";

export type Cat = Category;
export type Vendor = { merchant: string; displayName: string };
export type Summary = MerchantSummary;
export type CatSummary = CategorySummary;
export type { MatchRule };

export type SettingsPatch = {
  alias?: string | null;
  expectedAmount?: number | null;
  cadence?: string | null;
  endedDate?: string | null;
  nextDate?: string | null;
  matchMode?: "exact" | "contains" | null;
  matchText?: string | null;
  amountTolerance?: number | null;
  clear?: boolean;
};
