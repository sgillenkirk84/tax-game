"use client";

import Link from "next/link";
import CardEntry from "@/components/card-entry";
import { startTransition, useCallback, useEffect, useState } from "react";

type RoundOne = {
  pathwayId: string;
  scenarioId: string;
  currentStage?: string;
  startingCash: number;
  startingStudentLoanDebt: number;
  roundNumber: number;
  totalRounds: number;
};

const PLAYER_STORAGE_KEY = "my-tax-life-player";

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

const scenarios: Record<string, { name: string; description: string }> = {
  "financial-head-start": {
    name: "Financial Head Start",
    description: "You begin your life with a cash cushion and no student-loan debt.",
  },
  "starting-from-scratch": {
    name: "Starting From Scratch",
    description: "You begin with no extra cash and no student-loan debt.",
  },
  "student-loan-debt": {
    name: "Student Loan Debt",
    description: "You begin with no extra cash and a student loan to pay down.",
  },
};

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[var(--brand-ivory)] px-6 py-12 text-[var(--brand-navy)]">
      <div className="mx-auto max-w-2xl rounded-[2rem] border border-[var(--brand-navy)]/20 bg-[var(--brand-white)] p-8 shadow-[0_20px_50px_rgba(15,29,82,0.08)]">
        {children}
      </div>
    </main>
  );
}

export default function RoundOnePage() {
  const [state, setState] = useState<"loading" | "ready" | "error" | "nosession">("loading");
  const [error, setError] = useState("");
  const [round, setRound] = useState<RoundOne | null>(null);
  const [player, setPlayer] = useState<{ id: string; resumeToken: string } | null>(null);

  const load = useCallback(async () => {
    startTransition(() => setState("loading"));
    let id: string | undefined;
    let resumeToken: string | undefined;
    try {
      const saved = JSON.parse(window.localStorage.getItem(PLAYER_STORAGE_KEY) ?? "null");
      id = saved?.id;
      resumeToken = saved?.resumeToken;
    } catch {
      id = undefined;
    }
    if (typeof id !== "string" || typeof resumeToken !== "string") {
      startTransition(() => setState("nosession"));
      return;
    }

    try {
      const response = await fetch("/api/rounds/one", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, resumeToken }),
      });
      const result = (await response.json()) as Partial<RoundOne> & { error?: string };
      if (
        !response.ok ||
        typeof result.pathwayId !== "string" ||
        typeof result.scenarioId !== "string" ||
        !scenarios[result.scenarioId] ||
        typeof result.startingCash !== "number" ||
        typeof result.startingStudentLoanDebt !== "number"
      ) {
        throw new Error(result.error ?? "Could not start Round 1.");
      }
      startTransition(() => {
        setRound(result as RoundOne);
        setPlayer({ id: id as string, resumeToken: resumeToken as string });
        setState("ready");
      });
    } catch (caught) {
      startTransition(() => {
        setError(caught instanceof Error ? caught.message : "Could not start Round 1.");
        setState("error");
      });
    }
  }, []);

  useEffect(() => {
    // Fetch once on mount; the RPC returns the same scenario on every refresh.
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (state === "loading") {
    return (
      <Shell>
        <h1 className="text-2xl font-black">Loading Round 1...</h1>
      </Shell>
    );
  }

  if (state === "nosession") {
    return (
      <Shell>
        <h1 className="text-2xl font-black">No active player session found</h1>
        <Link
          href="/play"
          className="mt-6 inline-flex rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white"
        >
          Join a Session
        </Link>
      </Shell>
    );
  }

  if (state === "error" || !round) {
    return (
      <Shell>
        <h1 className="text-2xl font-black">Could not open Round 1</h1>
        <p className="mt-3 text-[var(--brand-navy)]/75">{error}</p>
        <div className="mt-6 flex flex-wrap gap-4">
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white"
          >
            Retry
          </button>
          <Link href="/play/game" className="rounded-xl border border-[var(--brand-navy)]/30 px-6 py-3 font-bold">
            Back to setup
          </Link>
        </div>
      </Shell>
    );
  }

  const scenario = scenarios[round.scenarioId];
  return (
    <Shell>
      <p className="text-sm font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
        Round {round.roundNumber} of {round.totalRounds}
      </p>
      <h1 className="mt-3 text-3xl font-black">Welcome to Round 1</h1>
      <dl className="mt-6 space-y-4">
        <div className="rounded-2xl border border-[var(--brand-navy)]/15 p-4">
          <dt className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">Your pathway</dt>
          <dd className="mt-1 text-xl font-black">{pathwayNames[round.pathwayId] ?? round.pathwayId}</dd>
        </div>
        <div className="rounded-2xl border border-[var(--brand-gold)]/40 bg-[var(--brand-gold)]/10 p-4">
          <dt className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">
            Your financial starting scenario
          </dt>
          <dd className="mt-1 text-xl font-black">{scenario.name}</dd>
          <dd className="mt-1 text-sm text-[var(--brand-navy)]/75">{scenario.description}</dd>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-[var(--brand-navy)]/15 p-4">
            <dt className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">Starting cash</dt>
            <dd className="mt-1 text-2xl font-black">{money(round.startingCash)}</dd>
          </div>
          <div className="rounded-2xl border border-[var(--brand-navy)]/15 p-4">
            <dt className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">
              Starting student-loan debt
            </dt>
            <dd className="mt-1 text-2xl font-black">{money(round.startingStudentLoanDebt)}</dd>
          </div>
        </div>
      </dl>
      {process.env.NEXT_PUBLIC_CARD_ENTRY_ENABLED === "true" && player && round.currentStage === "income-or-retirement" ? (
        <CardEntry
          round={round.roundNumber}
          stage="income-or-retirement"
          player={player}
          expectedCategory="Income"
        />
      ) : (
        <p className="mt-6 text-sm text-[var(--brand-navy)]/70">Card entry for this round is coming soon.</p>
      )}
    </Shell>
  );
}
