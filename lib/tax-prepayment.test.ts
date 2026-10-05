import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import dataset from "./game-data/workbook-data.json" with { type: "json" };
import { isValidCardChoice, stageCardRules } from "./card-entry.ts";
import { advanceTarget } from "./round-stages.ts";
import {
  calculatePrepaymentDollars,
  canRedraw,
  PREPAYMENT_RATES_PCT,
  settlementPreview,
  summarizePrepayment,
} from "./tax-prepayment.ts";

test("settlement preview shows a refund, an amount due, or exactly settled", () => {
  assert.deepEqual(settlementPreview(5000, 6500), { kind: "refund", amount: 1500 });
  assert.deepEqual(settlementPreview(5000, 4000), { kind: "due", amount: 1000 });
  assert.deepEqual(settlementPreview(5000, 5000), { kind: "settled", amount: 0 });
  assert.deepEqual(settlementPreview(0, 0), { kind: "settled", amount: 0 });
});

const cards = dataset.cards.filter((card) => card.deck === "Tax Prepayment" && card.active === "Yes");

test("all 10 Tax Prepayment card rates match the workbook and the migration", () => {
  assert.equal(cards.length, 10);
  const sql = readFileSync(new URL("../supabase/migrations/20261004080000_tax_prepayment.sql", import.meta.url), "utf8");
  for (const card of cards) {
    const id = String(card.id);
    assert.equal(PREPAYMENT_RATES_PCT[id], Math.round(Number(card.effectValue) * 100), id);
    assert.match(sql, new RegExp(`\\('${id}', ${PREPAYMENT_RATES_PCT[id]}\\)`), `${id} in migration`);
  }
});

test("prepayment rounds to whole dollars, halves up, and is zero for zero tax", () => {
  assert.equal(calculatePrepaymentDollars(1000, 40), 400);
  assert.equal(calculatePrepaymentDollars(1001, 50), 501); // 500.5 rounds up
  assert.equal(calculatePrepaymentDollars(1003, 40), 401); // 401.2 rounds down
  assert.equal(calculatePrepaymentDollars(1005, 40), 402); // 402.0
  assert.equal(calculatePrepaymentDollars(999, 105), 1049); // 1048.95
  assert.equal(calculatePrepaymentDollars(333, 130), 433); // 432.9
  assert.equal(calculatePrepaymentDollars(0, 130), 0);
  assert.equal(calculatePrepaymentDollars(5000, 0), 0);
  for (const rate of Object.values(PREPAYMENT_RATES_PCT)) {
    assert.equal(calculatePrepaymentDollars(0, rate), 0);
  }
});

test("a $5,000 calculated tax prepays the expected amounts", () => {
  assert.equal(calculatePrepaymentDollars(5000, PREPAYMENT_RATES_PCT["PRE-001"]), 2000);
  assert.equal(calculatePrepaymentDollars(5000, PREPAYMENT_RATES_PCT["PRE-005"]), 5000);
  assert.equal(calculatePrepaymentDollars(5000, PREPAYMENT_RATES_PCT["PRE-008"]), 6500);
  assert.equal(calculatePrepaymentDollars(5000, PREPAYMENT_RATES_PCT["PRE-010"]), 0);
});

test("only a Corporate Climber with a first card below 90% may redraw", () => {
  for (const [id, rate] of Object.entries(PREPAYMENT_RATES_PCT)) {
    assert.equal(canRedraw("PATH-001", rate), rate < 90, id);
    for (const other of ["PATH-002", "PATH-003", "PATH-004", "PATH-005", "PATH-006"]) {
      assert.equal(canRedraw(other, rate), false, `${other} ${id}`);
    }
  }
});

test("Tax Prepayment is one card in Round 1 and a redraw choice is accepted only for PRE cards", () => {
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-003", 1), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 1), { min: 1, max: 1 });
  assert.equal(isValidCardChoice("PRE-001", "redraw"), true);
  assert.equal(isValidCardChoice("PRE-001", null), true);
  assert.equal(isValidCardChoice("PRE-001", "keep"), false);
  assert.equal(isValidCardChoice("DED-001", "redraw"), false);
});

test("Deduction advances to Tax Prepayment and nothing advances past it", () => {
  assert.deepEqual(advanceTarget("deduction", 1), { stage: "tax-prepayment", label: "Tax Prepayment" });
  assert.equal(advanceTarget("tax-prepayment", 1), null);
  assert.equal(advanceTarget("deduction", 2), null);
});

test("migration requires a saved tax calculation and never rewrites saved tax", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261004080000_tax_prepayment.sql", import.meta.url), "utf8");
  assert.match(sql, /TAX_CALCULATION_REQUIRED/);
  assert.match(sql, /PREPAYMENT_ALREADY_FIXED/);
  assert.match(sql, /REDRAW_NOT_ALLOWED/);
  assert.doesNotMatch(sql, /update[^;]*final_tax_liability\s*=/i);
});

test("restores a provisional Climber card, a redraw and a fixed prepayment", () => {
  const provisional = summarizePrepayment({
    pathway_id: "PATH-001",
    calculated_tax: 1000,
    cards: [{ card_id: "PRE-001", order_in_stage: 1, rate_pct: 40 }],
    prepayment: null,
    redraw_eligible: true,
  });
  assert.equal(provisional?.status, "provisional");
  assert.equal(provisional?.redrawEligible, true);

  const redrawn = summarizePrepayment({
    pathway_id: "PATH-001",
    calculated_tax: 1000,
    cards: [
      { card_id: "PRE-001", order_in_stage: 1, rate_pct: 40 },
      { card_id: "PRE-002", order_in_stage: 2, rate_pct: 60 },
    ],
    prepayment: { card_id: "PRE-002", rate_pct: 60, prepaid_amount: 600, redraw_used: true, first_card_id: "PRE-001" },
    redraw_eligible: false,
  });
  assert.equal(redrawn?.status, "fixed");
  assert.equal(redrawn?.fixed?.prepaidAmount, 600);
  assert.equal(redrawn?.fixed?.firstCardId, "PRE-001");
  assert.equal(redrawn?.calculatedTax, 1000);
  assert.equal(redrawn?.cards.length, 2);

  const none = summarizePrepayment({ pathway_id: "PATH-002", calculated_tax: 500, cards: [], prepayment: null });
  assert.equal(none?.status, "none");
  assert.equal(none?.showEstimatedPaymentNote, true);
  assert.equal(summarizePrepayment({ cards: "bad" }), null);
});
