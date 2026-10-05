import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { computeRoundResults, economicGrossIncome, pendingCashEffects, resultsAvailableForRound, summarizeStoredResults, toFinalizePayload } from "./round-results.ts";
import { ACTIVE_ROUND_FLOW, advanceTarget, ROUND_FLOW } from "./round-stages.ts";
import { calculatePrepaymentDollars } from "./tax-prepayment.ts";

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

test("Round 2 fixed prepayment opens shared Results while unfinished rounds remain closed", () => {
  assert.deepEqual(advanceTarget("tax-prepayment", 2), { stage: "results-and-life-ledger", label: "Results and Life Ledger" });
  assert.equal(resultsAvailableForRound(2, 1), false);
  assert.equal(resultsAvailableForRound(2, 2), true);
  assert.equal(resultsAvailableForRound(1, 2), true);
  assert.equal(resultsAvailableForRound(3, 3), false);
  assert.equal(resultsAvailableForRound(4, 5), false);
  assert.equal(advanceTarget("tax-prepayment", 3), null);
});

function roundTwoStored(auditResolution: "not-triggered" | "bypassed-beta") {
  const computed = computeRoundResults({
    beginningCash: 10000, beginningDebt: 2500,
    grossIncome: 35000, adjustedGrossIncome: 35000, finalTax: 0,
    fixedPrepayment: 368, pendingEffects: [],
  });
  return {
    round_number: 2,
    cards: [{ stage: "tax-prepayment", card_id: "PRE-006" }, { stage: "wildcard", card_id: auditResolution === "bypassed-beta" ? "WILD-006" : "WILD-001" }],
    results: {
      version: 2, pathway_id: "PATH-003", scenario_id: "student-loan-debt",
      beginning_cash: computed.beginningCash, gross_income: computed.grossIncome,
      adjusted_gross_income: 35000, other_cash_inflows: 0, living_costs: computed.livingCosts,
      personal_expenses: 0, calculated_tax: computed.calculatedTax, tax_prepaid: computed.taxPrepaid,
      tax_refund: computed.taxRefund, tax_amount_due: 0, audit_penalty: 0,
      beginning_student_loan_debt: 2500, student_loan_payment: computed.studentLoanPayment,
      ending_student_loan_debt: computed.endingDebt, ending_cash: computed.endingCash,
      filing_status: "MFJ", homeowner: true, active_dependents: 2,
      deduction_method: "standard", deduction_amount: 31500, taxable_income: 3500,
      tax_before_credits: 350, credits_applied: 350, prepayment_rate_pct: 105,
      investment_income: 0, investment_asset_value: 10000, audit_resolution: auditResolution,
    },
  };
}

test("Round 2 restored Results preserve $368, saved household, assets and capped debt payment", () => {
  const stored = roundTwoStored("not-triggered");
  const before = structuredClone(stored);
  const results = summarizeStoredResults(stored);
  assert.equal(results?.roundNumber, 2);
  assert.equal(results?.calculatedTax, 0);
  assert.equal(results?.taxPrepaid, 368);
  assert.equal(results?.taxRefund, 368);
  assert.equal(results?.taxAmountDue, 0);
  assert.equal(results?.studentLoanPayment, 2500);
  assert.equal(results?.endingDebt, 0);
  assert.equal(results?.filingStatus, "MFJ");
  assert.equal(results?.homeowner, true);
  assert.equal(results?.activeDependents, 2);
  assert.equal(results?.details?.investmentAssetValue, 10000);
  assert.equal(results?.details?.taxBeforeCredits, 350);
  assert.equal(results?.details?.creditsApplied, 350);
  assert.equal(results?.details?.prepaymentRatePct, 105);
  assert.equal(results?.endingCash, 10000 + 35000 - (25500 + 2750) - 2500);
  assert.deepEqual(summarizeStoredResults(JSON.parse(JSON.stringify(stored))), results);
  assert.deepEqual(stored, before);
});

test("triggered Audit is explicitly bypassed in beta, never shown as resolved or assessed", () => {
  const stored = roundTwoStored("bypassed-beta");
  const result = summarizeStoredResults(stored);
  assert.equal(result?.details?.auditResolution, "bypassed-beta");
  assert.equal(result?.details?.auditPenalty, 0);
  assert.equal(result?.taxPrepaid, 368);
  assert.equal(result?.taxRefund, 368);
  assert.equal(summarizeStoredResults({ ...stored, results: { ...stored.results, audit_resolution: "resolved" } }), null);
});

test("new Results details reject missing saved values rather than inventing them", () => {
  const stored = roundTwoStored("not-triggered");
  assert.equal(summarizeStoredResults({ ...stored, results: { ...stored.results, tax_before_credits: null } }), null);
  assert.equal(summarizeStoredResults({ ...stored, results: { ...stored.results, deduction_method: "guessed" } }), null);
});

test("new migration preserves shared finalization, immutable ledger, replay and state handoff", () => {
  const read = (file: string) => readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const migration = read("20261005150000_round_two_results.sql");
  const existing = read("20261004090000_round_results.sql");
  const nextRound = read("20261004100000_next_round.sql");
  const extract = (source: string, name: string) => {
    const start = source.indexOf(`create or replace function public.${name}(`);
    const end = source.indexOf("\n$$;", start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  const definitions = new Map([
    ["public.advance_round_stage(uuid,text,integer,text,uuid)", extract(nextRound, "advance_round_stage")],
    ["public.finalize_round_results(uuid,text,integer,uuid,jsonb)", extract(existing, "finalize_round_results")],
  ]);
  const changes = [...migration.matchAll(/\(\s*'([^']+)',\s*(?:\$old\$([\s\S]*?)\$old\$|'([^']*)'),\s*(?:\$new\$([\s\S]*?)\$new\$|'([^']*)')\s*\)/g)];
  assert.equal(changes.length, 6);
  for (const [, signature, oldBlock, oldString, newBlock, newString] of changes) {
    const source = definitions.get(signature);
    assert.ok(source);
    const oldText = oldBlock ?? oldString;
    const newText = newBlock ?? newString;
    assert.equal(source.split(oldText).length - 1, 1, signature);
    definitions.set(signature, source.replace(oldText, newText));
  }
  const advance = definitions.get("public.advance_round_stage(uuid,text,integer,text,uuid)")!;
  assert.match(advance, /when 'tax-prepayment' then\s+if life_row.current_round between 1 and 2 then/);
  assert.match(advance, /PREPAYMENT_REQUIRED/);
  const finalizer = definitions.get("public.finalize_round_results(uuid,text,integer,uuid,jsonb)")!;
  assert.match(finalizer, /current_round not between 1 and 2/);
  assert.match(finalizer, /v_prepaid := round_row\.fixed_tax_prepayment/);
  assert.match(finalizer, /v_refund := greatest\(0, v_prepaid - v_final\)/);
  assert.match(finalizer, /v_due := greatest\(0, v_final - v_prepaid\)/);
  assert.doesNotMatch(finalizer, /set fixed_tax_prepayment|calculate.*prepayment|prepaid.*\*.*rate/i);
  assert.match(finalizer, /status = 'finalized'[\s\S]*'replayed', true/);
  assert.match(finalizer, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(finalizer, /insert into public\.mm_game_life_ledger/);
  assert.match(finalizer, /'round', pg_catalog\.to_jsonb\(round_row\)/);
  assert.match(finalizer, /filing_status = v_filing[\s\S]*homeowner = v_homeowner[\s\S]*cash_resources = v_ending_cash[\s\S]*student_loan_debt = v_ending_debt/);
  assert.match(finalizer, /jsonb_array_length\(round_row\.input_snapshot -> 'dependents'\)/);
  assert.match(finalizer, /effect\.status = 'active'[\s\S]*status = 'removed'/);
  assert.match(finalizer, /'audit_trigger', tax -> 'audit_trigger'/);
  assert.match(finalizer, /'bypassed-beta' else 'not-triggered'/);
  assert.match(finalizer, /jsonb_typeof\(tax -> 'audit_trigger' -> 'triggered'\) is distinct from 'boolean'/);
  assert.match(migration, /old_count <> 1/);
  assert.match(migration, /grant execute on function public\.finalize_round_results\(uuid, text, integer, uuid, jsonb\) to service_role/);
  assert.doesNotMatch(migration, /alter table|start_next_round|set current_round|update public\.mm_game/);
  const schema = read("20261003200000_replayable_game_schema.sql");
  assert.match(schema, /GAME_ROUND_FINALIZED/);
  assert.match(schema, /GAME_LEDGER_SNAPSHOT_ROUND_MISMATCH/);
});

test("Results APIs enforce shared availability and next-round RPC requires finalized Round 2", () => {
  for (const route of ["results", "results-finalize"]) {
    const source = readFileSync(new URL(`../app/api/rounds/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /resultsAvailableForRound\(body.round, serverMaxEnabledRound\(\)\)/);
  }
  const next = readFileSync(new URL("../supabase/migrations/20261004100000_next_round.sql", import.meta.url), "utf8");
  assert.match(next, /previous_round\.status <> 'finalized'/);
  assert.match(next, /PREVIOUS_ROUND_NOT_FINALIZED/);
  const ui = readFileSync(new URL("../components/round-results.tsx", import.meta.url), "utf8");
  assert.match(ui, /nextRound <= 3 && nextRound <= clientMaxEnabledRound\(\)/);
  assert.match(ui, /if \(!results\)/);
});

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

test("credits reduce final tax to zero but the full positive prepayment is refunded", () => {
  const r = computeRoundResults({
    ...base, finalTax: 0, fixedPrepayment: calculatePrepaymentDollars(1757, 80),
  });
  assert.equal(r.calculatedTax, 0);
  assert.equal(r.taxPrepaid, 1406);
  assert.equal(r.taxRefund, 1406);
  assert.equal(r.taxAmountDue, 0);
  assert.equal(r.endingCash, 10000 + 60000 - LIVING_60K);
  assert.equal(toFinalizePayload(r).tax_refund, 1406);
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
