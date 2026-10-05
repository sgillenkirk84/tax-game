import workbookData from "../game-data/workbook-data.json" with { type: "json" };
import type { GameCard, GameDataset, IncomeComponent } from "../game-data/types";

const GAME_DATA: GameDataset = workbookData;

export type FilingStatusCode = "SINGLE" | "MFJ" | "HOH";

export type IncomeCategory =
  | "w2-wages"
  | "business-net-income"
  | "social-security"
  | "retirement-distribution"
  | "investment-income"
  | "retirement-or-investment-income"
  | "other-taxable-income";

export type IncomeSource = {
  category: IncomeCategory;
  amount: number;
  sourceId: string;
};

export type AdditionalRetirementInvestmentIncome = {
  investmentId: string;
  amount: number;
};

export type InvestmentAsset = {
  sourceCardId: string;
  value: number;
};

export type ActiveDependent = {
  sourceCardId: string | null;
  category: "qualifying-child" | "other-dependent" | "unspecified" | "non-credit";
};

export type EducationOpportunity = {
  active: boolean;
  qualifyingExpense: boolean | null;
};

export type CreditCalculation = {
  totalCredits: number;
  availableCredits: number;
  creditsAppliedToTax: number;
  unusedCredits: number;
  appliedCredits: Array<{ ruleId: string; amount: number; reason: string }>;
  notApplied: Array<{ cardId: string; reason: string }>;
  unsupported: string[];
};

type TaxResultCommon = {
  grossIncome: number;
  adjustedGrossIncome: number;
  incomeByCategory: Record<IncomeCategory, number>;
  businessIncomeAdjustment: number;
  businessIncomeAdjustmentNote: string;
  socialSecurityIncludedInIncome: number;
  investmentAssetValue: number;
  medicalDeduction: number;
  eligibleItemizedDeduction: number;
};

export type SupportedTaxResult = TaxResultCommon & {
  status: "supported";
  filingStatus: FilingStatusCode;
  deductionMethod: "standard" | "itemized";
  deductionAmount: number;
  taxableIncome: number;
  taxBeforeCredits: number;
  credits: CreditCalculation;
  finalTax: number;
};

export type UnsupportedTaxResult = TaxResultCommon & {
  status: "unsupported";
  reasons: string[];
  incomeByCategory: Record<IncomeCategory, number>;
  taxableIncome: null;
  taxBeforeCredits: null;
  finalTax: null;
  credits?: CreditCalculation;
};

export type TaxCalculationResult = SupportedTaxResult | UnsupportedTaxResult;

export type GameTaxInput = {
  incomeSources: IncomeSource[];
  filingStatus: FilingStatusCode;
  headOfHousehold?: {
    unmarried: boolean;
    qualifyingDependent: boolean;
  };
  otherEligibleItemizedDeduction: number;
  medicalExpenses?: number;
  dependents?: ActiveDependent[];
  educationOpportunity?: EducationOpportunity;
  pathwayIds?: string[];
  investmentAssets?: InvestmentAsset[];
};

export type EarlyRetirementIncomeResult = {
  pathwayId: string;
  roundNumber: number;
  annualPackageAmount: number;
  totalAnnualIncome: number;
  currentRetirementCardId: string;
  winningRetirementCardId: string | null;
  retirementIncomeSources: IncomeSource[];
  additionalInvestmentIncome: IncomeSource[];
  incomeSources: IncomeSource[];
  status: "supported" | "unsupported";
  reasons: string[];
};

export type Aud008AuditResult =
  | {
      status: "supported";
      preAuditTax: SupportedTaxResult;
      auditedTax: SupportedTaxResult;
      additionalTax: number;
      penalty: number;
      fixedTaxPrepayment: number;
      taxSettlement: ReturnType<typeof settleTaxPrepayment>;
      totalAmountDue: number;
    }
  | {
      status: "unsupported";
      reasons: string[];
    };

export type TaxBracketBreakdown = {
  bracketNumber: number;
  lowerBound: number;
  upperBound: number | null;
  rate: number;
  taxableInBracket: number;
  taxInBracket: number;
};

export type FederalTaxResult = {
  taxYear: number;
  filingStatus: FilingStatusCode;
  taxableIncome: number;
  tax: number;
  brackets: TaxBracketBreakdown[];
};

function toCents(amount: number, label: string): number {
  if (!Number.isFinite(amount) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
    throw new RangeError(`${label} must be a finite amount with no more than two decimal places.`);
  }
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`${label} exceeds the supported monetary range.`);
  }
  return cents;
}

function fromCents(cents: number): number {
  return cents / 100;
}

function nonNegativeMoney(amount: number, label: string): number {
  const cents = toCents(amount, label);
  if (cents < 0) {
    throw new RangeError(`${label} cannot be negative.`);
  }
  return cents;
}

function getRows(
  dataset: GameDataset,
  table: "filingStatuses" | "brackets" | "credits"
) {
  const rows = dataset.taxRules[table];
  if (!Array.isArray(rows)) {
    throw new Error(`Tax Rules table ${table} is missing.`);
  }
  return rows.filter((row) => row.fields["Tax Year"] === dataset.gameRules.approved.betaTaxYear);
}

function requireTaxRuleValue<T extends string | number>(
  value: unknown,
  field: string,
  sourceRow: number
): T {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Tax Rules row ${sourceRow} is missing ${field}.`);
  }
  return value as T;
}

export function calculateFederalIncomeTax(
  taxableIncome: number,
  filingStatus: FilingStatusCode,
  dataset: GameDataset = GAME_DATA
): FederalTaxResult {
  const incomeCents = nonNegativeMoney(taxableIncome, "Taxable income");
  const selectedBrackets = getRows(dataset, "brackets")
    .filter((row) => row.fields["Filing Status Code"] === filingStatus)
    .sort((left, right) => Number(left.fields["Bracket No"]) - Number(right.fields["Bracket No"]));

  if (selectedBrackets.length === 0) {
    throw new Error(`No ${dataset.gameRules.approved.betaTaxYear} tax brackets exist for ${filingStatus}.`);
  }

  let totalTaxCents = 0;
  const breakdown: TaxBracketBreakdown[] = [];
  let expectedLowerBound = 0;

  for (const [index, row] of selectedBrackets.entries()) {
    const bracketNumber = requireTaxRuleValue<number>(row.fields["Bracket No"], "Bracket No", row.source.row);
    const lowerBound = requireTaxRuleValue<number>(row.fields["Lower Bound"], "Lower Bound", row.source.row);
    const upperSource = row.fields["Upper Bound"];
    const rate = requireTaxRuleValue<number>(row.fields["Tax Rate"], "Tax Rate", row.source.row);
    const upperBound = typeof upperSource === "number" ? upperSource : null;

    if (lowerBound !== expectedLowerBound || rate < 0 || rate > 1) {
      throw new Error(`Tax Brackets row ${row.source.row} is not a valid contiguous bracket.`);
    }
    if (upperBound !== null && upperBound <= lowerBound) {
      throw new Error(`Tax Brackets row ${row.source.row} has an invalid upper bound.`);
    }
    if (upperBound === null && index !== selectedBrackets.length - 1) {
      throw new Error(`Only the final tax bracket may be open-ended.`);
    }

    const lowerCents = lowerBound * 100;
    const upperCents = upperBound === null ? incomeCents : upperBound * 100;
    const taxableHereCents = Math.max(0, Math.min(incomeCents, upperCents) - lowerCents);
    const taxHereCents = Math.round(taxableHereCents * rate);
    totalTaxCents += taxHereCents;
    breakdown.push({
      bracketNumber,
      lowerBound,
      upperBound,
      rate,
      taxableInBracket: fromCents(taxableHereCents),
      taxInBracket: fromCents(taxHereCents),
    });

    if (upperBound !== null) {
      expectedLowerBound = upperBound;
    }
  }

  if (selectedBrackets.at(-1)?.fields["Upper Bound"] !== "No Limit") {
    throw new Error(`The final ${filingStatus} tax bracket must be open-ended.`);
  }

  return {
    taxYear: dataset.gameRules.approved.betaTaxYear,
    filingStatus,
    taxableIncome: fromCents(incomeCents),
    tax: fromCents(totalTaxCents),
    brackets: breakdown,
  };
}

export function selectDeduction(
  standardDeduction: number,
  eligibleItemizedDeduction: number
): { method: "standard" | "itemized"; amount: number } {
  const standardCents = nonNegativeMoney(standardDeduction, "Standard deduction");
  const itemizedCents = nonNegativeMoney(eligibleItemizedDeduction, "Eligible itemized deduction");
  return itemizedCents > standardCents
    ? { method: "itemized", amount: fromCents(itemizedCents) }
    : { method: "standard", amount: fromCents(standardCents) };
}

export function selectWorkbookDeduction(
  filingStatus: FilingStatusCode,
  eligibleItemizedDeduction: number,
  dataset: GameDataset = GAME_DATA
): { method: "standard" | "itemized"; amount: number } {
  const row = getRows(dataset, "filingStatuses").find(
    (candidate) => candidate.fields["Filing Status Code"] === filingStatus
  );
  if (!row || typeof row.fields["Standard Deduction"] !== "number") {
    throw new Error(`No 2025 standard deduction exists for ${filingStatus}.`);
  }
  return selectDeduction(row.fields["Standard Deduction"], eligibleItemizedDeduction);
}

function creditAmount(dataset: GameDataset, ruleId: string): number {
  const row = getRows(dataset, "credits").find((candidate) => candidate.fields["Rule ID"] === ruleId);
  if (!row) {
    throw new Error(`The active Tax Rules do not contain credit ${ruleId}.`);
  }
  const amount = row.fields.Amount;
  if (typeof amount !== "number" || amount < 0) {
    throw new Error(`Credit Tax Rules row ${row.source.row} has an invalid amount.`);
  }
  return amount;
}

export function calculateWorkbookCredits(
  input: {
    dependents: ActiveDependent[];
    educationOpportunity?: EducationOpportunity;
    pathwayIds?: string[];
  },
  dataset: GameDataset = GAME_DATA
): CreditCalculation {
  const appliedCredits: CreditCalculation["appliedCredits"] = [];
  const notApplied: CreditCalculation["notApplied"] = [];
  const unsupported: string[] = [];

  for (const dependent of input.dependents) {
    if (dependent.sourceCardId === "LIFE-001" && dependent.category === "qualifying-child") {
      appliedCredits.push({
        ruleId: "TAX-2025-CTC",
        amount: creditAmount(dataset, "TAX-2025-CTC"),
        reason: "Active qualifying-child effect from LIFE-001.",
      });
    } else if (
      ["LIFE-002", "LIFE-008"].includes(dependent.sourceCardId ?? "") &&
      dependent.category === "other-dependent"
    ) {
      appliedCredits.push({
        ruleId: "TAX-2025-ODC",
        amount: creditAmount(dataset, "TAX-2025-ODC"),
        reason: `Active qualifying other-dependent effect from ${dependent.sourceCardId}.`,
      });
    } else if (dependent.sourceCardId === "LIFE-010") {
      if (dependent.category === "non-credit") {
        notApplied.push({
          cardId: "LIFE-010",
          reason: "The LIFE-010 dependent is no longer active or eligible for a dependent credit.",
        });
      } else {
        appliedCredits.push({
          ruleId: "TAX-2025-ODC",
          amount: creditAmount(dataset, "TAX-2025-ODC"),
          reason: "Active dependent from LIFE-010 is classified as an other dependent.",
        });
      }
    } else if (dependent.sourceCardId === "LIFE-001" && dependent.category !== "qualifying-child") {
      notApplied.push({ cardId: "LIFE-001", reason: "The active dependent is not recorded as a qualifying child." });
    } else if (
      ["LIFE-002", "LIFE-008"].includes(dependent.sourceCardId ?? "") &&
      dependent.category !== "other-dependent"
    ) {
      notApplied.push({ cardId: dependent.sourceCardId ?? "unknown", reason: "The active dependent is not recorded as an other dependent." });
    }
  }

  const educationOpportunity = input.educationOpportunity;
  if (educationOpportunity?.active) {
    if (educationOpportunity.qualifyingExpense === null) {
      unsupported.push("WILD-005 education-credit applicability has not been determined.");
    } else if (educationOpportunity.qualifyingExpense) {
      const rules = dataset.gameRules.approved.educationBenefit;
      const standardBenefit = creditAmount(dataset, "TAX-2025-EDU");
      const enhancement = input.pathwayIds?.includes(rules.pathwayId)
        ? rules.enhancementAmount
        : 0;
      const benefit = Math.min(rules.maximumBenefit, standardBenefit + enhancement);
      appliedCredits.push({
        ruleId: "TAX-2025-EDU",
        amount: benefit,
        reason: enhancement > 0
          ? `Active WILD-005 qualifying expense with ${rules.pathwayId} enhancement, capped at $${rules.maximumBenefit}.`
          : "Active WILD-005 with a qualifying education expense; amount follows the workbook Tax Rules table.",
      });
    } else {
      notApplied.push({ cardId: "WILD-005", reason: "The education expense is not recorded as qualifying." });
    }
  }

  const availableCredits = fromCents(
    appliedCredits.reduce((sum, credit) => sum + nonNegativeMoney(credit.amount, "Credit amount"), 0)
  );
  return {
    totalCredits: availableCredits,
    availableCredits,
    creditsAppliedToTax: availableCredits,
    unusedCredits: 0,
    appliedCredits,
    notApplied,
    unsupported,
  };
}

function emptyIncomeTotals(): Record<IncomeCategory, number> {
  return {
    "w2-wages": 0,
    "business-net-income": 0,
    "social-security": 0,
    "retirement-distribution": 0,
    "investment-income": 0,
    "retirement-or-investment-income": 0,
    "other-taxable-income": 0,
  };
}

export function getRequiredGameRoundCount(
  pathwayId: string,
  dataset: GameDataset = GAME_DATA
): number {
  if (!dataset.pathways.some((pathway) => pathway.id === pathwayId)) {
    throw new Error(`Unknown Pathway ${pathwayId}.`);
  }
  return dataset.gameRules.approved.roundCount;
}

export function getRetirementStartRound(
  pathwayId: string,
  dataset: GameDataset = GAME_DATA
): number {
  if (!dataset.pathways.some((pathway) => pathway.id === pathwayId)) {
    throw new Error(`Unknown Pathway ${pathwayId}.`);
  }
  const rules = dataset.gameRules.approved.retirement;
  return pathwayId === rules.earlyRetirementPathwayId
    ? rules.earlyRetirementStartRound
    : rules.standardRetirementStartRound;
}

type ValidRetirementCard = GameCard & {
  id: string;
  amount: number;
  effectType: "Retirement Income";
  effectValue: number;
  durationRounds: 1;
  incomeComponents: IncomeComponent[];
};

function isValidRetirementCard(card: GameCard | undefined): card is ValidRetirementCard {
  if (
    !card ||
    typeof card.id !== "string" ||
    card.deck !== "Retirement" ||
    card.active !== "Yes" ||
    typeof card.amount !== "number" ||
    card.effectType !== "Retirement Income" ||
    typeof card.effectValue !== "number" ||
    card.durationRounds !== 1 ||
    !Array.isArray(card.incomeComponents)
  ) {
    return false;
  }
  return card.effectValue === card.amount &&
    card.incomeComponents.every(
      (component) => Number.isFinite(component.amount) && component.amount >= 0
    ) &&
    card.incomeComponents.reduce((sum, component) => sum + component.amount, 0) === card.amount;
}

function getRetirementCard(cardId: string, dataset: GameDataset): ValidRetirementCard {
  const card = dataset.cards.find((candidate) => candidate.id === cardId);
  if (!isValidRetirementCard(card)) {
    throw new Error(
      `${cardId} is not an active Retirement card with one consistent round of income.`
    );
  }
  return card;
}

function isIncomeCategory(value: string): value is IncomeCategory {
  return (
    value === "w2-wages" ||
    value === "business-net-income" ||
    value === "social-security" ||
    value === "retirement-distribution" ||
    value === "investment-income" ||
    value === "retirement-or-investment-income" ||
    value === "other-taxable-income"
  );
}

function mapRetirementCardIncome(card: ValidRetirementCard): IncomeSource[] {
  return card.incomeComponents.map((component) => {
    if (!isIncomeCategory(component.type)) {
      throw new Error(
        `Retirement card ${card.id} has unsupported income component ${component.type}.`
      );
    }
    return {
      category: component.type,
      amount: fromCents(nonNegativeMoney(component.amount, `Retirement card ${card.id} component`)),
      sourceId: card.id,
    };
  });
}

function mapAdditionalInvestmentIncome(
  sources: AdditionalRetirementInvestmentIncome[]
): IncomeSource[] {
  const uniqueIncomeByInvestment = new Map<string, number>();
  for (const source of sources) {
    if (typeof source.investmentId !== "string" || source.investmentId.trim() === "") {
      throw new Error("Each additional retirement investment income source requires an investment ID.");
    }
    const amountCents = nonNegativeMoney(
      source.amount,
      `Retirement investment ${source.investmentId} income`
    );
    const existingAmount = uniqueIncomeByInvestment.get(source.investmentId);
    if (existingAmount !== undefined && existingAmount !== amountCents) {
      throw new Error(
        `Retirement investment ${source.investmentId} has conflicting income values in one round.`
      );
    }
    uniqueIncomeByInvestment.set(source.investmentId, amountCents);
  }
  return [...uniqueIncomeByInvestment].map(([investmentId, amountCents]) => ({
    category: "investment-income",
    amount: fromCents(amountCents),
    sourceId: investmentId,
  }));
}

export function calculateEarlyRetirementIncome(
  input: {
    roundNumber: number;
    retirementCardId: string;
    previousRound?: EarlyRetirementIncomeResult;
    additionalInvestmentIncome?: AdditionalRetirementInvestmentIncome[];
  },
  dataset: GameDataset = GAME_DATA
): EarlyRetirementIncomeResult {
  const rules = dataset.gameRules.approved.retirement;
  if (
    input.roundNumber !== rules.earlyRetirementStartRound &&
    input.roundNumber !== dataset.gameRules.approved.roundCount
  ) {
    throw new RangeError(
      `Early Retiree retirement income is only evaluated in rounds ${rules.earlyRetirementStartRound} and ${dataset.gameRules.approved.roundCount}.`
    );
  }

  if (input.roundNumber === rules.earlyRetirementStartRound && input.previousRound) {
    throw new Error("Round 4 cannot use a previous retirement result.");
  }
  if (input.roundNumber === dataset.gameRules.approved.roundCount) {
    if (
      !input.previousRound ||
      input.previousRound.pathwayId !== rules.earlyRetirementPathwayId ||
      input.previousRound.roundNumber !== rules.earlyRetirementStartRound
    ) {
      throw new Error("Round 5 requires the Early Retiree's Round 4 protected income result.");
    }
  }

  const card = getRetirementCard(input.retirementCardId, dataset);
  const guarantee = rules.earlyRetirementIncomeGuarantee;
  const guaranteeCents = nonNegativeMoney(guarantee.annualAmount, "Early Retiree income guarantee");
  const cardIncomeCents = nonNegativeMoney(card.amount, `Retirement card ${input.retirementCardId}`);
  const previousIncomeCents = input.previousRound
    ? nonNegativeMoney(input.previousRound.annualPackageAmount, "Previous protected retirement package")
    : 0;
  if (
    input.previousRound &&
    (
      input.previousRound.status !== "supported" ||
      input.previousRound.pathwayId !== rules.earlyRetirementPathwayId ||
      input.previousRound.retirementIncomeSources.reduce(
        (sum, source) => sum + nonNegativeMoney(source.amount, "Previous retirement package component"),
        0
      ) !== previousIncomeCents
    )
  ) {
    throw new Error("Round 5 requires a supported and internally consistent Round 4 package.");
  }

  let annualPackageCents = guaranteeCents;
  let winningRetirementCardId: string | null = null;
  let retirementIncomeSources: IncomeSource[] = [
    {
      category: "social-security",
      amount: guarantee.socialSecurity,
      sourceId: rules.earlyRetirementPathwayId,
    },
    {
      category: "retirement-or-investment-income",
      amount: guarantee.pensionAndInvestment,
      sourceId: rules.earlyRetirementPathwayId,
    },
  ];

  if (input.previousRound && previousIncomeCents > annualPackageCents) {
    annualPackageCents = previousIncomeCents;
    winningRetirementCardId = input.previousRound.winningRetirementCardId;
    retirementIncomeSources = input.previousRound.retirementIncomeSources;
  }
  if (cardIncomeCents > annualPackageCents) {
    annualPackageCents = cardIncomeCents;
    winningRetirementCardId = String(card.id);
    retirementIncomeSources = mapRetirementCardIncome(card);
  }

  const additionalInvestmentIncome = mapAdditionalInvestmentIncome(
    input.additionalInvestmentIncome ?? []
  );
  const packageAmount = fromCents(annualPackageCents);
  const additionalInvestmentTotalCents = additionalInvestmentIncome.reduce(
    (sum, source) => sum + nonNegativeMoney(source.amount, "Additional retirement investment income"),
    0
  );
  const totalAnnualIncomeCents = annualPackageCents + additionalInvestmentTotalCents;
  if (!Number.isSafeInteger(totalAnnualIncomeCents)) {
    throw new RangeError("Total annual retirement income exceeds the supported monetary range.");
  }
  const totalAnnualIncome = fromCents(totalAnnualIncomeCents);
  const incomeSources = [...retirementIncomeSources, ...additionalInvestmentIncome];
  return {
    pathwayId: rules.earlyRetirementPathwayId,
    roundNumber: input.roundNumber,
    annualPackageAmount: packageAmount,
    totalAnnualIncome,
    currentRetirementCardId: input.retirementCardId,
    winningRetirementCardId,
    retirementIncomeSources,
    additionalInvestmentIncome,
    incomeSources,
    status: "supported",
    reasons: [],
  };
}

export function calculateGameTax(
  input: GameTaxInput,
  dataset: GameDataset = GAME_DATA
): TaxCalculationResult {
  const incomeByCategory = emptyIncomeTotals();
  const reasons: string[] = [];
  let grossIncomeCents = 0;

  for (const source of input.incomeSources) {
    const amountCents = nonNegativeMoney(source.amount, `Income source ${source.sourceId}`);
    incomeByCategory[source.category] = fromCents(
      nonNegativeMoney(incomeByCategory[source.category], `${source.category} total`) + amountCents
    );
    grossIncomeCents += amountCents;
  }

  if (input.filingStatus === "HOH") {
    const eligibility = input.headOfHousehold;
    if (!eligibility) {
      reasons.push("Head of Household requires an unmarried player and an active qualifying household dependent in this game.");
    } else {
      if (!eligibility.unmarried) {
        reasons.push("Head of Household requires an unmarried player.");
      }
      if (!eligibility.qualifyingDependent) {
        reasons.push("Head of Household requires a qualifying dependent.");
      }
    }
  }

  const businessIncomeCents = nonNegativeMoney(
    incomeByCategory["business-net-income"],
    "Business net income"
  );
  const businessIncomeAdjustmentCents = Math.round(
    businessIncomeCents * dataset.gameRules.approved.businessIncome.adjustmentPercentage
  );
  const socialSecurityCents = nonNegativeMoney(
    incomeByCategory["social-security"],
    "Social Security benefits"
  );
  const otherRetirementInvestmentCents =
    nonNegativeMoney(incomeByCategory["retirement-distribution"], "Retirement distributions") +
    nonNegativeMoney(incomeByCategory["investment-income"], "Investment income") +
    nonNegativeMoney(
      incomeByCategory["retirement-or-investment-income"],
      "Combined retirement or investment income"
    );
  const nonSocialSecurityIncomeCents = grossIncomeCents - socialSecurityCents;
  if (
    socialSecurityCents > 0 &&
    otherRetirementInvestmentCents === 0 &&
    nonSocialSecurityIncomeCents > 0
  ) {
    reasons.push(
      "The approved rules do not define Social Security treatment when wages or business income exist without retirement or investment income."
    );
  }
  if (
    socialSecurityCents > 0 &&
    otherRetirementInvestmentCents === 0 &&
    nonSocialSecurityIncomeCents === 0 &&
    !dataset.gameRules.approved.socialSecurity.nontaxableWhenOnlyIncome
  ) {
    reasons.push("The approved rules do not define the taxable portion of Social Security-only income.");
  }
  const socialSecurityIncludedCents =
    otherRetirementInvestmentCents > 0
      ? Math.round(
          socialSecurityCents *
            dataset.gameRules.approved.socialSecurity
              .taxableFractionWhenRetirementOrInvestmentIncomeExists
        )
      : 0;
  const grossIncome = fromCents(grossIncomeCents);
  const adjustedGrossIncomeCents = Math.max(
    0,
    grossIncomeCents -
      businessIncomeAdjustmentCents -
      socialSecurityCents +
      socialSecurityIncludedCents
  );
  const adjustedGrossIncome = fromCents(adjustedGrossIncomeCents);
  const medicalExpensesCents = nonNegativeMoney(input.medicalExpenses ?? 0, "Eligible medical expenses");
  const medicalThresholdCents = Math.round(
    adjustedGrossIncomeCents *
      dataset.gameRules.approved.medicalDeduction.adjustedIncomeThresholdPercentage
  );
  const medicalDeductionCents = Math.max(0, medicalExpensesCents - medicalThresholdCents);
  const otherItemizedDeductionCents = nonNegativeMoney(
    input.otherEligibleItemizedDeduction,
    "Other eligible itemized deductions"
  );
  const eligibleItemizedDeductionCents = otherItemizedDeductionCents + medicalDeductionCents;
  const investmentAssetValue = fromCents(
    (input.investmentAssets ?? []).reduce(
      (totalCents, asset) =>
        totalCents + nonNegativeMoney(asset.value, `Investment asset ${asset.sourceCardId}`),
      0
    )
  );
  const deduction = selectWorkbookDeduction(
    input.filingStatus,
    fromCents(eligibleItemizedDeductionCents),
    dataset
  );
  const credits = calculateWorkbookCredits(
    {
      dependents: input.dependents ?? [],
      educationOpportunity: input.educationOpportunity,
      pathwayIds: input.pathwayIds,
    },
    dataset
  );
  reasons.push(...credits.unsupported);

  if (reasons.length > 0) {
    return {
      status: "unsupported",
      reasons,
      grossIncome,
      adjustedGrossIncome,
      incomeByCategory,
      businessIncomeAdjustment: fromCents(businessIncomeAdjustmentCents),
      businessIncomeAdjustmentNote: "9% educational simplification; not actual self-employment tax.",
      socialSecurityIncludedInIncome: fromCents(socialSecurityIncludedCents),
      investmentAssetValue,
      medicalDeduction: fromCents(medicalDeductionCents),
      eligibleItemizedDeduction: fromCents(eligibleItemizedDeductionCents),
      taxableIncome: null,
      taxBeforeCredits: null,
      finalTax: null,
      credits,
    };
  }

  const taxableIncome = fromCents(
    Math.max(0, adjustedGrossIncomeCents - nonNegativeMoney(deduction.amount, "Deduction amount"))
  );
  const taxBeforeCredits = calculateFederalIncomeTax(taxableIncome, input.filingStatus, dataset).tax;
  // Credits are nonrefundable: they never reduce tax below zero and unused credits are not paid out.
  const creditsAppliedToTax = Math.min(credits.availableCredits, taxBeforeCredits);
  const creditsWithApplication: CreditCalculation = {
    ...credits,
    creditsAppliedToTax,
    unusedCredits: fromCents(
      nonNegativeMoney(credits.availableCredits, "Available credits") -
        nonNegativeMoney(creditsAppliedToTax, "Applied credits")
    ),
  };

  return {
    status: "supported",
    filingStatus: input.filingStatus,
    grossIncome,
    adjustedGrossIncome,
    incomeByCategory,
    businessIncomeAdjustment: fromCents(businessIncomeAdjustmentCents),
    businessIncomeAdjustmentNote: "9% educational simplification; not actual self-employment tax.",
    socialSecurityIncludedInIncome: fromCents(socialSecurityIncludedCents),
    investmentAssetValue,
    medicalDeduction: fromCents(medicalDeductionCents),
    eligibleItemizedDeduction: fromCents(eligibleItemizedDeductionCents),
    deductionMethod: deduction.method,
    deductionAmount: deduction.amount,
    taxableIncome,
    taxBeforeCredits,
    credits: creditsWithApplication,
    finalTax: fromCents(
      nonNegativeMoney(taxBeforeCredits, "Tax before credits") -
        nonNegativeMoney(creditsAppliedToTax, "Applied credits")
    ),
  };
}

export function calculateProgressiveLivingCosts(
  applicableIncome: number,
  dataset: GameDataset = GAME_DATA
): number {
  const incomeCents = nonNegativeMoney(applicableIncome, "Applicable income");
  let costCents = 0;
  for (const band of dataset.gameRules.approved.livingCostBands) {
    const lowerCents = band.lowerBound * 100;
    const upperCents = band.upperBound === null ? incomeCents : band.upperBound * 100;
    const portionCents = Math.max(0, Math.min(incomeCents, upperCents) - lowerCents);
    costCents += Math.round(portionCents * band.rate);
  }
  return fromCents(costCents);
}

export function getStartingFinancialPosition(
  decisionId: string,
  dataset: GameDataset = GAME_DATA
): { cash: number; debt: number } {
  const decision = dataset.gameRules.approved.startingDecisions.find((entry) => entry.id === decisionId);
  if (!decision) {
    throw new Error(`Unknown Starting Decision ${decisionId}.`);
  }
  return {
    cash: fromCents(nonNegativeMoney(decision.startingCash, "Starting cash")),
    debt: fromCents(nonNegativeMoney(decision.startingDebt, "Starting debt")),
  };
}

export function calculateStudentLoanPayment(
  outstandingDebt: number,
  dataset: GameDataset = GAME_DATA
): { principalPayment: number; endingDebt: number } {
  const debtCents = nonNegativeMoney(outstandingDebt, "Outstanding student-loan debt");
  const rule = dataset.gameRules.approved.studentLoan;
  const scheduledPaymentCents = nonNegativeMoney(rule.principalPaymentPerRound, "Student-loan principal payment");
  const principalPaymentCents = Math.min(debtCents, scheduledPaymentCents);
  return {
    principalPayment: fromCents(principalPaymentCents),
    endingDebt: fromCents(debtCents - principalPaymentCents),
  };
}

export function calculateTaxPrepayment(
  taxBeforePrepayment: number,
  prepaymentRate: number
): { taxBeforePrepayment: number; rate: number; prepaidAmount: number } {
  const taxCents = nonNegativeMoney(taxBeforePrepayment, "Tax before prepayment");
  if (!Number.isFinite(prepaymentRate) || prepaymentRate < 0) {
    throw new RangeError("Tax prepayment rate must be a finite non-negative number.");
  }
  const prepaidCents = Math.round(taxCents * prepaymentRate);
  return {
    taxBeforePrepayment: fromCents(taxCents),
    rate: prepaymentRate,
    prepaidAmount: fromCents(prepaidCents),
  };
}

export function settleTaxPrepayment(
  fixedPrepayment: number,
  finalTaxLiability: number
): { taxPrepaid: number; finalTaxLiability: number; refund: number; amountDue: number } {
  const prepaymentCents = nonNegativeMoney(fixedPrepayment, "Fixed tax prepayment");
  const liabilityCents = nonNegativeMoney(finalTaxLiability, "Final tax liability");
  const balanceCents = prepaymentCents - liabilityCents;
  return {
    taxPrepaid: fromCents(prepaymentCents),
    finalTaxLiability: fromCents(liabilityCents),
    refund: fromCents(Math.max(0, balanceCents)),
    amountDue: fromCents(Math.max(0, -balanceCents)),
  };
}

export function calculateAud008Audit(
  input: {
    taxInput: GameTaxInput;
    fixedTaxPrepayment: number;
  },
  dataset: GameDataset = GAME_DATA
): Aud008AuditResult {
  const auditRule = dataset.gameRules.approved.audit;
  if (auditRule.adjustmentCardId !== "AUD-008") {
    throw new Error(`Expected the approved audit adjustment card to be AUD-008; found ${auditRule.adjustmentCardId}.`);
  }
  if (input.taxInput.incomeSources.some((source) => source.sourceId === auditRule.adjustmentCardId)) {
    throw new Error("AUD-008 adjustment is already present; refusing to apply it twice.");
  }

  const fixedTaxPrepayment = fromCents(
    nonNegativeMoney(input.fixedTaxPrepayment, "Fixed pre-audit tax prepayment")
  );
  const preAuditResult = calculateGameTax(input.taxInput, dataset);
  if (preAuditResult.status === "unsupported") {
    return { status: "unsupported", reasons: preAuditResult.reasons };
  }

  const auditedResult = calculateGameTax(
    {
      ...input.taxInput,
      incomeSources: [
        ...input.taxInput.incomeSources,
        {
          category: "other-taxable-income",
          amount: auditRule.omittedIncomeAmount,
          sourceId: auditRule.adjustmentCardId,
        },
      ],
    },
    dataset
  );
  if (auditedResult.status === "unsupported") {
    return { status: "unsupported", reasons: auditedResult.reasons };
  }

  const additionalTaxCents = Math.max(
    0,
    nonNegativeMoney(auditedResult.finalTax, "Audited tax liability") -
      nonNegativeMoney(preAuditResult.finalTax, "Pre-audit tax liability")
  );
  const penaltyCents = Math.round(
    additionalTaxCents * auditRule.penaltyPercentage
  );
  const taxSettlement = settleTaxPrepayment(fixedTaxPrepayment, auditedResult.finalTax);

  return {
    status: "supported",
    preAuditTax: preAuditResult,
    auditedTax: auditedResult,
    additionalTax: fromCents(additionalTaxCents),
    penalty: fromCents(penaltyCents),
    fixedTaxPrepayment,
    taxSettlement,
    totalAmountDue: fromCents(
      nonNegativeMoney(taxSettlement.amountDue, "Audited tax amount due") + penaltyCents
    ),
  };
}

export function reconcileRoundResources(input: {
  beginningCash: number;
  outstandingDebt: number;
  incomeCashInflows: number;
  otherCashInflows: number;
  livingCosts: number;
  personalExpenses: number;
  fixedTaxPrepayment: number;
  finalTaxLiability: number;
  auditPenalty: number;
}): {
  beginningCash: number;
  incomeCashInflows: number;
  otherCashInflows: number;
  livingCosts: number;
  personalExpenses: number;
  taxPrepaymentOutflow: number;
  taxRefund: number;
  taxAmountDue: number;
  auditPenaltyOutflow: number;
  debtPrincipalPayment: number;
  endingDebt: number;
  resourcesRetained: number;
  endingCash: number;
} {
  const beginningCents = toCents(input.beginningCash, "Beginning cash");
  const incomeCents = nonNegativeMoney(input.incomeCashInflows, "Income cash inflows");
  const otherInflowsCents = nonNegativeMoney(input.otherCashInflows, "Other cash inflows");
  const livingCostCents = nonNegativeMoney(input.livingCosts, "Living costs");
  const personalExpenseCents = nonNegativeMoney(input.personalExpenses, "Personal expenses");
  const prepaymentCents = nonNegativeMoney(input.fixedTaxPrepayment, "Fixed tax prepayment");
  const taxSettlement = settleTaxPrepayment(input.fixedTaxPrepayment, input.finalTaxLiability);
  const refundCents = nonNegativeMoney(taxSettlement.refund, "Tax refund");
  const amountDueCents = nonNegativeMoney(taxSettlement.amountDue, "Tax amount due");
  const auditPenaltyCents = nonNegativeMoney(input.auditPenalty, "Audit penalty");
  const loanPayment = calculateStudentLoanPayment(input.outstandingDebt);
  const debtPaymentCents = nonNegativeMoney(loanPayment.principalPayment, "Debt principal payment");

  const endingCents =
    beginningCents +
    incomeCents +
    otherInflowsCents -
    livingCostCents -
    personalExpenseCents -
    prepaymentCents +
    refundCents -
    amountDueCents -
    auditPenaltyCents -
    debtPaymentCents;
  const retainedCents = endingCents - beginningCents;

  return {
    beginningCash: fromCents(beginningCents),
    incomeCashInflows: fromCents(incomeCents),
    otherCashInflows: fromCents(otherInflowsCents),
    livingCosts: fromCents(livingCostCents),
    personalExpenses: fromCents(personalExpenseCents),
    taxPrepaymentOutflow: fromCents(prepaymentCents),
    taxRefund: fromCents(refundCents),
    taxAmountDue: fromCents(amountDueCents),
    auditPenaltyOutflow: fromCents(auditPenaltyCents),
    debtPrincipalPayment: fromCents(debtPaymentCents),
    endingDebt: loanPayment.endingDebt,
    resourcesRetained: fromCents(retainedCents),
    endingCash: fromCents(endingCents),
  };
}
