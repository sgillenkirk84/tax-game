"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import {
  type CardCategory,
  type CardPreview,
  type CardSection,
  type CardStage,
  choiceConfigFor,
  choiceLabel,
  sectionsFor,
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
  // Reports whether the stage's card has been saved (now or earlier), so a
  // parent can offer a separate Continue action.
  onSavedChange?: (saved: boolean) => void;
};

const saveEnabled = process.env.NEXT_PUBLIC_CARD_SAVE_ENABLED === "true";

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// Students draw physical cards, then pick the matching card from the approved
// deck. The server supplies the list and re-validates the card on save; the
// browser never supplies amounts or effects, and nothing is drawn at random.
export default function CardEntry({
  round,
  stage,
  expectedCategory,
  player,
  instructions,
  onVerified,
  onSaved,
  onSavedChange,
}: CardEntryProps) {
  const [cards, setCards] = useState<CardPreview[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [card, setCard] = useState<CardPreview | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCards, setSavedCards] = useState<CardPreview[]>([]);
  const [limitReached, setLimitReached] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const saved = limitReached || justSaved;
  useEffect(() => {
    onSavedChange?.(saved);
  }, [saved, onSavedChange]);
  // One key per selected card, reused on retries so a repeated save is safe.
  const idempotencyKey = useRef<string | null>(null);

  const loadCards = useCallback(async () => {
    startTransition(() => {
      setCards(null);
      setLoadError("");
    });
    try {
      const response = await fetch("/api/rounds/card-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: player.id, resumeToken: player.resumeToken, round, stage }),
      });
      const result = (await response.json()) as {
        category?: string;
        cards?: CardPreview[];
        savedCards?: CardPreview[];
        limitReached?: boolean;
        error?: string;
      };
      if (!response.ok || !Array.isArray(result.cards) || result.category !== expectedCategory) {
        throw new Error(result.error ?? "Could not load the cards.");
      }
      const list = result.cards;
      const previous = Array.isArray(result.savedCards) ? result.savedCards : [];
      const reached = result.limitReached === true;
      startTransition(() => {
        setCards(list);
        setSavedCards(previous);
        setLimitReached(reached);
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not load the cards.";
      startTransition(() => setLoadError(message));
    }
  }, [player.id, player.resumeToken, round, stage, expectedCategory]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCards(), 0);
    return () => window.clearTimeout(timer);
  }, [loadCards]);

  function select(next: CardPreview) {
    if (saving || saved) {
      return;
    }
    setError("");
    setCard(next);
    setChoice(null);
    idempotencyKey.current = null;
    onVerified?.(next);
  }

  async function save() {
    if (!card || saving || saved || (choiceConfigFor(card.id) && !choice)) {
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
          choice: choiceConfigFor(card.id) ? choice : undefined,
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
      setSavedCards((current) => [...current, { ...card, recordedChoice: choice }]);
      setJustSaved(true);
      onSaved?.(card);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save your card.");
    } finally {
      setSaving(false);
    }
  }

  const shown = saved ? (savedCards.length > 0 ? savedCards[savedCards.length - 1] : card) : card;
  const sections: CardSection[] = sectionsFor(expectedCategory);

  return (
    <section className="mt-8 rounded-2xl border border-[var(--brand-navy)]/15 p-5">
      <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-gold)]">
        Round {round} · {expectedCategory} card
      </p>
      {saved ? null : (
        <p className="mt-2 text-sm text-[var(--brand-navy)]/75">
          {instructions ?? stageInstructions[stage]}
        </p>
      )}

      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}

      {shown ? (
        <div className="mt-4 rounded-2xl border-2 border-[var(--brand-gold)] bg-[var(--brand-gold)]/10 p-5">
          {saved ? (
            <p role="status" className="mb-4 rounded-xl bg-green-50 p-3 text-sm font-semibold text-green-800">
              Card saved. This is the card recorded for this stage.
            </p>
          ) : (
            <p className="mb-2 text-xs font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">
              Selected card
            </p>
          )}
          <h2 className="text-2xl font-black">{shown.name}</h2>
          <p className="mt-3 text-lg leading-relaxed">{shown.description}</p>
          {shown.amount !== null ? <p className="mt-3 text-2xl font-black">{money(shown.amount)}</p> : null}
          {shown.taxCategory ? (
            <p className="mt-1 text-xs text-[var(--brand-navy)]/70">Tax category: {shown.taxCategory}</p>
          ) : null}
          {shown.educationMessage ? (
            <p className="mt-3 text-sm text-[var(--brand-navy)]/75">{shown.educationMessage}</p>
          ) : null}
          {shown.playerChoiceRequired && !choiceConfigFor(shown.id) ? (
            <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-900">
              This card needs a choice from you. Choices are not recorded yet, so only the card itself is saved.
            </p>
          ) : null}
          {shown.triggersAudit ? (
            <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-900">
              This card triggers an audit. Audit results will be handled in a later step; nothing is applied now.
            </p>
          ) : null}
          {shown.roundRule || shown.pathwayRule ? (
            <p className="mt-2 text-xs text-[var(--brand-navy)]/60">
              {shown.roundRule ? `Rounds: ${shown.roundRule}. ` : ""}
              {shown.pathwayRule && shown.pathwayRule !== "None" ? shown.pathwayRule : ""}
            </p>
          ) : null}
          <p className="mt-3 font-mono text-[11px] text-[var(--brand-navy)]/50">
            {shown.id} · {shown.category}
            {shown.subcategory ? ` · ${shown.subcategory}` : ""}
          </p>

          {saved && shown.recordedChoice ? (
            <p className="mt-3 text-sm font-black">
              Your choice: {choiceLabel(shown.id, shown.recordedChoice)}
            </p>
          ) : null}
          {saved ? null : choiceConfigFor(shown.id) ? (
            <fieldset className="mt-4" disabled={saving}>
              <legend className="text-sm font-black">{choiceConfigFor(shown.id)?.prompt}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {choiceConfigFor(shown.id)?.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={choice === option.value}
                    onClick={() => setChoice(option.value)}
                    className={`rounded-xl border px-4 py-2 text-sm font-bold ${
                      choice === option.value
                        ? "border-[var(--brand-navy)] bg-[var(--brand-navy)] text-white"
                        : "border-[var(--brand-navy)]/30 bg-white"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}

          {saved ? null : saveEnabled ? (
            <div className="mt-4">
              <p className="text-sm font-semibold">Does this match the card in your hand?</p>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || (choiceConfigFor(shown.id) !== null && !choice)}
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
      ) : null}

      {saved ? null : loadError ? (
        <div role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800">
          <p>{loadError}</p>
          <button type="button" onClick={() => void loadCards()} className="mt-2 underline">
            Try again
          </button>
        </div>
      ) : cards === null ? (
        <p className="mt-4 text-sm text-[var(--brand-navy)]/70">Loading cards...</p>
      ) : (
        <div
          className={`mt-4 grid gap-6 ${sections.length > 1 ? "md:grid-cols-2" : ""}`}
          aria-label={`${expectedCategory} cards`}
        >
          {sections.map((section) => {
            const sectionCards = cards.filter(
              (option) => section.subcategory === null || option.subcategory === section.subcategory,
            );
            if (sectionCards.length === 0) {
              return null;
            }
            return (
              <div key={section.heading ?? "all"}>
                {section.heading ? (
                  <h3 className="text-lg font-black text-[var(--brand-navy)]">{section.heading}</h3>
                ) : null}
                {section.note ? (
                  <p className="mt-1 text-sm text-[var(--brand-navy)]/75">{section.note}</p>
                ) : null}
                <ul className={`mt-3 grid gap-3 ${sections.length > 1 ? "" : "sm:grid-cols-2"}`}>
                  {sectionCards.map((option) => {
                    const selected = card?.id === option.id;
                    return (
                      <li key={option.id}>
                        <button
                          type="button"
                          onClick={() => select(option)}
                          disabled={saving}
                          aria-pressed={selected}
                          className={`flex h-full w-full flex-col rounded-xl border p-3 text-left disabled:opacity-60 ${
                            selected
                              ? "border-[var(--brand-gold)] bg-[var(--brand-gold)]/15 ring-2 ring-[var(--brand-gold)]"
                              : "border-[var(--brand-navy)]/20 bg-white"
                          }`}
                        >
                          <span className="text-sm font-black">{option.name}</span>
                          <span className="mt-1 text-base leading-snug">{option.description}</span>
                          {option.amount !== null ? (
                            <span className="mt-2 text-lg font-black">{money(option.amount)}</span>
                          ) : null}
                          <span className="mt-2 font-mono text-[11px] text-[var(--brand-navy)]/50">
                            {option.id}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}