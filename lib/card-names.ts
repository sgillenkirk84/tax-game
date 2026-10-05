import { GAME_DATA } from "@/lib/game-data";

// Server-side names for the saved cards shown on Results, taken from the
// approved dataset. WILD-006 is shown by ID only: Audit is not part of the
// current flow, so Results must not announce one.
export function cardNamesFor(cardIds: string[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const id of new Set(cardIds)) {
    if (id === "WILD-006") {
      continue;
    }
    const card = GAME_DATA.cards.find((entry) => entry.id === id && entry.active === "Yes");
    if (card && typeof card.name === "string" && card.name.trim()) {
      names[id] = card.name;
    }
  }
  return names;
}
