"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import CardEntry from "@/components/card-entry";
import { type PrepaymentState, REDRAW_THRESHOLD_PCT, settlementPreview } from "@/lib/tax-prepayment";

type TaxPrepaymentProps = {
  round: number;
  player: { id: string; resumeToken: string };
  pathwayId: string;
};

type Details = Record<string, { name: string; description: string }>;

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// Tax Prepayment: the student selects the physical card they drew. The server
// fixes the prepaid amount from the saved calculated tax and the card's rate,
// so the browser never supplies an amount. Nothing here changes cash or settles
// tax; the refund or amount due is a derived preview shown only once final.
export default function TaxPrepayment({ round, player, pathwayId }: TaxPrepaymentProps) {
  const [state, setState] = useState<PrepaymentState | null>(null);
  const [details, setDetails] = useState<Details>({});
  const [loadError, setLoadError] = useState("");
  const [redrawing, setRedrawing] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const [keepError, setKeepError] = useState("");
  const keepKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/rounds/prepayment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: player.id, resumeToken: player.resumeToken, round }),
      });
      const body = (await response.json()) as { state?: PrepaymentState | null; details?: Details; error?: string };
      if (!response.ok || !body.state) {
        throw new Error(body.error ?? "Could not load your Tax Prepayment.");
      }
      const next = body.state;
      startTransition(() => {
        setState(next);
        setDetails(body.details ?? {});
        setLoadError("");
        if (next.status === "fixed") {
          setRedrawing(false);
        }
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not load your Tax Prepayment.";
      startTransition(() => setLoadError(message));
    }
  }, [player.id, player.resumeToken, round]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function keepFirstCard() {
    if (keeping) {
      return;
    }
    setKeeping(true);
    setKeepError("");
    keepKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/rounds/prepayment-keep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: player.id,
          resumeToken: player.resumeToken,
          round,
          idempotencyKey: keepKey.current,
        }),
      });
      const body = (await response.json()) as { kept?: boolean; error?: string };
      if (!response.ok || !body.kept) {
        throw new Error(body.error ?? "Could not keep your card.");
      }
      keepKey.current = null;
      await load();
    } catch (caught) {
      setKeepError(caught instanceof Error ? caught.message : "Could not keep your card.");
    } finally {
      setKeeping(false);
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="mt-8 rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-800">
        <p>{loadError}</p>
        <button type="button" onClick={() => void load()} className="mt-2 underline">
          Try again
        </button>
      </div>
    );
  }
  if (!state) {
    return <p className="mt-8 text-sm text-[var(--brand-navy)]/70">Loading Tax Prepayment...</p>;
  }

  const estimatedNote = state.showEstimatedPaymentNote ? (
    <p className="mt-4 rounded-xl bg-blue-50 p-3 text-sm text-blue-900">
      Business owners and self-employed people often make estimated tax payments during the year instead of
      having tax taken from a paycheck. Your Tax Prepayment card works the same way for everyone in this game.
    </p>
  ) : null;

  if (state.status === "fixed" && state.fixed) {
    const finalCard = details[state.fixed.cardId];
    const firstCard = state.fixed.firstCardId ? details[state.fixed.firstCardId] : null;
    const preview =
      state.calculatedTax === null ? null : settlementPreview(state.calculatedTax, state.fixed.prepaidAmount);
    return (
      <section className="mt-2 rounded-2xl border-2 border-[var(--brand-gold)] bg-[var(--brand-gold)]/10 p-5">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-gold)]">
          Round {round} · Tax Prepayment
        </p>
        <p role="status" className="mt-3 rounded-xl bg-green-50 p-3 text-sm font-semibold text-green-800">
          Your Tax Prepayment is final.
        </p>
        <h2 className="mt-3 text-2xl font-black">{finalCard?.name ?? state.fixed.cardId}</h2>
        {finalCard ? <p className="mt-2 text-lg leading-relaxed">{finalCard.description}</p> : null}
        <p className="mt-2 font-mono text-[11px] text-[var(--brand-navy)]/50">{state.fixed.cardId}</p>
        {state.fixed.redrawUsed && firstCard ? (
          <p className="mt-3 text-sm text-[var(--brand-navy)]/75">
            You redrew. Your first card, {firstCard.name}, stays on record, and your second card is final.
          </p>
        ) : null}
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-white p-4">
            <dt className="text-sm font-bold">Your calculated tax</dt>
            <dd className="mt-1 text-2xl font-black">{state.calculatedTax === null ? "—" : money(state.calculatedTax)}</dd>
          </div>
          <div className="rounded-xl bg-white p-4">
            <dt className="text-sm font-bold">Tax you prepaid</dt>
            <dd className="mt-1 text-2xl font-black">{money(state.fixed.prepaidAmount)}</dd>
          </div>
        </dl>
        {preview ? (
          <div className="mt-3 rounded-xl bg-white p-4">
            <p className="text-2xl font-black">
              {preview.kind === "refund"
                ? `Your tax refund: ${money(preview.amount)}`
                : preview.kind === "due"
                  ? `Tax amount due: ${money(preview.amount)}`
                  : "You're exactly settled — $0 due and $0 refund."}
            </p>
            <p className="mt-1 text-sm text-[var(--brand-navy)]/75">Before any audit.</p>
          </div>
        ) : null}
        <p className="mt-3 text-sm text-[var(--brand-navy)]/75">
          Your prepaid amount is now locked in. This is a preview only: your cash has not changed and nothing
          has been paid or collected yet.
        </p>
        {estimatedNote}
      </section>
    );
  }

  if (state.status === "provisional" && state.redrawEligible) {
    const first = state.cards[0];
    const firstCard = first ? details[first.cardId] : null;
    if (redrawing) {
      return (
        <div>
          <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-900">
            Redraw: shuffle the Tax Prepayment deck and physically draw another card. Your second card will be
            final, even if it is lower or higher than your first.
          </p>
          <CardEntry
            key="redraw"
            round={round}
            stage="tax-prepayment"
            expectedCategory="Tax Prepayment"
            player={player}
            pathwayId={pathwayId}
            redraw
            onSaved={() => void load()}
          />
          {estimatedNote}
        </div>
      );
    }
    return (
      <section className="mt-2 rounded-2xl border-2 border-[var(--brand-gold)] bg-[var(--brand-gold)]/10 p-5">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-gold)]">
          Round {round} · Tax Prepayment
        </p>
        <h2 className="mt-3 text-2xl font-black">{firstCard?.name ?? first?.cardId}</h2>
        {firstCard ? <p className="mt-2 text-lg leading-relaxed">{firstCard.description}</p> : null}
        {first ? <p className="mt-2 font-mono text-[11px] text-[var(--brand-navy)]/50">{first.cardId}</p> : null}
        <p className="mt-4 text-sm">
          As a Corporate Climber, you may redraw once when your first card prepays less than{" "}
          {REDRAW_THRESHOLD_PCT}% of your tax. Your first card stays on record. If you redraw, your second card is
          final. A redraw means you must physically draw another card from the deck.
        </p>
        {keepError ? (
          <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800">
            {keepError}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void keepFirstCard()}
            disabled={keeping}
            className="rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white disabled:opacity-50"
          >
            {keeping ? "Saving..." : "Keep this card"}
          </button>
          <button
            type="button"
            onClick={() => setRedrawing(true)}
            disabled={keeping}
            className="rounded-xl border border-[var(--brand-navy)] px-6 py-3 font-bold disabled:opacity-50"
          >
            Redraw one card
          </button>
        </div>
        {estimatedNote}
      </section>
    );
  }

  return (
    <div>
      <CardEntry
        key="first"
        round={round}
        stage="tax-prepayment"
        expectedCategory="Tax Prepayment"
        player={player}
        pathwayId={pathwayId}
        onSaved={() => void load()}
      />
      {estimatedNote}
    </div>
  );
}
