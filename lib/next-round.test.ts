import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CARD_STAGES, expectedCategoryFor, isRoundCardStageAvailable, stageCardRules, stageInstructionsFor } from "./card-entry.ts";
import { getRoundIncomeCardCategory, isRetirementRound } from "./round-income.ts";
import workbookData from "./game-data/workbook-data.json" with { type: "json" };
import { calculateEarlyRetirementIncome, calculateGameTax, getRetirementStartRound } from "./game-calculations/calculations.ts";
import { resultsAvailableForRound } from "./round-results.ts";
import { parseMaxEnabledRound } from "./round-limits.ts";
import {
  authorizeNextRound,
  dependentActiveInRound,
  dependentExpiresAfter,
  planStartNextRound,
  resolveClimberPrimary,
} from "./round-rules.ts";
import { advanceTarget } from "./round-stages.ts";

const migration = readFileSync(new URL("../supabase/migrations/20261004100000_next_round.sql", import.meta.url), "utf8");
const dependent = (added: number) => ({ status: "active", startsRound: added, expiresAfterRound: dependentExpiresAfter(added) });

const finalizedState = (round: number) => ({
  life_status: "in_progress",
  life_current_round: round,
  round_status: "finalized",
  round_current_stage: "results-and-life-ledger",
});

test("next-round request rejects disabled Round 2", () => {
  assert.deepEqual(authorizeNextRound(finalizedState(1), 2, 1), { ok: false, code: "ROUND_NOT_ENABLED" });
});

test("next-round request permits finalized Round 1 to enabled Round 2", () => {
  assert.deepEqual(authorizeNextRound(finalizedState(1), 2, 2), { ok: true, roundNumber: 2 });
});

test("next-round request permits Round 3 only when enabled", () => {
  assert.deepEqual(authorizeNextRound(finalizedState(2), 3, 2), { ok: false, code: "ROUND_NOT_ENABLED" });
  assert.deepEqual(authorizeNextRound(finalizedState(2), 3, 3), { ok: true, roundNumber: 3 });
});

test("next-round request rejects Round 5 and malformed targets", () => {
  for (const target of [1, 5, 2.5, NaN]) {
    assert.deepEqual(authorizeNextRound(finalizedState(3), target, 5), { ok: false, code: "STAGE_NOT_SUPPORTED" });
  }
});

test("client targets cannot skip ahead or move behind trusted state", () => {
  assert.deepEqual(authorizeNextRound(finalizedState(1), 3, 3), { ok: false, code: "NOT_CURRENT_STAGE" });
  assert.deepEqual(authorizeNextRound(finalizedState(3), 2, 3), { ok: false, code: "NOT_CURRENT_STAGE" });
});

test("next-round retries keep the original target even after it is finalized", () => {
  assert.deepEqual(authorizeNextRound({
    ...finalizedState(2), round_status: "in_progress", round_current_stage: "income-or-retirement",
  }, 2, 3), { ok: true, roundNumber: 2 });
  assert.deepEqual(authorizeNextRound(finalizedState(2), 2, 3), { ok: true, roundNumber: 2 });
  assert.deepEqual(authorizeNextRound(finalizedState(3), 3, 3), { ok: true, roundNumber: 3 });
});

test("next-round requests require active life and finalized Results before a new start", () => {
  assert.deepEqual(authorizeNextRound({ ...finalizedState(1), life_status: "completed" }, 2, 3),
    { ok: false, code: "GAME_LIFE_NOT_ACTIVE" });
  assert.deepEqual(authorizeNextRound({ ...finalizedState(1), round_status: "in_progress" }, 2, 3),
    { ok: false, code: "PREVIOUS_ROUND_NOT_FINALIZED" });
  assert.deepEqual(authorizeNextRound({ ...finalizedState(1), round_current_stage: "deduction" }, 2, 3),
    { ok: false, code: "NOT_CURRENT_STAGE" });
});

test("Round 2 starts from the finalized Round 1 balances", () => {
  const plan = planStartNextRound({
    currentRound: 1, targetRound: 2, previousFinalized: true, previousEndingCash: 12345.67, previousEndingDebt: 16000,
  });
  assert.deepEqual(plan, { action: "start", beginningCash: 12345.67, beginningDebt: 16000 });
});

test("Round 3 starts only from a finalized Round 2", () => {
  const base = { targetRound: 3, previousEndingCash: 500, previousEndingDebt: 0 };
  assert.equal(planStartNextRound({ ...base, currentRound: 2, previousFinalized: true }).action, "start");
  assert.deepEqual(planStartNextRound({ ...base, currentRound: 2, previousFinalized: false }), {
    action: "reject", code: "PREVIOUS_ROUND_NOT_FINALIZED",
  });
  assert.equal(planStartNextRound({ ...base, currentRound: 1, previousFinalized: true }).action, "reject");
});

test("a refresh or retry replays the started round; Round 1 and Round 5 are rejected", () => {
  const base = { previousFinalized: true, previousEndingCash: 0, previousEndingDebt: 0 };
  assert.deepEqual(planStartNextRound({ ...base, currentRound: 2, targetRound: 2 }), { action: "replay" });
  assert.equal(planStartNextRound({ ...base, currentRound: 4, targetRound: 5 }).action, "reject");
  assert.equal(planStartNextRound({ ...base, currentRound: 1, targetRound: 1 }).action, "reject");
});

test("the migration enforces the same rules in one transaction before the round insert", () => {
  assert.match(migration, /not between 2 and 3/);
  assert.match(migration, /PREVIOUS_ROUND_NOT_FINALIZED/);
  assert.ok(migration.indexOf("set current_round = p_round_number") < migration.indexOf("insert into public.mm_game_rounds ("));
  assert.match(migration, /grant execute on function public\.start_next_round\(uuid, text, integer\) to service_role/);
});

test("Round 1 dependent is active in Rounds 1 and 2 and expires before Round 3", () => {
  const d = dependent(1);
  assert.deepEqual([1, 2, 3].map((round) => dependentActiveInRound(d, round)), [true, true, false]);
});

test("Round 2 dependent is active in Rounds 2 and 3 and expires before Round 4", () => {
  const d = dependent(2);
  assert.deepEqual([1, 2, 3, 4].map((round) => dependentActiveInRound(d, round)), [false, true, true, false]);
});

test("removed or expired dependents never count", () => {
  assert.equal(dependentActiveInRound({ status: "removed", startsRound: 1, expiresAfterRound: 2 }, 1), false);
  assert.equal(dependentActiveInRound({ status: "expired", startsRound: 1, expiresAfterRound: 2 }, 2), false);
});

test("Corporate Climber keeps the retained card unless the new one pays more", () => {
  const prior = { id: "INC-W2-005", amount: 60000, establishedRound: 1 };
  assert.deepEqual(resolveClimberPrimary({ id: "INC-BUS-001", amount: 40000 }, prior, 2), {
    card: { id: "INC-W2-005", amount: 60000 }, establishedRound: 1,
  });
  assert.deepEqual(resolveClimberPrimary({ id: "INC-BUS-002", amount: 60000 }, prior, 2).card.id, "INC-W2-005");
  assert.deepEqual(resolveClimberPrimary({ id: "INC-W2-009", amount: 90000 }, prior, 3), {
    card: { id: "INC-W2-009", amount: 90000 }, establishedRound: 3,
  });
  assert.deepEqual(resolveClimberPrimary({ id: "INC-W2-001", amount: 30000 }, null, 1), {
    card: { id: "INC-W2-001", amount: 30000 }, establishedRound: 1,
  });
});

test("Rounds 1 to 3 offer the same card stages including Tax Prepayment", () => {
  for (const round of [1, 2, 3]) {
    assert.deepEqual(stageCardRules("income-or-retirement", "PATH-004", round), { min: 1, max: 1 });
    assert.deepEqual(stageCardRules("income-or-retirement", "PATH-006", round), { min: 2, max: 2 });
    assert.deepEqual(stageCardRules("income-or-retirement", "PATH-002", round), { min: 1, max: 2 });
    assert.deepEqual(stageCardRules("life-event", "PATH-004", round), { min: 1, max: 1 });
    assert.deepEqual(stageCardRules("wildcard", "PATH-004", round), { min: 1, max: 1 });
    assert.deepEqual(stageCardRules("deduction", "PATH-004", round), { min: 1, max: 1 });
  }
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-004", 2), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-004", 3), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("income-or-retirement", "PATH-004", 4), { min: 1, max: 1 });
  assert.match(stageInstructionsFor("income-or-retirement", "PATH-006", 3), /two cards/);
});

test("Rounds 2 and 3 open shared Tax Prepayment and Results", () => {
  for (const round of [2, 3]) {
    assert.equal(advanceTarget("income-or-retirement", round)?.stage, "life-event");
    assert.equal(advanceTarget("life-event", round)?.stage, "wildcard");
    assert.equal(advanceTarget("wildcard", round)?.stage, "deduction");
    assert.equal(advanceTarget("deduction", round)?.stage, "tax-prepayment");
    assert.equal(advanceTarget("tax-prepayment", round)?.stage, "results-and-life-ledger");
  }
  assert.equal(advanceTarget("deduction", 1)?.stage, "tax-prepayment");
  assert.deepEqual(advanceTarget("wildcard", 4), { stage: "deduction", label: "Deduction" });
});

test("Round 3 remains the default; Round 4 requires an explicit limit and Round 5 stays closed", () => {
  assert.equal(parseMaxEnabledRound(undefined), 3);
  assert.equal(parseMaxEnabledRound(""), 3);
  assert.equal(parseMaxEnabledRound("  "), 3);
  assert.equal(parseMaxEnabledRound("abc"), 1);
  assert.equal(parseMaxEnabledRound("0"), 1);
  assert.equal(parseMaxEnabledRound("1"), 1);
  assert.equal(parseMaxEnabledRound("2"), 2);
  assert.equal(parseMaxEnabledRound("3"), 3);
  assert.equal(parseMaxEnabledRound("4"), 4);
  assert.equal(parseMaxEnabledRound("5"), 4);
  assert.deepEqual(authorizeNextRound(finalizedState(2), 3, parseMaxEnabledRound(undefined)), { ok: true, roundNumber: 3 });
  assert.deepEqual(authorizeNextRound({ ...finalizedState(2), round_status: "in_progress" }, 3, 3),
    { ok: false, code: "PREVIOUS_ROUND_NOT_FINALIZED" });
  assert.deepEqual(authorizeNextRound(finalizedState(3), 4, 3), { ok: false, code: "ROUND_NOT_ENABLED" });
});

test("visible Round 3 is rejected when the deployment still uses a lower server limit", () => {
  const publicLimit = parseMaxEnabledRound("3");
  const deployedServerLimit = parseMaxEnabledRound("2");
  assert.equal(3 <= publicLimit, true);
  assert.deepEqual(authorizeNextRound(finalizedState(2), 3, deployedServerLimit), {
    ok: false, code: "ROUND_NOT_ENABLED",
  });
  const route = readFileSync(new URL("../app/api/rounds/next-round/route.ts", import.meta.url), "utf8");
  assert.match(route, /\["ROUND_NOT_ENABLED", 409, "This round is not available yet\."\]/);
  assert.ok(route.indexOf("if (body.round > maxEnabledRound)") < route.indexOf('student.rpc("get_current_round_state"'));
});

test("aligned deployed limits allow finalized Round 2 to start or recover Round 3 at Income", () => {
  const limit = parseMaxEnabledRound("3");
  assert.equal(3 <= limit, true);
  assert.deepEqual(authorizeNextRound(finalizedState(2), 3, limit), { ok: true, roundNumber: 3 });
  assert.deepEqual(planStartNextRound({
    currentRound: 2, targetRound: 3, previousFinalized: true,
    previousEndingCash: 14250, previousEndingDebt: 12000,
  }), { action: "start", beginningCash: 14250, beginningDebt: 12000 });
  assert.deepEqual(authorizeNextRound({
    ...finalizedState(3), round_status: "in_progress", round_current_stage: "income-or-retirement",
  }, 3, limit), { ok: true, roundNumber: 3 });
  assert.deepEqual(planStartNextRound({
    currentRound: 3, targetRound: 3, previousFinalized: true,
    previousEndingCash: 14250, previousEndingDebt: 12000,
  }), { action: "replay" });
  assert.match(migration, /set current_round = p_round_number,\s*current_stage = 'income-or-retirement'/);
  assert.doesNotMatch(migration, /ROUND_NOT_ENABLED|MAX_ENABLED_ROUND/);
});

test("Round 3 handoff preserves balances and life state without rewriting finalized history", () => {
  const previous = { currentRound: 2, targetRound: 3, previousFinalized: true, previousEndingCash: 14250.75, previousEndingDebt: 12000 };
  const before = structuredClone(previous);
  assert.deepEqual(planStartNextRound(previous), { action: "start", beginningCash: 14250.75, beginningDebt: 12000 });
  assert.deepEqual(previous, before);
  const start = migration.slice(migration.indexOf("create or replace function public.start_next_round("), migration.indexOf("create or replace function public.get_current_round_state("));
  assert.match(start, /previous_round\.status <> 'finalized'/);
  assert.match(start, /previous_round\.ending_cash_resources,\s*previous_round\.ending_student_loan_debt/);
  assert.match(start, /effect\.status = 'active'[\s\S]*effect\.expires_after_round < p_round_number/);
  assert.doesNotMatch(start, /update public\.mm_game_rounds|update public\.mm_game_life_ledger|update public\.mm_game_investments/);
  assert.doesNotMatch(start, /set filing_status|set homeowner|set pathway_id|set corporate_climber_primary/);
  const schema = readFileSync(new URL("../supabase/migrations/20261003200000_replayable_game_schema.sql", import.meta.url), "utf8");
  assert.match(schema, /GAME_ROUND_FINALIZED/);
  assert.match(schema, /GAME_LEDGER_IMMUTABLE/);
});

test("Round 3 physical Income and supported stages reuse existing card rules", () => {
  for (const pathway of ["PATH-001", "PATH-002", "PATH-003", "PATH-004", "PATH-005", "PATH-006", "PATH-007", "PATH-008"]) {
    assert.equal(expectedCategoryFor("income-or-retirement", pathway, 3), "Income");
    assert.deepEqual(stageCardRules("income-or-retirement", pathway, 3),
      pathway === "PATH-006" ? { min: 2, max: 2 } : pathway === "PATH-002" ? { min: 1, max: 2 } : { min: 1, max: 1 });
    assert.match(stageInstructionsFor("income-or-retirement", pathway, 3), /draw|hand/);
    for (const stage of ["life-event", "wildcard", "deduction"] as const) {
      assert.deepEqual(stageCardRules(stage, pathway, 3), { min: 1, max: 1 });
      assert.match(stageInstructionsFor(stage, pathway, 3), /draw.*card/);
    }
  }
  assert.equal(expectedCategoryFor("income-or-retirement", "PATH-008", 4), "Retirement");
  const entry = readFileSync(new URL("../components/card-entry.tsx", import.meta.url), "utf8");
  assert.match(entry, /\/api\/rounds\/card-save/);
  assert.doesNotMatch(entry, /Math\.random/);
});

test("Round 4 can advance through shared Prepayment but Results stay closed", () => {
  assert.deepEqual(advanceTarget("deduction", 3), { stage: "tax-prepayment", label: "Tax Prepayment" });
  assert.deepEqual(advanceTarget("tax-prepayment", 3), { stage: "results-and-life-ledger", label: "Results and Life Ledger" });
  assert.equal(advanceTarget("tax-prepayment", 4), null);
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 3), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 4), { min: 1, max: 1 });
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const prepaymentMigration = read("../supabase/migrations/20261005160000_round_three_tax_prepayment.sql");
  assert.match(prepaymentMigration, /when life_row\.current_round not between 1 and 3 then 0/);
  assert.match(prepaymentMigration, /when 'deduction' then\n      if life_row\.current_round between 1 and 3 then/);
  const resultsMigration = read("../supabase/migrations/20261005170000_round_three_results.sql");
  assert.match(resultsMigration, /if life_row\.current_round not between 1 and 3 then/);
  assert.match(read("../app/api/rounds/prepayment/route.ts"), /body\.round > 4/);
  assert.match(read("./round-results.ts"), /round <= 3 && round <= maxEnabledRound/);
  const dashboard = read("../components/round-dashboard.tsx");
  assert.match(dashboard, /taxCalculated && prepaymentEnabled && round <= 4/);
});

test("Tax Prepayment, Results and Audit are untouched by this migration", () => {
  assert.doesNotMatch(migration, /create or replace function public\.(finalize_round_results|get_round_results|get_round_prepayment|keep_round_prepayment_card)/);
  assert.doesNotMatch(migration, /drop (table|function|constraint)/i);
});

test("shared retirement card source matches all approved pathways in all five rounds without opening Round 5", () => {
  for (const pathway of workbookData.pathways) {
    for (const round of [1, 2, 3, 4, 5]) {
      const expected = round >= getRetirementStartRound(pathway.id) ? "Retirement" : "Income";
      assert.equal(getRoundIncomeCardCategory(pathway.id, round), expected);
      assert.equal(isRetirementRound(pathway.id, round), expected === "Retirement");
      assert.equal(expectedCategoryFor("income-or-retirement", pathway.id, round), expected);
    }
    assert.deepEqual(stageCardRules("income-or-retirement", pathway.id, 5), { min: 0, max: 0 });
    assert.equal(advanceTarget("income-or-retirement", 5), null);
  }
  assert.deepEqual(authorizeNextRound(finalizedState(4), 5, 5), { ok: false, code: "STAGE_NOT_SUPPORTED" });
  assert.throws(() => getRoundIncomeCardCategory("PATH-999", 4), /Unknown Pathway/);
});

test("Round 4 requires aligned explicit rollout limits and finalized Round 3; start/recovery keeps inherited balances", () => {
  const target = 4;
  assert.equal(parseMaxEnabledRound(undefined), 3);
  assert.equal(parseMaxEnabledRound(""), 3);
  assert.deepEqual(authorizeNextRound(finalizedState(3), target, parseMaxEnabledRound("3")),
    { ok: false, code: "ROUND_NOT_ENABLED" });
  assert.deepEqual(authorizeNextRound(finalizedState(3), target, parseMaxEnabledRound("4")),
    { ok: true, roundNumber: 4 });
  assert.deepEqual(authorizeNextRound({ ...finalizedState(3), round_status: "in_progress" }, target, 4),
    { ok: false, code: "PREVIOUS_ROUND_NOT_FINALIZED" });
  assert.deepEqual(authorizeNextRound(finalizedState(2), target, 4),
    { ok: false, code: "NOT_CURRENT_STAGE" });
  assert.deepEqual(authorizeNextRound({ ...finalizedState(4), round_status: "in_progress", round_current_stage: "income-or-retirement" }, target, 4),
    { ok: true, roundNumber: 4 });
  const input = {
    currentRound: 3, targetRound: target, previousFinalized: true,
    previousEndingCash: -1250.75, previousEndingDebt: 8000,
  };
  assert.deepEqual(planStartNextRound(input), { action: "start", beginningCash: -1250.75, beginningDebt: 8000 });
  assert.deepEqual(planStartNextRound({ ...input, previousFinalized: false }),
    { action: "reject", code: "PREVIOUS_ROUND_NOT_FINALIZED" });
  assert.deepEqual(planStartNextRound({ ...input, currentRound: 4 }), { action: "replay" });
});

test("Round 4 opens shared card stages through Deduction and keeps all regular-life pathway counts", () => {
  for (const pathway of workbookData.pathways) {
    const expectedRules = pathway.id === "PATH-006" ? { min: 2, max: 2 }
      : pathway.id === "PATH-002" ? { min: 1, max: 2 } : { min: 1, max: 1 };
    assert.deepEqual(stageCardRules("income-or-retirement", pathway.id, 4), expectedRules);
    assert.equal(isRoundCardStageAvailable("income-or-retirement", 4), true);
    assert.match(stageInstructionsFor("income-or-retirement", pathway.id, 4), /draw.*card/i);
    for (const stage of ["life-event", "wildcard", "deduction", "tax-prepayment"] as const) {
      assert.equal(isRoundCardStageAvailable(stage, 4), true);
      assert.deepEqual(stageCardRules(stage, pathway.id, 4), { min: 1, max: 1 });
      assert.match(stageInstructionsFor(stage, pathway.id, 4), /draw.*card/i);
    }
    for (const stage of ["audit-if-triggered"] as const) {
      assert.equal(isRoundCardStageAvailable(stage, 4), false);
      assert.deepEqual(stageCardRules(stage, pathway.id, 4), { min: 0, max: 0 });
      assert.equal(advanceTarget(stage, 4), null);
    }
    assert.equal(advanceTarget("income-or-retirement", 4)?.stage, "life-event");
    assert.equal(advanceTarget("life-event", 4)?.stage, "wildcard");
    assert.equal(advanceTarget("wildcard", 4)?.stage, "deduction");
    assert.equal(advanceTarget("deduction", 4)?.stage, "tax-prepayment");
    assert.equal(advanceTarget("tax-prepayment", 4), null);
    for (const stage of CARD_STAGES) {
      assert.equal(isRoundCardStageAvailable(stage, 5), false);
      assert.equal(advanceTarget(stage, 5), null);
    }
  }
  assert.match(stageInstructionsFor("income-or-retirement", "PATH-008", 4), /Physically shuffle the Retirement deck/);
  assert.doesNotMatch(stageInstructionsFor("income-or-retirement", "PATH-008", 4), /Income deck/);
  assert.match(stageInstructionsFor("income-or-retirement", "PATH-006", 4), /two cards/);
  assert.match(stageInstructionsFor("income-or-retirement", "PATH-002", 4), /Business Income/);
  assert.match(stageInstructionsFor("life-event", "PATH-003", 4), /permanent dependent token/);
  assert.equal(resultsAvailableForRound(4, 4), false);
});

test("Round 4 boundary expires only effects due now; permanent and Round 3 effects remain and removed effects stay removed", () => {
  assert.equal(dependentActiveInRound(dependent(2), 4), false);
  assert.equal(dependentActiveInRound(dependent(3), 4), true);
  assert.equal(dependentActiveInRound(dependent(3), 5), false);
  assert.equal(dependentActiveInRound({ status: "active", startsRound: 1, expiresAfterRound: null }, 4), true);
  for (const status of ["removed", "expired"]) {
    assert.equal(dependentActiveInRound({ status, startsRound: 3, expiresAfterRound: 4 }, 4), false);
  }
  const prior = { id: "INC-BIZ-004", amount: 100000, establishedRound: 3 };
  assert.deepEqual(resolveClimberPrimary({ id: "INC-W2-004", amount: 50000 }, prior, 4),
    { card: { id: prior.id, amount: prior.amount }, establishedRound: 3 });
});

test("physical Retirement card IDs retain workbook component identity after restore; existing tax treatment is not wages", () => {
  const before = structuredClone(workbookData);
  const cards = workbookData.cards.filter((card) => card.deck === "Retirement" && card.active === "Yes");
  assert.equal(cards.length, 10);
  for (const card of cards) {
    const saved = { round_number: 4, stage: "income-or-retirement", card_id: card.id, deck: "Retirement" };
    const restored = JSON.parse(JSON.stringify(saved));
    const source = workbookData.cards.find((candidate) => candidate.id === restored.card_id)!;
    assert.equal(source.deck, "Retirement");
    assert.deepEqual(source.incomeComponents, card.incomeComponents);
    assert.ok(Array.isArray(source.incomeComponents));
    assert.equal(source.incomeComponents.reduce((sum, component) => sum + component.amount, 0), source.amount);
    const retirement = calculateEarlyRetirementIncome({ roundNumber: 4, retirementCardId: String(card.id) });
    assert.equal(retirement.currentRetirementCardId, card.id);
    assert.ok(retirement.retirementIncomeSources.every((source) => source.category !== "w2-wages"));
  }
  const benefitsOnly = calculateGameTax({
    incomeSources: [{ category: "social-security", amount: 18000, sourceId: "RET-SSA-001" }],
    filingStatus: "SINGLE", otherEligibleItemizedDeduction: 0,
  });
  assert.equal(benefitsOnly.status, "supported");
  assert.equal(benefitsOnly.socialSecurityIncludedInIncome, 0);
  assert.equal(benefitsOnly.incomeByCategory["w2-wages"], 0);
  const mixed = calculateEarlyRetirementIncome({ roundNumber: 4, retirementCardId: "RET-MIX-003" });
  assert.deepEqual(mixed.retirementIncomeSources.map((source) => source.category),
    ["social-security", "retirement-or-investment-income"]);
  assert.deepEqual(workbookData, before);
});

test("Round 4 migrations patch only authorized gates in the cumulative installed definitions", () => {
  const read = (file: string) => readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const extract = (source: string, name: string) => {
    source = source.replace(/\r\n/g, "\n");
    const start = source.indexOf(`create or replace function public.${name}(`);
    const end = source.indexOf("\n$$;", start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end);
  };
  const startKey = "public.start_next_round(uuid,text,integer)";
  const recordKey = "public.record_round_card(uuid,text,integer,text,text,text,uuid,text)";
  const advanceKey = "public.advance_round_stage(uuid,text,integer,text,uuid)";
  const finalizerKey = "public.finalize_round_results(uuid,text,integer,uuid,jsonb)";
  const keepKey = "public.keep_round_prepayment_card(uuid,text,integer,uuid)";
  const taxKey = "public.save_round_tax_result(uuid,text,integer,uuid,jsonb)";
  const definitions = new Map([
    [startKey, extract(migration, "start_next_round")],
    [recordKey, extract(migration, "record_round_card")],
    [advanceKey, extract(migration, "advance_round_stage")],
    [finalizerKey, extract(read("20261004090000_round_results.sql"), "finalize_round_results")],
    [keepKey, extract(read("20261004080000_tax_prepayment.sql"), "keep_round_prepayment_card")],
    [taxKey, extract(migration, "save_round_tax_result")],
  ]);
  const patch = (file: string, expectedCount: number) => {
    const sql = read(file);
    const changes = [...sql.matchAll(/\(\s*'([^']+)',\s*(?:\$old\$([\s\S]*?)\$old\$|'([^']*)'),\s*(?:\$new\$([\s\S]*?)\$new\$|'([^']*)')\s*\)/g)];
    assert.equal(changes.length, expectedCount);
    for (const [, signature, oldBlock, oldString, newBlock, newString] of changes) {
      const source = definitions.get(signature);
      assert.ok(source, signature);
      const oldText = oldBlock ?? oldString;
      assert.equal(source.split(oldText).length - 1, 1, `${file}: ${signature}`);
      definitions.set(signature, source.replace(oldText, newBlock ?? newString));
    }
    return sql;
  };
  patch("20261005120000_round_two_tax_prepayment.sql", 3);
  patch("20261005150000_round_two_results.sql", 6);
  patch("20261005160000_round_three_tax_prepayment.sql", 3);
  patch("20261005170000_round_three_results.sql", 2);
  const before = new Map(definitions);
  const sql = patch("20261005180000_round_four_opening.sql", 2);
  const start = definitions.get(startKey)!;
  assert.equal(start, before.get(startKey)!.replace("p_round_number not between 2 and 3", "p_round_number not between 2 and 4"));
  assert.match(start, /previous_round.status <> 'finalized'/);
  assert.match(start, /previous_round.ending_cash_resources,\s+previous_round.ending_student_loan_debt/);
  assert.match(start, /effect.status = 'active'[\s\S]*effect.expires_after_round < p_round_number/);
  assert.match(start, /current_stage = 'income-or-retirement'/);
  assert.match(start, /life_row.current_round = p_round_number[\s\S]*was_replayed := true/);
  assert.doesNotMatch(start, /set filing_status|set homeowner|mm_game_investments|set persistent_state|finalize_round_results/);
  const record = definitions.get(recordKey)!;
  const oldIncomeStart = before.get(recordKey)!.indexOf("      required_deck :=");
  const oldIncomeEnd = before.get(recordKey)!.indexOf("\n    when 'life-event'", oldIncomeStart);
  const newIncomeStart = record.indexOf("      required_deck :=");
  const newIncomeEnd = record.indexOf("\n    when 'life-event'", newIncomeStart);
  assert.equal(record.slice(0, newIncomeStart), before.get(recordKey)!.slice(0, oldIncomeStart));
  assert.equal(record.slice(newIncomeEnd), before.get(recordKey)!.slice(oldIncomeEnd));
  assert.match(record, /public.mm_round_income_deck\(life_row.pathway_id, life_row.current_round\)/);
  assert.match(record, /current_round not between 1 and 4 then 0/);
  assert.match(record, /required_deck = 'Retirement' then 1/);
  assert.match(record, /catalog_row.deck <> required_deck or catalog_row.stage <> p_stage/);
  assert.match(record, /normalized_card_id not like 'INC-BIZ-%'/);
  assert.match(record, /saved_count >= stage_card_limit/);
  assert.match(record, /IDEMPOTENCY_KEY_REUSED/);
  assert.ok(record.indexOf("if found then") < record.indexOf("insert into public.mm_game_card_history"));
  for (const key of [advanceKey, finalizerKey, keepKey]) {
    assert.equal(definitions.get(key), before.get(key), key);
  }
  assert.match(sql, /p_round_number = 5 or \(p_pathway_id = 'PATH-008' and p_round_number = 4\)/);
  assert.match(sql, /revoke all on function public.mm_round_income_deck/);
  assert.doesNotMatch(sql, /grant execute on function public.mm_round_income_deck/);
  assert.match(sql, /fn.prosecdef/);
  assert.match(sql, /search_path=pg_catalog/);
  assert.match(sql, /old_count <> 1/);
  assert.match(sql, /grant execute on function public.start_next_round.*to service_role/);
  assert.match(sql, /grant execute on function public.record_round_card.*to anon/);
  assert.doesNotMatch(sql, /alter table|update public\.|insert into public\.|mm_fix_round_prepayment/);
  const beforeTax = new Map(definitions);
  const taxSql = patch("20261005190000_round_four_tax_calculation.sql", 7);
  for (const key of [startKey, finalizerKey, keepKey]) {
    assert.equal(definitions.get(key), beforeTax.get(key), key);
  }
  assert.equal(definitions.get(taxKey), beforeTax.get(taxKey)!.replace(
    "if life_row.current_round not between 1 and 3 then",
    "if life_row.current_round not between 1 and 4 then",
  ));
  const updatedRecord = definitions.get(recordKey)!;
  const updatedAdvance = definitions.get(advanceKey)!;
  for (const stage of ["life-event", "wildcard", "deduction"]) {
    assert.match(updatedRecord, new RegExp(`when '${stage}' then[\\s\\S]*?between 1 and 4 then 1 else 0`));
  }
  for (const stage of ["income-or-retirement", "life-event", "wildcard"]) {
    assert.match(updatedAdvance, new RegExp(`when '${stage}' then\\n      if life_row.current_round between 1 and 4 then`));
  }
  for (const [key, fromStage] of [[recordKey, "tax-prepayment"], [advanceKey, "deduction"]]) {
    const marker = `when '${fromStage}' then`;
    assert.equal(definitions.get(key)!.slice(definitions.get(key)!.indexOf(marker)),
      beforeTax.get(key)!.slice(beforeTax.get(key)!.indexOf(marker)));
  }
  assert.match(definitions.get(taxKey)!, /stored is not null[\s\S]*'replayed', true/);
  assert.match(definitions.get(taxKey)!, /activation_round[\s\S]*round_row.round_number \+ 1/);
  assert.match(definitions.get(taxKey)!, /input_snapshot = p_calculation -> 'input_snapshot'/);
  assert.match(taxSql, /fn.prosecdef/);
  assert.match(taxSql, /search_path=pg_catalog/);
  assert.match(taxSql, /old_count <> 1/);
  assert.match(taxSql, /grant execute on function public.save_round_tax_result.*to service_role/);
  assert.doesNotMatch(taxSql, /alter table|update public\.|insert into public\.|mm_fix_round_prepayment/);
  const beforePrepayment = new Map(definitions);
  const prepaymentSql = patch("20261005200000_round_four_tax_prepayment.sql", 3);
  for (const key of [startKey, finalizerKey, taxKey]) {
    assert.equal(definitions.get(key), beforePrepayment.get(key), key);
  }
  assert.equal(definitions.get(recordKey), beforePrepayment.get(recordKey)!.replace(
    "when life_row.current_round not between 1 and 3 then 0",
    "when life_row.current_round not between 1 and 4 then 0",
  ));
  assert.equal(definitions.get(advanceKey), beforePrepayment.get(advanceKey)!.replace(
    "when 'deduction' then\n      if life_row.current_round between 1 and 3 then",
    "when 'deduction' then\n      if life_row.current_round between 1 and 4 then",
  ));
  assert.equal(definitions.get(keepKey), beforePrepayment.get(keepKey)!.replace(
    "if life_row.current_round not between 1 and 3 then",
    "if life_row.current_round not between 1 and 4 then",
  ));
  assert.match(definitions.get(advanceKey)!, /when 'tax-prepayment' then\s+if life_row.current_round between 1 and 3 then/);
  assert.match(definitions.get(recordKey)!, /first_rate >= 90/);
  assert.match(definitions.get(recordKey)!, /PREPAYMENT_ALREADY_FIXED/);
  assert.match(definitions.get(recordKey)!, /catalog_row.prepayment_rate_pct/);
  assert.match(prepaymentSql, /old_count <> 1/);
  assert.match(prepaymentSql, /fn.prosecdef/);
  assert.match(prepaymentSql, /search_path=pg_catalog/);
  assert.doesNotMatch(prepaymentSql, /mm_fix_round_prepayment|finalize_round_results|alter table|update public\.|insert into public\./);
});

test("Round 4 API/UI restore and card entry reuse authoritative IDs, retry keys and stage guards without random draws", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const entry = read("../components/card-entry.tsx");
  assert.match(entry, /setSavedCards\(previous\)/);
  assert.match(entry, /idempotencyKey.current \?\?= crypto.randomUUID\(\)/);
  assert.match(entry, /cardId: card.id/);
  assert.doesNotMatch(entry, /Math.random|incomeSources|calculateEarlyRetirementIncome|w2-wages/);
  const lookup = read("./card-lookup.ts");
  assert.match(lookup, /card.deck !== expectedCategory/);
  assert.doesNotMatch(lookup, /Math.random|w2-wages/);
  for (const file of ["card-preview", "card-save"]) {
    assert.match(read(`../app/api/rounds/${file}/route.ts`), /isRoundCardStageAvailable/);
  }
  assert.match(read("../app/api/rounds/card-options/route.ts"), /rules.max === 0/);
  assert.match(read("../app/api/rounds/progress/route.ts"), /lookupCard\(row.card_id, category\)/);
  assert.match(read("../app/api/rounds/stage-advance/route.ts"), /!advanceTarget\(body.stage, body.round\)/);
  assert.match(read("../components/round-dashboard.tsx"), /taxCalculated && \(!target \|\| !prepaymentEnabled/);
  assert.match(read("../components/round-dashboard.tsx"), /Your Round \{round\} tax return is saved\. Tax Prepayment is not available yet/);
  assert.match(read("../components/tax-calculation.tsx"), /advanceTarget\("deduction", round\)/);
  assert.match(read("../components/round-results.tsx"), /nextRound <= MAX_PLAYABLE_ROUND && nextRound <= clientMaxEnabledRound\(\)/);
  assert.match(read("../app/api/rounds/next-round/route.ts"), /body.round > MAX_PLAYABLE_ROUND/);
  assert.match(read("./round-tax.ts"), /round.round_number > 4/);
});
