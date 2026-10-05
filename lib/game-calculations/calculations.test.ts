import assert from "node:assert/strict";
import { test } from "node:test";
import workbookData from "../game-data/workbook-data.json" with { type: "json" };
import {
  calculateAud008Audit,
  calculateEarlyRetirementIncome,
  calculateFederalIncomeTax,
  calculateGameTax,
  calculateProgressiveLivingCosts,
  calculateStudentLoanPayment,
  calculateTaxPrepayment,
  calculateWorkbookCredits,
  getStartingFinancialPosition,
  getRequiredGameRoundCount,
  getRetirementStartRound,
  reconcileRoundResources,
  selectDeduction,
  selectWorkbookDeduction,
  settleTaxPrepayment,
  type GameTaxInput,
} from "./calculations.ts";
import { itemizedDeductionForCard } from "./deduction-rules.ts";
import type { GameDataset } from "../game-data/types";
import { calculatePrepaymentDollars, settlementPreview } from "../tax-prepayment.ts";

const prepaymentCases = [
  { name: "credits reduce tax to zero", before: 1757, credits: 1757, final: 0, rate: 0.8, prepaid: 1406, refund: 1406, due: 0 },
  { name: "no credits", before: 1000, credits: 0, final: 1000, rate: 0.8, prepaid: 800, refund: 0, due: 200 },
  { name: "partial credits", before: 2000, credits: 500, final: 1500, rate: 0.8, prepaid: 1600, refund: 100, due: 0 },
  { name: "zero percent card", before: 2000, credits: 500, final: 1500, rate: 0, prepaid: 0, refund: 0, due: 1500 },
  { name: "100 percent card", before: 1757, credits: 1757, final: 0, rate: 1, prepaid: 1757, refund: 1757, due: 0 },
  { name: "overpayment card", before: 2000, credits: 500, final: 1500, rate: 1.15, prepaid: 2300, refund: 800, due: 0 },
  { name: "zero pre-credit tax", before: 0, credits: 0, final: 0, rate: 1.3, prepaid: 0, refund: 0, due: 0 },
];

for (const example of prepaymentCases) {
  test(`pre-credit Tax Prepayment: ${example.name}`, () => {
    assert.equal(example.before - example.credits, example.final);
    const payment = calculateTaxPrepayment(example.before, example.rate);
    assert.equal(payment.taxBeforePrepayment, example.before);
    assert.equal(payment.prepaidAmount, example.prepaid);
    assert.equal(calculatePrepaymentDollars(example.before, example.rate * 100), example.prepaid);
    assert.deepEqual(settleTaxPrepayment(payment.prepaidAmount, example.final), {
      taxPrepaid: example.prepaid,
      finalTaxLiability: example.final,
      refund: example.refund,
      amountDue: example.due,
    });
    assert.deepEqual(settlementPreview(example.final, payment.prepaidAmount), {
      kind: example.refund > 0 ? "refund" : example.due > 0 ? "due" : "settled",
      amount: example.refund || example.due,
    });
  });
}

test("real tax-engine credits leave prepayment independent and preserve one final tax cost", () => {
  for (const dependent of ["qualifying-child", "other-dependent"] as const) {
    const tax = calculateGameTax({
      incomeSources: [{ category: "w2-wages", amount: 33000, sourceId: "primary" }],
      filingStatus: "SINGLE",
      otherEligibleItemizedDeduction: 0,
      dependents: [{ sourceCardId: dependent === "qualifying-child" ? "LIFE-001" : "LIFE-002", category: dependent }],
    });
    if (tax.status !== "supported") {
      assert.fail(tax.reasons.join("; "));
    }
    const before = structuredClone(tax);
    const prepaid = calculateTaxPrepayment(tax.taxBeforeCredits, 0.8).prepaidAmount;
    assert.ok(prepaid > 0);
    assert.ok(tax.credits.creditsAppliedToTax > 0);
    assert.equal(tax.finalTax, tax.taxBeforeCredits - tax.credits.creditsAppliedToTax);
    if (dependent === "qualifying-child") {
      assert.equal(tax.finalTax, 0);
      assert.equal(settleTaxPrepayment(prepaid, tax.finalTax).refund, prepaid);
    } else {
      assert.ok(tax.finalTax > 0);
    }
    const settlement = settleTaxPrepayment(prepaid, tax.finalTax);
    assert.equal(Math.round((prepaid + settlement.amountDue - settlement.refund) * 100), Math.round(tax.finalTax * 100));
    assert.deepEqual(tax, before);
  }
});

test("calculates progressive single-filer tax at bracket boundaries", () => {
  assert.equal(calculateFederalIncomeTax(0, "SINGLE").tax, 0);
  assert.equal(calculateFederalIncomeTax(11925, "SINGLE").tax, 1192.5);
  assert.equal(calculateFederalIncomeTax(11926, "SINGLE").tax, 1192.62);
  assert.equal(calculateFederalIncomeTax(48475, "SINGLE").tax, 5578.5);
  assert.equal(calculateFederalIncomeTax(48476, "SINGLE").tax, 5578.72);
  assert.equal(calculateFederalIncomeTax(103350, "SINGLE").tax, 17651);
});

test("uses each selected 2025 filing-status bracket table", () => {
  assert.equal(calculateFederalIncomeTax(23850, "MFJ").tax, 2385);
  assert.equal(calculateFederalIncomeTax(17000, "HOH").tax, 1700);
  assert.throws(() => calculateFederalIncomeTax(-1, "SINGLE"), /cannot be negative/);
});

test("chooses the larger deduction and uses the standard deduction on a tie", () => {
  assert.deepEqual(selectDeduction(15750, 18000), { method: "itemized", amount: 18000 });
  assert.deepEqual(selectDeduction(15750, 15750), { method: "standard", amount: 15750 });
  assert.deepEqual(selectWorkbookDeduction("MFJ", 0), { method: "standard", amount: 31500 });
  assert.deepEqual(selectWorkbookDeduction("HOH", 25000), { method: "itemized", amount: 25000 });
});

test("applies workbook credits only when supported player/card conditions are active", () => {
  const credits = calculateWorkbookCredits({
    dependents: [
      { sourceCardId: "LIFE-001", category: "qualifying-child" },
      { sourceCardId: "LIFE-008", category: "other-dependent" },
      { sourceCardId: "PATH-003", category: "non-credit" },
    ],
    educationOpportunity: { active: true, qualifyingExpense: true },
  });
  assert.equal(credits.totalCredits, 5200);
  assert.deepEqual(credits.appliedCredits.map((credit) => credit.ruleId), [
    "TAX-2025-CTC",
    "TAX-2025-ODC",
    "TAX-2025-EDU",
  ]);
  assert.equal(
    calculateWorkbookCredits({
      dependents: [{ sourceCardId: "LIFE-001", category: "other-dependent" }],
    }).totalCredits,
    0
  );
});

test("classifies eligible LIFE-010 dependents as Other Dependents", () => {
  const credit = calculateWorkbookCredits({
    dependents: [{ sourceCardId: "LIFE-010", category: "unspecified" }],
  });
  assert.equal(credit.totalCredits, 500);
  assert.equal(credit.appliedCredits[0].ruleId, "TAX-2025-ODC");

  const otherCardTypeDoesNotOverrideLIFE010Classification = calculateWorkbookCredits({
    dependents: [{ sourceCardId: "LIFE-010", category: "qualifying-child" }],
  });
  assert.equal(otherCardTypeDoesNotOverrideLIFE010Classification.totalCredits, 500);
  assert.equal(otherCardTypeDoesNotOverrideLIFE010Classification.appliedCredits[0].ruleId, "TAX-2025-ODC");

  const inactiveOrIneligible = calculateWorkbookCredits({
    dependents: [{ sourceCardId: "LIFE-010", category: "non-credit" }],
  });
  assert.equal(inactiveOrIneligible.totalCredits, 0);
  assert.equal(inactiveOrIneligible.appliedCredits.length, 0);
});

test("enhances only an applicable Lifelong Learner education credit, capped at $3,000", () => {
  const regular = calculateWorkbookCredits({
    dependents: [],
    educationOpportunity: { active: true, qualifyingExpense: true },
  });
  assert.equal(regular.totalCredits, 2500);

  const enhanced = calculateWorkbookCredits({
    dependents: [],
    educationOpportunity: { active: true, qualifyingExpense: true },
    pathwayIds: ["PATH-005"],
  });
  assert.equal(enhanced.totalCredits, 3000);

  const higherBaseCredit: GameDataset = structuredClone(workbookData);
  const educationCredit = higherBaseCredit.taxRules.credits.find(
    (row) => row.fields["Rule ID"] === "TAX-2025-EDU"
  );
  assert.ok(educationCredit);
  educationCredit.fields.Amount = 2800;
  const capped = calculateWorkbookCredits(
    {
      dependents: [],
      educationOpportunity: { active: true, qualifyingExpense: true },
      pathwayIds: ["PATH-005"],
    },
    higherBaseCredit
  );
  assert.equal(capped.totalCredits, 3000);

  const notQualifying = calculateWorkbookCredits({
    dependents: [],
    educationOpportunity: { active: true, qualifyingExpense: false },
    pathwayIds: ["PATH-005"],
  });
  assert.equal(notQualifying.totalCredits, 0);

  const undetermined = calculateWorkbookCredits({
    dependents: [],
    educationOpportunity: { active: true, qualifyingExpense: null },
    pathwayIds: ["PATH-005"],
  });
  assert.match(undetermined.unsupported[0], /applicability/);

  const inactive = calculateWorkbookCredits({
    dependents: [],
    educationOpportunity: { active: false, qualifyingExpense: true },
    pathwayIds: ["PATH-005"],
  });
  assert.equal(inactive.totalCredits, 0);
});

test("calculates W-2 tax with the workbook standard deduction and zero income", () => {
  const zeroIncome = calculateGameTax({
    incomeSources: [],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(zeroIncome.status, "supported");
  assert.equal(zeroIncome.grossIncome, 0);
  assert.equal(zeroIncome.taxableIncome, 0);
  assert.equal(zeroIncome.finalTax, 0);

  const result = calculateGameTax({
    incomeSources: [{ category: "w2-wages", amount: 40000, sourceId: "INC-W2-003" }],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(result.status, "supported");
  if (result.status === "supported") {
    assert.equal(result.grossIncome, 40000);
    assert.equal(result.taxableIncome, 24250);
    assert.equal(result.finalTax, 2671.5);
  }
});

test("all pathways complete five rounds and use their approved retirement schedule", () => {
  for (const pathway of workbookData.pathways) {
    assert.equal(getRequiredGameRoundCount(pathway.id), 5, String(pathway.id));
    assert.equal(
      getRetirementStartRound(pathway.id),
      pathway.id === "PATH-008" ? 4 : 5,
      String(pathway.id)
    );
  }
  assert.throws(() => getRequiredGameRoundCount("PATH-999"), /Unknown Pathway/);
  assert.throws(() => getRetirementStartRound("PATH-999"), /Unknown Pathway/);
});

test("guarantees and classifies the Early Retiree's $42,000 annual minimum", () => {
  const protectedIncome = calculateEarlyRetirementIncome({
    roundNumber: 4,
    retirementCardId: "RET-SSA-001",
  });
  assert.equal(protectedIncome.status, "supported");
  assert.equal(protectedIncome.annualPackageAmount, 42000);
  assert.equal(protectedIncome.totalAnnualIncome, 42000);
  assert.equal(protectedIncome.winningRetirementCardId, null);
  assert.deepEqual(
    protectedIncome.retirementIncomeSources.map(({ category, amount }) => [category, amount]),
    [
      ["social-security", 12000],
      ["retirement-or-investment-income", 30000],
    ]
  );

  const estimatedTax = calculateGameTax({
    incomeSources: protectedIncome.incomeSources ?? [],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(estimatedTax.status, "supported");
  if (estimatedTax.status === "supported") {
    assert.equal(estimatedTax.grossIncome, 42000);
    assert.equal(estimatedTax.incomeByCategory["social-security"], 12000);
    assert.equal(estimatedTax.incomeByCategory["retirement-or-investment-income"], 30000);
    assert.equal(estimatedTax.socialSecurityIncludedInIncome, 6000);
    assert.equal(estimatedTax.adjustedGrossIncome, 36000);
    assert.equal(estimatedTax.taxableIncome, 20250);
    assert.equal(estimatedTax.finalTax, 2191.5);
  }
});

test("preserves each winning Retirement card's complete original annual package and classifications", () => {
  const retirementCards = workbookData.cards.filter((card) => card.deck === "Retirement");
  assert.equal(retirementCards.length, 10);

  for (const card of retirementCards) {
    const protectedIncome = calculateEarlyRetirementIncome({
      roundNumber: 4,
      retirementCardId: String(card.id),
    });
    const expectedPackage = Math.max(42000, Number(card.amount));
    assert.equal(protectedIncome.annualPackageAmount, expectedPackage, String(card.id));
    assert.equal(protectedIncome.totalAnnualIncome, expectedPackage, String(card.id));
    assert.equal(protectedIncome.currentRetirementCardId, card.id);
    if (Number(card.amount) <= 42000) {
      assert.equal(protectedIncome.winningRetirementCardId, null, String(card.id));
      assert.deepEqual(
        protectedIncome.retirementIncomeSources.map(({ category, amount }) => [category, amount]),
        [
          ["social-security", 12000],
          ["retirement-or-investment-income", 30000],
        ],
        String(card.id)
      );
    } else {
      assert.equal(protectedIncome.winningRetirementCardId, card.id, String(card.id));
      assert.deepEqual(
        protectedIncome.retirementIncomeSources.map(({ category, amount }) => [category, amount]),
        (card.incomeComponents ?? []).map(({ type, amount }) => [type, amount]),
        String(card.id)
      );
    }
    assert.equal(
      protectedIncome.retirementIncomeSources.reduce((sum, source) => sum + source.amount, 0),
      expectedPackage,
      String(card.id)
    );
  }
});

test("protects the highest eligible retirement outcome from Round 4 through Round 5", () => {
  const roundFour = calculateEarlyRetirementIncome({
    roundNumber: 4,
    retirementCardId: "RET-MIX-003",
  });
  assert.equal(roundFour.annualPackageAmount, 60000);
  assert.equal(roundFour.winningRetirementCardId, "RET-MIX-003");

  const weakerRoundFive = calculateEarlyRetirementIncome({
    roundNumber: 5,
    retirementCardId: "RET-SSA-001",
    previousRound: roundFour,
  });
  assert.equal(weakerRoundFive.annualPackageAmount, 60000);
  assert.equal(weakerRoundFive.winningRetirementCardId, "RET-MIX-003");
  assert.deepEqual(weakerRoundFive.retirementIncomeSources, roundFour.retirementIncomeSources);

  const strongerRoundFive = calculateEarlyRetirementIncome({
    roundNumber: 5,
    retirementCardId: "RET-MIX-004",
    previousRound: roundFour,
    additionalInvestmentIncome: [
      { investmentId: "investment-event-1", amount: 500 },
      { investmentId: "investment-event-2", amount: 500 },
    ],
  });
  assert.equal(strongerRoundFive.annualPackageAmount, 85000);
  assert.equal(strongerRoundFive.totalAnnualIncome, 86000);
  assert.equal(strongerRoundFive.winningRetirementCardId, "RET-MIX-004");
  assert.deepEqual(
    strongerRoundFive.retirementIncomeSources.map(({ category, amount }) => [category, amount]),
    [
      ["social-security", 30000],
      ["retirement-or-investment-income", 55000],
    ]
  );
  assert.equal(
    strongerRoundFive.incomeSources.reduce((sum, source) => sum + source.amount, 0),
    86000
  );
});

test("requires Round 4 protected state and only evaluates Early Retiree in Rounds 4 and 5", () => {
  assert.throws(
    () => calculateEarlyRetirementIncome({ roundNumber: 5, retirementCardId: "RET-SSA-001" }),
    /requires the Early Retiree's Round 4/
  );
  assert.throws(
    () => calculateEarlyRetirementIncome({ roundNumber: 3, retirementCardId: "RET-SSA-001" }),
    /only evaluated in rounds/
  );
  assert.throws(
    () => calculateEarlyRetirementIncome({ roundNumber: 4, retirementCardId: "INC-W2-001" }),
    /active Retirement card/
  );
});

test("adds distinct gameplay investment income once per investment event without altering the protected package", () => {
  const roundFour = calculateEarlyRetirementIncome({
    roundNumber: 4,
    retirementCardId: "RET-SSA-001",
    additionalInvestmentIncome: [
      { investmentId: "investment-event-1", amount: 500 },
      { investmentId: "investment-event-1", amount: 500 },
      { investmentId: "investment-event-2", amount: 500 },
    ],
  });
  assert.equal(roundFour.annualPackageAmount, 42000);
  assert.equal(roundFour.totalAnnualIncome, 43000);
  assert.deepEqual(
    roundFour.additionalInvestmentIncome.map(({ sourceId, amount }) => [sourceId, amount]),
    [
      ["investment-event-1", 500],
      ["investment-event-2", 500],
    ]
  );
  assert.equal(
    roundFour.incomeSources.reduce((sum, source) => sum + source.amount, 0),
    43000
  );

  const tax = calculateGameTax({
    incomeSources: roundFour.incomeSources,
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(tax.status, "supported");
  if (tax.status === "supported") {
    assert.equal(tax.incomeByCategory["social-security"], 12000);
    assert.equal(tax.incomeByCategory["retirement-or-investment-income"], 30000);
    assert.equal(tax.incomeByCategory["investment-income"], 1000);
    assert.equal(tax.grossIncome, 43000);
  }

  assert.throws(
    () =>
      calculateEarlyRetirementIncome({
        roundNumber: 4,
        retirementCardId: "RET-SSA-001",
        additionalInvestmentIncome: [
          { investmentId: "investment-event-1", amount: 500 },
          { investmentId: "investment-event-1", amount: 700 },
        ],
      }),
    /conflicting income values/
  );
});

test("keeps RET-HIGH-003's combined source classification and uses the approved tax treatment", () => {
  const result = calculateEarlyRetirementIncome({
    roundNumber: 4,
    retirementCardId: "RET-HIGH-003",
  });
  assert.equal(result.annualPackageAmount, 300000);
  assert.equal(result.winningRetirementCardId, "RET-HIGH-003");
  assert.deepEqual(
    result.retirementIncomeSources.map(({ category, amount }) => [category, amount]),
    [["retirement-or-investment-income", 300000]]
  );

  const tax = calculateGameTax({
    incomeSources: result.incomeSources,
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(tax.status, "supported");
  if (tax.status === "supported") {
    assert.equal(tax.incomeByCategory["retirement-or-investment-income"], 300000);
    assert.equal(tax.incomeByCategory["social-security"], 0);
    assert.equal(tax.adjustedGrossIncome, 300000);
  }
});

test("applies the 9% business adjustment once while retaining original business income", () => {
  const businessCardIds = [
    "INC-BIZ-001", "INC-BIZ-002", "INC-BIZ-003", "INC-BIZ-004",
    "INC-BIZ-005", "INC-BIZ-006", "INC-BIZ-007", "INC-BIZ-008",
    "WILD-002", "WILD-004",
  ];
  for (const sourceId of businessCardIds) {
    const result = calculateGameTax({
      incomeSources: [{ category: "business-net-income", amount: 40000, sourceId }],
      filingStatus: "SINGLE",
      otherEligibleItemizedDeduction: 0,
    });
    assert.equal(result.status, "supported", sourceId);
    if (result.status === "supported") {
      assert.equal(result.grossIncome, 40000);
      assert.equal(result.incomeByCategory["business-net-income"], 40000);
      assert.equal(result.businessIncomeAdjustment, 3600);
      assert.match(result.businessIncomeAdjustmentNote, /educational simplification; not actual self-employment tax/);
      assert.equal(result.adjustedGrossIncome, 36400);
    }
  }

  const withAud007AddBack = calculateGameTax({
    incomeSources: [
      { category: "business-net-income", amount: 40000, sourceId: "INC-BIZ-001" },
      { category: "business-net-income", amount: 4000, sourceId: "AUD-007" },
    ],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(withAud007AddBack.status, "supported");
  assert.equal(withAud007AddBack.grossIncome, 44000);
  assert.equal(withAud007AddBack.businessIncomeAdjustment, 3960);
  assert.equal(withAud007AddBack.adjustedGrossIncome, 40040);
});

test("treats Social Security-only benefits as nontaxable and includes half in mixed retirement income", () => {
  const benefitsOnly = calculateGameTax({
    incomeSources: [{ category: "social-security", amount: 18000, sourceId: "RET-SSA-001" }],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(benefitsOnly.status, "supported");
  assert.equal(benefitsOnly.grossIncome, 18000);
  assert.equal(benefitsOnly.adjustedGrossIncome, 0);
  assert.equal(benefitsOnly.socialSecurityIncludedInIncome, 0);
  assert.equal(benefitsOnly.incomeByCategory["social-security"], 18000);

  const wagesAndBenefits = calculateGameTax({
    incomeSources: [
      { category: "social-security", amount: 18000, sourceId: "RET-SSA-001" },
      { category: "w2-wages", amount: 40000, sourceId: "INC-W2-003" },
    ],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(wagesAndBenefits.status, "unsupported");
  if (wagesAndBenefits.status === "unsupported") {
    assert.match(wagesAndBenefits.reasons[0], /do not define Social Security treatment/);
  }

  const mixed = calculateGameTax({
    incomeSources: [
      { category: "social-security", amount: 22000, sourceId: "RET-MIX-001" },
      { category: "retirement-distribution", amount: 8000, sourceId: "RET-MIX-001" },
    ],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(mixed.status, "supported");
  assert.equal(mixed.grossIncome, 30000);
  assert.equal(mixed.socialSecurityIncludedInIncome, 11000);
  assert.equal(mixed.adjustedGrossIncome, 19000);
});

test("taxes recurring investment income but not investment asset balances", () => {
  const assetOnly = calculateGameTax({
    incomeSources: [{ category: "w2-wages", amount: 40000, sourceId: "INC-W2-003" }],
    investmentAssets: [{ sourceCardId: "WILD-007", value: 10000 }],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  const withRecurringIncome = calculateGameTax({
    incomeSources: [
      { category: "w2-wages", amount: 40000, sourceId: "INC-W2-003" },
      { category: "investment-income", amount: 500, sourceId: "WILD-007" },
    ],
    investmentAssets: [{ sourceCardId: "WILD-007", value: 10000 }],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(assetOnly.status, "supported");
  assert.equal(withRecurringIncome.status, "supported");
  assert.equal(assetOnly.grossIncome, 40000);
  assert.equal(assetOnly.investmentAssetValue, 10000);
  assert.equal(withRecurringIncome.grossIncome, 40500);
  assert.equal(withRecurringIncome.investmentAssetValue, 10000);
  if (assetOnly.status === "supported" && withRecurringIncome.status === "supported") {
    assert.equal(assetOnly.taxableIncome, 24250);
    assert.equal(withRecurringIncome.taxableIncome, 24750);
    assert.equal(withRecurringIncome.finalTax > assetOnly.finalTax, true);
  }

  const combinedIncome = calculateGameTax({
    incomeSources: [{
      category: "retirement-or-investment-income",
      amount: 32000,
      sourceId: "RET-MIX-003",
    }],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(combinedIncome.status, "supported");
  assert.equal(combinedIncome.incomeByCategory["retirement-or-investment-income"], 32000);
  assert.equal(combinedIncome.adjustedGrossIncome, 32000);
});

test("requires the approved educational household conditions and uses HOH table values", () => {
  const eligibilityCases = [
    { unmarried: false, qualifyingDependent: true },
    { unmarried: true, qualifyingDependent: false },
  ];
  for (const headOfHousehold of eligibilityCases) {
    const result = calculateGameTax({
      incomeSources: [{ category: "w2-wages", amount: 40000, sourceId: "INC-W2-003" }],
      filingStatus: "HOH",
      headOfHousehold,
      otherEligibleItemizedDeduction: 0,
    });
    assert.equal(result.status, "unsupported");
  }

  const eligible = calculateGameTax({
    incomeSources: [{ category: "w2-wages", amount: 40000, sourceId: "INC-W2-003" }],
    filingStatus: "HOH",
    headOfHousehold: {
      unmarried: true,
      qualifyingDependent: true,
    },
    otherEligibleItemizedDeduction: 0,
  });
  assert.equal(eligible.status, "supported");
  if (eligible.status === "supported") {
    assert.equal(eligible.deductionAmount, 23625);
    assert.equal(eligible.taxableIncome, 16375);
  }
});

test("deducts medical expenses only above the 7.5% adjusted-income threshold", () => {
  const atThreshold = calculateGameTax({
    incomeSources: [{ category: "w2-wages", amount: 100000, sourceId: "INC-W2-003" }],
    medicalExpenses: 7500,
    otherEligibleItemizedDeduction: 0,
    filingStatus: "SINGLE",
  });
  assert.equal(atThreshold.medicalDeduction, 0);

  const oneDollarOver = calculateGameTax({
    incomeSources: [{ category: "w2-wages", amount: 100000, sourceId: "INC-W2-003" }],
    medicalExpenses: 7501,
    otherEligibleItemizedDeduction: 15749,
    filingStatus: "SINGLE",
  });
  assert.equal(oneDollarOver.medicalDeduction, 1);
  assert.equal(oneDollarOver.eligibleItemizedDeduction, 15750);
  assert.equal(oneDollarOver.status, "supported");
  if (oneDollarOver.status === "supported") {
    assert.equal(oneDollarOver.deductionMethod, "standard");
  }

  const itemizedWins = calculateGameTax({
    incomeSources: [{ category: "w2-wages", amount: 100000, sourceId: "INC-W2-003" }],
    medicalExpenses: 32500,
    otherEligibleItemizedDeduction: 0,
    filingStatus: "SINGLE",
  });
  assert.equal(itemizedWins.medicalDeduction, 25000);
  assert.equal(itemizedWins.status, "supported");
  if (itemizedWins.status === "supported") {
    assert.equal(itemizedWins.deductionMethod, "itemized");
    assert.equal(itemizedWins.deductionAmount, 25000);
  }
});

test("applies AUD-008 omitted income and incremental-tax penalty without changing locked prepayment", () => {
  const taxInput: GameTaxInput = {
    incomeSources: [{ category: "w2-wages", amount: 50000, sourceId: "INC-W2-003" }],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
  };
  const preAuditTax = calculateGameTax(taxInput);
  if (preAuditTax.status !== "supported") {
    assert.fail(preAuditTax.reasons.join("; "));
  }
  const lockedPrepayment = calculateTaxPrepayment(preAuditTax.taxBeforeCredits, 0.9).prepaidAmount;
  const audit = calculateAud008Audit({ taxInput, fixedTaxPrepayment: lockedPrepayment });
  if (audit.status !== "supported") {
    assert.fail(audit.reasons.join("; "));
  }
  assert.equal(audit.auditedTax.grossIncome, 55000);
  assert.equal(audit.additionalTax, 600);
  assert.equal(audit.penalty, 120);
  assert.equal(audit.fixedTaxPrepayment, lockedPrepayment);
  assert.equal(audit.taxSettlement.taxPrepaid, lockedPrepayment);
  assert.equal(
    audit.taxSettlement.amountDue,
    Math.round((audit.auditedTax.finalTax - lockedPrepayment) * 100) / 100
  );
  assert.equal(
    audit.totalAmountDue,
    Math.round((audit.taxSettlement.amountDue + audit.penalty) * 100) / 100
  );

  assert.throws(
    () => calculateAud008Audit({
      taxInput: {
        ...taxInput,
        incomeSources: [
          ...taxInput.incomeSources,
          { category: "other-taxable-income", amount: 5000, sourceId: "AUD-008" },
        ],
      },
      fixedTaxPrepayment: lockedPrepayment,
    }),
    /already present/
  );
});

test("uses the locked tax payment for refunds and balances due", () => {
  const lockedPayment = calculateTaxPrepayment(1000, 0.9);
  assert.deepEqual(lockedPayment, { taxBeforePrepayment: 1000, rate: 0.9, prepaidAmount: 900 });
  assert.deepEqual(settleTaxPrepayment(lockedPayment.prepaidAmount, 1200), {
    taxPrepaid: 900,
    finalTaxLiability: 1200,
    refund: 0,
    amountDue: 300,
  });
  assert.deepEqual(settleTaxPrepayment(1200, 1000), {
    taxPrepaid: 1200,
    finalTaxLiability: 1000,
    refund: 200,
    amountDue: 0,
  });
});

test("calculates progressive living costs by marginal bands", () => {
  assert.equal(calculateProgressiveLivingCosts(0), 0);
  assert.equal(calculateProgressiveLivingCosts(30000), 25500);
  assert.equal(calculateProgressiveLivingCosts(40000), 31000);
  assert.equal(calculateProgressiveLivingCosts(50000), 36500);
  assert.equal(calculateProgressiveLivingCosts(75000), 47750);
  assert.equal(calculateProgressiveLivingCosts(100000), 56500);
  assert.equal(calculateProgressiveLivingCosts(110000), 59000);
});

test("loads approved starting cash and debt scenarios", () => {
  assert.deepEqual(getStartingFinancialPosition("financial-head-start"), { cash: 10000, debt: 0 });
  assert.deepEqual(getStartingFinancialPosition("starting-from-scratch"), { cash: 0, debt: 0 });
  assert.deepEqual(getStartingFinancialPosition("student-loan-debt"), { cash: 0, debt: 20000 });
  assert.throws(() => getStartingFinancialPosition("unknown"), /Unknown Starting Decision/);
});

test("applies end-of-round loan principal payments capped at outstanding debt", () => {
  assert.deepEqual(calculateStudentLoanPayment(20000), { principalPayment: 4000, endingDebt: 16000 });
  assert.deepEqual(calculateStudentLoanPayment(2500), { principalPayment: 2500, endingDebt: 0 });
  assert.deepEqual(calculateStudentLoanPayment(0), { principalPayment: 0, endingDebt: 0 });
});

test("reconciles prepayment, tax balance, audit penalty, and debt exactly once", () => {
  const result = reconcileRoundResources({
    beginningCash: 0,
    outstandingDebt: 20000,
    incomeCashInflows: 1000,
    otherCashInflows: 0,
    livingCosts: 900,
    personalExpenses: 0,
    fixedTaxPrepayment: 120,
    finalTaxLiability: 150,
    auditPenalty: 120,
  });
  assert.equal(result.taxAmountDue, 30);
  assert.equal(result.auditPenaltyOutflow, 120);
  assert.equal(result.debtPrincipalPayment, 4000);
  assert.equal(result.endingDebt, 16000);
  assert.equal(result.resourcesRetained, -4170);
  assert.equal(result.endingCash, -4170);
});

test("rejects money values that cannot be safely represented", () => {
  assert.throws(() => calculateTaxPrepayment(-1, 1), /cannot be negative/);
  assert.throws(() => calculateTaxPrepayment(1, -0.1), /non-negative/);
  assert.throws(
    () => reconcileRoundResources({
      beginningCash: 0,
      outstandingDebt: -1,
      incomeCashInflows: 1,
      otherCashInflows: 0,
      livingCosts: 0,
      personalExpenses: 0,
      fixedTaxPrepayment: 1,
      finalTaxLiability: 1,
      auditPenalty: 0,
    }),
    /Outstanding student-loan debt cannot be negative/
  );
});

test("treats credits as nonrefundable and reports available, applied and unused amounts", () => {
  const result = calculateGameTax({
    incomeSources: [{ category: "w2-wages", amount: 17000, sourceId: "INC-W2-001" }],
    filingStatus: "SINGLE",
    otherEligibleItemizedDeduction: 0,
    dependents: [{ sourceCardId: "LIFE-001", category: "qualifying-child" }],
  });
  assert.equal(result.status, "supported");
  if (result.status === "supported") {
    assert.equal(result.taxBeforeCredits, 125);
    assert.equal(result.credits.availableCredits, 2200);
    assert.equal(result.credits.creditsAppliedToTax, 125);
    assert.equal(result.credits.unusedCredits, 2075);
    assert.equal(result.finalTax, 0);
  }
});

test("applies the approved simplified formula for all ten Deduction cards", () => {
  const standard = selectWorkbookDeduction("SINGLE", 0).amount;
  assert.equal(standard, 15750);
  const dataset = workbookData as unknown as GameDataset;
  const deductionCards = dataset.cards.filter((card) => card.deck === "Deduction");
  assert.equal(deductionCards.length, 10);
  const expected: Record<string, { method: string; deduction: number }> = {
    "DED-001": { method: "standard", deduction: 15750 },
    "DED-002": { method: "standard", deduction: 15750 },
    "DED-003": { method: "standard", deduction: 15750 },
    "DED-004": { method: "standard", deduction: 15750 },
    "DED-005": { method: "standard", deduction: 15750 },
    "DED-006": { method: "itemized", deduction: 23750 },
    "DED-007": { method: "itemized", deduction: 24750 },
    "DED-008": { method: "itemized", deduction: 25750 },
    "DED-009": { method: "itemized", deduction: 18000 },
    "DED-010": { method: "itemized", deduction: 25000 },
  };
  for (const rawCard of deductionCards) {
    const card = { id: rawCard.id as string, amount: rawCard.amount };
    const itemized = itemizedDeductionForCard(card.id, card.amount as number, standard);
    assert.notEqual(itemized, null, card.id);
    const result = calculateGameTax({
      incomeSources: [{ category: "w2-wages", amount: 60000, sourceId: "INC-W2-001" }],
      filingStatus: "SINGLE",
      otherEligibleItemizedDeduction: itemized as number,
    });
    assert.equal(result.status, "supported", card.id);
    assert.equal(result.deductionMethod, expected[card.id].method, card.id);
    assert.equal(result.deductionAmount, expected[card.id].deduction, card.id);
  }
  assert.equal(itemizedDeductionForCard("DED-099", 1, standard), null);
  // The same formula follows the filing status's standard deduction.
  assert.equal(itemizedDeductionForCard("DED-007", 9000, 31500), 40500);
});
