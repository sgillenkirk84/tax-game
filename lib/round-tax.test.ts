import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildRoundTaxCalculation, type RoundTaxSnapshot } from "./round-tax.ts";
import { dependentExpiresAfter } from "./round-rules.ts";
import { computeRoundResults, economicGrossIncome, toFinalizePayload } from "./round-results.ts";
import { calculateFederalIncomeTax } from "./game-calculations/calculations.ts";

function snapshot(options: {
  round?: number;
  filing?: string;
  pathway?: string;
  lifeCard?: string;
  income?: string[];
  wildcard?: string;
  choice?: string;
} = {}): RoundTaxSnapshot {
  const round = options.round ?? 1;
  const entry = (cardId: string, stage: string, order = 1) => ({
    history_id: `${stage}-${order}`,
    card_id: cardId,
    stage,
    order_in_stage: order,
    choices: stage === "wildcard" && options.choice ? { expense_type: options.choice } : null,
  });
  return {
    life: {
      id: "life", status: "in_progress", pathway_id: options.pathway ?? "PATH-004",
      starting_decision_id: "starting-from-scratch", tax_year: 2025, rules_version: "household-test",
      current_round: round, current_stage: "deduction", filing_status: options.filing ?? "SINGLE",
      homeowner: false, cash_resources: 0, student_loan_debt: 0,
    },
    round: {
      id: "round", round_number: round, status: "in_progress", current_stage: "deduction",
      beginning_cash_resources: 0, beginning_student_loan_debt: 0, calculation: null,
    },
    cards: [
      ...(options.income ?? ["INC-W2-004"]).map((id, index) => entry(id, "income-or-retirement", index + 1)),
      entry(options.lifeCard ?? "LIFE-005", "life-event"),
      entry(options.wildcard ?? "WILD-006", "wildcard"),
      entry("DED-001", "deduction"),
    ],
    effects: [],
    investments: [],
  };
}

function dependent(added: number, source = "LIFE-001", status = "active"): RoundTaxSnapshot["effects"][number] {
  return {
    source_card_id: source, effect_type: "add-dependent", starts_round: added,
    expires_after_round: dependentExpiresAfter(added), status,
    details: { category: source === "LIFE-001" ? "qualifying-child" : "other-dependent" },
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function calculate(input: RoundTaxSnapshot) {
  const before = structuredClone(input);
  const built = buildRoundTaxCalculation(input);
  assert.ok(built.ok, !built.ok ? `${built.code}: ${built.message}` : "");
  assert.deepEqual(input, before, "calculation must not mutate trusted input state");
  const calculation = built.calculation;
  const applied = record(calculation.input_snapshot);
  assert.ok(Array.isArray(applied.income_sources));
  assert.ok(Array.isArray(applied.dependents));
  return {
    calculation,
    round: record(calculation.round),
    applied,
    sources: applied.income_sources.map(record),
    dependents: applied.dependents.map(record),
    changes: record(calculation.pending_state_changes),
  };
}

test("unmarried with no dependents is Single and has no spouse income", () => {
  const result = calculate(snapshot());
  assert.equal(result.applied.filing_status_applied, "SINGLE");
  assert.equal(result.changes.filing_status, "SINGLE");
  assert.equal(result.applied.spouse_income, null);
  assert.equal(result.round.gross_income, 50000);
});

for (const count of [1, 2]) {
  test(`unmarried with ${count} active qualifying dependents derives HOH`, () => {
    const input = snapshot({ round: 2 });
    input.effects = [dependent(1), dependent(2, "LIFE-008")].slice(0, count);
    const result = calculate(input);
    assert.equal(result.dependents.length, count);
    assert.equal(result.applied.filing_status_applied, "HOH");
    assert.equal(result.changes.filing_status, "HOH");
    assert.equal(result.round.standard_deduction, 23625);
    assert.equal(result.round.taxable_income, 26375);
    assert.equal(result.round.tax_before_credits, calculateFederalIncomeTax(26375, "HOH").tax);
  });
}

for (const lifeCard of ["LIFE-001", "LIFE-002", "LIFE-008", "LIFE-010"]) {
  test(`${lifeCard} establishes current-round HOH while unmarried`, () => {
    const result = calculate(snapshot({ lifeCard }));
    assert.equal(result.applied.filing_status_applied, "HOH");
    assert.equal(result.dependents.length, 1);
  });
}

test("married with a dependent remains MFJ and adds exactly one spouse source", () => {
  const result = calculate(snapshot({ filing: "MFJ", lifeCard: "LIFE-001" }));
  assert.equal(result.applied.filing_status_applied, "MFJ");
  assert.equal(result.round.gross_income, 100000);
  assert.equal(result.round.standard_deduction, 31500);
  assert.equal(result.sources.filter((source) => String(source.sourceId).startsWith("spouse:")).length, 1);
  assert.equal(record(result.calculation.credits).available, 2200);
});

for (const remaining of [0, 1]) {
  test(`divorce removes spouse income with ${remaining} remaining dependents`, () => {
    const input = snapshot({ round: 3, filing: "MFJ", lifeCard: "LIFE-004" });
    if (remaining) input.effects = [dependent(2, "LIFE-008")];
    const result = calculate(input);
    assert.equal(result.applied.filing_status_applied, remaining ? "HOH" : "SINGLE");
    assert.equal(result.changes.filing_status, remaining ? "HOH" : "SINGLE");
    assert.equal(result.applied.spouse_income, null);
    assert.equal(result.round.gross_income, 50000);
    assert.equal(result.dependents.length, remaining);
  });
}

for (const lifeCard of ["LIFE-003", "LIFE-007"]) {
  test(`${lifeCard} restores MFJ and spouse income from unmarried HOH`, () => {
    const input = snapshot({ round: 3, filing: "HOH", lifeCard });
    input.effects = [dependent(2, "LIFE-008")];
    const result = calculate(input);
    assert.equal(result.changes.filing_status, "MFJ");
    assert.equal(result.round.gross_income, 100000);
    assert.equal(record(result.applied.spouse_income).amount, 50000);
  });
}

test("dependent gained Round 1 counts Round 1/2 but not Round 3", () => {
  const gained = calculate(snapshot({ lifeCard: "LIFE-001" }));
  assert.equal(gained.applied.filing_status_applied, "HOH");
  for (const round of [2, 3]) {
    const input = snapshot({ round, filing: "HOH" });
    input.effects = [dependent(1)];
    const result = calculate(input);
    assert.equal(result.dependents.length, round === 2 ? 1 : 0);
    assert.equal(result.changes.filing_status, round === 2 ? "HOH" : "SINGLE");
  }
});

test("dependent gained Round 2 counts Round 2/3; Round 3 gain expires after Round 4", () => {
  assert.equal(dependent(2).expires_after_round, 3);
  assert.equal(dependent(3).expires_after_round, 4);
  const gained = calculate(snapshot({ round: 2, lifeCard: "LIFE-008" }));
  assert.equal(gained.dependents.length, 1);
  const input = snapshot({ round: 3, filing: "HOH" });
  input.effects = [dependent(2, "LIFE-008")];
  assert.equal(calculate(input).dependents.length, 1);
});

test("Round 3 target household: child expired, parent active, divorce gives HOH", () => {
  const input = snapshot({ round: 3, filing: "MFJ", lifeCard: "LIFE-004" });
  input.effects = [dependent(1), dependent(2, "LIFE-008")];
  const result = calculate(input);
  assert.equal(result.dependents.length, 1);
  assert.equal(result.dependents[0].sourceCardId, "LIFE-008");
  assert.equal(result.changes.filing_status, "HOH");
  assert.equal(result.applied.spouse_income, null);
});

test("removed and expired dependents do not establish HOH", () => {
  const input = snapshot({ round: 2, filing: "HOH" });
  input.effects = [dependent(1, "LIFE-001", "removed"), dependent(1, "LIFE-008", "expired")];
  assert.equal(calculate(input).changes.filing_status, "SINGLE");
});

test("LIFE-006 removes the last temporary dependent before deriving filing status", () => {
  const input = snapshot({ round: 2, filing: "HOH", lifeCard: "LIFE-006" });
  input.effects = [dependent(1)];
  const result = calculate(input);
  assert.equal(result.dependents.length, 0);
  assert.equal(result.changes.filing_status, "SINGLE");
});

test("Caregiver remains HOH with a permanent non-credit dependent after temporary removal", () => {
  const input = snapshot({ round: 2, pathway: "PATH-003", lifeCard: "LIFE-006" });
  input.effects = [dependent(1)];
  const result = calculate(input);
  assert.equal(result.changes.filing_status, "HOH");
  assert.deepEqual(result.dependents, [{ sourceCardId: "PATH-003", category: "non-credit" }]);
  assert.equal(record(result.calculation.credits).available, 0);
  const later = calculate(snapshot({ round: 3, pathway: "PATH-003" }));
  assert.equal(later.dependents.length, 1);
  assert.equal(later.changes.filing_status, "HOH");
});

test("married spouse source does not duplicate investments or Wildcard earnings", () => {
  for (const wildcard of ["WILD-001", "WILD-002", "WILD-003"]) {
    const input = snapshot({ round: 2, filing: "MFJ", wildcard });
    input.investments = [{
      source_type: "card-history", source_card_id: "WILD-007", acquired_round: 1,
      activation_round: 2, recurring_income_per_round: 500, asset_value: 10000, status: "active",
    }];
    const result = calculate(input);
    const extra = wildcard === "WILD-001" ? 7500 : wildcard === "WILD-002" ? 10000 : 0;
    assert.equal(result.round.gross_income, 100500 + extra);
    assert.equal(record(result.round.income_by_category)["investment-income"], 500);
    assert.equal(result.round.investment_asset_value, 10000);
    assert.equal(result.sources.filter((source) => String(source.sourceId).startsWith("spouse:")).length, 1);
    if (wildcard === "WILD-003") {
      assert.ok(Array.isArray(result.calculation.pending_effects));
      assert.equal(result.calculation.pending_effects.length, 1);
    }
  }
});

for (const pathway of ["PATH-002", "PATH-006"]) {
  test(`${pathway} doubles only the first saved Income card, not both`, () => {
    const input = snapshot({ pathway, filing: "MFJ", income: ["INC-W2-004", "INC-BIZ-002"] });
    input.cards.reverse();
    const result = calculate(input);
    assert.equal(result.round.gross_income, 125000);
    assert.equal(record(result.applied.spouse_income).category, "w2-wages");
    assert.equal(record(result.round.income_by_category)["business-net-income"], 25000);
  });
}

test("Corporate Climber spouse matches retained primary amount and classification", () => {
  const input = snapshot({ round: 2, pathway: "PATH-001", filing: "MFJ", income: ["INC-W2-001"] });
  input.life.corporate_climber_primary = { card_id: "INC-BIZ-004", established_round: 1 };
  const result = calculate(input);
  assert.equal(result.round.gross_income, 100000);
  assert.deepEqual(result.applied.spouse_income, {
    sourceId: "spouse:INC-BIZ-004", category: "business-net-income", amount: 50000,
  });
  assert.deepEqual(result.calculation.persistent_updates, {
    corporate_climber_primary: { card_id: "INC-BIZ-004", established_round: 1 },
  });
});

test("married business primary keeps its classification and receives the normal 9% adjustment", () => {
  const result = calculate(snapshot({ filing: "MFJ", income: ["INC-BIZ-004"] }));
  assert.equal(result.round.gross_income, 100000);
  assert.equal(record(result.round.income_by_category)["business-net-income"], 100000);
  assert.equal(result.round.business_income_adjustment, 9000);
  assert.equal(result.round.adjusted_gross_income, 91000);
  assert.equal(record(result.applied.spouse_income).category, "business-net-income");
});

test("marriage changes the deduction table without duplicating the Deduction card amount", () => {
  const input = snapshot({ filing: "MFJ" });
  const deduction = input.cards.find((card) => card.stage === "deduction");
  assert.ok(deduction);
  deduction.card_id = "DED-006";
  const result = calculate(input);
  assert.equal(result.round.standard_deduction, 31500);
  assert.equal(result.round.deduction_amount, 39500);
});

test("a higher Corporate Climber card updates individual primary, not doubled household income", () => {
  const input = snapshot({ round: 3, pathway: "PATH-001", filing: "MFJ", income: ["INC-W2-005"] });
  input.life.corporate_climber_primary = { card_id: "INC-BIZ-004", established_round: 1 };
  const result = calculate(input);
  assert.equal(result.round.gross_income, 120000);
  assert.equal(record(result.applied.spouse_income).amount, 60000);
  assert.equal(record(result.applied.spouse_income).category, "w2-wages");
  assert.deepEqual(result.calculation.persistent_updates, {
    corporate_climber_primary: { card_id: "INC-W2-005", established_round: 3 },
  });
});

for (const choice of ["personal", "business"]) {
  test(`married business primary with WILD-004 ${choice} incurs one $5,000 cash expense`, () => {
    const result = calculate(snapshot({
      filing: "MFJ", income: ["INC-BIZ-004"], wildcard: "WILD-004", choice,
    }));
    assert.equal(record(result.applied.spouse_income).amount, 50000);
    assert.equal(result.round.gross_income, choice === "business" ? 95000 : 100000);
    assert.equal(result.round.business_income_adjustment, choice === "business" ? 8550 : 9000);
    assert.equal(record(result.applied.wild_004).business_income_reduction, choice === "business" ? 5000 : 0);
    assert.ok(Array.isArray(result.calculation.pending_effects));
    assert.equal(result.calculation.pending_effects.length, 1);
    assert.equal(typeof result.round.gross_income, "number");
    const gross = economicGrossIncome(Number(result.round.gross_income), result.calculation.pending_effects);
    const reconciled = computeRoundResults({
      beginningCash: 0, beginningDebt: 0, grossIncome: gross,
      adjustedGrossIncome: Number(result.round.adjusted_gross_income),
      finalTax: 0, fixedPrepayment: 0, pendingEffects: result.calculation.pending_effects,
    });
    assert.equal(gross, 100000);
    assert.equal(reconciled.personalExpenses, 5000);
    assert.equal(gross - reconciled.personalExpenses, 95000);
  });
}

test("WILD-004 business choice with no business income has zero tax reduction and one cash expense", () => {
  const result = calculate(snapshot({ filing: "MFJ", wildcard: "WILD-004", choice: "business" }));
  assert.equal(result.round.gross_income, 100000);
  assert.equal(record(result.applied.wild_004).business_income_reduction, 0);
  assert.ok(Array.isArray(result.calculation.pending_effects));
  assert.equal(result.calculation.pending_effects.length, 1);
  assert.equal(record(result.calculation.pending_effects[0]).cash_delta, -5000);
});

test("rebuilding inputs is deterministic and never accumulates spouse income", () => {
  const input = snapshot({ filing: "MFJ" });
  assert.deepEqual(calculate(input).calculation, calculate(input).calculation);
  assert.equal(calculate(input).round.gross_income, 100000);
});

test("finalized rounds are rejected and existing saved calculations remain replay-only", () => {
  const input = snapshot({ filing: "MFJ" });
  input.round.status = "finalized";
  const built = buildRoundTaxCalculation(input);
  assert.ok(!built.ok);
  assert.equal(built.code, "ROUND_NOT_OPEN");
  const route = readFileSync(new URL("../app/api/rounds/tax-calculate/route.ts", import.meta.url), "utf8");
  assert.ok(route.indexOf("if (snapshot.round.calculation)") < route.indexOf("const built = buildRoundTaxCalculation"));
});

for (const pathway of ["PATH-001", "PATH-002", "PATH-003", "PATH-004", "PATH-005", "PATH-006", "PATH-007", "PATH-008"]) {
  test(`Round 3 ${pathway} uses shared Income, household and persistent investment rules`, () => {
    const income = pathway === "PATH-002" || pathway === "PATH-006"
      ? ["INC-W2-004", "INC-BIZ-002"] : ["INC-W2-004"];
    const input = snapshot({ round: 3, pathway, filing: "MFJ", lifeCard: "LIFE-001", income });
    input.life.homeowner = true;
    input.life.cash_resources = 14250;
    input.life.student_loan_debt = 12000;
    input.round.beginning_cash_resources = 14250;
    input.round.beginning_student_loan_debt = 12000;
    input.effects = [dependent(1), dependent(2, "LIFE-008"), dependent(2, "LIFE-010", "removed")];
    input.investments = [{
      source_type: "card-history", source_card_id: "WILD-007", acquired_round: 2,
      activation_round: 3, recurring_income_per_round: 500, asset_value: 10000, status: "active",
    }];
    if (pathway === "PATH-001") {
      input.life.corporate_climber_primary = { card_id: "INC-BIZ-004", established_round: 2 };
    }
    const result = calculate(input);
    assert.equal(result.applied.filing_status_applied, "MFJ");
    assert.equal(result.dependents.length, pathway === "PATH-003" ? 3 : 2);
    assert.equal(result.dependents.some((d) => d.sourceCardId === "LIFE-010"), false);
    assert.equal(result.round.investment_asset_value, 10000);
    const categories = record(result.round.income_by_category);
    assert.equal(categories["investment-income"], 500);
    assert.equal(categories["w2-wages"], pathway === "PATH-001" ? 0 : 100000);
    if (pathway === "PATH-001") assert.equal(categories["business-net-income"], 100000);
    if (income.length === 2) assert.equal(categories["business-net-income"], 25000);
    assert.equal(result.round.gross_income, income.length === 2 ? 125500 : 100500);
    assert.equal(result.applied.homeowner_before, true);
    assert.equal(result.applied.homeowner_after, true);
    if (pathway === "PATH-001") {
      assert.deepEqual(result.calculation.persistent_updates, {
        corporate_climber_primary: { card_id: "INC-BIZ-004", established_round: 2 },
      });
    }
    assert.equal(result.sources.some((source) => source.category === "social-security" || source.category === "pension-income"), false);
    const before = structuredClone(input);
    const savedFixedPrepayment = 1234;
    assert.ok(typeof result.round.gross_income === "number");
    assert.ok(typeof result.round.adjusted_gross_income === "number");
    assert.ok(typeof result.round.final_tax_liability === "number");
    const settled = computeRoundResults({
      beginningCash: input.round.beginning_cash_resources,
      beginningDebt: input.round.beginning_student_loan_debt,
      grossIncome: economicGrossIncome(result.round.gross_income, result.calculation.pending_effects),
      adjustedGrossIncome: result.round.adjusted_gross_income,
      finalTax: result.round.final_tax_liability,
      fixedPrepayment: savedFixedPrepayment,
      pendingEffects: result.calculation.pending_effects,
    });
    assert.equal(settled.taxPrepaid, savedFixedPrepayment);
    assert.equal(settled.studentLoanPayment, 4000);
    assert.equal(settled.endingDebt, 8000);
    assert.equal(settled.auditPenalty, 0);
    assert.equal(toFinalizePayload(settled).ending_student_loan_debt, 8000);
    assert.equal(toFinalizePayload(settled).ending_cash, settled.endingCash);
    assert.deepEqual(input, before, "settlement must not expire effects or mutate household/assets");
    if (pathway === "PATH-003") {
      assert.ok(result.dependents.some((dependent) => dependent.sourceCardId === "PATH-003"));
    }
  });
}

test("Round 3 cannot save authoritative tax inputs with any required physical-card stage missing", () => {
  for (const stage of ["income-or-retirement", "life-event", "wildcard", "deduction"]) {
    const input = snapshot({ round: 3 });
    input.cards = input.cards.filter((card) => card.stage !== stage);
    const built = buildRoundTaxCalculation(input);
    assert.ok(!built.ok);
    assert.equal(built.code, "INCOMPLETE_ROUND", stage);
  }
});

for (const wildcard of ["WILD-001", "WILD-002", "WILD-003", "WILD-004", "WILD-005", "WILD-006", "WILD-007", "WILD-008", "WILD-009", "WILD-010"]) {
  test(`Round 3 ${wildcard} and Deduction reuse Round 2 treatment without new formulas`, () => {
    const second = snapshot({ round: 2, wildcard, choice: wildcard === "WILD-004" ? "business" : undefined });
    const third = snapshot({ round: 3, wildcard, choice: wildcard === "WILD-004" ? "business" : undefined });
    for (const input of [second, third]) {
      input.cards.find((card) => card.stage === "deduction")!.card_id = "DED-006";
    }
    const prior = calculate(second);
    const result = calculate(third);
    assert.deepEqual(result.round, prior.round);
    assert.equal(result.round.standard_deduction, 15750);
    assert.equal(result.round.deduction_amount, 23750);
    assert.deepEqual(result.calculation.pending_effects, prior.calculation.pending_effects);
    assert.deepEqual(result.calculation.audit_trigger, prior.calculation.audit_trigger);
  });
}

test("Round 3 Entrepreneur rejects extra W-2 and Side Hustler requires both physical Income cards", () => {
  const entrepreneur = buildRoundTaxCalculation(snapshot({ round: 3, pathway: "PATH-002", income: ["INC-W2-004", "INC-W2-001"] }));
  assert.ok(!entrepreneur.ok);
  assert.equal(entrepreneur.code, "INCOMPLETE_ROUND");
  const hustler = buildRoundTaxCalculation(snapshot({ round: 3, pathway: "PATH-006", income: ["INC-W2-004"] }));
  assert.ok(!hustler.ok);
  assert.equal(hustler.code, "INCOMPLETE_ROUND");
  const homeowner = snapshot({ round: 3, lifeCard: "LIFE-005" });
  homeowner.life.homeowner = true;
  const invalidEvent = buildRoundTaxCalculation(homeowner);
  assert.ok(!invalidEvent.ok);
  assert.equal(invalidEvent.code, "LIFE_EVENT_INELIGIBLE");
});
