import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stageCardRules, stageInstructionsFor } from "./card-entry.ts";
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

test("Rounds 1 to 3 offer the same card stages; Prepayment opens in Rounds 1-2", () => {
  for (const round of [1, 2, 3]) {
    assert.deepEqual(stageCardRules("income-or-retirement", "PATH-004", round), { min: 1, max: 1 });
    assert.deepEqual(stageCardRules("income-or-retirement", "PATH-006", round), { min: 2, max: 2 });
    assert.deepEqual(stageCardRules("income-or-retirement", "PATH-002", round), { min: 1, max: 2 });
    assert.deepEqual(stageCardRules("life-event", "PATH-004", round), { min: 1, max: 1 });
    assert.deepEqual(stageCardRules("wildcard", "PATH-004", round), { min: 1, max: 1 });
    assert.deepEqual(stageCardRules("deduction", "PATH-004", round), { min: 1, max: 1 });
  }
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-004", 2), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-004", 3), { min: 0, max: 0 });
  assert.deepEqual(stageCardRules("income-or-retirement", "PATH-004", 4), { min: 0, max: 0 });
  assert.match(stageInstructionsFor("income-or-retirement", "PATH-006", 3), /two cards/);
});

test("Round 2 opens Tax Prepayment but not Results; Round 3 stops after Tax Calculation", () => {
  for (const round of [2, 3]) {
    assert.equal(advanceTarget("income-or-retirement", round)?.stage, "life-event");
    assert.equal(advanceTarget("life-event", round)?.stage, "wildcard");
    assert.equal(advanceTarget("wildcard", round)?.stage, "deduction");
    assert.equal(advanceTarget("deduction", round)?.stage ?? null, round === 2 ? "tax-prepayment" : null);
    assert.equal(advanceTarget("tax-prepayment", round), null);
  }
  assert.equal(advanceTarget("deduction", 1)?.stage, "tax-prepayment");
  assert.equal(advanceTarget("wildcard", 4), null);
});

test("the round limit defaults to Round 1 and is clamped to Rounds 1 to 3", () => {
  assert.equal(parseMaxEnabledRound(undefined), 1);
  assert.equal(parseMaxEnabledRound(""), 1);
  assert.equal(parseMaxEnabledRound("abc"), 1);
  assert.equal(parseMaxEnabledRound("0"), 1);
  assert.equal(parseMaxEnabledRound("2"), 2);
  assert.equal(parseMaxEnabledRound("3"), 3);
  assert.equal(parseMaxEnabledRound("5"), 3);
});

test("Tax Prepayment, Results and Audit are untouched by this migration", () => {
  assert.doesNotMatch(migration, /create or replace function public\.(finalize_round_results|get_round_results|get_round_prepayment|keep_round_prepayment_card)/);
  assert.doesNotMatch(migration, /drop (table|function|constraint)/i);
});
