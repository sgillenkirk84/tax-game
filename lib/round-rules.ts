// Pure round rules shared by the tax builder and the tests. No card data and no imports.

export const MAX_PLAYABLE_ROUND = 3;

// The requested target is also the retry identity; never infer a later target on retry.
export function authorizeNextRound(
  state: {
    life_status: string;
    life_current_round: number;
    round_status: string;
    round_current_stage: string;
  },
  requestedRound: number,
  maxEnabledRound: number,
): { ok: true; roundNumber: number } | {
  ok: false;
  code: "STAGE_NOT_SUPPORTED" | "ROUND_NOT_ENABLED" | "GAME_LIFE_NOT_ACTIVE" |
    "NOT_CURRENT_STAGE" | "PREVIOUS_ROUND_NOT_FINALIZED";
} {
  if (!Number.isInteger(requestedRound) || requestedRound < 2 || requestedRound > MAX_PLAYABLE_ROUND) {
    return { ok: false, code: "STAGE_NOT_SUPPORTED" };
  }
  if (requestedRound > maxEnabledRound) {
    return { ok: false, code: "ROUND_NOT_ENABLED" };
  }
  if (state.life_status !== "in_progress") {
    return { ok: false, code: "GAME_LIFE_NOT_ACTIVE" };
  }
  if (state.life_current_round === requestedRound) {
    return state.round_status === "in_progress" || state.round_status === "finalized"
      ? { ok: true, roundNumber: state.life_current_round }
      : { ok: false, code: "NOT_CURRENT_STAGE" };
  }
  if (state.life_current_round + 1 !== requestedRound) {
    return { ok: false, code: "NOT_CURRENT_STAGE" };
  }
  if (state.round_status !== "finalized") {
    return { ok: false, code: "PREVIOUS_ROUND_NOT_FINALIZED" };
  }
  if (state.round_current_stage !== "results-and-life-ledger") {
    return { ok: false, code: "NOT_CURRENT_STAGE" };
  }
  return { ok: true, roundNumber: state.life_current_round + 1 };
}

export type ClimberCard = { id: string; amount: number };

// Corporate Climber keeps one primary income that never decreases. The higher dollar amount
// wins; a tie keeps the card already retained. Round 1 (no retained card) uses the drawn card.
export function resolveClimberPrimary(
  drawn: ClimberCard,
  prior: (ClimberCard & { establishedRound: number }) | null,
  round: number,
): { card: ClimberCard; establishedRound: number } {
  if (prior && drawn.amount <= prior.amount) {
    return { card: { id: prior.id, amount: prior.amount }, establishedRound: prior.establishedRound };
  }
  return { card: drawn, establishedRound: round };
}

// An effect-based dependent counts in a round from starts_round through expires_after_round.
export function dependentActiveInRound(
  effect: { status: string; startsRound: number; expiresAfterRound: number | null },
  round: number,
): boolean {
  return (
    effect.status === "active" &&
    effect.startsRound <= round &&
    (effect.expiresAfterRound === null || effect.expiresAfterRound >= round)
  );
}

// A dependent added in a round lasts that round and the next.
export function dependentExpiresAfter(addedRound: number): number {
  return Math.min(5, addedRound + 1);
}

export type StartNextRoundPlan =
  | { action: "replay" }
  | { action: "start"; beginningCash: number; beginningDebt: number }
  | { action: "reject"; code: "STAGE_NOT_SUPPORTED" | "NOT_CURRENT_STAGE" | "PREVIOUS_ROUND_NOT_FINALIZED" };

// Mirrors start_next_round, which stays the authority.
export function planStartNextRound(input: {
  currentRound: number;
  targetRound: number;
  previousFinalized: boolean;
  previousEndingCash: number;
  previousEndingDebt: number;
}): StartNextRoundPlan {
  if (input.targetRound < 2 || input.targetRound > MAX_PLAYABLE_ROUND) {
    return { action: "reject", code: "STAGE_NOT_SUPPORTED" };
  }
  if (input.currentRound === input.targetRound) {
    return { action: "replay" };
  }
  if (input.currentRound !== input.targetRound - 1) {
    return { action: "reject", code: "NOT_CURRENT_STAGE" };
  }
  if (!input.previousFinalized) {
    return { action: "reject", code: "PREVIOUS_ROUND_NOT_FINALIZED" };
  }
  return { action: "start", beginningCash: input.previousEndingCash, beginningDebt: input.previousEndingDebt };
}
