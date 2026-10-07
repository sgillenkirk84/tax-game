import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compactCardAmount } from "./completed-card-summary.ts";
import { advanceTarget, ACTIVE_ROUND_FLOW } from "./round-stages.ts";
import { stageCardRules, stageInstructionsFor } from "./card-entry.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const summary = read("../components/saved-card-summary.tsx");
const entry = read("../components/card-entry.tsx");
const dashboard = read("../components/round-dashboard.tsx");

test("compact card values use explicit, category-safe labels", () => {
  assert.deepEqual(compactCardAmount("Income", 50000, "PATH-002"), { label: "Card amount" });
  assert.deepEqual(compactCardAmount("Retirement", 60000, "PATH-008"), { label: "Retirement card amount" });
  assert.deepEqual(compactCardAmount("Deduction", 3000, "PATH-004"), {
    label: "Card amount",
    note: "This is not necessarily the deduction used.",
  });
});

test("ambiguous wildcard values and Corporate Climber income amounts are not implied as retained money", () => {
  assert.equal(compactCardAmount("Wildcard", 10000, "PATH-004"), null);
  assert.equal(compactCardAmount("Income", 80000, "PATH-001"), null);
  assert.equal(compactCardAmount("Life Event", null, "PATH-003"), null);
  assert.equal(compactCardAmount("Tax Prepayment", null, "PATH-001"), null);
});

test("completed physical cards have a native, keyboard-operable details disclosure", () => {
  assert.match(summary, /<details className=/);
  assert.match(summary, /<summary className="[^"]*min-h-11[^"]*focus-visible:outline/);
  assert.match(summary, />\s*View card details\s*</);
  assert.match(summary, /card\.description/);
  assert.match(summary, /card\.educationMessage/);
  assert.match(summary, /card\.roundRule \|\| card\.pathwayRule/);
});

test("compact summaries retain saved text state and recorded choice without relying on color", () => {
  assert.match(summary, /Saved · \{card\.category\}/);
  assert.match(summary, /Your choice: \{recordedChoice\}/);
  assert.match(summary, /font-mono text-\[11px\][^\n]*\{card\.id\}/);
  assert.match(summary, /playerChoiceRequired && !recordedChoice/);
});

test("completed physical-card stages use a responsive one-to-two-column grid in chronological DOM order", () => {
  assert.match(dashboard, /grid grid-cols-1 gap-3 sm:grid-cols-2/);
  assert.match(dashboard, /ACTIVE_ROUND_FLOW\.map\(\(step, index\)/);
  assert.match(dashboard, /compactPhysicalStage =[\s\S]*step\.kind === "cards"/);
  assert.doesNotMatch(dashboard, /grid-auto-flow:\s*dense|grid-auto-rows|line-clamp/);
});

test("each authoritatively completed physical stage renders its saved records through the compact summary", () => {
  assert.match(dashboard, /if \(index < currentIndex\)/);
  assert.match(dashboard, /cards\.map\(\(card, position\) => \(/);
  assert.match(dashboard, /<SavedCardSummary key=\{`\$\{card\.id\}-\$\{position\}`\} card=\{card\} pathwayId=\{pathwayId\} \/>/);
});

test("completed descriptions are collapsed by default rather than removed", () => {
  assert.match(summary, /<details className="mt-2">/);
  assert.doesNotMatch(summary, /<details[^>]*\sopen(?:\s|>|=)/);
  assert.match(summary, /<p className="text-sm leading-relaxed">\{card\.description\}<\/p>/);
});

test("several completed physical stages render as separate chronological grid items", () => {
  assert.match(dashboard, /ACTIVE_ROUND_FLOW\.map\(\(step, index\)/);
  assert.match(dashboard, /cardsFor\(step\.id\)/);
  assert.match(dashboard, /Completed · \{label\}/);
  assert.doesNotMatch(dashboard, /slice\([^)]*4|\.take\(4\)/);
});

test("completed selections have content-driven heights with no forced truncation", () => {
  assert.doesNotMatch(summary, /className="[^"]*(?:^|\s)(?:max-h|h)-\d+/);
  assert.doesNotMatch(summary, /line-clamp|truncate/);
  assert.match(summary, /leading-snug/);
});

test("system, prepayment, current and future stages remain full-width dashboard items", () => {
  assert.match(dashboard, /"sm:col-span-2"/);
  assert.match(dashboard, /className="sm:col-span-2"/);
  assert.match(dashboard, /className="col-span-full flex items-center justify-between/);
});

test("a completed stage is shown only after progression, while current-stage saved cards stay separate from stage completion", () => {
  assert.match(dashboard, /if \(index < currentIndex\)/);
  assert.match(dashboard, /Completed · \{label\}/);
  assert.match(entry, /const canContinue = saved \|\| \(rules\.min > 0 && savedCards\.length >= rules\.min\)/);
  assert.match(entry, /rules\.min > savedCards\.length/);
});

test("the active unsaved card remains a full preview with explicit verification and save", () => {
  assert.match(entry, /saved && compactSavedCards/);
  assert.match(entry, /!saved \? \([\s\S]*?Selected card/);
  assert.match(entry, /<p className="mt-3 text-lg leading-relaxed">\{shown\.description\}<\/p>/);
  assert.match(entry, /Does this match the card in your hand\?/);
  assert.match(entry, /Yes, save this card/);
});

test("save errors do not mark a card saved, and the summary follows successful authoritative response", () => {
  const successfulResponse = entry.indexOf("if (!response.ok || !result.saved)");
  const addSavedCard = entry.indexOf("setSavedCards((current) => [...current, { ...card, recordedChoice: choice }])");
  const catchBlock = entry.indexOf("setError(caught instanceof Error ? caught.message : \"Could not save your card.\")");
  assert.ok(successfulResponse >= 0 && addSavedCard > successfulResponse && catchBlock > addSavedCard);
});

test("multiple saved cards and repeated IDs remain separate, ordered records", () => {
  assert.match(entry, /savedCards\.map\(\(savedCard, position\)/);
  assert.match(entry, /key=\{`\$\{savedCard\.id\}-\$\{position\}`\}/);
  assert.match(dashboard, /cards\.map\(\(card, position\)/);
  assert.match(dashboard, /key=\{`\$\{card\.id\}-\$\{position\}`\}/);
});

test("Side Hustler keeps its second required Income card discoverable after the first save", () => {
  assert.deepEqual(stageCardRules("income-or-retirement", "PATH-006", 3), { min: 2, max: 2 });
  assert.match(stageInstructionsFor("income-or-retirement", "PATH-006", 3), /draw two cards, one at a time/);
  assert.match(entry, /\$\{savedCards\.length\} of \$\{rules\.min\} cards saved\. Draw and save/);
});

test("Entrepreneur keeps its additional Business card optional", () => {
  assert.deepEqual(stageCardRules("income-or-retirement", "PATH-002", 3), { min: 1, max: 2 });
  assert.match(stageInstructionsFor("income-or-retirement", "PATH-002", 3), /may then draw one additional.*only if it is Business Income/);
  assert.match(entry, /You may draw \$\{remaining\} more if your pathway allows it/);
});

test("Corporate Climber compact Income presentation does not claim retained-income totals", () => {
  assert.equal(compactCardAmount("Income", 100000, "PATH-001"), null);
  assert.match(summary, /Saved · \{card\.category\}/);
  assert.doesNotMatch(summary, /Retained income|income retained/i);
});

test("saved Wildcard choices remain visible while unsaved choice controls remain available", () => {
  assert.match(summary, /Your choice: \{recordedChoice\}/);
  assert.match(entry, /choiceConfigFor\(shown\.id\) \? \(/);
  assert.match(entry, /aria-pressed=\{choice === option\.value\}/);
});

test("Audit-triggering Wildcards retain the unresolved beta limitation outside the disclosure", () => {
  assert.match(summary, /triggersAudit/);
  assert.match(summary, /bypassed-beta/);
  assert.match(summary, /No Audit[\s\S]*adjustment or penalty is applied/);
  assert.match(summary, /Audit trigger recorded/);
});

test("Retirement summaries do not call card amounts taxable income and retain component details", () => {
  assert.deepEqual(compactCardAmount("Retirement", 60000, "PATH-008"), { label: "Retirement card amount" });
  assert.doesNotMatch(summary, /taxable income/i);
  assert.match(summary, /card\.description/);
});

test("Deduction values are not mislabeled as the final deduction used", () => {
  const amount = compactCardAmount("Deduction", 3000, "PATH-004");
  assert.equal(amount?.label, "Card amount");
  assert.match(amount?.note ?? "", /not necessarily the deduction used/i);
  assert.doesNotMatch(summary, /Deduction Used/);
});

test("Investment Wildcard amounts are not labeled as cash, profit or investment return", () => {
  assert.equal(compactCardAmount("Wildcard", 10000, "PATH-007"), null);
  assert.doesNotMatch(summary, /immediate cash|profit|annual return|investment income/i);
});

test("Tax Calculation remains the existing read-only system-stage presentation", () => {
  assert.match(dashboard, /<TaxCalculation round=\{round\} player=\{player\} readOnly \/>/);
  assert.match(dashboard, /<TaxCalculation round=\{round\} player=\{player\} onCalculatedChange=\{setTaxCalculated\} \/>/);
});

test("Tax Prepayment cards keep their existing expanded presentation and keep/redraw controls", () => {
  assert.match(dashboard, /compactPhysicalStage =[\s\S]*step\.id !== "tax-prepayment"/);
  assert.match(dashboard, /compactSavedCards=\{step\.id !== "tax-prepayment"\}/);
  assert.match(dashboard, /<TaxPrepayment round=\{round\} player=\{player\} pathwayId=\{pathwayId\}/);
  const prepayment = read("../components/tax-prepayment.tsx");
  assert.match(prepayment, /Keep this card/);
  assert.match(prepayment, /Redraw one card/);
  assert.match(prepayment, /Income Tax Before Credits/);
});

test("Continue eligibility, stage advancement and five-round authorization are not changed", () => {
  assert.match(entry, /onSavedChange\?\.\(canContinue\)/);
  assert.match(dashboard, /currentSaved && isCardStage\(step\.id\)/);
  assert.match(dashboard, /onClick=\{\(\) => void advance\(\)\}/);
  assert.equal(advanceTarget("tax-prepayment", 5)?.stage, "results-and-life-ledger");
  assert.equal(advanceTarget("tax-prepayment", 6), null);
});

test("Rounds 1-4 progression and Round 5 post-game separation are preserved", () => {
  assert.deepEqual(advanceTarget("income-or-retirement", 1), { stage: "life-event", label: "Life Event" });
  assert.deepEqual(advanceTarget("tax-prepayment", 4), { stage: "results-and-life-ledger", label: "Results and Life Ledger" });
  assert.match(dashboard, /hidden=\{postGame\}/);
  const results = read("../components/round-results.tsx");
  assert.match(results, /View My Tax Life Recap/);
  assert.match(results, /onViewLedger=\{\(\) => changeView\("ledger"\)\}/);
});

test("the compact summary is presentation-only and introduces no API, persistence or financial operations", () => {
  assert.doesNotMatch(summary, /fetch\(|\.rpc\(|localStorage|sessionStorage|Math\.random|calculate|finaliz/i);
  assert.doesNotMatch(summary, /computeRoundResults|INSERT|UPDATE|DELETE/i);
});

test("card-entry data and active preview remain unchanged while compact summaries are opt-in", () => {
  assert.match(entry, /compactSavedCards = false/);
  assert.match(entry, /onSaved\?\.\(card\)/);
  assert.match(entry, /expectedCategory/);
  assert.match(entry, /setCard\(null\)/);
  assert.match(dashboard, /compactSavedCards=\{step\.id !== "tax-prepayment"\}/);
});

test("the round dashboard still renders the existing opening-independent Results stage", () => {
  assert.match(dashboard, /<RoundResults round=\{round\} player=\{player\}/);
  assert.deepEqual(ACTIVE_ROUND_FLOW.slice(0, 4).map((step) => step.id), [
    "income-or-retirement",
    "life-event",
    "wildcard",
    "deduction",
  ]);
});
