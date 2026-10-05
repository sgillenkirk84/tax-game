// Student-safe view of a persisted Round tax calculation. Only these summary
// fields ever leave the server; input snapshots, card history ids, pending
// effects and credit internals are deliberately not exposed.
export type TaxSummary = {
  grossIncome: number;
  adjustedGrossIncome: number;
  deductionMethod: "standard" | "itemized";
  standardDeduction: number;
  itemizedDeduction: number;
  deductionAmount: number;
  taxableIncome: number;
  taxBeforeCredits: number;
  creditsAvailable: number;
  creditsApplied: number;
  creditsUnused: number;
  finalTax: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const amount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// Returns null when the stored value is missing or malformed, so a caller never
// shows a partial or guessed result.
export function summarizeTaxCalculation(stored: unknown): TaxSummary | null {
  if (!isRecord(stored) || !isRecord(stored.round)) {
    return null;
  }
  const round = stored.round;
  const credits = isRecord(stored.credits) ? stored.credits : {};
  const method = round.deduction_method;

  const summary = {
    grossIncome: amount(round.gross_income),
    adjustedGrossIncome: amount(round.adjusted_gross_income),
    standardDeduction: amount(round.standard_deduction),
    itemizedDeduction: amount(round.eligible_itemized_deduction),
    deductionAmount: amount(round.deduction_amount),
    taxableIncome: amount(round.taxable_income),
    taxBeforeCredits: amount(round.tax_before_credits),
    creditsAvailable: amount(credits.available),
    creditsApplied: amount(credits.applied),
    creditsUnused: amount(credits.unused),
    finalTax: amount(round.final_tax_liability),
  };

  if ((method !== "standard" && method !== "itemized") || Object.values(summary).some((value) => value === null)) {
    return null;
  }
  return { ...(summary as Omit<TaxSummary, "deductionMethod">), deductionMethod: method };
}

const summaryKeys: Array<keyof TaxSummary> = [
  "grossIncome",
  "adjustedGrossIncome",
  "standardDeduction",
  "itemizedDeduction",
  "deductionAmount",
  "taxableIncome",
  "taxBeforeCredits",
  "creditsAvailable",
  "creditsApplied",
  "creditsUnused",
  "finalTax",
];

// Validates a summary received by the browser; unknown extra fields are dropped.
export function asTaxSummary(value: unknown): TaxSummary | null {
  if (!isRecord(value) || (value.deductionMethod !== "standard" && value.deductionMethod !== "itemized")) {
    return null;
  }
  const picked: Record<string, unknown> = { deductionMethod: value.deductionMethod };
  for (const key of summaryKeys) {
    const number = amount(value[key]);
    if (number === null) {
      return null;
    }
    picked[key] = number;
  }
  return picked as TaxSummary;
}

export const TAX_FRIENDLY_ERRORS = {
  unavailable: "Tax calculation is not available yet. Your teacher will let you know when it opens.",
  notReady: "Your round isn't ready to calculate yet. Make sure every card for this round is saved.",
  failed: "We couldn't calculate your taxes right now. Please try again in a moment.",
} as const;

// Maps a tax-calculate / tax-result HTTP outcome to student-friendly state.
// Server error text is never shown, and a retry keeps the same idempotency key
// only for failures where the request may have reached the server.
export function interpretTaxResponse(
  status: number,
  body: unknown,
): { kind: "success"; summary: TaxSummary } | { kind: "unavailable" | "error"; message: string; keepKey: boolean } {
  const summary = status >= 200 && status < 300 && isRecord(body) ? asTaxSummary(body.summary) : null;
  if (summary) {
    return { kind: "success", summary };
  }
  if (status === 404) {
    return { kind: "unavailable", message: TAX_FRIENDLY_ERRORS.unavailable, keepKey: true };
  }
  if (status === 409 || status === 422) {
    return { kind: "error", message: TAX_FRIENDLY_ERRORS.notReady, keepKey: false };
  }
  return { kind: "error", message: TAX_FRIENDLY_ERRORS.failed, keepKey: true };
}
