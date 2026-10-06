"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import CardEntry from "@/components/card-entry";
import RoundResults from "@/components/round-results";
import TaxCalculation from "@/components/tax-calculation";
import TaxPrepayment from "@/components/tax-prepayment";
import { type CardPreview, choiceLabel, expectedCategoryFor, isCardStage, stageInstructionsFor } from "@/lib/card-entry";
import { STANDARD_DEDUCTION_NOTE, showsStandardDeduction } from "@/lib/standard-deduction";
import { ACTIVE_ROUND_FLOW, advanceTarget, flowIndex } from "@/lib/round-stages";

type RoundDashboardProps = {
  round: number;
  pathwayId: string;
  player: { id: string; resumeToken: string };
  onRoundStarted?: () => void;
};

type Progress = {
  currentStage: string;
  stages: { stage: string; cards: CardPreview[] }[];
};

const advanceEnabled = process.env.NEXT_PUBLIC_STAGE_ADVANCE_ENABLED === "true";
const resultsEnabled = process.env.NEXT_PUBLIC_ROUND_RESULTS_ENABLED === "true";
const prepaymentEnabled = process.env.NEXT_PUBLIC_TAX_PREPAYMENT_ENABLED === "true";

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// Reusable stage-based dashboard: completed stages with their saved cards, the
// current stage's card selection, and compact locked future stages. Saved-card
// records are the only source of truth, and a student moves on only by choosing
// Continue after their card is saved.
export default function RoundDashboard({ round, pathwayId, player, onRoundStarted }: RoundDashboardProps) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loadError, setLoadError] = useState("");
  const [currentSaved, setCurrentSaved] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState("");
  // True once a saved tax calculation exists; Tax Prepayment will unlock from this persisted status.
  const [taxCalculated, setTaxCalculated] = useState(false);
  const [prepaymentFixed, setPrepaymentFixed] = useState(false);
  // One key per advance attempt, reused on retries so a repeated request is safe.
  const advanceKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/rounds/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: player.id, resumeToken: player.resumeToken }),
      });
      const result = (await response.json()) as Partial<Progress> & { error?: string };
      if (!response.ok || typeof result.currentStage !== "string" || !Array.isArray(result.stages)) {
        throw new Error(result.error ?? "Could not load your progress.");
      }
      const next = { currentStage: result.currentStage, stages: result.stages };
      startTransition(() => {
        setProgress(next);
        setLoadError("");
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not load your progress.";
      startTransition(() => setLoadError(message));
    }
  }, [player.id, player.resumeToken]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function advance() {
    if (!progress || advancing) {
      return;
    }
    setAdvancing(true);
    setAdvanceError("");
    advanceKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/rounds/stage-advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: player.id,
          resumeToken: player.resumeToken,
          round,
          stage: progress.currentStage,
          idempotencyKey: advanceKey.current,
        }),
      });
      const result = (await response.json()) as { advanced?: unknown; error?: string };
      if (!response.ok || !result.advanced) {
        throw new Error(result.error ?? "Could not move to the next stage.");
      }
      advanceKey.current = null;
      setCurrentSaved(false);
      await load();
    } catch (caught) {
      setAdvanceError(caught instanceof Error ? caught.message : "Could not move to the next stage.");
    } finally {
      setAdvancing(false);
    }
  }

  if (!progress) {
    if (loadError && resultsEnabled) {
      // A finished round no longer has an in-progress stage, so restore its saved Results instead.
      return <RoundResults round={round} player={player} restoreOnly restoreFailure={loadError} onRoundStarted={onRoundStarted} />;
    }
    return loadError ? (
      <div role="alert" className="mt-8 rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-800">
        <p>{loadError}</p>
        <button type="button" onClick={() => void load()} className="mt-2 underline">
          Try again
        </button>
      </div>
    ) : (
      <p className="mt-8 text-sm text-[var(--brand-navy)]/70">Loading your round...</p>
    );
  }

  const stage = progress.currentStage;
  const currentIndex = flowIndex(stage);
  const target = advanceTarget(stage, round);
  const cardsFor = (id: string) => progress.stages.find((entry) => entry.stage === id)?.cards ?? [];
  const completedNeedsNote = ACTIVE_ROUND_FLOW.some(
    (step, index) =>
      index < currentIndex &&
      cardsFor(step.id).some((card) => showsStandardDeduction(card.description, card.subcategory)),
  );
  const labelFor = (id: (typeof ACTIVE_ROUND_FLOW)[number]["id"], fallback: string) =>
    isCardStage(id) && id === "income-or-retirement" ? expectedCategoryFor(id, pathwayId, round) : fallback;

  return (
    <div className="mt-8">
      <ol className="space-y-3" aria-label="Round stages">
        {ACTIVE_ROUND_FLOW.map((step, index) => {
          const label = labelFor(step.id, step.label);
          if (index < currentIndex) {
            const cards = cardsFor(step.id);
            return (
              <li key={step.id} className="rounded-2xl border border-green-700/25 bg-green-50 p-4">
                <p className="text-xs font-black uppercase tracking-[0.2em] text-green-800">Completed · {label}</p>
                {step.kind === "automatic" ? (
                  round >= 1 && round <= 5 ? (
                    <TaxCalculation round={round} player={player} readOnly />
                  ) : (
                    <p className="mt-1 text-sm text-[var(--brand-navy)]/75">Calculated automatically.</p>
                  )
                ) : null}
                {cards.map((card, position) => (
                  <div key={`${card.id}-${position}`} className="mt-2">
                    <p className="text-sm font-black">{card.name}</p>
                    <p className="text-base leading-snug">{card.description}</p>
                    {card.amount !== null ? <p className="mt-1 text-lg font-black">{money(card.amount)}</p> : null}
                    {card.recordedChoice ? (
                      <p className="mt-1 text-sm font-black">Your choice: {choiceLabel(card.id, card.recordedChoice)}</p>
                    ) : null}
                    <p className="mt-1 font-mono text-[11px] text-[var(--brand-navy)]/50">{card.id}</p>
                  </div>
                ))}
              </li>
            );
          }
          if (index === currentIndex) {
            return (
              <li key={step.id}>
                {step.id === "tax-prepayment" && prepaymentEnabled ? (
                  <TaxPrepayment round={round} player={player} pathwayId={pathwayId} onFixedChange={setPrepaymentFixed} />
                ) : step.id === "results-and-life-ledger" && resultsEnabled ? (
                  <RoundResults round={round} player={player} onRoundStarted={onRoundStarted} />
                ) : isCardStage(step.id) ? (
                  <CardEntry
                    key={step.id}
                    round={round}
                    stage={step.id}
                    player={player}
                    expectedCategory={expectedCategoryFor(step.id, pathwayId, round)}
                    instructions={stageInstructionsFor(step.id, pathwayId, round)}
                    pathwayId={pathwayId}
                    onSavedChange={setCurrentSaved}
                    hideStandardDeductionNote={completedNeedsNote}
                  />
                ) : (
                  <p className="rounded-2xl border border-[var(--brand-navy)]/15 p-4 text-sm">
                    {label} is coming soon.
                  </p>
                )}
                {step.id === "tax-prepayment" && prepaymentEnabled && prepaymentFixed && resultsEnabled && advanceEnabled && target ? (
                  <div className="mt-4">
                    {advanceError ? (
                      <p role="alert" className="mb-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800">
                        {advanceError}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void advance()}
                      disabled={advancing}
                      className="rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white disabled:opacity-50"
                    >
                      {advancing ? "Moving on..." : `Continue to ${target.label}`}
                    </button>
                  </div>
                ) : null}
                {currentSaved && isCardStage(step.id) && step.id !== "tax-prepayment" ? (
                  <div className="mt-4">
                    {step.id === "deduction" && round >= 1 && round <= 5 ? <TaxCalculation round={round} player={player} onCalculatedChange={setTaxCalculated} /> : null}
                    {advanceError ? (
                      <p role="alert" className="mb-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800">
                        {advanceError}
                      </p>
                    ) : null}
                    {target && advanceEnabled && (step.id !== "deduction" || (taxCalculated && prepaymentEnabled && round <= 5)) ? (
                      <button
                        type="button"
                        onClick={() => void advance()}
                        disabled={advancing}
                        className="rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white disabled:opacity-50"
                      >
                        {advancing ? "Moving on..." : `Continue to ${target.label}`}
                      </button>
                    ) : step.id === "deduction" ? (
                      taxCalculated && (!target || !prepaymentEnabled || !advanceEnabled) ? (
                        <p className="rounded-xl bg-green-50 p-3 text-sm font-semibold text-green-800">
                          Your Round {round} tax return is saved. Tax Prepayment is not available yet.
                        </p>
                      ) : null
                    ) : (
                      <p className="rounded-xl bg-green-50 p-3 text-sm font-semibold text-green-800">
                        {target ? "The next stage is coming soon." : `${label} complete. Your teacher will let you know when the next step opens.`}
                      </p>
                    )}
                  </div>
                ) : null}
                {step.id === "tax-prepayment" && round >= 2 && round <= 5 && prepaymentFixed && (!target || !resultsEnabled || !advanceEnabled) ? (
                  <p className="mt-4 rounded-xl bg-green-50 p-3 text-sm font-semibold text-green-800">
                    Your Round {round} Tax Prepayment is saved. Results and Life Ledger are coming next.
                  </p>
                ) : null}
              </li>
            );
          }
          return (
            <li
              key={step.id}
              className="flex items-center justify-between rounded-xl border border-dashed border-[var(--brand-navy)]/25 px-4 py-2 text-sm text-[var(--brand-navy)]/55"
            >
              <span className="font-bold">{label}</span>
              <span className="text-xs uppercase tracking-[0.15em]">Locked</span>
            </li>
          );
        })}
      </ol>
      {completedNeedsNote ? (
        <p className="mt-4 text-xs leading-snug text-[var(--brand-navy)]/70">{STANDARD_DEDUCTION_NOTE}</p>
      ) : null}
    </div>
  );
}