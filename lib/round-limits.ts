// Highest round students may play. Unset means Round 3; explicit limits are clamped to 1..3.
const HARD_MAX_ROUND = 3;

export function parseMaxEnabledRound(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return HARD_MAX_ROUND;
  }
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(parsed, HARD_MAX_ROUND);
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
