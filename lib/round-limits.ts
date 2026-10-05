import { MAX_PLAYABLE_ROUND } from "./round-rules.ts";

// Round 4 foundation is opt-in; existing unset/empty configuration still opens through Round 3.
const DEFAULT_MAX_ROUND = 3;

export function parseMaxEnabledRound(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_MAX_ROUND;
  }
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(parsed, MAX_PLAYABLE_ROUND);
}

export function serverMaxEnabledRound(): number {
  return parseMaxEnabledRound(process.env.MAX_ENABLED_ROUND);
}

export function clientMaxEnabledRound(): number {
  return parseMaxEnabledRound(process.env.NEXT_PUBLIC_MAX_ENABLED_ROUND);
}

export function serverRoundEnabled(round: number): boolean {
  return Number.isInteger(round) && round >= 1 && round <= serverMaxEnabledRound();
}
