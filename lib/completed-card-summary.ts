import type { CardCategory } from "@/lib/card-entry";

export type CompactCardAmount = {
  label: string;
  note?: string;
};

export function compactCardAmount(
  category: CardCategory,
  amount: number | null,
  pathwayId: string,
): CompactCardAmount | null {
  if (amount === null || category === "Wildcard" || category === "Life Event" || category === "Tax Prepayment") {
    return null;
  }
  if (category === "Income" && pathwayId === "PATH-001") {
    return null;
  }
  if (category === "Retirement") {
    return { label: "Retirement card amount" };
  }
  if (category === "Deduction") {
    return { label: "Card amount", note: "This is not necessarily the deduction used." };
  }
  return { label: "Card amount" };
}
