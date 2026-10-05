import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { expectedCategoryFor, stageCardRules, stageInstructionsFor } from "./card-entry.ts";
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

test("next-round request rejects Round 4 and malformed targets", () => {
  for (const target of [1, 4, 2.5, NaN]) {
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

test("a refresh or retry replays the started round; Round 1 and Round 4 are rejected", () => {
  const base = { previousFinalized: true, previousEndingCash: 0, previousEndingDebt: 0 };
  assert.deepEqual(planStartNextRound({ ...base, currentRound: 2, targetRound: 2 }), { action: "replay" });
  assert.equal(planStartNextRound({ ...base, currentRound: 3, targetRound: 4 }).action, "reject");
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
  assert.deepEqual(stageCardRules("income-or-retirement", "PATH-004", 4), { min: 0, max: 0 });
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
  assert.equal(advanceTarget("wildcard", 4), null);
});

test("Round 3 rollout defaults on, respects explicit limits and keeps Round 4 closed", () => {
  assert.equal(parseMaxEnabledRound(undefined), 3);
  assert.equal(parseMaxEnabledRound(""), 3);
  assert.equal(parseMaxEnabledRound("  "), 3);
  assert.equal(parseMaxEnabledRound("abc"), 1);
  assert.equal(parseMaxEnabledRound("0"), 1);
  assert.equal(parseMaxEnabledRound("1"), 1);
  assert.equal(parseMaxEnabledRound("2"), 2);
  assert.equal(parseMaxEnabledRound("3"), 3);
  assert.equal(parseMaxEnabledRound("5"), 3);
  assert.deepEqual(authorizeNextRound(finalizedState(2), 3, parseMaxEnabledRound(undefined)), { ok: true, roundNumber: 3 });
  assert.deepEqual(authorizeNextRound({ ...finalizedState(2), round_status: "in_progress" }, 3, 3),
    { ok: false, code: "PREVIOUS_ROUND_NOT_FINALIZED" });
  assert.deepEqual(authorizeNextRound(finalizedState(3), 4, 3), { ok: false, code: "STAGE_NOT_SUPPORTED" });
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

test("Round 3 can advance through shared Results but cannot expose Round 4", () => {
  assert.deepEqual(advanceTarget("deduction", 3), { stage: "tax-prepayment", label: "Tax Prepayment" });
  assert.deepEqual(advanceTarget("tax-prepayment", 3), { stage: "results-and-life-ledger", label: "Results and Life Ledger" });
  assert.equal(advanceTarget("tax-prepayment", 4), null);
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 3), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 4), { min: 0, max: 0 });
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const prepaymentMigration = read("../supabase/migrations/20261005160000_round_three_tax_prepayment.sql");
  assert.match(prepaymentMigration, /when life_row\.current_round not between 1 and 3 then 0/);
  assert.match(prepaymentMigration, /when 'deduction' then\n      if life_row\.current_round between 1 and 3 then/);
  const resultsMigration = read("../supabase/migrations/20261005170000_round_three_results.sql");
  assert.match(resultsMigration, /if life_row\.current_round not between 1 and 3 then/);
  assert.match(read("../app/api/rounds/prepayment/route.ts"), /body\.round > 3/);
  assert.match(read("./round-results.ts"), /round <= 3 && round <= maxEnabledRound/);
  const dashboard = read("../components/round-dashboard.tsx");
  assert.match(dashboard, /taxCalculated && prepaymentEnabled && round <= 3/);
});

test("Tax Prepayment, Results and Audit are untouched by this migration", () => {
  assert.doesNotMatch(migration, /create or replace function public\.(finalize_round_results|get_round_results|get_round_prepayment|keep_round_prepayment_card)/);
  assert.doesNotMatch(migration, /drop (table|function|constraint)/i);
});
