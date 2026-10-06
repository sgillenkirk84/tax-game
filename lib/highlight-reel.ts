import workbookData from "./game-data/workbook-data.json" with { type: "json" };
import type { StoredResults } from "./round-results.ts";

type HighlightRound = Omit<StoredResults, "details"> & {
  details: Partial<NonNullable<StoredResults["details"]>> | null;
};

export type HighlightCategory =
  | "finish" | "retirement" | "life" | "refund" | "prepayment" | "credits"
  | "investment" | "curveball" | "change" | "debt" | "deduction";

export type Highlight = {
  id: string;
  category: HighlightCategory;
  title: string;
  value: string;
  explanation: string;
  rounds: number[];
  evidenceKeys: string[];
};

export type HighlightResult =
  | { ok: true; highlights: Highlight[] }
  | { ok: false; error: string };

const cards = new Map(workbookData.cards.map((card) => [String(card.id), card]));
const pathways = new Set(workbookData.pathways.map((pathway) => String(pathway.id)));
const filingLabels: Record<string, string> = {
  SINGLE: "Single", MFJ: "Married filing jointly", HOH: "Head of household",
  single: "Single", married_filing_jointly: "Married filing jointly",
  head_of_household: "Head of household", married_filing_separately: "Married filing separately",
};
const coreAmounts = [
  "grossIncome", "otherCashInflows", "livingCosts", "personalExpenses", "calculatedTax",
  "taxPrepaid", "taxRefund", "taxAmountDue", "studentLoanPayment", "endingDebt",
] as const;
const detailAmounts = [
  "adjustedGrossIncome", "deductionAmount", "taxableIncome", "taxBeforeCredits",
  "creditsApplied", "prepaymentRatePct", "beginningDebt", "investmentIncome",
  "investmentAssetValue", "auditPenalty",
] as const;
const decks: Record<string, readonly string[]> = {
  "income-or-retirement": ["Income", "Retirement"], "life-event": ["Life Event"],
  wildcard: ["Wildcard"], deduction: ["Deduction"], "tax-prepayment": ["Tax Prepayment"],
  "audit-if-triggered": ["Audit"],
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100));
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const cents = (value: number) => Math.round(value * 100);
export const highlightMoney = (value: number) => value.toLocaleString("en-US", {
  style: "currency", currency: "USD",
  minimumFractionDigits: cents(value) % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
});

// Partial older detail payloads can supply individual facts; missing fields are never backfilled.
function isHighlightRound(value: unknown): value is HighlightRound {
  if (!record(value) || !Number.isInteger(value.roundNumber)
    || typeof value.roundNumber !== "number" || value.roundNumber < 1 || value.roundNumber > 5
    || typeof value.pathwayId !== "string" || !pathways.has(value.pathwayId)
    || typeof value.scenarioId !== "string" || !workbookData.gameRules.approved.startingDecisions.some((s) => s.id === value.scenarioId)
    || typeof value.filingStatus !== "string" || !filingLabels[value.filingStatus]
    || typeof value.homeowner !== "boolean" || !nonnegative(value.activeDependents)
    || !Number.isInteger(value.activeDependents)
    || !finite(value.beginningCash) || !finite(value.endingCash)
    || coreAmounts.some((key) => !nonnegative(value[key])) || !Array.isArray(value.cards)
    || (Number(value.taxRefund) > 0 && Number(value.taxAmountDue) > 0)) return false;
  if (!value.cards.every((entry) => {
    if (!record(entry) || typeof entry.stage !== "string" || typeof entry.cardId !== "string") return false;
    const card = cards.get(entry.cardId);
    return card !== undefined && card.active === "Yes" && decks[entry.stage]?.includes(String(card.deck));
  })) return false;
  if (value.details !== null) {
    if (!record(value.details)) return false;
    const details = value.details;
    if (detailAmounts.some((key) => details[key] !== undefined && !nonnegative(details[key]))) return false;
    if (details.deductionMethod !== undefined && !["standard", "itemized"].includes(String(details.deductionMethod))) return false;
    if (details.auditResolution !== undefined && !["not-triggered", "bypassed-beta"].includes(String(details.auditResolution))) return false;
  }
  return true;
}

export function validateHighlightHistory(history: unknown):
  { ok: true; rounds: HighlightRound[] } | { ok: false; error: string } {
  if (!Array.isArray(history) || history.length !== 5 || !history.every(isHighlightRound)) {
    return { ok: false, error: "The Highlight Reel needs valid saved Results for all five rounds." };
  }
  const rounds = [...history].sort((a, b) => a.roundNumber - b.roundNumber);
  const first = rounds[0];
  if (rounds.some((round, index) => round.roundNumber !== index + 1
    || round.pathwayId !== first.pathwayId || round.scenarioId !== first.scenarioId
    || (index > 0 && cents(round.beginningCash) !== cents(rounds[index - 1].endingCash))
    || (index > 0 && round.details?.beginningDebt !== undefined
      && cents(round.details.beginningDebt) !== cents(rounds[index - 1].endingDebt)))) {
    return { ok: false, error: "The saved rounds do not form one consistent five-round history." };
  }
  return { ok: true, rounds };
}

type Event = { round: HighlightRound; cardId: string; order: number; key: string; name: string };
function events(rounds: readonly HighlightRound[], stage: string): Event[] {
  return rounds.flatMap((round) => round.cards.flatMap((card, order) => {
    const metadata = cards.get(card.cardId);
    return card.stage === stage && metadata && typeof metadata.name === "string"
      ? [{ round, cardId: card.cardId, order, key: `event:${round.roundNumber}:${stage}:${order}:${card.cardId}`, name: metadata.name }]
      : [];
  }));
}
const eventCompare = (a: Event, b: Event) =>
  a.round.roundNumber - b.round.roundNumber || a.order - b.order || a.cardId.localeCompare(b.cardId, "en");
const orderedAmounts = (rounds: readonly HighlightRound[], amount: (round: HighlightRound) => number, ascending = false) =>
  [...rounds].sort((a, b) => (ascending ? 1 : -1) * (cents(amount(a)) - cents(amount(b))) || a.roundNumber - b.roundNumber);

// Editorial diversity, not a financial score. Event priorities use fixed ID lists, then saved order.
export const HIGHLIGHT_PRIORITY: readonly HighlightCategory[] = [
  "retirement", "life", "credits", "investment", "curveball", "refund",
  "prepayment", "debt", "deduction", "change",
];
const LIFE_PRIORITY = ["LIFE-003", "LIFE-004", "LIFE-001", "LIFE-002", "LIFE-005", "LIFE-007", "LIFE-008", "LIFE-006", "LIFE-009", "LIFE-010"];
const CURVEBALL_PRIORITY = ["WILD-003", "WILD-004", "WILD-006", "WILD-005", "WILD-002", "WILD-001"];
const taxEvidence = (round: number) => `tax-outcome:${round}`;

export function buildHighlightCandidates(history: unknown):
  { ok: true; candidates: Highlight[] } | { ok: false; error: string } {
  const validated = validateHighlightHistory(history);
  if (!validated.ok) return validated;
  const rounds = validated.rounds;
  const first = rounds[0];
  const final = rounds[4];
  const candidates: Highlight[] = [];
  const add = (category: HighlightCategory, title: string, value: string, explanation: string, sources: number[], evidenceKeys: string[]) =>
    candidates.push({ id: `${category}:${sources.join("-")}`, category, title, value, explanation, rounds: sources, evidenceKeys });

  const retirementStart = first.pathwayId === "PATH-008" ? 4 : 5;
  const retirementEvents = events(rounds, "income-or-retirement").filter((event) => cards.get(event.cardId)?.deck === "Retirement");
  if (retirementEvents.length > 0 && retirementEvents[0].round.roundNumber === retirementStart
    && rounds.filter((round) => round.roundNumber >= retirementStart).every((round) =>
      round.cards.filter((card) => card.stage === "income-or-retirement").length === 1
      && retirementEvents.some((event) => event.round.roundNumber === round.roundNumber))) {
    add("retirement", "Retirement", `Round ${retirementStart}`,
      `Your saved card history first records Retirement in Round ${retirementStart}.`,
      [retirementStart], [`retirement:${retirementStart}`]);
  }

  const milestone = events(rounds, "life-event").sort((a, b) =>
    LIFE_PRIORITY.indexOf(a.cardId) - LIFE_PRIORITY.indexOf(b.cardId) || eventCompare(a, b))[0];
  if (milestone) add("life", "Life Milestone", `${milestone.name} - Round ${milestone.round.roundNumber}`,
    "This Life Event is recorded in your finalized history.",
    [milestone.round.roundNumber], [milestone.key]);

  const refund = orderedAmounts(rounds.filter((round) => round.taxRefund > 0), (round) => round.taxRefund)[0];
  if (refund) add("refund", "Biggest Refund", `${highlightMoney(refund.taxRefund)} - Round ${refund.roundNumber}`,
    "A refund means your fixed prepayment exceeded final tax for that round, not that the round earned a better score.",
    [refund.roundNumber], [taxEvidence(refund.roundNumber)]);

  const closest = orderedAmounts(rounds, (round) => round.taxRefund + round.taxAmountDue, true)[0];
  add("prepayment", "Closest Prepayment", `${highlightMoney(closest.taxRefund + closest.taxAmountDue)} gap - Round ${closest.roundNumber}`,
    `Your saved prepayment of ${highlightMoney(closest.taxPrepaid)} came within ${highlightMoney(closest.taxRefund + closest.taxAmountDue)} of final tax of ${highlightMoney(closest.calculatedTax)}.`,
    [closest.roundNumber], [taxEvidence(closest.roundNumber)]);

  const credit = orderedAmounts(rounds.filter((round) => nonnegative(round.details?.taxBeforeCredits)
    && nonnegative(round.details?.creditsApplied) && Number(round.details?.creditsApplied) > 0),
  (round) => round.details?.creditsApplied ?? 0)[0];
  if (credit && credit.details?.taxBeforeCredits !== undefined && credit.details.creditsApplied !== undefined) {
    add("credits", "Credits Applied", `${highlightMoney(credit.details.creditsApplied)} - Round ${credit.roundNumber}`,
      `Applied credits reduced your saved tax from ${highlightMoney(credit.details.taxBeforeCredits)} to ${highlightMoney(credit.calculatedTax)}.`,
      [credit.roundNumber], [taxEvidence(credit.roundNumber)]);
  }

  const investments = events(rounds, "wildcard").filter((event) => ["WILD-007", "WILD-008", "WILD-009", "WILD-010"].includes(event.cardId)).sort(eventCompare);
  const asset = final.details?.investmentAssetValue;
  const income = final.details?.investmentIncome;
  if (investments.length > 0 || (nonnegative(asset) && asset > 0) || (nonnegative(income) && income > 0)) {
    const start = investments[0];
    const finalFacts = [
      nonnegative(asset) ? `${highlightMoney(asset)} in recorded investment assets` : "",
      nonnegative(income) ? `${highlightMoney(income)} in aggregate investment income` : "",
    ].filter(Boolean);
    add("investment", "Investment Journey",
      start ? `${investments.length} recorded acquisition${investments.length === 1 ? "" : "s"}` : "Investments in saved Results",
      `${start ? `${start.name} was recorded in Round ${start.round.roundNumber}. ` : ""}${finalFacts.length ? `Round 5 shows ${finalFacts.join(" and ")}.` : "Saved card history records the acquisition events."}`,
      start ? [...new Set(investments.map((event) => event.round.roundNumber))] : [5],
      investments.map((event) => event.key));
  }

  const curveball = events(rounds, "wildcard").filter((event) => CURVEBALL_PRIORITY.includes(event.cardId)
    && (event.cardId !== "WILD-006" || event.round.details?.auditResolution === "bypassed-beta"))
    .sort((a, b) => CURVEBALL_PRIORITY.indexOf(a.cardId) - CURVEBALL_PRIORITY.indexOf(b.cardId) || eventCompare(a, b))[0];
  if (curveball) {
    const explanations: Record<string, string> = {
      "WILD-001": "Your saved history records a work-bonus opportunity; this is not a claim that higher income is always better.",
      "WILD-002": "Your saved history records a freelance opportunity alongside the other events of that round.",
      "WILD-003": `That round recorded ${highlightMoney(curveball.round.otherCashInflows)} in other cash inflows.`,
      "WILD-004": `That round recorded ${highlightMoney(curveball.round.personalExpenses)} in personal-expense outflows; no deduction or expense choice is inferred here.`,
      "WILD-005": "An education opportunity was recorded. Any credits shown elsewhere use saved applied amounts, not an assumed benefit.",
      "WILD-006": "An Audit trigger was recorded; resolution was bypassed during the beta (bypassed-beta), with no adjustment or penalty.",
    };
    add("curveball", "Curveball", `${curveball.name} - Round ${curveball.round.roundNumber}`,
      explanations[curveball.cardId], [curveball.round.roundNumber],
      [curveball.key, ...(curveball.cardId === "WILD-005" ? [taxEvidence(curveball.round.roundNumber)] : [])]);
  }

  const startingDebt = first.details?.beginningDebt;
  if (nonnegative(startingDebt) && startingDebt > 0 && rounds.some((round) => round.studentLoanPayment > 0)
    && final.endingDebt <= startingDebt) {
    add("debt", "Debt Journey", `${highlightMoney(startingDebt)} to ${highlightMoney(final.endingDebt)}`,
      "Saved student-loan payments were applied under the shared game rules; this is not a claim of an accelerated repayment choice.",
      [1, 5], ["debt-journey"]);
  } else if (final.endingDebt > 0) {
    add("debt", "Debt Journey", `${highlightMoney(final.endingDebt)} remaining`,
      "This is your recorded student-loan debt at the end of Round 5.", [5], ["debt-journey"]);
  }

  if (rounds.every((round) => round.details?.deductionMethod !== undefined)) {
    const itemized = rounds.filter((round) => round.details?.deductionMethod === "itemized").map((round) => round.roundNumber);
    add("deduction", "Deduction Pattern", itemized.length ? `Itemized in Round${itemized.length === 1 ? "" : "s"} ${itemized.join(", ")}` : "Standard deduction in all five rounds",
      "These are the saved deduction methods. Itemizing is not always better, and no historical dollar advantage is reconstructed.",
      itemized.length ? itemized : [1, 2, 3, 4, 5], ["deduction-pattern"]);
  }

  // Choose one named metric by fixed editorial order; never rank unrelated metrics together.
  const metrics = [
    { name: "Adjusted gross income", get: (round: HighlightRound) => round.details?.adjustedGrossIncome },
    { name: "Ending cash/resources", get: (round: HighlightRound) => round.endingCash },
    { name: "Remaining debt", get: (round: HighlightRound) => round.endingDebt },
    { name: "Calculated Tax", get: (round: HighlightRound) => round.calculatedTax },
  ];
  for (const metric of metrics) {
    const pairs = rounds.slice(1).flatMap((round, index) => {
      const before = metric.get(rounds[index]);
      const after = metric.get(round);
      return finite(before) && finite(after) && cents(before) !== cents(after)
        ? [{ from: rounds[index], to: round, before, after, delta: Math.abs(cents(after) - cents(before)) }] : [];
    }).sort((a, b) => b.delta - a.delta || a.from.roundNumber - b.from.roundNumber);
    const pair = pairs[0];
    if (!pair) continue;
    add("change", "Biggest Change", `${metric.name}: ${highlightMoney(pair.before)} to ${highlightMoney(pair.after)}`,
      `This was the largest recorded change in ${metric.name.toLowerCase()} between adjacent Rounds ${pair.from.roundNumber} and ${pair.to.roundNumber}; it does not establish the cause.`,
      [pair.from.roundNumber, pair.to.roundNumber],
      [metric.name === "Remaining debt" ? "debt-journey" : `change:${metric.name}`,
        ...(pair.to.roundNumber === retirementStart ? [`retirement:${retirementStart}`] : [])]);
    break;
  }

  add("finish", "Where You Finished", `${highlightMoney(final.endingCash)} cash/resources`,
    `${highlightMoney(final.endingDebt)} remaining student-loan debt; ${filingLabels[final.filingStatus]}; ${final.activeDependents} active dependent${final.activeDependents === 1 ? "" : "s"}; homeowner: ${final.homeowner ? "Yes" : "No"}. This is a saved final position, not a score or net worth.`,
    [5], []);
  return { ok: true, candidates };
}

export function buildHighlightReel(history: unknown): HighlightResult {
  const built = buildHighlightCandidates(history);
  if (!built.ok) return built;
  const selected: Highlight[] = [];
  const used = new Set<string>();
  for (const category of HIGHLIGHT_PRIORITY) {
    const candidate = built.candidates.find((entry) => entry.category === category);
    if (!candidate || candidate.evidenceKeys.some((key) => used.has(key))) continue;
    selected.push(candidate);
    candidate.evidenceKeys.forEach((key) => used.add(key));
    if (selected.length === 6) break;
  }
  const finish = built.candidates.find((candidate) => candidate.category === "finish");
  if (finish) selected.push(finish);
  return { ok: true, highlights: selected };
}
