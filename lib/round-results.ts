// Round Results reconciliation. Pure and deterministic: every amount is derived
// from values the database has already saved (gross income, AGI, final tax,
// fixed Tax Prepayment, opening cash and debt, pending card effects). The
// database re-derives and verifies the same numbers before it finalizes, so the
// browser never supplies or influences an amount.
import { calculateProgressiveLivingCosts, reconcileRoundResources } from "./game-calculations/calculations.ts";

export type RoundResultsInput = {
  beginningCash: number;
  beginningDebt: number;
  // Actual (economic) gross income: the income cash inflow. The database supplies the
  // saved gross income plus any WILD-004 tax-only business reduction (see
  // economicGrossIncome). AGI only drives living costs.
  grossIncome: number;
  adjustedGrossIncome: number;
  finalTax: number;
  fixedPrepayment: number;
  // Saved calculation_details.tax_calculation.pending_effects.
  pendingEffects: unknown;
};

export type RoundResultsBreakdown = {
  beginningCash: number;
  grossIncome: number;
  otherCashInflows: number;
  livingCosts: number;
  personalExpenses: number;
  calculatedTax: number;
  taxPrepaid: number;
  taxRefund: number;
  taxAmountDue: number;
  // Audit is intentionally omitted from the current flow.
  auditPenalty: 0;
  beginningDebt: number;
  studentLoanPayment: number;
  endingDebt: number;
  endingCash: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// WILD-003 is an other cash inflow and WILD-004 a personal expense. Anything
// else in the saved list is ignored, and malformed known entries are rejected.
export function pendingCashEffects(
  pendingEffects: unknown,
): { otherCashInflows: number; personalExpenses: number; businessIncomeReduction: number } {
  if (!Array.isArray(pendingEffects)) {
    throw new RangeError("Pending effects must be a list.");
  }
  let otherCashInflows = 0;
  let personalExpenses = 0;
  let businessIncomeReduction = 0;
  for (const entry of pendingEffects) {
    if (!isRecord(entry)) {
      throw new RangeError("Pending effect is malformed.");
    }
    const delta = entry.cash_delta;
    if (entry.source_card_id === "WILD-003" && entry.type === "cash-increase") {
      if (typeof delta !== "number" || !Number.isFinite(delta) || delta < 0) {
        throw new RangeError("WILD-003 cash effect is malformed.");
      }
      otherCashInflows += delta;
    } else if (entry.source_card_id === "WILD-004" && entry.type === "cash-expense") {
      if (typeof delta !== "number" || !Number.isFinite(delta) || delta > 0) {
        throw new RangeError("WILD-004 cash effect is malformed.");
      }
      personalExpenses += -delta;
      const reduction = entry.business_income_reduction ?? 0;
      if (typeof reduction !== "number" || !Number.isFinite(reduction) || reduction < 0 || reduction > -delta) {
        throw new RangeError("WILD-004 business income reduction is malformed.");
      }
      businessIncomeReduction += reduction;
    }
  }
  return { otherCashInflows, personalExpenses, businessIncomeReduction };
}

// The saved gross income is already reduced by WILD-004's business treatment, which
// is a tax-only adjustment. Cash uses the actual income, so the reduction is added
// back and the one $5,000 expense is then charged exactly once.
export function economicGrossIncome(savedGrossIncome: number, pendingEffects: unknown): number {
  return savedGrossIncome + pendingCashEffects(pendingEffects).businessIncomeReduction;
}

export function computeRoundResults(input: RoundResultsInput): RoundResultsBreakdown {
  const { otherCashInflows, personalExpenses } = pendingCashEffects(input.pendingEffects);
  const livingCosts = calculateProgressiveLivingCosts(input.adjustedGrossIncome);
  const reconciled = reconcileRoundResources({
    beginningCash: input.beginningCash,
    outstandingDebt: input.beginningDebt,
    incomeCashInflows: input.grossIncome,
    otherCashInflows,
    livingCosts,
    personalExpenses,
    fixedTaxPrepayment: input.fixedPrepayment,
    finalTaxLiability: input.finalTax,
    auditPenalty: 0,
  });
  return {
    beginningCash: reconciled.beginningCash,
    grossIncome: reconciled.incomeCashInflows,
    otherCashInflows: reconciled.otherCashInflows,
    livingCosts: reconciled.livingCosts,
    personalExpenses: reconciled.personalExpenses,
    calculatedTax: input.finalTax,
    taxPrepaid: reconciled.taxPrepaymentOutflow,
    taxRefund: reconciled.taxRefund,
    taxAmountDue: reconciled.taxAmountDue,
    auditPenalty: 0,
    beginningDebt: input.beginningDebt,
    studentLoanPayment: reconciled.debtPrincipalPayment,
    endingDebt: reconciled.endingDebt,
    endingCash: reconciled.endingCash,
  };
}

// The exact keys the database re-derives and compares before finalizing.
export function toFinalizePayload(results: RoundResultsBreakdown): Record<string, number> {
  return {
    other_cash_inflows: results.otherCashInflows,
    living_costs: results.livingCosts,
    personal_expenses: results.personalExpenses,
    tax_refund: results.taxRefund,
    tax_amount_due: results.taxAmountDue,
    audit_penalty: results.auditPenalty,
    student_loan_payment: results.studentLoanPayment,
    ending_student_loan_debt: results.endingDebt,
    ending_cash: results.endingCash,
  };
}

// Student-safe view of the stored calculation_details.results.
export type StoredResults = {
  pathwayId: string;
  scenarioId: string;
  roundNumber: number;
  grossIncome: number;
  otherCashInflows: number;
  livingCosts: number;
  personalExpenses: number;
  calculatedTax: number;
  taxPrepaid: number;
  taxRefund: number;
  taxAmountDue: number;
  studentLoanPayment: number;
  beginningCash: number;
  endingCash: number;
  endingDebt: number;
  filingStatus: string;
  homeowner: boolean;
  activeDependents: number;
  details: {
    adjustedGrossIncome: number;
    deductionAmount: number;
    deductionMethod: "standard" | "itemized";
    taxableIncome: number;
    taxBeforeCredits: number;
    creditsApplied: number;
    prepaymentRatePct: number;
    beginningDebt: number;
    investmentIncome: number;
    investmentAssetValue: number;
    auditPenalty: number;
    auditResolution: "not-triggered" | "bypassed-beta";
  } | null;
  cards: { stage: string; cardId: string }[];
};

export function resultsAvailableForRound(round: number, maxEnabledRound: number): boolean {
  return Number.isInteger(round) && round >= 1 && round <= 3 && round <= maxEnabledRound;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function summarizeStoredResults(stored: unknown): StoredResults | null {
  if (!isRecord(stored) || !isRecord(stored.results)) {
    return null;
  }
  const r = stored.results;
  const cards = Array.isArray(stored.cards) ? stored.cards : null;
  const numbers = {
    grossIncome: num(r.gross_income),
    otherCashInflows: num(r.other_cash_inflows),
    livingCosts: num(r.living_costs),
    personalExpenses: num(r.personal_expenses),
    calculatedTax: num(r.calculated_tax),
    taxPrepaid: num(r.tax_prepaid),
    taxRefund: num(r.tax_refund),
    taxAmountDue: num(r.tax_amount_due),
    studentLoanPayment: num(r.student_loan_payment),
    beginningCash: num(r.beginning_cash),
    endingCash: num(r.ending_cash),
    endingDebt: num(r.ending_student_loan_debt),
    activeDependents: num(r.active_dependents),
    roundNumber: num(stored.round_number),
  };
  if (
    Object.values(numbers).some((value) => value === null) ||
    typeof r.pathway_id !== "string" ||
    typeof r.scenario_id !== "string" ||
    typeof r.filing_status !== "string" ||
    typeof r.homeowner !== "boolean" ||
    !cards
  ) {
    return null;
  }
  let details: StoredResults["details"] = null;
  if (r.version === 2) {
    const values = {
      adjustedGrossIncome: num(r.adjusted_gross_income),
      deductionAmount: num(r.deduction_amount),
      taxableIncome: num(r.taxable_income),
      taxBeforeCredits: num(r.tax_before_credits),
      creditsApplied: num(r.credits_applied),
      prepaymentRatePct: num(r.prepayment_rate_pct),
      beginningDebt: num(r.beginning_student_loan_debt),
      investmentIncome: num(r.investment_income),
      investmentAssetValue: num(r.investment_asset_value),
      auditPenalty: num(r.audit_penalty),
    };
    if (
      Object.values(values).some((value) => value === null || value < 0) ||
      (r.deduction_method !== "standard" && r.deduction_method !== "itemized") ||
      (r.audit_resolution !== "not-triggered" && r.audit_resolution !== "bypassed-beta")
    ) {
      return null;
    }
    details = {
      ...(values as { [K in keyof typeof values]: number }),
      deductionMethod: r.deduction_method,
      auditResolution: r.audit_resolution,
    };
  }
  return {
    ...(numbers as { [K in keyof typeof numbers]: number }),
    pathwayId: r.pathway_id,
    scenarioId: r.scenario_id,
    filingStatus: r.filing_status,
    homeowner: r.homeowner,
    details,
    cards: cards.flatMap((card) =>
      isRecord(card) && typeof card.stage === "string" && typeof card.card_id === "string"
        ? [{ stage: card.stage, cardId: card.card_id }]
        : [],
    ),
  };
}
