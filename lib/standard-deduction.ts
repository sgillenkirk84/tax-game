// The approved dataset writes the annual standard deduction as a bare "X".
// Students see "$X*" with a shared explanation. The dataset itself is unchanged
// and no amount or tax year is chosen here; the backend substitutes the real value.
export const STANDARD_DEDUCTION_NOTE =
  "* $X represents the standard deduction for the tax year used in this game. The game substitutes that year's applicable dollar amount when calculating taxes.";

// Decks where X means the standard deduction. Other decks use X differently
// (for example the Child Tax Credit on Life Event cards), so they are not touched.
const STANDARD_DEDUCTION_DECKS = new Set(["Deduction", "Audit Result"]);

export function usesStandardDeductionPlaceholder(deck: string | null | undefined): boolean {
  return deck != null && STANDARD_DEDUCTION_DECKS.has(deck);
}

// Display only: turns a standalone X into $X*. Existing "$X" or "$X*" are left alone.
export function formatStandardDeduction(value: string | null, deck: string | null | undefined): string | null {
  if (value === null || !usesStandardDeductionPlaceholder(deck)) {
    return value;
  }
  return value.replace(/(?<![$\w])X\b(?!\*)/g, "$X*");
}

export function showsStandardDeduction(...values: (string | null | undefined)[]): boolean {
  return values.some((value) => typeof value === "string" && value.includes("$X*"));
}
