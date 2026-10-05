// Approved simplified Deduction-card rules. The card's displayed expenses are examples
// and are never deducted separately. The standard deduction is supplied by the caller
// (resolved from the tax-year configuration); nothing is hardcoded here.
const BELOW_X = new Set(["DED-001", "DED-002", "DED-003", "DED-004", "DED-005"]);
const ABOVE_X = new Set(["DED-006", "DED-007", "DED-008"]);
const TOTAL_ITEMIZED = new Set(["DED-009", "DED-010"]);

// Returns the total itemized deductions to compare with the standard deduction,
// or null when the card has no approved rule.
export function itemizedDeductionForCard(cardId: string, cardAmount: number, standardDeduction: number): number | null {
  if (BELOW_X.has(cardId)) return 0;
  if (ABOVE_X.has(cardId)) return Math.round((standardDeduction + cardAmount) * 100) / 100;
  if (TOTAL_ITEMIZED.has(cardId)) return cardAmount;
  return null;
}
