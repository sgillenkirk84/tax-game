// Tax Prepayment rules for the client and tests. The database (mm_card_catalog,
// mm_fix_round_prepayment) is the authority: it stores the rates and fixes the
// prepayment. This module mirrors the approved rates so tests can prove they
// agree with the game data and the migration, and it shapes the student-safe
// view of the stored prepayment. It never decides or stores an amount.

// Whole-percent rate for each approved Tax Prepayment card.
export const PREPAYMENT_RATES_PCT: Readonly<Record<string, number>> = {
  "PRE-001": 40,
  "PRE-002": 60,
  "PRE-003": 80,
  "PRE-004": 90,
  "PRE-005": 100,
  "PRE-006": 105,
  "PRE-007": 115,
  "PRE-008": 130,
  "PRE-009": 100,
  "PRE-010": 0,
};

export const CORPORATE_CLIMBER_PATHWAY_ID = "PATH-001";
// A Corporate Climber may redraw once when the first card's rate is below this.
export const REDRAW_THRESHOLD_PCT = 90;
// Entrepreneur and Side Hustler get an educational note; their arithmetic is unchanged.
const ESTIMATED_PAYMENT_PATHWAYS = ["PATH-002", "PATH-006"];

// Prepayment = income tax before credits x rate, rounded to the nearest whole dollar with
// halves rounding up. Integer cents avoid floating-point drift.
export function calculatePrepaymentDollars(taxBeforeCredits: number, ratePct: number): number {
  if (!Number.isFinite(taxBeforeCredits) || taxBeforeCredits < 0 || !Number.isFinite(ratePct) || ratePct < 0) {
    throw new RangeError("Tax and rate must be finite and non-negative.");
  }
  return Math.floor((Math.round(taxBeforeCredits * 100) * ratePct + 5000) / 10000);
}

export type SettlementPreview = { kind: "refund" | "due" | "settled"; amount: number };

// Display-only: derived from the two saved values and never stored.
export function settlementPreview(calculatedTax: number, prepaidAmount: number): SettlementPreview {
  if (!Number.isFinite(calculatedTax) || !Number.isFinite(prepaidAmount)) {
    throw new RangeError("Tax and prepaid amount must be finite.");
  }
  const result = prepaidAmount - calculatedTax;
  if (result > 0) {
    return { kind: "refund", amount: result };
  }
  if (result < 0) {
    return { kind: "due", amount: -result };
  }
  return { kind: "settled", amount: 0 };
}

export function canRedraw(pathwayId: string, firstRatePct: number): boolean {
  return pathwayId === CORPORATE_CLIMBER_PATHWAY_ID && firstRatePct < REDRAW_THRESHOLD_PCT;
}

export type PrepaymentCard = { cardId: string; ratePct: number };

export type PrepaymentState = {
  // none: no card yet. provisional: a Corporate Climber's first card is waiting
  // for keep or redraw. fixed: the prepayment is locked.
  status: "none" | "provisional" | "fixed";
  calculatedTax: number | null;
  taxBeforeCredits: number | null;
  creditsApplied: number | null;
  cards: PrepaymentCard[];
  redrawEligible: boolean;
  fixed: {
    cardId: string;
    ratePct: number;
    prepaidAmount: number;
    redrawUsed: boolean;
    firstCardId: string | null;
    calculationBase: "income-tax-before-credits" | "legacy-final-tax";
    baseAmount: number | null;
  } | null;
  showEstimatedPaymentNote: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// Returns null for a malformed value so nothing partial or guessed is shown.
export function summarizePrepayment(stored: unknown): PrepaymentState | null {
  if (!isRecord(stored) || !Array.isArray(stored.cards)) {
    return null;
  }
  const cards: PrepaymentCard[] = [];
  for (const entry of stored.cards) {
    if (!isRecord(entry) || typeof entry.card_id !== "string" || num(entry.rate_pct) === null) {
      return null;
    }
    cards.push({ cardId: entry.card_id, ratePct: entry.rate_pct as number });
  }

  let fixed: PrepaymentState["fixed"] = null;
  if (stored.prepayment !== null && stored.prepayment !== undefined) {
    const raw = stored.prepayment;
    if (
      !isRecord(raw) ||
      typeof raw.card_id !== "string" ||
      num(raw.rate_pct) === null ||
      num(raw.prepaid_amount) === null
    ) {
      return null;
    }
    const usesPreCreditBase = raw.calculation_base === "income-tax-before-credits";
    if (
      (raw.calculation_base !== undefined && !usesPreCreditBase) ||
      (usesPreCreditBase && (num(raw.tax_before_credits) === null || Number(raw.tax_before_credits) < 0))
    ) {
      return null;
    }
    fixed = {
      cardId: raw.card_id,
      ratePct: raw.rate_pct as number,
      prepaidAmount: raw.prepaid_amount as number,
      redrawUsed: raw.redraw_used === true,
      firstCardId: typeof raw.first_card_id === "string" ? raw.first_card_id : null,
      calculationBase: usesPreCreditBase ? "income-tax-before-credits" : "legacy-final-tax",
      baseAmount: usesPreCreditBase ? num(raw.tax_before_credits) : num(raw.calculated_tax),
    };
  }

  const calculatedTax = stored.calculated_tax === null ? null : num(stored.calculated_tax);
  if (stored.calculated_tax !== null && calculatedTax === null) {
    return null;
  }
  const taxBeforeCredits = num(stored.tax_before_credits);
  const creditsApplied = num(stored.credits_applied);
  for (const key of ["tax_before_credits", "credits_applied"] as const) {
    if (stored[key] !== undefined && stored[key] !== null && (num(stored[key]) === null || Number(stored[key]) < 0)) {
      return null;
    }
  }

  return {
    status: fixed ? "fixed" : cards.length > 0 ? "provisional" : "none",
    calculatedTax,
    taxBeforeCredits,
    creditsApplied,
    cards,
    redrawEligible: !fixed && stored.redraw_eligible === true,
    fixed,
    showEstimatedPaymentNote:
      typeof stored.pathway_id === "string" && ESTIMATED_PAYMENT_PATHWAYS.includes(stored.pathway_id),
  };
}
