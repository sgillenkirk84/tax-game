// Shared, client-safe round stage flow. Contains no card data.
import type { CardStage } from "@/lib/card-entry";

export type RoundFlowStep = {
  id: CardStage | "tax-calculation" | "results-and-life-ledger";
  label: string;
  // "cards": the student records physical cards. "automatic": backend work with
  // no card draw. "results": the final review.
  kind: "cards" | "automatic" | "results";
};

// Approved sequence. Tax calculation is a backend step, not a persisted stage
// and not a physical card draw; it will run when Deduction is completed.
export const ROUND_FLOW: readonly RoundFlowStep[] = [
  { id: "income-or-retirement", label: "Income", kind: "cards" },
  { id: "life-event", label: "Life Event", kind: "cards" },
  { id: "wildcard", label: "Wildcard", kind: "cards" },
  { id: "deduction", label: "Deduction", kind: "cards" },
  { id: "tax-calculation", label: "Tax calculation", kind: "automatic" },
  { id: "tax-prepayment", label: "Tax Prepayment", kind: "cards" },
  { id: "audit-if-triggered", label: "Audit (if triggered)", kind: "cards" },
  { id: "results-and-life-ledger", label: "Results and Life Ledger", kind: "results" },
];

// Audit is intentionally omitted for now: students go from Tax Prepayment straight
// to Results. The Audit step stays defined in ROUND_FLOW for later work.
export const ACTIVE_ROUND_FLOW: readonly RoundFlowStep[] = ROUND_FLOW.filter(
  (step) => step.id !== "audit-if-triggered",
);

export function flowIndex(stage: string): number {
  return ACTIVE_ROUND_FLOW.findIndex((step) => step.id === stage);
}

// The next persisted stage a student can be advanced to, or null. Mirrors
// advance_round_stage, which remains the authority; this only decides whether
// to offer the Continue action. Prepayment opens in Rounds 1-3; Results in Rounds 1-2.
export function advanceTarget(
  stage: string,
  round: number,
): { stage: CardStage | "results-and-life-ledger"; label: string } | null {
  if (round >= 1 && round <= 3 && stage === "income-or-retirement") {
    return { stage: "life-event", label: "Life Event" };
  }
  if (round >= 1 && round <= 3 && stage === "life-event") {
    return { stage: "wildcard", label: "Wildcard" };
  }
  if (round >= 1 && round <= 3 && stage === "wildcard") {
    return { stage: "deduction", label: "Deduction" };
  }
  if (round >= 1 && round <= 3 && stage === "deduction") {
    return { stage: "tax-prepayment", label: "Tax Prepayment" };
  }
  if ((round === 1 || round === 2) && stage === "tax-prepayment") {
    return { stage: "results-and-life-ledger", label: "Results and Life Ledger" };
  }
  return null;
}