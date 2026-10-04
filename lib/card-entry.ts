// Shared, client-safe card-entry definitions. Contains no card data.

export const CARD_STAGES = [
  "income-or-retirement",
  "life-event",
  "wildcard",
  "deduction",
  "tax-prepayment",
  "audit-if-triggered",
] as const;

export type CardStage = (typeof CARD_STAGES)[number];

export type CardCategory =
  | "Income"
  | "Retirement"
  | "Life Event"
  | "Wildcard"
  | "Deduction"
  | "Tax Prepayment"
  | "Audit Result";

const EARLY_RETIREE_PATHWAY_ID = "PATH-008";
const EARLY_RETIREMENT_START_ROUND = 4;

const stageCategories: Record<Exclude<CardStage, "income-or-retirement">, CardCategory> = {
  "life-event": "Life Event",
  wildcard: "Wildcard",
  deduction: "Deduction",
  "tax-prepayment": "Tax Prepayment",
  "audit-if-triggered": "Audit Result",
};

export const stageInstructions: Record<CardStage, string> = {
  "income-or-retirement": "Shuffle the deck, draw one card, and select the card that matches the one in your hand.",
  "life-event": "Shuffle the Life Event deck, draw one card, and select the card that matches the one in your hand.",
  wildcard: "Shuffle the Wildcard deck, draw one card, and select the card that matches the one in your hand.",
  deduction: "Shuffle the Deduction deck, draw one card, and select the card that matches the one in your hand.",
  "tax-prepayment": "Shuffle the Tax Prepayment deck, draw one card, and select the card that matches the one in your hand.",
  "audit-if-triggered": "Your teacher will tell you if an audit applies. Draw an Audit Result card and select the matching card.",
};

// Student-facing heading for each of the five rounds.
export const ROUND_HEADINGS: Record<number, string> = {
  1: "Starting Out",
  2: "Finding Your Feet",
  3: "Building Your Future",
  4: "Major Life Decisions",
  5: "Looking Ahead",
};

export function roundHeading(round: number): string {
  return ROUND_HEADINGS[round] ?? `Round ${round}`;
}

export function isCardStage(value: unknown): value is CardStage {
  return typeof value === "string" && (CARD_STAGES as readonly string[]).includes(value);
}

// The deck a student must draw from at a stage. Early Retiree uses Retirement
// cards instead of Income cards from Round 4.
export function expectedCategoryFor(stage: CardStage, pathwayId: string, round: number): CardCategory {
  if (stage === "income-or-retirement") {
    return pathwayId === EARLY_RETIREE_PATHWAY_ID && round >= EARLY_RETIREMENT_START_ROUND
      ? "Retirement"
      : "Income";
  }
  return stageCategories[stage];
}

// Maximum cards a student may save at a stage. Mirrors record_round_card, which
// remains the authority; this only decides whether to offer the save button.
export function stageCardLimit(stage: CardStage, round: number): number {
  return stage === "income-or-retirement" && round === 1 ? 1 : 0;
}

export type CardSection = { heading: string | null; subcategory: string | null; note?: string };

// How a deck is grouped on screen. Decks without an entry show as one list.
const deckSections: Partial<Record<CardCategory, CardSection[]>> = {
  Income: [
    { heading: "W-2 Jobs", subcategory: "W-2" },
    {
      heading: "Business Income",
      subcategory: "Business",
      note: "Business income may involve additional self-employment taxes. Money Moves will calculate the applicable taxes automatically.",
    },
  ],
};

export function sectionsFor(category: CardCategory): CardSection[] {
  return deckSections[category] ?? [{ heading: null, subcategory: null }];
}

export function normalizeCardId(value: string): string {
  return value.trim().toUpperCase();
}

export const cardIdPattern = /^[A-Z0-9][A-Z0-9-]{1,38}[A-Z0-9]$/;

export type CardPreview = {
  id: string;
  name: string;
  category: CardCategory;
  subcategory: string | null;
  description: string;
  amount: number | null;
  taxCategory: string | null;
  educationMessage: string | null;
  // Source eligibility metadata, shown as-is. Not enforced until rules are approved.
  roundRule: string | null;
  pathwayRule: string | null;
  playerChoiceRequired: boolean;
};
