"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import type { StoredResults } from "@/lib/round-results";

type RoundResultsProps = {
  round: number;
  player: { id: string; resumeToken: string };
  // When the progress screen could not load (a finished round), only a restore is attempted.
  restoreOnly?: boolean;
  restoreFailure?: string;
};

const pathwayNames: Record<string, string> = {
  "PATH-001": "Corporate Climber",
  "PATH-002": "Entrepreneur",
  "PATH-003": "Caregiver",
  "PATH-004": "Home Builder",
  "PATH-005": "Lifelong Learner",
  "PATH-006": "Side Hustler",
  "PATH-007": "Investor",
  "PATH-008": "Early Retiree",
};

const scenarioNames: Record<string, string> = {
  "financial-head-start": "Financial Head Start",
  "starting-from-scratch": "Starting From Scratch",
  "student-loan-debt": "Student Loan Debt",
};

const filingLabels: Record<string, string> = {
  single: "Single",
  married_filing_jointly: "Married filing jointly",
  head_of_household: "Head of household",
  married_filing_separately: "Married filing separately",
};

const stageLabels: Record<string, string> = {
  "income-or-retirement": "Income",
  "life-event": "Life Event",
  wildcard: "Wildcard",
  deduction: "Deduction",
  "tax-prepayment": "Tax Prepayment",
};

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

type Payload = { results?: StoredResults; cardNames?: Record<string, string>; finalized?: boolean; error?: string };

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-sm">{label}</dt>
      <dd className={strong ? "text-xl font-black" : "font-bold"}>{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-2xl border border-[var(--brand-navy)]/15 p-4">
      <h3 className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">{title}</h3>
      <dl className="mt-2">{children}</dl>
    </section>
  );
}

// Round Results and Life Ledger: read-only. The student finishes the round with
// one button; the server rebuilds every amount from saved round data, applies
// it exactly once, and returns the stored result. Reloading only restores it.
export default function RoundResults({ round, player, restoreOnly = false, restoreFailure = "" }: RoundResultsProps) {
  const [results, setResults] = useState<StoredResults | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  const [finishing, setFinishing] = useState(false);
  const finishKey = useRef<string | null>(null);

  const restore = useCallback(async () => {
    try {
      const response = await fetch("/api/rounds/results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: player.id, resumeToken: player.resumeToken, round }),
      });
      const body = (await response.json()) as Payload;
      if (!response.ok) {
        throw new Error(body.error ?? "Could not load your Results.");
      }
      startTransition(() => {
        if (body.finalized && body.results) {
          setResults(body.results);
          setNames(body.cardNames ?? {});
        }
        setChecked(true);
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not load your Results.";
      startTransition(() => {
        setError(message);
        setChecked(true);
      });
    }
  }, [player.id, player.resumeToken, round]);

  useEffect(() => {
    const timer = window.setTimeout(() => void restore(), 0);
    return () => window.clearTimeout(timer);
  }, [restore]);

  async function finish() {
    if (finishing) {
      return;
    }
    setFinishing(true);
    setError("");
    finishKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/rounds/results-finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: player.id,
          resumeToken: player.resumeToken,
          round,
          idempotencyKey: finishKey.current,
        }),
      });
      const body = (await response.json()) as Payload;
      if (!response.ok || !body.results) {
        throw new Error(body.error ?? "Could not finish your round.");
      }
      finishKey.current = null;
      setResults(body.results);
      setNames(body.cardNames ?? {});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not finish your round.");
    } finally {
      setFinishing(false);
    }
  }

  if (!checked) {
    return <p className="mt-8 text-sm text-[var(--brand-navy)]/70">Loading your Results...</p>;
  }

  if (!results) {
    if (restoreOnly) {
      return (
        <div role="alert" className="mt-8 rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-800">
          <p>{error || restoreFailure || "Could not load your progress."}</p>
          <button type="button" onClick={() => void restore()} className="mt-2 underline">
            Try again
          </button>
        </div>
      );
    }
    return (
      <section className="rounded-2xl border-2 border-[var(--brand-gold)] bg-[var(--brand-gold)]/10 p-5">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-gold)]">
          Round {round} · Results and Life Ledger
        </p>
        <p className="mt-3 text-lg leading-relaxed">
          Your cards are saved. Finish the round to see your final results. Your tax prepayment is settled against
          your calculated tax, and your living costs and any student-loan payment are applied one time.
        </p>
        {error ? (
          <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void finish()}
          disabled={finishing}
          className="mt-4 rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white disabled:opacity-50"
        >
          {finishing ? "Finishing..." : `Finish Round ${round}`}
        </button>
      </section>
    );
  }

  const taxResult =
    results.taxRefund > 0
      ? `Your tax refund: ${money(results.taxRefund)}`
      : results.taxAmountDue > 0
        ? `Tax amount due: ${money(results.taxAmountDue)}`
        : "You're exactly settled — $0 due and $0 refund.";

  return (
    <section className="rounded-2xl border-2 border-[var(--brand-gold)] bg-white p-5">
      <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-gold)]">
        Round {results.roundNumber} complete
      </p>
      <h2 className="mt-2 text-2xl font-black">Round {results.roundNumber} Results</h2>
      <dl className="mt-3">
        <Row label="Pathway" value={pathwayNames[results.pathwayId] ?? results.pathwayId} />
        <Row label="Scenario" value={scenarioNames[results.scenarioId] ?? results.scenarioId} />
      </dl>

      <Section title="Money this round">
        <Row label="Gross income" value={money(results.grossIncome)} />
        {results.otherCashInflows > 0 ? <Row label="Other cash inflows" value={money(results.otherCashInflows)} /> : null}
        <Row label="Living costs" value={`-${money(results.livingCosts)}`} />
        {results.personalExpenses > 0 ? <Row label="Personal expenses" value={`-${money(results.personalExpenses)}`} /> : null}
        {results.studentLoanPayment > 0 ? (
          <Row label="Student-loan payment" value={`-${money(results.studentLoanPayment)}`} />
        ) : null}
      </Section>

      <Section title="Tax results">
        <Row label="Calculated tax" value={money(results.calculatedTax)} />
        <Row label="Tax you prepaid" value={money(results.taxPrepaid)} />
      </Section>
      <p role="status" className="mt-2 rounded-xl bg-[var(--brand-gold)]/15 p-3 text-lg font-black">
        {taxResult}
      </p>

      <Section title="Ending position">
        <Row label="Ending cash" value={money(results.endingCash)} strong />
        <Row label="Student-loan debt" value={money(results.endingDebt)} />
        <Row label="Filing status" value={filingLabels[results.filingStatus] ?? results.filingStatus} />
        <Row label="Homeowner" value={results.homeowner ? "Yes" : "No"} />
        <Row label="Active dependents" value={String(results.activeDependents)} />
      </Section>

      <Section title="Round activity">
        {results.cards.map((card, position) => (
          <Row
            key={`${card.cardId}-${position}`}
            label={stageLabels[card.stage] ?? card.stage}
            value={names[card.cardId] ?? card.cardId}
          />
        ))}
      </Section>
      <p className="mt-4 rounded-xl bg-green-50 p-3 text-sm font-semibold text-green-800">
        Round {results.roundNumber} is complete. Your teacher will let you know when the next round opens.
      </p>
    </section>
  );
}
