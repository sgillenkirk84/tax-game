import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { computeRoundResults, economicGrossIncome, pendingCashEffects, summarizeStoredResults, toFinalizePayload } from "./round-results.ts";
import { ACTIVE_ROUND_FLOW, ROUND_FLOW } from "./round-stages.ts";

const base = {
  beginningCash: 10000,
  beginningDebt: 0,
  grossIncome: 60000,
  adjustedGrossIncome: 60000,
  finalTax: 5000,
  fixedPrepayment: 5000,
  pendingEffects: [] as unknown[],
};

// Living costs at AGI $60,000: 30,000x85% + 20,000x55% + 10,000x45% = 25,500 + 11,000 + 4,500.
const LIVING_60K = 41000;

test("refund: prepayment above tax adds the refund to cash", () => {
  const r = computeRoundResults({ ...base, fixedPrepayment: 6500 });
  assert.equal(r.taxRefund, 1500);
  assert.equal(r.taxAmountDue, 0);
  assert.equal(r.endingCash, 10000 + 60000 - LIVING_60K - 6500 + 1500);
});

test("amount due: tax above prepayment subtracts the amount due from cash", () => {
  const r = computeRoundResults({ ...base, fixedPrepayment: 4000 });
  assert.equal(r.taxRefund, 0);
  assert.equal(r.taxAmountDue, 1000);
  assert.equal(r.endingCash, 10000 + 60000 - LIVING_60K - 4000 - 1000);
});

test("exact settlement leaves only the prepayment as a tax outflow", () => {
  const r = computeRoundResults(base);
  assert.equal(r.taxRefund, 0);
  assert.equal(r.taxAmountDue, 0);
  assert.equal(r.endingCash, 10000 + 60000 - LIVING_60K - 5000);
});

test("zero tax: a zero prepayment is exactly settled", () => {
  const r = computeRoundResults({ ...base, finalTax: 0, fixedPrepayment: 0 });
  assert.equal(r.taxRefund, 0);
  assert.equal(r.taxAmountDue, 0);
  assert.equal(r.endingCash, 10000 + 60000 - LIVING_60K);
});

test("student loan above $4,000 pays $4,000", () => {
  const r = computeRoundResults({ ...base, beginningDebt: 20000 });
  assert.equal(r.studentLoanPayment, 4000);
  assert.equal(r.endingDebt, 16000);
  assert.equal(r.endingCash, 10000 + 60000 - LIVING_60K - 5000 - 4000);
});

test("student loan below $4,000 pays only the balance", () => {
  const r = computeRoundResults({ ...base, beginningDebt: 2500 });
  assert.equal(r.studentLoanPayment, 2500);
  assert.equal(r.endingDebt, 0);
});

test("zero student loan makes no payment", () => {
  const r = computeRoundResults(base);
  assert.equal(r.studentLoanPayment, 0);
  assert.equal(r.endingDebt, 0);
});

test("WILD-003 is an other cash inflow", () => {
  const effects = [{ source_card_id: "WILD-003", type: "cash-increase", cash_delta: 3000, taxable: false }];
  const r = computeRoundResults({ ...base, pendingEffects: effects });
  assert.equal(r.otherCashInflows, 3000);
  assert.equal(r.endingCash, computeRoundResults(base).endingCash + 3000);
});

test("WILD-004 is a $5,000 personal expense", () => {
  const effects = [{ source_card_id: "WILD-004", type: "cash-expense", cash_delta: -5000, choice: "personal" }];
  const r = computeRoundResults({ ...base, pendingEffects: effects });
  assert.equal(r.personalExpenses, 5000);
  assert.equal(r.endingCash, computeRoundResults(base).endingCash - 5000);
});

test("gross income, not AGI, is the cash inflow", () => {
  const r = computeRoundResults({ ...base, grossIncome: 70000, adjustedGrossIncome: 60000 });
  assert.equal(r.grossIncome, 70000);
  assert.equal(r.endingCash, 10000 + 70000 - LIVING_60K - 5000);
});

test("living costs use the approved AGI-based bands, not gross income", () => {
  const r = computeRoundResults({ ...base, grossIncome: 90000, adjustedGrossIncome: 60000 });
  assert.equal(r.livingCosts, LIVING_60K);
  assert.equal(computeRoundResults({ ...base, adjustedGrossIncome: 120000 }).livingCosts, 25500 + 11000 + 11250 + 8750 + 5000);
});

test("the current no-Audit flow has no audit penalty and sends the exact figures to the database", () => {
  const r = computeRoundResults({ ...base, beginningDebt: 20000 });
  assert.equal(r.auditPenalty, 0);
  const payload = toFinalizePayload(r);
  assert.equal(payload.audit_penalty, 0);
  assert.equal(payload.ending_cash, r.endingCash);
  assert.equal(payload.student_loan_payment, 4000);
});

test("malformed pending effects are rejected, unrelated ones ignored", () => {
  assert.throws(() => pendingCashEffects("nope"));
  assert.throws(() => pendingCashEffects([{ source_card_id: "WILD-004", type: "cash-expense", cash_delta: 5000 }]));
  assert.deepEqual(pendingCashEffects([{ source_card_id: "WILD-005", type: "other" }]), {
    otherCashInflows: 0,
    personalExpenses: 0,
    businessIncomeReduction: 0,
  });
});

test("stored Results summary requires every field", () => {
  const stored = {
    round_number: 1,
    cards: [{ stage: "income-or-retirement", card_id: "INC-001" }],
    results: {
      pathway_id: "PATH-001",
      scenario_id: "financial-head-start",
      beginning_cash: 10000,
      gross_income: 60000,
      other_cash_inflows: 0,
      living_costs: 41000,
      personal_expenses: 0,
      calculated_tax: 5000,
      tax_prepaid: 5000,
      tax_refund: 0,
      tax_amount_due: 0,
      student_loan_payment: 0,
      ending_cash: 24000,
      ending_student_loan_debt: 0,
      filing_status: "SINGLE",
      homeowner: false,
      active_dependents: 0,
    },
  };
  assert.equal(summarizeStoredResults(stored)?.endingCash, 24000);
  assert.equal(summarizeStoredResults({ ...stored, results: { ...stored.results, ending_cash: null } }), null);
  assert.equal(summarizeStoredResults(null), null);
});

test("Audit stays defined but is not part of the active flow", () => {
  assert.ok(ROUND_FLOW.some((step) => step.id === "audit-if-triggered"));
  assert.ok(!ACTIVE_ROUND_FLOW.some((step) => step.id === "audit-if-triggered"));
});

test("migration finalizes through a service_role-only RPC without touching Audit or Round 2", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261004090000_round_results.sql", import.meta.url), "utf8");
  assert.match(sql, /grant execute on function public\.finalize_round_results\(uuid, text, integer, uuid, jsonb\) to service_role;/);
  assert.match(sql, /grant execute on function public\.get_round_results\(uuid, text, integer\) to service_role;/);
  assert.match(sql, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(sql, /status = 'finalized'/);
  assert.doesNotMatch(sql, /drop (table|column|constraint)/i);
  assert.doesNotMatch(sql, /current_round\s*=\s*current_round\s*\+/i);
});

// WILD-004: one $5,000 economic expense. The business choice also lowers saved
// (tax) gross income by $5,000; Results must add that back so cash is not hit twice.
const wild004 = (choice: "personal" | "business", reduction: number) => [
  { source_card_id: "WILD-004", type: "cash-expense", cash_delta: -5000, choice, business_income_reduction: reduction },
];

function preTaxCash(savedGross: number, effects: unknown[]) {
  const r = computeRoundResults({
    ...base,
    beginningCash: 0,
    grossIncome: economicGrossIncome(savedGross, effects),
    adjustedGrossIncome: savedGross,
    finalTax: 0,
    fixedPrepayment: 0,
    pendingEffects: effects,
  });
  return { r, contribution: r.grossIncome + r.otherCashInflows - r.personalExpenses };
}

test("WILD-004 personal: one $5,000 expense, no tax reduction, $45,000 contribution", () => {
  const effects = wild004("personal", 0);
  assert.equal(economicGrossIncome(50000, effects), 50000);
  const { r, contribution } = preTaxCash(50000, effects);
  assert.equal(r.personalExpenses, 5000);
  assert.equal(contribution, 45000);
});

test("WILD-004 business: saved tax income is $45,000 but cash still has one $5,000 expense", () => {
  const effects = wild004("business", 5000);
  assert.equal(pendingCashEffects(effects).businessIncomeReduction, 5000);
  assert.equal(economicGrossIncome(45000, effects), 50000);
  const { r, contribution } = preTaxCash(45000, effects);
  assert.equal(r.grossIncome, 50000);
  assert.equal(r.personalExpenses, 5000);
  assert.equal(contribution, 45000);
});

test("WILD-004 business reduction is capped by the expense and by income", () => {
  const effects = wild004("business", 2000);
  assert.equal(economicGrossIncome(0, effects), 2000);
  assert.equal(preTaxCash(0, effects).contribution, -3000);
  assert.throws(() => pendingCashEffects(wild004("business", 6000)));
  assert.throws(() => pendingCashEffects(wild004("business", -1)));
});

test("without WILD-004 the gross income is unchanged", () => {
  assert.equal(economicGrossIncome(50000, []), 50000);
  assert.equal(economicGrossIncome(50000, [{ source_card_id: "WILD-003", type: "cash-increase", cash_delta: 3000 }]), 50000);
});

test("migration adds the business reduction back to gross income in both RPCs", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261004090000_round_results.sql", import.meta.url), "utf8");
  assert.match(sql, /v_gross := v_gross \+ v_business_reduction;/);
  assert.match(sql, /'gross_income', round_row\.gross_income \+ coalesce\(/);
});
