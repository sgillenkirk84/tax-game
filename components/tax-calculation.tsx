"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { asTaxSummary, interpretTaxResponse, TAX_FRIENDLY_ERRORS, type TaxSummary } from "@/lib/tax-summary";
import { advanceTarget } from "@/lib/round-stages";

type TaxCalculationProps = {
  round: number;
  player: { id: string; resumeToken: string };
  // Read-only mode shows a saved return (e.g. after the student moves on) and never offers calculation.
  readOnly?: boolean;
  // Reports whether a calculation is saved, so the dashboard can unlock later stages from it.
  onCalculatedChange?: (calculated: boolean) => void;
};

type Phase = "checking" | "ready" | "calculating" | "done" | "unavailable";

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// Explicit-action tax calculation shown once the Deduction card is saved. A saved
// result is only read back (never recalculated) on load; nothing here supplies
// amounts, and the stage is not advanced.
export default function TaxCalculation({ round, player, readOnly = false, onCalculatedChange }: TaxCalculationProps) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [summary, setSummary] = useState<TaxSummary | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const calculated = phase === "done" && summary !== null;
  const storageKey = `money-moves:tax-key:${player.id}:${round}`;

  useEffect(() => {
    onCalculatedChange?.(calculated);
  }, [calculated, onCalculatedChange]);

  const credentials = useCallback(
    () => ({ id: player.id, resumeToken: player.resumeToken, round }),
    [player.id, player.resumeToken, round],
  );

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/rounds/tax-result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentials()),
        });
        const body = (await response.json()) as { available?: boolean; summary?: unknown };
        if (cancelled) {
          return;
        }
        const saved = response.ok ? asTaxSummary(body.summary) : null;
        startTransition(() => {
          if (saved) {
            setSummary(saved);
            setPhase("done");
          } else {
            setPhase(response.ok && body.available === false ? "unavailable" : "ready");
          }
        });
      } catch {
        if (!cancelled) {
          startTransition(() => setPhase("ready"));
        }
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [credentials]);

  async function calculate() {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setPhase("calculating");
    setError("");
    // One key per calculation attempt, kept across retries and refreshes until it succeeds.
    let key = window.sessionStorage.getItem(storageKey);
    if (!key) {
      key = crypto.randomUUID();
      window.sessionStorage.setItem(storageKey, key);
    }
    try {
      const response = await fetch("/api/rounds/tax-calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credentials(), idempotencyKey: key }),
      });
      const outcome = interpretTaxResponse(response.status, await response.json().catch(() => null));
      if (outcome.kind === "success") {
        window.sessionStorage.removeItem(storageKey);
        setSummary(outcome.summary);
        setPhase("done");
        return;
      }
      if (!outcome.keepKey) {
        window.sessionStorage.removeItem(storageKey);
      }
      setError(outcome.message);
      setPhase(outcome.kind === "unavailable" ? "unavailable" : "ready");
    } catch {
      setError(TAX_FRIENDLY_ERRORS.failed);
      setPhase("ready");
    } finally {
      busy.current = false;
    }
  }

  if (phase === "checking" || (readOnly && !calculated)) {
    return null;
  }

  if (phase === "unavailable") {
    return (
      <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-900">
        {TAX_FRIENDLY_ERRORS.unavailable}
      </p>
    );
  }

  if (phase === "done" && summary) {
    const rows: Array<[string, string]> = [
      ["Gross income (all the money you earned)", money(summary.grossIncome)],
      ["Adjusted gross income", money(summary.adjustedGrossIncome)],
      [
        summary.deductionMethod === "itemized" ? "Deduction: itemized" : "Deduction: standard",
        money(summary.deductionAmount),
      ],
      ["Taxable income (income left to tax)", money(summary.taxableIncome)],
      ["Income tax before credits", money(summary.taxBeforeCredits)],
      ["Tax credits applied", money(summary.creditsApplied)],
    ];
    return (
      <section aria-label="Your tax return" className="mt-4 rounded-2xl border-2 border-green-700/40 bg-green-50 p-4 sm:p-6">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-green-800">Your Round {round} tax return</p>
        <dl className="mt-3 space-y-2 text-sm sm:text-base">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt>{label}</dt>
              <dd className="font-bold">{value}</dd>
            </div>
          ))}
          <div className="rounded-xl bg-white p-3">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="font-black">Your calculated tax</dt>
              <dd className="text-xl font-black sm:text-2xl">{money(summary.finalTax)}</dd>
            </div>
            <p className="mt-1 text-xs text-[var(--brand-navy)]/70">
              This is the tax the game calculated from your income, deductions and credits. It is not the same as tax you have already paid.
            </p>
          </div>
        </dl>
        <p className="mt-3 text-sm text-[var(--brand-navy)]/75">
          {summary.deductionMethod === "itemized"
            ? `Your itemized deductions (${money(summary.itemizedDeduction)}) were larger than the standard deduction (${money(summary.standardDeduction)}), so they were used.`
            : `The standard deduction (${money(summary.standardDeduction)}) was used because your itemized deductions (${money(summary.itemizedDeduction)}) were not larger.`}
        </p>
        <p className="mt-2 rounded-xl bg-white p-3 text-sm font-semibold">
          {advanceTarget("deduction", round)
            ? "Next, you will choose your physical Tax Prepayment card to find out how much tax you have already paid."
            : "Tax Prepayment is not available yet."} Your tax return above is saved and will not change.
        </p>
      </section>
    );
  }

  return (
    <div className="mt-4">
      {error ? (
        <p role="alert" className="mb-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void calculate()}
        disabled={phase === "calculating"}
        className="w-full rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white disabled:opacity-50 sm:w-auto"
      >
        {phase === "calculating" ? "Calculating..." : "Calculate My Taxes"}
      </button>
    </div>
  );
}
