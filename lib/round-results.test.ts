import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { computeRoundResults, economicGrossIncome, pendingCashEffects, resultsAvailableForRound, summarizeStoredResults, toFinalizePayload } from "./round-results.ts";
import { ACTIVE_ROUND_FLOW, advanceTarget, ROUND_FLOW } from "./round-stages.ts";
import { calculatePrepaymentDollars } from "./tax-prepayment.ts";
import { LEDGER_ROUNDS, lifeLedgerRows, loadEarlierLedgerRounds } from "./life-ledger.ts";

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

test("Rounds 1-5 offer shared Results within the configured limit; Round 6 remains closed", () => {
  assert.deepEqual(advanceTarget("tax-prepayment", 2), { stage: "results-and-life-ledger", label: "Results and Life Ledger" });
  assert.equal(resultsAvailableForRound(2, 1), false);
  assert.equal(resultsAvailableForRound(2, 2), true);
  assert.equal(resultsAvailableForRound(1, 2), true);
  assert.equal(resultsAvailableForRound(3, 2), false);
  assert.equal(resultsAvailableForRound(3, 3), true);
  assert.equal(resultsAvailableForRound(4, 3), false);
  assert.equal(resultsAvailableForRound(4, 4), true);
  assert.equal(resultsAvailableForRound(5, 4), false);
  assert.equal(resultsAvailableForRound(5, 5), true);
  assert.equal(resultsAvailableForRound(6, 6), false);
  assert.equal(resultsAvailableForRound(0, 5), false);
  assert.equal(resultsAvailableForRound(4.5, 5), false);
  assert.deepEqual(advanceTarget("tax-prepayment", 3), { stage: "results-and-life-ledger", label: "Results and Life Ledger" });
  assert.equal(advanceTarget("tax-prepayment", 4)?.stage, "results-and-life-ledger");
  assert.equal(advanceTarget("tax-prepayment", 5)?.stage, "results-and-life-ledger");
  assert.equal(advanceTarget("tax-prepayment", 6), null);
  assert.equal(advanceTarget("results-and-life-ledger", 5), null);
  assert.equal(advanceTarget("results-and-life-ledger", 3), null);
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

test("Round 5 settlement consumes fixed saved payments, not a new prepayment calculation", () => {
  for (const [finalTax, fixedPrepayment, refund] of [[0, 368, 368], [3391.5, 3561, 169.5], [5000, 3561, 0]]) {
    const inputs = {
      beginningCash: -50000, beginningDebt: 10000, grossIncome: 60500,
      adjustedGrossIncome: 46500, finalTax, fixedPrepayment, pendingEffects: [],
    };
    const before = structuredClone(inputs);
    const result = computeRoundResults(inputs);
    assert.equal(result.taxPrepaid, fixedPrepayment);
    assert.equal(result.calculatedTax, finalTax);
    assert.equal(result.taxRefund, refund);
    assert.equal(result.taxAmountDue, Math.max(0, finalTax - fixedPrepayment));
    assert.equal(result.livingCosts, 34575, "unchanged progressive Living Costs use saved AGI, not Retirement gross");
    assert.equal(result.studentLoanPayment, 4000);
    assert.equal(result.endingDebt, 6000);
    assert.equal(result.endingCash, -50000 + 60500 - 34575 - finalTax - 4000);
    assert.ok(result.endingCash < 0);
    assert.equal(result.auditPenalty, 0);
    assert.deepEqual(computeRoundResults(inputs), result);
    assert.deepEqual(inputs, before);
  }
});

test("Final Round 5 restores identical snapshots and all five ledger columns without rewriting earlier rounds", async () => {
  const snapshots = [1, 2, 3, 4, 5].map((round_number) => ({
    ...roundTwoStored("bypassed-beta"), round_number,
  }));
  snapshots[4].cards.unshift({ stage: "income-or-retirement", card_id: "RET-MIX-003" });
  snapshots[4].results.investment_income = 500;
  snapshots[4].results.investment_asset_value = 20000;
  const before = structuredClone(snapshots);
  const summaries = snapshots.map((saved) => summarizeStoredResults(saved)!);
  const final = summarizeStoredResults(JSON.parse(JSON.stringify(snapshots[4])))!;
  assert.equal(final.roundNumber, 5);
  assert.equal(final.calculatedTax, 0);
  assert.equal(final.taxPrepaid, 368);
  assert.equal(final.taxRefund, 368);
  assert.equal(final.filingStatus, "MFJ");
  assert.equal(final.homeowner, true);
  assert.equal(final.activeDependents, 2);
  assert.equal(final.details?.investmentIncome, 500);
  assert.equal(final.details?.investmentAssetValue, 20000);
  assert.equal(final.details?.auditResolution, "bypassed-beta");
  assert.equal(final.details?.auditPenalty, 0);
  assert.deepEqual(final, summaries[4]);
  const calls: number[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "/api/rounds/results");
    const { round } = JSON.parse(String(init?.body));
    calls.push(round);
    return Response.json({ finalized: true, results: summaries[round - 1] });
  };
  const player = { id: "player", resumeToken: "token" };
  const signal = new AbortController().signal;
  const history = await loadEarlierLedgerRounds(player, 5, signal, request);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  const rows = lifeLedgerRows([...history, final]);
  assert.deepEqual(rows, lifeLedgerRows(summaries));
  const priorRows = lifeLedgerRows(summaries.slice(0, 4));
  for (const row of rows) {
    assert.equal(row.values.length, 5);
    assert.deepEqual(row.values.slice(0, 4), priorRows.find((prior) => prior.label === row.label)!.values.slice(0, 4));
  }
  assert.equal(rows.find((row) => row.label === "Tax refund")!.values[4], "$368");
  assert.equal(rows.find((row) => row.label === "Investment income")!.values[4], "$500");
  assert.deepEqual(lifeLedgerRows([...await loadEarlierLedgerRounds(player, 5, signal, request), final]), rows);
  assert.deepEqual(snapshots, before);
});

test("Round 5 completion is displayed only after saved Results, with no next round or story/AI action", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const ui = read("../components/round-results.tsx");
  assert.match(ui, /if \(!results\)/);
  assert.ok(ui.indexOf("if (!results)") < ui.indexOf("results.roundNumber === MAX_PLAYABLE_ROUND"));
  assert.match(ui, /if \(body.finalized && body.results\)/);
  assert.match(ui, /results.roundNumber === MAX_PLAYABLE_ROUND[\s\S]*five-round financial game is complete[\s\S]*There is no next round/);
  assert.match(ui, /My Tax Life Story is not available yet/);
  assert.match(ui, /nextRound <= MAX_PLAYABLE_ROUND && nextRound <= clientMaxEnabledRound\(\)/);
  assert.match(ui, /getRoundIncomeCardCategory\(results.pathwayId, results.roundNumber\)/);
  assert.doesNotMatch(ui, /\/api\/.*(?:story|ai)|generateStory|calculateRetirementIncome|calculatePrepaymentDollars/);
  const finalize = read("../app/api/rounds/results-finalize/route.ts");
  assert.match(finalize, /if \(!inputs\)[\s\S]*status: 409/);
  assert.match(finalize, /finalTax: num\(inputs.final_tax_liability\)/);
  assert.match(finalize, /fixedPrepayment: num\(inputs.fixed_tax_prepayment\)/);
  assert.ok(finalize.indexOf("if (current?.finalized)") < finalize.indexOf("computeRoundResults({"));
  assert.doesNotMatch(finalize, /calculateRetirementIncome|calculateEarlyRetirementIncome|buildRoundTaxCalculation|calculatePrepaymentDollars|generateStory/);
  const recovery = read("../supabase/migrations/20261004090000_round_results.sql").split("create or replace function public.get_round_results(")[1];
  assert.match(recovery, /round_row.status = 'finalized'[\s\S]*round_row.calculation_details -> 'results'/);
  assert.match(recovery, /tax_prepayment' is null/);
  assert.doesNotMatch(recovery, /update public\.|insert into public\./);
  assert.match(read("../app/api/rounds/next-round/route.ts"), /body.round < 2 \|\| body.round > MAX_PLAYABLE_ROUND/);
  assert.match(read("./round-rules.ts"), /MAX_PLAYABLE_ROUND = 5/);
});

test("Life Ledger aligns saved rounds by number without recalculation or mutation", () => {
  const second = summarizeStoredResults(roundTwoStored("bypassed-beta"))!;
  const first = { ...second, roundNumber: 1, grossIncome: 12345, taxPrepaid: 999, taxRefund: 7, filingStatus: "HOH", homeowner: false, activeDependents: 1, details: null };
  const input = [second, first];
  const before = structuredClone(input);
  const rows = lifeLedgerRows(input);
  const values = (label: string) => rows.find((row) => row.label === label)!.values;
  assert.deepEqual(LEDGER_ROUNDS, [1, 2, 3, 4, 5]);
  assert.deepEqual(values("Gross income"), ["$12,345", "$35,000", "\u2014", "\u2014", "\u2014"]);
  assert.deepEqual(values("Tax you prepaid"), ["$999", "$368", "\u2014", "\u2014", "\u2014"]);
  assert.deepEqual(values("Tax refund").slice(0, 2), ["$7", "$368"]);
  assert.deepEqual(values("Filing status").slice(0, 2), ["Head of household", "Married filing jointly"]);
  assert.deepEqual(values("Homeowner").slice(0, 2), ["No", "Yes"]);
  assert.deepEqual(values("Active dependents").slice(0, 2), ["1", "2"]);
  assert.deepEqual(values("Tax Prepayment percentage").slice(0, 2), ["\u2014", "105%"]);
  assert.deepEqual(values("Audit resolution").slice(0, 2), ["\u2014", "bypassed-beta (temporary; unresolved)"]);
  assert.deepEqual(values("Calculated tax after credits").slice(0, 2), ["$0", "$0"]);
  assert.deepEqual(input, before);
  assert.deepEqual(lifeLedgerRows(JSON.parse(JSON.stringify(input))), rows);
  const fifth = { ...second, roundNumber: 5, grossIncome: 54321 };
  assert.equal(lifeLedgerRows([fifth]).find((row) => row.label === "Gross income")!.values[4], "$54,321");
});

test("Life Ledger reloads earlier finalized snapshots through the existing read-only endpoint", async () => {
  const second = summarizeStoredResults(roundTwoStored("not-triggered"))!;
  const first = { ...second, roundNumber: 1, grossIncome: 12345 };
  const calls: number[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "/api/rounds/results");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.id, "test-player");
    assert.equal(body.resumeToken, "test-token");
    calls.push(body.round);
    return Response.json({ finalized: true, results: first });
  };
  const player = { id: "test-player", resumeToken: "test-token" };
  const signal = new AbortController().signal;
  const history = await loadEarlierLedgerRounds(player, 2, signal, request);
  assert.deepEqual(calls, [1]);
  assert.deepEqual(history, [first]);
  assert.deepEqual(await loadEarlierLedgerRounds(player, 2, signal, request), history);
  assert.deepEqual(await loadEarlierLedgerRounds(player, 1, signal, request), []);
  await assert.rejects(loadEarlierLedgerRounds(player, 2, signal, async () => Response.json({ finalized: true, results: second })), /Round 1/);
  await assert.rejects(loadEarlierLedgerRounds(player, 2, signal, async () => Response.json({ finalized: false })), /Round 1/);
  await assert.rejects(loadEarlierLedgerRounds(player, 2, signal, async () => Response.json({ error: "Storage unavailable." }, { status: 503 })), /Storage unavailable/);
});

test("Life Ledger keeps a semantic five-column table in a focusable horizontal scroll region", () => {
  const source = readFileSync(new URL("../components/life-ledger.tsx", import.meta.url), "utf8");
  assert.match(source, /overflow-x-auto/);
  assert.match(source, /min-w-\[1050px\]/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.match(source, /scope="col"/);
  assert.match(source, /scope="row"/);
  assert.match(source, /LEDGER_ROUNDS\.map/);
  assert.doesNotMatch(source, /computeRoundResults|calculate|results-finalize/);
});

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
  assert.match(ui, /nextRound <= MAX_PLAYABLE_ROUND && nextRound <= clientMaxEnabledRound\(\)/);
  assert.match(ui, /if \(!results\)/);
});

test("Round 3 and Round 4 Results migrations change only two gates in cumulative installed definitions", () => {
  const read = (name: string) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const extract = (source: string, name: string) => {
    const start = source.indexOf(`create or replace function public.${name}(`);
    const end = source.indexOf("\n$$;", start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end);
  };
  const advanceSignature = "public.advance_round_stage(uuid,text,integer,text,uuid)";
  const finalizeSignature = "public.finalize_round_results(uuid,text,integer,uuid,jsonb)";
  const original = read("20261004090000_round_results.sql");
  const definitions = new Map([
    [advanceSignature, extract(read("20261004100000_next_round.sql"), "advance_round_stage")],
    [finalizeSignature, extract(original, "finalize_round_results")],
  ]);
  const patch = (name: string, expectedCount: number) => {
    const sql = read(name);
    const changes = [...sql.matchAll(/\(\s*'([^']+)',\s*(?:\$old\$([\s\S]*?)\$old\$|'([^']*)'),\s*(?:\$new\$([\s\S]*?)\$new\$|'([^']*)')\s*\)/g)];
    assert.equal(changes.length, expectedCount, name);
    for (const [, signature, oldBlock, oldString, newBlock, newString] of changes) {
      const source = definitions.get(signature);
      if (!source) {
        assert.match(signature, /^public\.(record_round_card|keep_round_prepayment_card|start_next_round|save_round_tax_result)\(/);
        continue;
      }
      const oldText = oldBlock ?? oldString;
      assert.equal(source.split(oldText).length - 1, 1, `${name}: ${signature}`);
      definitions.set(signature, source.replace(oldText, newBlock ?? newString));
    }
    return sql;
  };
  patch("20261005120000_round_two_tax_prepayment.sql", 3);
  patch("20261005150000_round_two_results.sql", 6);
  patch("20261005160000_round_three_tax_prepayment.sql", 3);
  const before = new Map(definitions);
  const sql = patch("20261005170000_round_three_results.sql", 2);
  const advance = definitions.get(advanceSignature)!;
  const finalizer = definitions.get(finalizeSignature)!;
  assert.equal(advance, before.get(advanceSignature)!.replace(
    "when 'tax-prepayment' then\n      if life_row.current_round between 1 and 2 then",
    "when 'tax-prepayment' then\n      if life_row.current_round between 1 and 3 then",
  ));
  assert.equal(finalizer, before.get(finalizeSignature)!.replace(
    "if life_row.current_round not between 1 and 2 then",
    "if life_row.current_round not between 1 and 3 then",
  ));
  assert.match(advance, /saved_count < minimum_cards/);
  assert.match(advance, /p_from_stage = 'tax-prepayment'[\s\S]*tax_prepayment' is null[\s\S]*PREPAYMENT_REQUIRED/);
  assert.match(finalizer, /current_stage <> 'results-and-life-ledger'/);
  assert.match(finalizer, /tax is null[\s\S]*TAX_CALCULATION_REQUIRED/);
  assert.match(finalizer, /tax_prepayment' is null[\s\S]*PREPAYMENT_REQUIRED/);
  assert.match(finalizer, /v_prepaid := round_row\.fixed_tax_prepayment/);
  assert.match(finalizer, /prepaid_amount'\)::numeric is distinct from v_prepaid/);
  assert.match(finalizer, /v_refund := greatest\(0, v_prepaid - v_final\)/);
  assert.match(finalizer, /v_due := greatest\(0, v_final - v_prepaid\)/);
  assert.match(finalizer, /v_loan := least\(4000, round_row\.beginning_student_loan_debt\)/);
  assert.match(finalizer, /ending_cash_resources = v_ending_cash/);
  assert.match(finalizer, /ending_student_loan_debt = v_ending_debt/);
  assert.match(finalizer, /jsonb_array_length\(round_row\.input_snapshot -> 'dependents'\)/);
  assert.match(finalizer, /'investment_asset_value', round_row\.investment_asset_value/);
  assert.match(finalizer, /'audit_trigger', tax -> 'audit_trigger'/);
  assert.match(finalizer, /'bypassed-beta' else 'not-triggered'/);
  assert.match(finalizer, /audit_adjustment_income = 0,\s+audit_penalty = 0/);
  assert.match(finalizer, /insert into public\.mm_game_life_ledger[\s\S]*'round', pg_catalog\.to_jsonb\(round_row\)/);
  for (const source of [advance, finalizer]) {
    assert.match(source, /PLAYER_SETUP_NOT_AVAILABLE/);
    assert.match(source, /for update/);
    assert.match(source, /IDEMPOTENCY_KEY_REUSED/);
  }
  const firstWrite = finalizer.indexOf("update public.mm_game_effects");
  assert.ok(firstWrite > finalizer.indexOf("if round_row.status = 'finalized' then"));
  assert.ok(firstWrite > finalizer.indexOf("if found then"));
  assert.doesNotMatch(finalizer, /set fixed_tax_prepayment|calculatePrepayment|mm_fix_round_prepayment|expires_after_round\s*=/);
  assert.match(sql, /fn.prosecdef/);
  assert.match(sql, /pg_get_userbyid\(fn.proowner\) = 'postgres'/);
  assert.match(sql, /search_path=pg_catalog/);
  assert.match(sql, /old_count <> 1/);
  assert.match(sql, /grant execute on function public\.advance_round_stage.*to anon/);
  assert.match(sql, /grant execute on function public\.finalize_round_results.*to service_role/);
  assert.doesNotMatch(sql, /alter table|update public\.|insert into public\.|get_round_results|start_next_round|mm_fix_round_prepayment/);
  const schema = read("20261003200000_replayable_game_schema.sql");
  assert.match(schema, /unique \(round_id\)/);
  assert.match(schema, /GAME_LEDGER_IMMUTABLE/);
  assert.match(schema, /GAME_ROUND_FINALIZED/);
  assert.match(schema, /GAME_LEDGER_SNAPSHOT_ROUND_MISMATCH/);
  assert.match(schema, /create constraint trigger mm_game_rounds_require_ledger/);
  const savedTax = read("20261004100000_next_round.sql");
  assert.match(savedTax, /saved_cards is distinct from \(p_calculation -> 'input_snapshot' -> 'card_history_ids'\)/);
  assert.match(savedTax, /income_min := case when life_row.pathway_id = 'PATH-006' then 2 else 1 end/);
  assert.match(savedTax, /saved_cards -> 'deduction'\) <> 1/);
  patch("20261005180000_round_four_opening.sql", 2);
  patch("20261005190000_round_four_tax_calculation.sql", 7);
  patch("20261005200000_round_four_tax_prepayment.sql", 3);
  const beforeFourth = new Map(definitions);
  const fourthSql = patch("20261005210000_round_four_results.sql", 2);
  const fourthFinalizer = definitions.get(finalizeSignature)!;
  assert.equal(fourthFinalizer, beforeFourth.get(finalizeSignature)!.replace(
    "if life_row.current_round not between 1 and 3 then",
    "if life_row.current_round not between 1 and 4 then",
  ));
  assert.equal(definitions.get(advanceSignature), beforeFourth.get(advanceSignature)!.replace(
    "when 'tax-prepayment' then\n      if life_row.current_round between 1 and 3 then",
    "when 'tax-prepayment' then\n      if life_row.current_round between 1 and 4 then",
  ));
  assert.match(fourthFinalizer, /v_final := round_row.final_tax_liability/);
  assert.match(fourthFinalizer, /v_prepaid := round_row.fixed_tax_prepayment/);
  assert.match(fourthFinalizer, /v_refund := greatest\(0, v_prepaid - v_final\)/);
  assert.match(fourthFinalizer, /v_due := greatest\(0, v_final - v_prepaid\)/);
  assert.match(fourthFinalizer, /v_living[\s\S]*least\(v_agi, 30000\) \* 0.85/);
  assert.match(fourthFinalizer, /tax_prepayment' is null[\s\S]*PREPAYMENT_REQUIRED/);
  assert.match(fourthFinalizer, /jsonb_array_length\(round_row.input_snapshot -> 'dependents'\)/);
  assert.match(fourthFinalizer, /'bypassed-beta' else 'not-triggered'/);
  assert.match(fourthFinalizer, /audit_adjustment_income = 0,\s+audit_penalty = 0/);
  assert.match(fourthFinalizer, /where id = round_row.id/);
  assert.match(fourthFinalizer, /'round', pg_catalog.to_jsonb\(round_row\)/);
  assert.match(fourthFinalizer, /player.resume_token_hash = p_resume_token_hash\s+for update/);
  assert.match(fourthFinalizer, /game_round.round_number = p_round_number\s+for update/);
  assert.match(fourthFinalizer, /operation_row.request_fingerprint <> fingerprint/);
  assert.match(fourthFinalizer, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(fourthFinalizer, /life_row.cash_resources is distinct from round_row.beginning_cash_resources/);
  assert.equal(fourthFinalizer.split("insert into public.mm_game_life_ledger").length - 1, 1);
  assert.ok(fourthFinalizer.indexOf("if round_row.status = 'finalized' then") < fourthFinalizer.indexOf("update public.mm_game_effects"));
  assert.doesNotMatch(fourthFinalizer, /mm_fix_round_prepayment|calculateEarlyRetirementIncome|set fixed_tax_prepayment|set persistent_state|update public.mm_game_investments|expires_after_round\s*=/);
  assert.doesNotMatch(fourthSql, /get_round_results|start_next_round|alter table|update public\.|insert into public\.|mm_fix_round_prepayment/);
  assert.match(fourthSql, /grant execute on function public.finalize_round_results.*to service_role/);
  assert.match(fourthSql, /search_path=pg_catalog/);
  const start = read("20261005180000_round_four_opening.sql");
  assert.match(start, /p_round_number not between 2 and 4/);
  for (const invariant of [
    "GAME_LEDGER_IMMUTABLE", "GAME_ROUND_FINALIZED",
    "GAME_LEDGER_SNAPSHOT_ROUND_MISMATCH", "GAME_LEDGER_SNAPSHOT_CARDS_MISMATCH",
    "GAME_FINALIZED_ROUND_REQUIRES_LEDGER",
  ]) assert.ok(schema.includes(invariant), invariant);
  assert.match(schema, /create constraint trigger mm_game_rounds_require_ledger[\s\S]*deferrable initially deferred/);
});

test("Round 3 read/finish paths require fixed Prepayment and restore without repeating settlement", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const sql = read("../supabase/migrations/20261004090000_round_results.sql");
  const restore = sql.slice(sql.indexOf("create or replace function public.get_round_results("));
  assert.match(restore, /current_stage <> 'results-and-life-ledger'[\s\S]*tax_calculation' is null[\s\S]*tax_prepayment' is null[\s\S]*'inputs', null/);
  assert.match(restore, /'fixed_tax_prepayment', round_row\.fixed_tax_prepayment/);
  assert.doesNotMatch(restore, /update public\.|insert into public\./);
  const route = read("../app/api/rounds/results-finalize/route.ts");
  assert.match(route, /if \(!inputs\)[\s\S]*status: 409/);
  assert.match(route, /fixedPrepayment: num\(inputs.fixed_tax_prepayment\)/);
  assert.ok(route.indexOf("if (current?.finalized)") < route.indexOf('supabase.rpc("finalize_round_results"'));
  assert.doesNotMatch(route, /calculatePrepaymentDollars|mm_fix_round_prepayment|round === 3/);
  const ui = read("../components/round-dashboard.tsx");
  assert.match(ui, /prepaymentFixed && resultsEnabled && advanceEnabled && target/);
  const resultsUi = read("../components/round-results.tsx");
  assert.match(resultsUi, /finishKey\.current \?\?= crypto\.randomUUID\(\)/);
  assert.match(resultsUi, /if \(body.finalized && body.results\)/);
  assert.match(resultsUi, /nextRound <= MAX_PLAYABLE_ROUND && nextRound <= clientMaxEnabledRound\(\)/);
  const nextApi = read("../app/api/rounds/next-round/route.ts");
  assert.match(nextApi, /body.round < 2 \|\| body.round > MAX_PLAYABLE_ROUND/);
});

test("Round 3 restores the fixed $368 payment, household, Caregiver dependent, assets and unresolved Audit", async () => {
  const first = roundTwoStored("not-triggered");
  first.round_number = 1;
  const second = roundTwoStored("not-triggered");
  const third = { ...roundTwoStored("bypassed-beta"), round_number: 3 };
  const snapshots = [first, second, third];
  const before = structuredClone(snapshots);
  const restored = summarizeStoredResults(JSON.parse(JSON.stringify(third)))!;
  assert.equal(restored.roundNumber, 3);
  assert.equal(restored.taxPrepaid, 368);
  assert.equal(restored.taxRefund, 368);
  assert.equal(restored.calculatedTax, 0);
  assert.equal(restored.taxAmountDue, 0);
  assert.equal(restored.studentLoanPayment, 2500);
  assert.equal(restored.endingDebt, 0);
  assert.equal(restored.endingCash, 14250);
  assert.equal(restored.filingStatus, "MFJ");
  assert.equal(restored.homeowner, true);
  assert.equal(restored.activeDependents, 2);
  assert.equal(restored.details?.investmentAssetValue, 10000);
  assert.equal(restored.details?.taxBeforeCredits, 350);
  assert.equal(restored.details?.auditResolution, "bypassed-beta");
  assert.equal(restored.details?.auditPenalty, 0);
  assert.ok(restored.cards.some((card) => card.cardId === "WILD-006"));
  const requests: number[] = [];
  const history = await loadEarlierLedgerRounds(
    { id: "player", resumeToken: "token" }, 3, new AbortController().signal,
    async (url, init) => {
      assert.equal(url, "/api/rounds/results");
      const { round } = JSON.parse(String(init?.body));
      requests.push(round);
      return Response.json({ finalized: true, results: summarizeStoredResults(snapshots[round - 1]) });
    },
  );
  assert.deepEqual(requests, [1, 2]);
  const rows = lifeLedgerRows([...history, restored]);
  const values = (label: string) => rows.find((row) => row.label === label)!.values;
  assert.deepEqual(values("Tax you prepaid"), ["$368", "$368", "$368", "\u2014", "\u2014"]);
  assert.deepEqual(values("Ending cash/resources"), ["$14,250", "$14,250", "$14,250", "\u2014", "\u2014"]);
  assert.equal(values("Audit resolution")[2], "bypassed-beta (temporary; unresolved)");
  assert.deepEqual(snapshots, before);
  assert.deepEqual(summarizeStoredResults(third), restored);
});

test("Round 3 settlement uses saved payments without double counting and permits negative cash", () => {
  for (const fixedPrepayment of [0, 4000, 5000, 6500]) {
    const results = computeRoundResults({ ...base, beginningCash: -20000, beginningDebt: 10000, fixedPrepayment });
    assert.equal(results.taxPrepaid, fixedPrepayment);
    assert.equal(results.taxRefund, Math.max(0, fixedPrepayment - 5000));
    assert.equal(results.taxAmountDue, Math.max(0, 5000 - fixedPrepayment));
    assert.equal(results.studentLoanPayment, 4000);
    assert.equal(results.endingDebt, 6000);
    assert.equal(results.endingCash, -10000);
    assert.equal(toFinalizePayload(results).ending_cash, -10000);
    assert.equal(toFinalizePayload(results).ending_student_loan_debt, 6000);
  }
  for (const [adjustedGrossIncome, livingCosts] of [
    [30000, 25500], [50000, 36500], [75000, 47750], [100000, 56500], [120000, 61500],
  ]) {
    assert.equal(computeRoundResults({ ...base, adjustedGrossIncome }).livingCosts, livingCosts);
  }
});

test("Round 4 ledger appends its saved column, preserves all prior columns, and restores unchanged on refresh", async () => {
  const snapshots = [1, 2, 3, 4].map((round) => ({
    ...roundTwoStored(round === 4 ? "bypassed-beta" : "not-triggered"), round_number: round,
  }));
  const before = structuredClone(snapshots);
  const prior = snapshots.slice(0, 3).map((stored) => summarizeStoredResults(stored)!);
  const fourth = summarizeStoredResults(JSON.parse(JSON.stringify(snapshots[3])))!;
  const previousRows = lifeLedgerRows(prior);
  const rows = lifeLedgerRows([...prior, fourth]);
  for (const [index, row] of rows.entries()) {
    assert.deepEqual(row.values.slice(0, 3), previousRows[index].values.slice(0, 3));
    assert.notEqual(row.values[3], "\u2014", row.label);
    assert.equal(row.values[4], "\u2014");
  }
  assert.equal(rows.find((row) => row.label === "Tax you prepaid")!.values[3], "$368");
  assert.equal(rows.find((row) => row.label === "Tax refund")!.values[3], "$368");
  assert.equal(fourth.activeDependents, 2);
  assert.equal(fourth.homeowner, true);
  const calls: number[] = [];
  const request: typeof fetch = async (_url, init) => {
    const round = JSON.parse(String(init?.body)).round;
    calls.push(round);
    return Response.json({ finalized: true, results: summarizeStoredResults(snapshots[round - 1]) });
  };
  const history = await loadEarlierLedgerRounds({ id: "test", resumeToken: "test" }, 4, new AbortController().signal, request);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(lifeLedgerRows([...history, fourth]), rows);
  assert.deepEqual(snapshots, before);
  const route = readFileSync(new URL("../app/api/rounds/results-finalize/route.ts", import.meta.url), "utf8");
  assert.ok(route.indexOf("if (current?.finalized)") < route.indexOf("computeRoundResults({"));
  assert.doesNotMatch(route, /calculatePrepaymentDollars|calculateEarlyRetirementIncome|calculateGameTax|incomeComponents/);
  const ui = readFileSync(new URL("../components/round-results.tsx", import.meta.url), "utf8");
  assert.match(ui, /getRoundIncomeCardCategory\(results.pathwayId, results.roundNumber\)/);
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
