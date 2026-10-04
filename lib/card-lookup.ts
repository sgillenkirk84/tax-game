import { GAME_DATA } from "@/lib/game-data";
import type { SourceValue } from "@/lib/game-data/types";
import { type CardCategory, type CardPreview } from "@/lib/card-entry";

const text = (value: SourceValue) => (typeof value === "string" && value.trim() ? value : null);

let cardsById: Map<string, (typeof GAME_DATA.cards)[number]> | null = null;

function getIndex() {
  if (!cardsById) {
    cardsById = new Map();
    for (const card of GAME_DATA.cards) {
      if (typeof card.id === "string" && card.active === "Yes") {
        cardsById.set(card.id.toUpperCase(), card);
      }
    }
  }
  return cardsById;
}

export type CardLookupResult =
  | { ok: true; card: CardPreview }
  | { ok: false; reason: "not-found" | "wrong-category"; actualCategory?: string };

// Looks up an active approved card and checks it belongs to the expected deck.
export function lookupCard(cardId: string, expectedCategory: CardCategory): CardLookupResult {
  const card = getIndex().get(cardId);
  if (!card) {
    return { ok: false, reason: "not-found" };
  }
  if (card.deck !== expectedCategory) {
    return { ok: false, reason: "wrong-category", actualCategory: text(card.deck) ?? undefined };
  }
  return {
    ok: true,
    card: {
      id: String(card.id),
      name: text(card.name) ?? String(card.id),
      category: expectedCategory,
      subcategory: text(card.subcategory),
      description: text(card.description) ?? "",
      amount: typeof card.amount === "number" ? card.amount : null,
      taxCategory: text(card.taxCategory),
      educationMessage: text(card.educationMessage),
      roundRule: text(card.roundRule),
      pathwayRule: text(card.pathwayRule),
      playerChoiceRequired: card.playerChoiceRequired === "Yes",
    },
  };
}
