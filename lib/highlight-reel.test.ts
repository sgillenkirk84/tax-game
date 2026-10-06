import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildHighlightCandidates, buildHighlightReel, highlightMoney, validateHighlightHistory, type HighlightCategory } from "./highlight-reel.ts";
import type { StoredResults } from "./round-results.ts";
import { lifeLedgerRows, loadEarlierLedgerRounds } from "./life-ledger.ts";
import workbookData from "./game-data/workbook-data.json" with { type: "json" };

function history(pathwayId = "PATH-004"): StoredResults[] {
  return [1, 2, 3, 4, 5].map((roundNumber) => ({
    pathwayId, scenarioId: "starting-from-scratch", roundNumber,
    grossIncome: 50000, otherCashInflows: 0, livingCosts: 31000, personalExpenses: 0,
    calculatedTax: 100, taxPrepaid: 100, taxRefund: 0, taxAmountDue: 0,
    studentLoanPayment: 0, beginningCash: (roundNumber - 1) * 1000,
    endingCash: roundNumber * 1000, endingDebt: 0, filingStatus: "SINGLE",
    homeowner: pathwayId === "PATH-004", activeDependents: pathwayId === "PATH-003" ? 1 : 0,
    details: {
      adjustedGrossIncome: 40000, deductionAmount: 15750, deductionMethod: "standard",
      taxableIncome: 24250, taxBeforeCredits: 100, creditsApplied: 0,
      prepaymentRatePct: 100, beginningDebt: 0, investmentIncome: 0,
      investmentAssetValue: 0, auditPenalty: 0, auditResolution: "not-triggered",
    },
    cards: [
      { stage: "income-or-retirement", cardId: roundNumber >= (pathwayId === "PATH-008" ? 4 : 5) ? "RET-MIX-003" : "INC-W2-004" },
      { stage: "life-event", cardId: "LIFE-008" },
      { stage: "wildcard", cardId: "WILD-001" },
      { stage: "deduction", cardId: "DED-001" },
      { stage: "tax-prepayment", cardId: "PRE-005" },
    ],
  }));
}
function candidates(input: unknown) {
  const result = buildHighlightCandidates(input);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.candidates;
}
function candidate(input: unknown, category: HighlightCategory) {
  return candidates(input).find((entry) => entry.category === category);
}
function changeCard(round: StoredResults, stage: string, cardId: string) {
  round.cards = round.cards.map((entry) => entry.stage === stage ? { ...entry, cardId } : entry);
}
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

test("complete finalized history produces 5-7 highlights without mutation; order and refresh are stable", () => {
  const input = history();
  const before = structuredClone(input);
  const reel = buildHighlightReel(input);
  assert.ok(reel.ok);
  assert.ok(reel.highlights.length >= 5 && reel.highlights.length <= 7);
  assert.equal(reel.highlights.at(-1)?.category, "finish");
  assert.deepEqual(buildHighlightReel([input[4], input[1], input[3], input[0], input[2]]), reel);
  assert.deepEqual(buildHighlightReel(JSON.parse(JSON.stringify(input))), reel);
  assert.deepEqual(input, before);
  assert.deepEqual(lifeLedgerRows(input), lifeLedgerRows(before));
});

test("Where You Finished uses saved final cash, debt, household and meaningful cents neutrally", () => {
  const input = history("PATH-003");
  input[4].endingCash = -169.5;
  input[4].endingDebt = 1234.56;
  input[4].filingStatus = "HOH";
  const finish = candidate(input, "finish")!;
  assert.equal(finish.value, "-$169.50 cash/resources");
  assert.match(finish.explanation, /\$1,234.56.*Head of household.*1 active dependent.*homeowner: No/);
  assert.match(finish.explanation, /not a score or net worth/);
  assert.equal(highlightMoney(169.5), "$169.50");
  assert.equal(highlightMoney(350), "$350");
  assert.equal(highlightMoney(0), "$0");
  assert.doesNotMatch(JSON.stringify(finish), /loser|failure|winning/);
});

test("all eight pathways require saved Retirement evidence and respect approved transition timing", () => {
  for (const pathway of workbookData.pathways) {
    const input = history(pathway.id);
    assert.deepEqual(candidate(input, "retirement")?.rounds, [pathway.id === "PATH-008" ? 4 : 5]);
    assert.ok(buildHighlightReel(input).ok);
    changeCard(input[4], "income-or-retirement", "INC-W2-004");
    assert.equal(candidate(input, "retirement"), undefined, "contradictory working-life card prevents transition claim");
  }
  const early = history("PATH-008");
  changeCard(early[3], "income-or-retirement", "INC-W2-004");
  assert.equal(candidate(early, "retirement"), undefined);
  const climber = candidates(history("PATH-001"));
  assert.doesNotMatch(JSON.stringify(climber), /retained income|winning package|newest.*package|two Income/);
});

test("Biggest Refund uses positive saved values, preserves $169.50 and breaks ties by earliest round", () => {
  const input = history();
  assert.equal(candidate(input, "refund"), undefined);
  input[2].taxRefund = 169.5;
  input[2].taxPrepaid = 269.5;
  assert.match(candidate(input, "refund")!.value, /\$169.50 - Round 3/);
  input[0].taxRefund = 169.5;
  input[0].taxPrepaid = 269.5;
  assert.deepEqual(candidate(input, "refund")!.rounds, [1]);
  input[4].taxRefund = 368;
  input[4].calculatedTax = 0;
  input[4].taxPrepaid = 368;
  assert.deepEqual(candidate(input, "refund")!.rounds, [5]);
  assert.match(candidate(input, "refund")!.explanation, /not.*better score/);
});

test("Closest Prepayment uses saved settlement gaps including amount-due and PRE-010 zero matches", () => {
  const input = history();
  for (const round of input) {
    round.calculatedTax = 500;
    round.taxPrepaid = 0;
    round.taxAmountDue = 500;
    changeCard(round, "tax-prepayment", "PRE-010");
  }
  assert.equal(candidate(input, "refund"), undefined);
  assert.deepEqual(candidate(input, "prepayment")!.rounds, [1]);
  input[3].taxPrepaid = 499.5;
  input[3].taxAmountDue = 0.5;
  assert.match(candidate(input, "prepayment")!.value, /\$0.50 gap - Round 4/);
  input[1].taxPrepaid = 499.5;
  input[1].taxAmountDue = 0.5;
  assert.deepEqual(candidate(input, "prepayment")!.rounds, [2]);
  input[4].calculatedTax = 0;
  input[4].taxPrepaid = 0;
  input[4].taxAmountDue = 0;
  assert.match(candidate(input, "prepayment")!.value, /\$0 gap - Round 5/);
  assert.doesNotMatch(candidate(input, "prepayment")!.explanation, /perfect|planning/);
});

test("applied-credit facts use saved pre-credit and final tax, including credits-to-zero", () => {
  const input = history("PATH-005");
  input[2].details!.taxBeforeCredits = 350;
  input[2].details!.creditsApplied = 350;
  input[2].calculatedTax = 0;
  const fact = candidate(input, "credits")!;
  assert.match(fact.explanation, /from \$350 to \$0/);
  assert.deepEqual(fact.rounds, [3]);
  input[0].details!.taxBeforeCredits = 350;
  input[0].details!.creditsApplied = 350;
  input[0].calculatedTax = 0;
  assert.deepEqual(candidate(input, "credits")!.rounds, [1]);
  assert.doesNotMatch(fact.explanation, /education|Caregiver|child credit/);
  assert.equal(candidate(history("PATH-003"), "credits"), undefined, "Caregiver's dependent is not automatically a credit");
});

test("investment evidence is required; repeated events are grouped without profit or future-income promises", () => {
  const empty = history("PATH-007");
  assert.equal(candidate(empty, "investment"), undefined, "pathway metadata is not investment evidence");
  const input = history("PATH-007");
  changeCard(input[1], "wildcard", "WILD-007");
  changeCard(input[3], "wildcard", "WILD-007");
  changeCard(input[4], "wildcard", "WILD-010");
  input[4].details!.investmentAssetValue = 120000;
  input[4].details!.investmentIncome = 1000;
  const investment = candidate(input, "investment")!;
  assert.equal(investment.value, "3 recorded acquisitions");
  assert.deepEqual(investment.rounds, [2, 4, 5]);
  assert.equal(investment.evidenceKeys.length, 3);
  assert.match(investment.explanation, /Starter Investment.*Round 2/);
  assert.match(investment.explanation, /\$120,000.*assets.*\$1,000.*aggregate/);
  assert.doesNotMatch(investment.explanation, /profit|ROI|return|future|Round 6|Big win|starting investment/);
  const finalOnly = history();
  changeCard(finalOnly[4], "wildcard", "WILD-007");
  assert.match(candidate(finalOnly, "investment")!.explanation, /Round 5/);
  assert.doesNotMatch(candidate(finalOnly, "investment")!.explanation, /future|following|Round 6/);
  empty[4].details!.investmentAssetValue = 10000;
  assert.equal(candidate(empty, "investment")!.value, "Investments in saved Results");
  assert.doesNotMatch(candidate(empty, "investment")!.explanation, /started|starting|acquired/);
});

test("Life Milestones identify authoritative cards, not homeowner/dependent state or inferred tax causes", () => {
  const input = history("PATH-004");
  input.forEach((round) => { round.cards = round.cards.filter((card) => card.stage !== "life-event"); });
  assert.equal(candidate(input, "life"), undefined, "starting homeowner is not a Bought Home event");
  input[3].cards.push({ stage: "life-event", cardId: "LIFE-005" });
  const purchase = candidate(input, "life")!;
  assert.match(purchase.value, /Bought a Home - Round 4/);
  const name = workbookData.cards.find((card) => card.id === "LIFE-005")!.name;
  assert.ok(purchase.value.includes(name));
  input[1].cards.push({ stage: "life-event", cardId: "LIFE-003" });
  input[4].cards.push({ stage: "life-event", cardId: "LIFE-004" });
  assert.match(candidate(input, "life")!.value, /Got Married - Round 2/, "fixed marriage priority precedes divorce");
  input[0].cards.push({ stage: "life-event", cardId: "LIFE-003" });
  assert.deepEqual(candidate(input, "life")!.rounds, [1]);
  for (const card of workbookData.cards.filter((card) => card.deck === "Life Event" && card.active === "Yes")) {
    const one = history();
    one.forEach((round) => { round.cards = round.cards.filter((entry) => entry.stage !== "life-event"); });
    one[2].cards.push({ stage: "life-event", cardId: card.id });
    assert.ok(candidate(one, "life")!.value.includes(card.name));
    assert.doesNotMatch(candidate(one, "life")!.explanation, /caused.*tax|credit of|homeownership.*better/);
  }
});

test("Curveball priorities and Audit beta wording do not consume workbook result instructions", () => {
  const input = history();
  input.forEach((round) => changeCard(round, "wildcard", "WILD-006"));
  assert.equal(candidate(input, "curveball"), undefined, "Audit resolution evidence is required");
  input[2].details!.auditResolution = "bypassed-beta";
  const audit = candidate(input, "curveball")!;
  assert.match(audit.explanation, /recorded.*bypassed.*bypassed-beta.*no adjustment or penalty/);
  assert.doesNotMatch(audit.explanation, /passed the audit|failed|was resolved|Draw.*Audit/);
  changeCard(input[4], "wildcard", "WILD-004");
  input[4].personalExpenses = 5000;
  assert.match(candidate(input, "curveball")!.value, /Unexpected Expense/);
  changeCard(input[1], "wildcard", "WILD-003");
  input[1].otherCashInflows = 25000;
  assert.match(candidate(input, "curveball")!.value, /Unexpected Inheritance - Round 2/);
  assert.match(candidate(input, "curveball")!.explanation, /\$25,000/);
  input[0].otherCashInflows = 25000;
  changeCard(input[0], "wildcard", "WILD-003");
  assert.deepEqual(candidate(input, "curveball")!.rounds, [1]);
});

test("Debt Journey describes saved payments and remaining debt without attributing a deliberate strategy", () => {
  const input = history();
  input.forEach((round, index) => {
    round.details!.beginningDebt = 20000 - index * 4000;
    round.endingDebt = 16000 - index * 4000;
    round.studentLoanPayment = 4000;
  });
  const debt = candidate(input, "debt")!;
  assert.equal(debt.value, "$20,000 to $0");
  assert.match(debt.explanation, /game rules.*not.*accelerated/);
  input[4].endingDebt = 1000;
  assert.equal(candidate(input, "debt")!.value, "$20,000 to $1,000");
  input[0].details = null;
  assert.equal(candidate(input, "debt")!.value, "$1,000 remaining", "missing opening detail is not reconstructed");
  assert.equal(candidate(history(), "debt"), undefined);
});

test("Deduction Pattern uses saved methods only; missing detail omits the pattern", () => {
  const input = history();
  assert.equal(candidate(input, "deduction")!.value, "Standard deduction in all five rounds");
  input[1].details!.deductionMethod = "itemized";
  input[3].details!.deductionMethod = "itemized";
  assert.equal(candidate(input, "deduction")!.value, "Itemized in Rounds 2, 4");
  assert.doesNotMatch(candidate(input, "deduction")!.value, /exceeded|advantage|\$/);
  input[0].details = null;
  assert.equal(candidate(input, "deduction"), undefined);
});

test("Biggest Change ranks within one named metric and ties use earliest adjacent pair", () => {
  const input = history();
  const values = [10000, 20000, 10000, 11000, 12000];
  input.forEach((round, index) => { round.details!.adjustedGrossIncome = values[index]; });
  const change = candidate(input, "change")!;
  assert.deepEqual(change.rounds, [1, 2]);
  assert.match(change.value, /Adjusted gross income: \$10,000 to \$20,000/);
  assert.match(change.explanation, /does not establish the cause/);
  input[4].endingCash = 10000000;
  assert.deepEqual(candidate(input, "change")!.rounds, [1, 2], "cash magnitude is not compared against AGI magnitude");
  input.forEach((round) => { round.details = null; });
  assert.match(candidate(input, "change")!.value, /Ending cash\/resources/);
});

test("older/partial details omit unsupported facts rather than backfilling or rejecting saved core history", () => {
  const input = history().map((round) => ({ ...round, details: null }));
  const pool = candidates(input);
  for (const category of ["credits", "deduction", "investment"]) {
    assert.equal(pool.some((entry) => entry.category === category), false);
  }
  assert.ok(buildHighlightReel(input).ok);
  const partial = history().map((round) => ({ ...round, details: { creditsApplied: 350 } }));
  assert.equal(candidate(partial, "credits"), undefined, "missing tax basis cannot be substituted");
  assert.equal(candidate(partial, "deduction"), undefined);
});

test("invalid, incomplete, duplicate, mismatched and malformed history is explicitly rejected", () => {
  for (const input of [null, [], history().slice(0, 4), [...history(), history()[4]],
    [...history().slice(0, 4), history()[0]]]) assert.equal(buildHighlightReel(input).ok, false);
  for (const replacement of [
    { roundNumber: 6 }, { pathwayId: "PATH-003" }, { scenarioId: "student-loan-debt" },
    { beginningCash: 999 }, { endingCash: NaN }, { endingDebt: -1 },
    { taxRefund: 100, taxAmountDue: 100 },
    { cards: [{ stage: "wildcard", cardId: "UNKNOWN" }] },
    { cards: [{ stage: "wildcard", cardId: "RET-MIX-003" }] },
    { details: { creditsApplied: -1 } }, { activeDependents: 0.5 },
  ]) {
    const input = history().map((round, index) => index === 3 ? { ...round, ...replacement } : round);
    const result = buildHighlightReel(input);
    assert.equal(result.ok, false, JSON.stringify(replacement));
    if (!result.ok) assert.ok(result.error.length > 0);
  }
  const debtMismatch = history();
  debtMismatch[2].details!.beginningDebt = 5;
  assert.equal(validateHighlightHistory(debtMismatch).ok, false);
});

test("selection is diverse, bounded, ends with finish and suppresses overlapping tax/event evidence", () => {
  const input = history();
  input[0].details!.taxBeforeCredits = 350;
  input[0].details!.creditsApplied = 350;
  input[0].calculatedTax = 0;
  input[0].taxRefund = 368;
  input[0].taxPrepaid = 368;
  for (const round of input.slice(1)) { round.taxAmountDue = 500; round.calculatedTax = 600; }
  changeCard(input[0], "wildcard", "WILD-005");
  input.slice(1).forEach((round) => changeCard(round, "wildcard", "WILD-007"));
  const reel = buildHighlightReel(input);
  assert.ok(reel.ok);
  assert.equal(reel.highlights.length, 7);
  assert.equal(reel.highlights.at(-1)!.category, "finish");
  assert.ok(reel.highlights.some((entry) => entry.category === "credits"));
  assert.equal(reel.highlights.some((entry) => entry.category === "refund"), false, "same tax round is not repeated");
  assert.equal(reel.highlights.some((entry) => entry.category === "curveball"), false, "education and credited tax round are grouped by evidence");
  assert.equal(new Set(reel.highlights.map((entry) => entry.category)).size, reel.highlights.length);
  const minimal = history().map((round) => ({ ...round, cards: [], details: null, endingCash: 0, beginningCash: 0 }));
  const small = buildHighlightReel(minimal);
  assert.ok(small.ok);
  assert.equal(small.highlights.length, 2, "unsupported content is not fabricated to reach five");
});

test("Life Ledger loading is reused, incomplete fetches fail, table and financial boundaries stay intact", async () => {
  const input = history();
  const calls: number[] = [];
  const fetched = await loadEarlierLedgerRounds({ id: "player", resumeToken: "token" }, 5,
    new AbortController().signal, async (url, init) => {
      assert.equal(url, "/api/rounds/results");
      const { round } = JSON.parse(String(init?.body));
      calls.push(round);
      return Response.json({ finalized: true, results: input[round - 1] });
    });
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.deepEqual(buildHighlightReel([...fetched, input[4]]), buildHighlightReel(input));
  await assert.rejects(loadEarlierLedgerRounds({ id: "player", resumeToken: "token" }, 5,
    new AbortController().signal, async () => Response.json({ finalized: false })));
  const ledger = read("../components/life-ledger.tsx");
  assert.equal(ledger.split("void loadEarlierLedgerRounds(").length - 1, 1);
  assert.match(ledger, /buildHighlightReel\(\[\.\.\.history.rounds, current\]\)/);
  assert.match(ledger, /current.roundNumber === 5/);
  assert.ok(ledger.indexOf("<HighlightReel") < ledger.indexOf('id="life-ledger-heading"'));
  for (const invariant of ["min-w-[1050px]", 'scope="col"', 'scope="row"', "LEDGER_ROUNDS.map"]) assert.ok(ledger.includes(invariant));
  const ui = read("../components/highlight-reel.tsx");
  assert.match(ui, /Your game remains finalized/);
  assert.match(ui, /View Full Life Ledger/);
  assert.match(ui, /role="alert"/);
  assert.doesNotMatch(ui, /fetch\(|results-finalize|Round 6|generate|model/);
  const logic = read("./highlight-reel.ts");
  assert.doesNotMatch(logic, /computeRoundResults|calculatePrepayment|buildRoundTax|game-calculations|Math.random|Date.now|new Date|fetch\(|supabase|resultMessage|educationMessage/);
});
