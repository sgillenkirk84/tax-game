import assert from "node:assert/strict";
import { test } from "node:test";
import dataset from "./workbook-data.json" with { type: "json" };
import { validateGameDataset } from "./validate.mjs";

test("imports the complete workbook gameplay catalog with normalized Wildcard fields", () => {
  assert.equal(dataset.cards.length, 74);
  assert.equal(dataset.pathways.length, 8);
  assert.deepEqual(
    dataset.cards.reduce((counts, card) => {
      const deck = card.deck.trim();
      counts[deck] = (counts[deck] ?? 0) + 1;
      return counts;
    }, {}),
    {
      Income: 16,
      Retirement: 10,
      "Life Event": 10,
      Deduction: 10,
      "Tax Prepayment": 10,
      Wildcard: 10,
      "Audit Result": 8,
    }
  );
  assert.equal(dataset.cards.find((card) => card.name === "Audit Trigger").id, "WILD-006");
  assert.equal(dataset.cards.find((card) => card.id === "INC-W2-007").effectValue, 90000);
  assert.equal(
    dataset.cards.find((card) => card.id === "INC-W2-007").source.originalValues.effectValue,
    "Income"
  );
  assert(
    dataset.cards
      .filter((card) => card.deck === "Wildcard")
      .every((card) => card.id === card.id.trim() && card.name === card.name.trim())
  );
  assert(dataset.cards.every((card) => card.source.sheet === "Card Deck" && Number.isInteger(card.source.row)));
  assert.equal(dataset.developerNotes.length, 518);
  assert.equal(dataset.workbookReferences.outputsAreIllustrative, true);
  assert(dataset.workbookReferences.lifeLedgerColumns.includes("Ending Resources"));
});

test("contains complete 2025 status, bracket, and credit tables", () => {
  assert.equal(dataset.taxRules.filingStatuses.length, 3);
  assert.equal(dataset.taxRules.brackets.length, 21);
  assert.equal(dataset.taxRules.credits.length, 3);
  assert(dataset.taxRules.filingStatuses.every((row) => row.fields["Tax Year"] === 2025));
  assert(dataset.taxRules.brackets.every((row) => row.fields["Tax Year"] === 2025));
  assert(dataset.taxRules.credits.every((row) => row.fields["Tax Year"] === 2025));
});

test("contains the approved game rules and simplified tax treatments", () => {
  const rules = dataset.gameRules.approved;
  assert.equal(rules.roundCount, 5);
  assert.equal(rules.betaTaxYear, 2025);
  assert.deepEqual(rules.retirement, {
    standardRetirementStartRound: 5,
    earlyRetirementPathwayId: "PATH-008",
    earlyRetirementStartRound: 4,
    earlyRetirementIncomeGuarantee: {
      annualAmount: 42000,
      socialSecurity: 12000,
      pensionAndInvestment: 30000,
    },
    protectedIncomeRule: "highest-annual-retirement-income-through-round-5",
    increaseClassification: "preserve-original-card-income-components",
    increaseClassificationStatus: "approved",
    separatelyAcquiredInvestmentsAreAdditional: true,
    duplicateInvestmentIncomeRule: "count-each-investment-event-once-per-round",
  });
  assert.deepEqual(rules.startingDecisions.map(({ startingCash, startingDebt }) => [startingCash, startingDebt]), [
    [10000, 0],
    [0, 0],
    [0, 20000],
  ]);
  assert.equal(rules.studentLoan.principalPaymentPerRound, 4000);
  assert.equal(rules.businessIncome.adjustmentPercentage, 0.09);
  assert.match(rules.businessIncome.status, /educational-simplification/);
  assert.equal(rules.socialSecurity.taxableFractionWhenRetirementOrInvestmentIncomeExists, 0.5);
  assert.equal(
    rules.taxCardTreatment.find((entry) => entry.treatment === "retirement-and-social-security-tax-treatment").status.startsWith("approved:"),
    true
  );
  assert.equal(rules.audit.adjustmentCardId, "AUD-008");
  assert.equal(rules.audit.omittedIncomeAmount, 5000);
  assert.equal(rules.auditPenaltyPercentage, 0.2);
  assert.equal(rules.educationBenefit.enhancementAmount, 500);
  assert.equal(rules.educationBenefit.maximumBenefit, 3000);
  assert.equal(rules.medicalDeduction.adjustedIncomeThresholdPercentage, 0.075);
  assert.equal(rules.taxPrepayment.fixedAtApplication, true);
  assert.deepEqual(
    rules.stageOrder,
    [
      "income-or-retirement",
      "life-event",
      "wildcard",
      "deduction",
      "tax-prepayment",
      "audit-if-triggered",
      "results-and-life-ledger",
    ]
  );
});

test("validates approved corrections, reports source provenance, and removes whitespace warnings", () => {
  const result = validateGameDataset(dataset);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.issues.some((issue) => issue.code === "CARD_ID_WHITESPACE"), false);
  assert.equal(result.issues.some((issue) => issue.code === "CARD_FIELD_WHITESPACE"), false);
  assert.equal(result.issues.some((issue) => issue.code === "UNRESOLVED_SOURCE_VALUE"), false);
});

test("indexes all explicitly identified tax-sensitive cards and their applicability", () => {
  const treatment = dataset.gameRules.approved.taxCardTreatment;
  assert.equal(treatment.find((entry) => entry.treatment === "business-income-adjustment").cardIds.length, 11);
  assert.equal(treatment.find((entry) => entry.treatment === "retirement-and-social-security-tax-treatment").cardIds.length, 10);
  assert.equal(treatment.find((entry) => entry.treatment === "audit-penalty").cardIds[0], "AUD-008");
  assert(dataset.gameRules.approved.cardApplicability.some((rule) => rule.cardIds.includes("LIFE-010")));
  assert(dataset.gameRules.approved.cardApplicability.some((rule) => rule.cardIds.includes("DED-003")));
  assert(dataset.gameRules.approved.cardApplicability.some((rule) => rule.cardIds.includes("AUD-007")));
});

test("retains retirement income components and delayed investment-income timing", () => {
  const retirementCards = dataset.cards.filter((card) => card.deck === "Retirement");
  assert.equal(retirementCards.length, 10);
  assert(retirementCards.every((card) => card.effectType === "Retirement Income" && card.durationRounds === 1));
  assert(retirementCards.every((card) => card.incomeComponents.reduce((sum, component) => sum + component.amount, 0) === card.amount));
  assert(retirementCards.some((card) => card.incomeComponents.some((component) => component.type === "retirement-or-investment-income")));
  const highPortfolio = retirementCards.find((card) => card.id === "RET-HIGH-003");
  assert.equal(highPortfolio.incomeComponents[0].type, "retirement-or-investment-income");
  assert.equal(highPortfolio.incomeComponents[0].originalType, "investment-or-retirement-income");
  assert.match(highPortfolio.incomeComponents[0].normalizationNote, /does not identify the source mix/);
  assert.deepEqual(
    retirementCards
      .filter((card) => card.amount > dataset.gameRules.approved.retirement.earlyRetirementIncomeGuarantee.annualAmount)
      .map((card) => card.id),
    ["RET-MIX-003", "RET-MIX-004", "RET-HIGH-001", "RET-HIGH-002", "RET-HIGH-003"]
  );
  const investments = dataset.cards.filter((card) => card.investment);
  assert.equal(investments.length, 4);
  assert(investments.every((card) => card.investment.recurringIncomeActivation === "following-round"));
});
