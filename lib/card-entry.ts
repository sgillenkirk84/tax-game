// Shared, client-safe card-entry definitions. Contains no card data.
import { getRoundIncomeCardCategory } from "./round-income.ts";

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

// The deck follows shared retirement timing, independent of rollout availability.
export function expectedCategoryFor(stage: CardStage, pathwayId: string, round: number): CardCategory {
  if (stage === "income-or-retirement") {
    return getRoundIncomeCardCategory(pathwayId, round);
  }
  return stageCategories[stage];
}

// Cards a student must save before continuing (min) and may save (max) at a
// stage. Mirrors record_round_card and advance_round_stage, which remain the
// authority; this only decides what to offer on screen. Tax Prepayment is open in Rounds 1-3.
export type StageCardRules = { min: number; max: number };

export function isRoundCardStageAvailable(stage: CardStage, round: number): boolean {
  return Number.isInteger(round) && round >= 1 && round <= 4
    && (round <= 3 || stage === "income-or-retirement")
    && stage !== "audit-if-triggered";
}

export function stageCardRules(stage: CardStage, pathwayId: string, round: number): StageCardRules {
  if (!isRoundCardStageAvailable(stage, round)) {
    return { min: 0, max: 0 };
  }
  if (stage === "income-or-retirement") {
    if (getRoundIncomeCardCategory(pathwayId, round) === "Retirement") {
      return { min: 1, max: 1 };
    }
    // Side Hustler draws exactly two Income cards; Entrepreneur may add one
    // optional Business Income card to the one required card.
    if (pathwayId === "PATH-006") {
      return { min: 2, max: 2 };
    }
    return pathwayId === "PATH-002" ? { min: 1, max: 2 } : { min: 1, max: 1 };
  }
  return stage === "life-event" || stage === "wildcard" || stage === "deduction" || stage === "tax-prepayment"
    ? { min: 1, max: 1 }
    : { min: 0, max: 0 };
}

// Pathway-specific student instructions; other stages use stageInstructions.
export function stageInstructionsFor(stage: CardStage, pathwayId: string, round: number): string {
  if (isRoundCardStageAvailable(stage, round) && stage === "income-or-retirement") {
    if (getRoundIncomeCardCategory(pathwayId, round) === "Retirement") {
      return "You are in retirement this round. Physically shuffle the Retirement deck, draw one card, and select the card that matches the one in your hand. Save the Retirement card; its income components remain separate for later tax calculation.";
    }
    if (pathwayId === "PATH-006") {
      return "Side Hustler: shuffle the Income deck and draw two cards, one at a time. Select each card that matches one in your hand and save it. Both cards count toward your income.";
    }
    if (pathwayId === "PATH-002") {
      return "Shuffle the Income deck, draw one card, and select the card that matches the one in your hand. As an Entrepreneur you may then draw one additional Income card, but you keep it only if it is Business Income.";
    }
  }
  if (round >= 1 && round <= 3 && stage === "life-event") {
    const base = stageInstructions[stage];
    return pathwayId === "PATH-003"
      ? `${base} Keep your permanent dependent token: Life Events can never reduce your dependents below one. If the card does not apply to you, return it to the bottom of the deck and draw again.`
      : `${base} If the card does not apply to you, return it to the bottom of the deck and draw again.`;
  }
  return stageInstructions[stage];
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
  // True when the approved data says the card triggers an audit.
  triggersAudit: boolean;
  // The student's recorded choice for this card, when it has one and was saved.
  recordedChoice?: string | null;
};

// Cards that need a student choice. The server and database accept only these
// values; the browser can never submit anything else.
export type CardChoiceConfig = {
  key: string;
  prompt: string;
  options: { value: string; label: string }[];
};

export const CARD_CHOICES: Record<string, CardChoiceConfig> = {
  "WILD-004": {
    key: "expense_type",
    prompt: "Is this a business expense or a personal expense?",
    options: [
      { value: "business", label: "Business Expense" },
      { value: "personal", label: "Personal Expense" },
    ],
  },
};

export function choiceConfigFor(cardId: string): CardChoiceConfig | null {
  return CARD_CHOICES[cardId] ?? null;
}

// A card with a choice needs one of its options; a card without one needs none.
export const REDRAW_CHOICE = "redraw";

export function isValidCardChoice(cardId: string, choice: string | null): boolean {
  // A Tax Prepayment card may be tagged as a redraw; the database decides eligibility.
  if (cardId.startsWith("PRE-") && choice === REDRAW_CHOICE) {
    return true;
  }
  const config = choiceConfigFor(cardId);
  if (!config) {
    return choice === null;
  }
  return choice !== null && config.options.some((option) => option.value === choice);
}

export function choiceLabel(cardId: string, value: string | null | undefined): string | null {
  return choiceConfigFor(cardId)?.options.find((option) => option.value === value)?.label ?? null;
}

// Reads the stored choice from a card-history row's choices object.
export function recordedChoiceFrom(cardId: string, choices: unknown): string | null {
  const config = choiceConfigFor(cardId);
  if (!config || choices === null || typeof choices !== "object") {
    return null;
  }
  const value = (choices as Record<string, unknown>)[config.key];
  return typeof value === "string" && config.options.some((option) => option.value === value) ? value : null;
}
