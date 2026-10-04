"use client";

import { useRef, useState } from "react";
import {
  type CardCategory,
  type CardPreview,
  type CardStage,
  stageInstructions,
} from "@/lib/card-entry";

type CardEntryProps = {
  round: number;
  stage: CardStage;
  expectedCategory: CardCategory;
  player: { id: string; resumeToken: string };
  instructions?: string;
  onVerified?: (card: CardPreview) => void;
  onSaved?: (card: CardPreview) => void;
};

const saveEnabled = process.env.NEXT_PUBLIC_CARD_SAVE_ENABLED === "true";

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// Students draw physical cards and type the printed ID. The server validates
// the ID against the approved dataset. Saving is a separate, confirmed step that
// the server re-validates; the browser never supplies amounts or effects.
export default function CardEntry({
  round,
  stage,
  expectedCategory,
  player,
  instructions,
  onVerified,
  onSaved,
}: CardEntryProps) {
  const [cardId, setCardId] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [card, setCard] = useState<CardPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // One key per previewed card, reused on retries so a repeated save is safe.
  const idempotencyKey = useRef<string | null>(null);

  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    if (!cardId.trim() || checking || saving || saved) {
      return;
    }
    setChecking(true);
    setError("");
    setCard(null);
    idempotencyKey.current = null;
    try {
      const response = await fetch("/api/rounds/card-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: player.id, resumeToken: player.resumeToken, cardId, round, stage, expectedCategory }),
      });
      const result = (await response.json()) as { card?: CardPreview; error?: string };
      if (!response.ok || !result.card) {
        throw new Error(result.error ?? "Could not look up that card.");
      }
      setCard(result.card);
      onVerified?.(result.card);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not look up that card.");
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    if (!card || saving || saved) {
      return;
    }
    setSaving(true);
    setError("");
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/rounds/card-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: player.id,
          resumeToken: player.resumeToken,
          cardId: card.id,
          round,
          stage,
          expectedCategory,
          idempotencyKey: idempotencyKey.current,
        }),
      });
      const result = (await response.json()) as { saved?: unknown; error?: string };
      if (!response.ok || !result.saved) {
        throw new Error(result.error ?? "Could not save your card.");
      }
      setSaved(true);
      onSaved?.(card);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save your card.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-8 rounded-2xl border border-[var(--brand-navy)]/15 p-5">
      <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-gold)]">
        Round {round} · {expectedCategory} card
      </p>
      <p className="mt-2 text-sm text-[var(--brand-navy)]/75">{instructions ?? stageInstructions[stage]}</p>

      <form onSubmit={lookup} className="mt-4 flex flex-wrap gap-3">
        <label className="sr-only" htmlFor="card-id-input">
          {expectedCategory} card ID
        </label>
        <input
          id="card-id-input"
          value={cardId}
          onChange={(event) => {
            setCardId(event.target.value);
            setCard(null);
            idempotencyKey.current = null;
          }}
          disabled={saved}
          maxLength={40}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="Card ID, e.g. INC-W2-001"
          className="min-w-0 flex-1 rounded-xl border border-[var(--brand-navy)]/30 px-4 py-3 font-mono uppercase"
        />
        <button
          type="submit"
          disabled={checking || saving || saved || !cardId.trim()}
          className="rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white disabled:opacity-50"
        >
          {checking ? "Checking..." : "Look up card"}
        </button>
      </form>

      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}

      {card ? (
        <div className="mt-4 rounded-2xl border border-[var(--brand-gold)]/40 bg-[var(--brand-gold)]/10 p-5">
          <h2 className="text-2xl font-black">{card.name}</h2>
          <p className="mt-3 text-lg leading-relaxed">{card.description}</p>
          {card.amount !== null ? <p className="mt-3 text-2xl font-black">{money(card.amount)}</p> : null}
          {card.taxCategory ? (
            <p className="mt-1 text-xs text-[var(--brand-navy)]/70">Tax category: {card.taxCategory}</p>
          ) : null}
          {card.educationMessage ? (
            <p className="mt-3 text-sm text-[var(--brand-navy)]/75">{card.educationMessage}</p>
          ) : null}
          {card.roundRule || card.pathwayRule ? (
            <p className="mt-2 text-xs text-[var(--brand-navy)]/60">
              {card.roundRule ? `Rounds: ${card.roundRule}. ` : ""}
              {card.pathwayRule && card.pathwayRule !== "None" ? card.pathwayRule : ""}
            </p>
          ) : null}
          <p className="mt-3 font-mono text-[11px] text-[var(--brand-navy)]/50">
            {card.id} · {card.category}
            {card.subcategory ? ` · ${card.subcategory}` : ""}
          </p>

          {saved ? (
            <p role="status" className="mt-4 rounded-xl bg-green-50 p-3 text-sm font-semibold text-green-800">
              Card saved. Wait for your teacher before moving on.
            </p>
          ) : saveEnabled ? (
            <div className="mt-4">
              <p className="text-sm font-semibold">Does this match the card in your hand?</p>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="mt-2 rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white disabled:opacity-50"
              >
                {saving ? "Saving..." : "Yes, save this card"}
              </button>
            </div>
          ) : (
            <p className="mt-4 text-xs text-[var(--brand-navy)]/60">
              Preview only. Saving this card is not available yet.
            </p>
          )}
        </div>
      ) : null}    </section>
  );
}
