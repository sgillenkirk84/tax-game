import { getRetirementStartRound } from "./game-calculations/calculations.ts";

// Approved lifecycle timing is independent of which rounds are currently open.
export function isRetirementRound(pathwayId: string, round: number): boolean {
  return Number.isInteger(round) && round >= 1 && round <= 5
    && round >= getRetirementStartRound(pathwayId);
}

export function getRoundIncomeCardCategory(pathwayId: string, round: number): "Income" | "Retirement" {
  return isRetirementRound(pathwayId, round) ? "Retirement" : "Income";
}
