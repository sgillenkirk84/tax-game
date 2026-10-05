import { GAME_DATA } from "@/lib/game-data";
import { itemizedDeductionForCard } from "@/lib/game-calculations/deduction-rules";
import type { GameCard } from "@/lib/game-data/types";
import {
  calculateGameTax,
  selectWorkbookDeduction,
  type ActiveDependent,
  type FilingStatusCode,
  type IncomeSource,
} from "@/lib/game-calculations";

// Authoritative Round 1 inputs as returned by the get_round_tax_inputs RPC.
// Nothing here comes from the browser.
export type RoundTaxSnapshot = {
  life: {
    id: string;
    status: string;
    pathway_id: string;
    starting_decision_id: string;
    tax_year: number;
    rules_version: string;
    current_round: number;
    current_stage: string;
    filing_status: string;
    homeowner: boolean;
    cash_resources: number;
    student_loan_debt: number;
  };
  round: {
    id: string;
    round_number: number;
    status: string;
    current_stage: string;
    beginning_cash_resources: number;
    beginning_student_loan_debt: number;
    calculation: unknown;
  };
  cards: Array<{
    history_id: string;
    card_id: string;
    stage: string;
    order_in_stage: number;
    choices: Record<string, unknown> | null;
  }>;
  investments: Array<{
    source_type: string;
    acquired_round: number;
    activation_round: number;
    asset_value: number;
    recurring_income_per_round: number;
    status: string;
    source_card_id: string | null;
  }>;
  effects: Array<{
    source_card_id: string;
    effect_type: string;
    starts_round: number;
    expires_after_round: number | null;
    status: string;
    details: Record<string, unknown> | null;
  }>;
};

export type RoundTaxFailure = { ok: false; code: string; message: string; cardId?: string };
export type RoundTaxSuccess = { ok: true; calculation: Record<string, unknown> };

const STAGES = [
  ["income-or-retirement", "Income"],
  ["life-event", "Life Event"],
  ["wildcard", "Wildcard"],
  ["deduction", "Deduction"],
] as const;

const WILD_004_EXPENSE = 5000;
const DEPENDENT_LIFE_EVENTS: Record<string, ActiveDependent["category"]> = {
  "LIFE-001": "qualifying-child",
  "LIFE-002": "other-dependent",
  "LIFE-008": "other-dependent",
  "LIFE-010": "other-dependent",
};

const fail = (code: string, message: string, cardId?: string): RoundTaxFailure => ({
  ok: false,
  code,
  message,
  ...(cardId ? { cardId } : {}),
});

const money = (value: number) => Math.round(value * 100) / 100;

type KnownCard = GameCard & { id: string };

function findCard(cardId: string): KnownCard | undefined {
  return GAME_DATA.cards.find(
    (card): card is KnownCard => card.id === cardId && card.active === "Yes"
  );
}

function incomeCategory(card: KnownCard): "w2-wages" | "business-net-income" | null {
  if (card.taxCategory === "W-2 Wages") return "w2-wages";
  if (card.taxCategory === "Business Net Income") return "business-net-income";
  return null;
}

// Reconstructs a student's Round 1 tax inputs from saved gameplay history and
// runs the approved engine. Incomplete or unsupported rounds are rejected, never guessed.
export function buildRoundTaxCalculation(snapshot: RoundTaxSnapshot): RoundTaxSuccess | RoundTaxFailure {
  const { life, round } = snapshot;

  if (life.status !== "in_progress" || round.status !== "in_progress") {
    return fail("ROUND_NOT_OPEN", "This round is not open for calculation.");
  }
  if (round.round_number !== 1 || life.current_round !== 1) {
    return fail("ROUND_NOT_SUPPORTED", "Tax calculation is only available for Round 1.");
  }
  if (round.current_stage !== "deduction" || life.current_stage !== "deduction") {
    return fail("NOT_DEDUCTION_STAGE", "Tax is calculated after the Deduction stage.");
  }
  if (life.filing_status !== "SINGLE" && life.filing_status !== "MFJ") {
    return fail("FILING_STATUS_NOT_SUPPORTED", "Head of Household has no approved Round 1 source.");
  }

  // Income cards per pathway: Side Hustler exactly two; Entrepreneur one plus an optional
  // second that must be Business Income; every other pathway exactly one.
  const incomeRange =
    life.pathway_id === "PATH-006" ? { min: 2, max: 2 } : life.pathway_id === "PATH-002" ? { min: 1, max: 2 } : { min: 1, max: 1 };
  const historyIds: Record<string, string[]> = {};
  const cardsByStage: Record<string, RoundTaxSnapshot["cards"][number]> = {};
  for (const [stage, deck] of STAGES) {
    const saved = snapshot.cards
      .filter((card) => card.stage === stage)
      .sort((a, b) => a.order_in_stage - b.order_in_stage);
    const range = stage === "income-or-retirement" ? incomeRange : { min: 1, max: 1 };
    if (saved.length < range.min || saved.length > range.max) {
      return fail(
        "INCOMPLETE_ROUND",
        `Round 1 needs ${range.min === range.max ? range.min : `${range.min} to ${range.max}`} saved ${deck} card(s) for this pathway (found ${saved.length}).`
      );
    }
    for (const entry of saved) {
      const dataCard = findCard(entry.card_id);
      if (!dataCard || dataCard.deck !== deck) {
        return fail("UNKNOWN_CARD", `Saved ${deck} card ${entry.card_id} is not an approved ${deck} card.`, entry.card_id);
      }
    }
    cardsByStage[stage] = saved[0];
    historyIds[stage] = saved.map((entry) => entry.history_id);
  }
  const incomeEntries = snapshot.cards
    .filter((card) => card.stage === "income-or-retirement")
    .sort((a, b) => a.order_in_stage - b.order_in_stage);

  const lifeCard = findCard(cardsByStage["life-event"].card_id)!;
  const wildCard = findCard(cardsByStage["wildcard"].card_id)!;
  const dedCard = findCard(cardsByStage["deduction"].card_id)!;

  // Income sources. Opening cash and debt are deliberately not read as income or deductions.
  // Each Income card is its own source; all of them contribute to the calculation.
  const sources: IncomeSource[] = [];
  for (const [position, entry] of incomeEntries.entries()) {
    const card = findCard(entry.card_id)!;
    const category = incomeCategory(card);
    if (!category || typeof card.amount !== "number") {
      return fail("UNSUPPORTED_INCOME", `Income card ${card.id} has no approved W-2 or business amount.`, card.id);
    }
    if (position > 0 && life.pathway_id === "PATH-002" && category !== "business-net-income") {
      return fail("INCOMPLETE_ROUND", `Entrepreneur's additional Income card ${card.id} must be Business Income.`, card.id);
    }
    sources.push({ category, amount: card.amount, sourceId: card.id });
  }

  // Recurring income from investments already active before this round.
  const recurring = snapshot.investments.filter(
    (investment) =>
      investment.status === "active" &&
      investment.activation_round <= round.round_number &&
      (investment.source_type === "pathway-starting" || investment.acquired_round < round.round_number)
  );
  for (const investment of recurring) {
    if (investment.recurring_income_per_round > 0) {
      sources.push({
        category: "investment-income",
        amount: investment.recurring_income_per_round,
        sourceId: investment.source_card_id ?? "PATH-007-START",
      });
    }
  }

  // Life Event: eligibility is re-verified, and the effect applies in the round drawn.
  let filingStatus = life.filing_status as FilingStatusCode;
  let homeowner = life.homeowner;
  const dependents: ActiveDependent[] = snapshot.effects
    .filter(
      (effect) =>
        effect.effect_type === "add-dependent" &&
        effect.status === "active" &&
        effect.starts_round <= round.round_number &&
        (effect.expires_after_round === null || effect.expires_after_round >= round.round_number)
    )
    .map((effect) => ({
      sourceCardId: effect.source_card_id,
      category: (effect.details?.category as ActiveDependent["category"]) ?? "unspecified",
    }));
  const removableDependents = dependents.length;
  const newDependents: ActiveDependent[] = [];
  let removedDependent = false;
  const stateChanges: Record<string, unknown> = {};

  switch (lifeCard.id) {
    case "LIFE-001":
    case "LIFE-002":
    case "LIFE-008":
    case "LIFE-010":
      newDependents.push({ sourceCardId: lifeCard.id, category: DEPENDENT_LIFE_EVENTS[lifeCard.id] });
      break;
    case "LIFE-003":
    case "LIFE-007":
      if (filingStatus === "MFJ") return fail("LIFE_EVENT_INELIGIBLE", `${lifeCard.id} requires an unmarried player.`, lifeCard.id);
      filingStatus = "MFJ";
      stateChanges.filing_status = "MFJ";
      break;
    case "LIFE-004":
      if (filingStatus !== "MFJ") return fail("LIFE_EVENT_INELIGIBLE", "LIFE-004 requires a married player.", lifeCard.id);
      // The approved dataset simplifies post-divorce filing to Single; Head of Household is never assumed.
      filingStatus = "SINGLE";
      stateChanges.filing_status = "SINGLE";
      break;
    case "LIFE-005":
      if (homeowner) return fail("LIFE_EVENT_INELIGIBLE", "LIFE-005 requires a non-homeowner.", lifeCard.id);
      homeowner = true;
      stateChanges.homeowner = true;
      break;
    case "LIFE-009":
      if (!homeowner) return fail("LIFE_EVENT_INELIGIBLE", "LIFE-009 requires a homeowner.", lifeCard.id);
      homeowner = false;
      stateChanges.homeowner = false;
      break;
    case "LIFE-006":
      if (removableDependents === 0) {
        return fail("LIFE_EVENT_INELIGIBLE", "LIFE-006 requires a removable Life Event dependent.", lifeCard.id);
      }
      removedDependent = true;
      break;
    default:
      return fail("UNSUPPORTED_LIFE_EVENT", `Life Event ${lifeCard.id} has no approved calculation rule.`, lifeCard.id);
  }
  const activeDependents = removedDependent ? dependents.slice(1) : [...dependents, ...newDependents];
  if (newDependents.length > 0) {
    stateChanges.dependents_added = newDependents;
  }

  // Wildcard.
  let educationOpportunity: { active: boolean; qualifyingExpense: boolean | null } | undefined;
  const pendingEffects: Array<Record<string, unknown>> = [];
  const newInvestments: Array<{ sourceCardId: string; value: number }> = [];
  let wildChoice: string | null = null;
  let businessExpenseReduction = 0;
  let auditTriggered = false;

  switch (wildCard.id) {
    case "WILD-001":
    case "WILD-002": {
      const category = incomeCategory(wildCard);
      if (!category || typeof wildCard.amount !== "number") {
        return fail("UNSUPPORTED_WILDCARD", `${wildCard.id} has no approved income treatment.`, wildCard.id);
      }
      sources.push({ category, amount: wildCard.amount, sourceId: wildCard.id });
      break;
    }
    case "WILD-003":
      pendingEffects.push({
        source_card_id: "WILD-003",
        type: "cash-increase",
        cash_delta: wildCard.amount,
        taxable: false,
      });
      break;
    case "WILD-004": {
      const choice = cardsByStage["wildcard"].choices?.expense_type;
      if (choice !== "business" && choice !== "personal") {
        return fail("MISSING_CHOICE", "WILD-004 has no saved business/personal choice.", "WILD-004");
      }
      wildChoice = choice;
      if (choice === "business") {
        let remaining = WILD_004_EXPENSE;
        for (const source of sources) {
          if (source.category !== "business-net-income" || remaining <= 0) continue;
          const reduction = Math.min(remaining, source.amount);
          source.amount = money(source.amount - reduction);
          remaining -= reduction;
          businessExpenseReduction += reduction;
        }
      }
      // Both choices are a $5,000 cash expense; it is recorded, not applied to opening cash.
      pendingEffects.push({
        source_card_id: "WILD-004",
        type: "cash-expense",
        cash_delta: -WILD_004_EXPENSE,
        choice,
        business_income_reduction: businessExpenseReduction,
      });
      break;
    }
    case "WILD-005":
      educationOpportunity = { active: true, qualifyingExpense: true };
      break;
    case "WILD-006":
      auditTriggered = true;
      break;
    case "WILD-007":
    case "WILD-008":
    case "WILD-009":
    case "WILD-010": {
      const value = wildCard.investment?.assetValue;
      if (typeof value !== "number") {
        return fail("UNSUPPORTED_WILDCARD", `${wildCard.id} has no approved investment value.`, wildCard.id);
      }
      newInvestments.push({ sourceCardId: wildCard.id, value });
      break;
    }
    default:
      return fail("UNSUPPORTED_WILDCARD", `Wildcard ${wildCard.id} has no approved calculation rule.`, wildCard.id);
  }

  // Deduction. The $X* label is resolved by the engine from tax year and filing status.
  const dedAmount = dedCard.amount;
  if (typeof dedAmount !== "number") {
    return fail("UNSUPPORTED_DEDUCTION", `${dedCard.id} has no approved amount.`, dedCard.id);
  }
  if (["DED-003", "DED-007"].includes(dedCard.id) && !homeowner) {
    return fail("DEDUCTION_INELIGIBLE", `${dedCard.id} requires active homeowner status.`, dedCard.id);
  }
  // Approved simplified rules. DED-001..005 always yield the standard deduction (their
  // displayed expenses are examples). DED-006..008 total allowable itemized deductions =
  // standard deduction + the card amount (the named expense is an example, never deducted
  // again). DED-009/010 state the total itemized deductions, compared with the standard.
  const medicalExpenses = 0;
  const standardForFiling = selectWorkbookDeduction(filingStatus, 0).amount;
  const otherItemized = itemizedDeductionForCard(dedCard.id, dedAmount, standardForFiling);
  if (otherItemized === null) {
    return fail("UNSUPPORTED_DEDUCTION", `${dedCard.id} has no approved calculation rule.`, dedCard.id);
  }

  const existingAssets = snapshot.investments
    .filter((investment) => investment.status === "active")
    .map((investment) => ({ sourceCardId: investment.source_card_id ?? "PATH-007-START", value: investment.asset_value }));
  const result = calculateGameTax({
    incomeSources: sources,
    filingStatus,
    otherEligibleItemizedDeduction: otherItemized,
    medicalExpenses,
    dependents: activeDependents,
    educationOpportunity,
    pathwayIds: [life.pathway_id],
    investmentAssets: [...existingAssets, ...newInvestments.map((asset) => ({ ...asset }))],
  });
  if (result.status !== "supported") {
    return fail("CALCULATION_UNSUPPORTED", result.reasons.join(" "));
  }

  const standardDeduction = selectWorkbookDeduction(filingStatus, 0).amount;

  const credits = result.credits;
  const calculation = {
    round: {
      income_by_category: result.incomeByCategory,
      gross_income: result.grossIncome,
      business_income_adjustment: result.businessIncomeAdjustment,
      social_security_included: result.socialSecurityIncludedInIncome,
      adjusted_gross_income: result.adjustedGrossIncome,
      investment_income: result.incomeByCategory["investment-income"],
      investment_asset_value: result.investmentAssetValue,
      deduction_method: result.deductionMethod,
      standard_deduction: standardDeduction,
      eligible_itemized_deduction: result.eligibleItemizedDeduction,
      medical_expenses: medicalExpenses,
      medical_deduction: result.medicalDeduction,
      deduction_amount: result.deductionAmount,
      taxable_income: result.taxableIncome,
      tax_before_credits: result.taxBeforeCredits,
      credits_total: credits.creditsAppliedToTax,
      credit_details: credits.appliedCredits,
      final_tax_liability: result.finalTax,
      applied_deductions: {
        method: result.deductionMethod,
        deduction_card_id: dedCard.id,
        standard_deduction: standardDeduction,
        itemized_total: result.eligibleItemizedDeduction,
      },
    },
    credits: {
      available: credits.availableCredits,
      applied: credits.creditsAppliedToTax,
      unused: credits.unusedCredits,
      not_applied: credits.notApplied,
    },
    pending_effects: pendingEffects,
    pending_state_changes: stateChanges,
    audit_trigger: {
      triggered: auditTriggered,
      source_card_id: auditTriggered ? "WILD-006" : null,
      card_history_id: auditTriggered ? historyIds.wildcard[0] : null,
      assessed: false,
    },
    input_snapshot: {
      rules_version: life.rules_version,
      tax_year: life.tax_year,
      pathway_id: life.pathway_id,
      starting_decision_id: life.starting_decision_id,
      opening_cash_resources: round.beginning_cash_resources,
      opening_student_loan_debt: round.beginning_student_loan_debt,
      card_history_ids: historyIds,
      cards: snapshot.cards
        .filter((card) => STAGES.some(([stage]) => stage === card.stage))
        .sort((a, b) => a.stage.localeCompare(b.stage) || a.order_in_stage - b.order_in_stage)
        .map((card) => ({ stage: card.stage, card_id: card.card_id, history_id: card.history_id })),
      filing_status_before: life.filing_status,
      filing_status_applied: filingStatus,
      homeowner_before: life.homeowner,
      homeowner_after: homeowner,
      income_sources: sources,
      wild_004: wildChoice ? { choice: wildChoice, business_income_reduction: businessExpenseReduction } : null,
      dependents: activeDependents,
      education_opportunity: educationOpportunity ?? null,
      recurring_investments_included: recurring.length,
      new_investments: newInvestments,
      medical_expenses: medicalExpenses,
      other_itemized_deductions: otherItemized,
    },
  };

  return { ok: true, calculation };
}
