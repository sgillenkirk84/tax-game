import { choiceLabel, type CardPreview } from "@/lib/card-entry";
import { compactCardAmount } from "@/lib/completed-card-summary";

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default function SavedCardSummary({
  card,
  pathwayId,
}: {
  card: CardPreview;
  pathwayId: string;
}) {
  const amount = compactCardAmount(card.category, card.amount, pathwayId);
  const amountValue = card.amount;
  const recordedChoice = card.recordedChoice ? choiceLabel(card.id, card.recordedChoice) : null;

  return (
    <article className="rounded-xl border border-green-700/25 bg-white/80 p-3">
      <p className="text-xs font-black uppercase tracking-[0.12em] text-green-800">
        Saved · {card.category}
      </p>
      <p className="mt-1 text-base font-bold leading-snug">{card.name}</p>
      {amount && amountValue !== null ? (
        <p className="mt-1 text-sm font-semibold">
          {amount.label}: {money(amountValue)}
        </p>
      ) : null}
      {amount?.note ? <p className="mt-1 text-xs text-[var(--brand-navy)]/75">{amount.note}</p> : null}
      {recordedChoice ? <p className="mt-1 text-sm font-semibold">Your choice: {recordedChoice}</p> : null}
      {card.playerChoiceRequired && !recordedChoice ? (
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs font-semibold text-amber-900">
          This card needs a choice from you. Choices are not recorded yet, so only the card itself is saved.
        </p>
      ) : null}
      {card.triggersAudit ? (
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs font-semibold text-amber-900">
          Audit trigger recorded; resolution remains bypassed under the beta rule (bypassed-beta). No Audit
          adjustment or penalty is applied.
        </p>
      ) : null}
      <p className="mt-1 font-mono text-[11px] text-[var(--brand-navy)]/50">{card.id}</p>
      <details className="mt-2">
        <summary className="flex min-h-11 w-fit cursor-pointer items-center rounded px-1 text-sm font-semibold underline decoration-[var(--brand-navy)]/40 underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-navy)]">
          View card details
        </summary>
        <div className="mt-2 border-t border-[var(--brand-navy)]/15 pt-2">
          <p className="text-sm leading-relaxed">{card.description}</p>
          {amountValue !== null ? <p className="mt-2 text-sm font-semibold">Card amount: {money(amountValue)}</p> : null}
          {card.taxCategory ? <p className="mt-2 text-xs">Tax category: {card.taxCategory}</p> : null}
          {card.educationMessage ? <p className="mt-2 text-sm text-[var(--brand-navy)]/75">{card.educationMessage}</p> : null}
          {card.roundRule || card.pathwayRule ? (
            <p className="mt-2 text-xs text-[var(--brand-navy)]/70">
              {card.roundRule ? `Rounds: ${card.roundRule}. ` : ""}
              {card.pathwayRule && card.pathwayRule !== "None" ? card.pathwayRule : ""}
            </p>
          ) : null}
          {card.subcategory ? <p className="mt-2 text-xs">Category detail: {card.subcategory}</p> : null}
        </div>
      </details>
    </article>
  );
}
