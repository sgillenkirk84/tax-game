import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import dataset from "./game-data/workbook-data.json" with { type: "json" };
import { isValidCardChoice, stageCardRules } from "./card-entry.ts";
import { advanceTarget } from "./round-stages.ts";
import { computeRoundResults } from "./round-results.ts";
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

test("PRE-006 live case restores the fixed $368 payment independently of zero final tax", () => {
  const prepaid = calculatePrepaymentDollars(350, PREPAYMENT_RATES_PCT["PRE-006"]);
  assert.equal(prepaid, 368);
  const stored = {
    round_number: 2, calculated_tax: 0, tax_before_credits: 350, credits_applied: 350,
    cards: [{ card_id: "PRE-006", rate_pct: 105 }],
    prepayment: {
      card_id: "PRE-006", rate_pct: 105, prepaid_amount: prepaid, calculated_tax: 0,
      calculation_base: "income-tax-before-credits", tax_before_credits: 350,
    },
  };
  const restored = summarizePrepayment(JSON.parse(JSON.stringify(stored)));
  assert.equal(restored?.status, "fixed");
  assert.equal(restored?.fixed?.prepaidAmount, 368);
  assert.equal(restored?.fixed?.ratePct, 105);
  assert.equal(restored?.fixed?.baseAmount, 350);
  assert.equal(restored?.creditsApplied, 350);
  assert.equal(restored?.calculatedTax, 0);
  assert.deepEqual(settlementPreview(0, restored.fixed.prepaidAmount), { kind: "refund", amount: 368 });
  const results = computeRoundResults({
    beginningCash: 0, beginningDebt: 0, grossIncome: 35000, adjustedGrossIncome: 35000,
    finalTax: restored.calculatedTax, fixedPrepayment: restored.fixed.prepaidAmount, pendingEffects: [],
  });
  assert.equal(results.taxPrepaid, 368);
  assert.equal(results.calculatedTax, 0);
  assert.equal(results.taxRefund, 368);
  assert.equal(results.taxAmountDue, 0);
});

test("save correction only renames the ambiguous local variable and preserves the RPC contract", () => {
  const read = (name: string) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const previous = read("20261005130000_precredit_tax_prepayment.sql");
  const corrected = read("20261005140000_fix_precredit_prepayment_save.sql");
  const helper = (sql: string) => {
    const start = sql.indexOf("create or replace function public.mm_fix_round_prepayment(");
    const end = sql.indexOf("\n$$;", start);
    assert.ok(start >= 0 && end > start);
    return sql.slice(start, end);
  };
  // Rename only unqualified variable identifiers, not JSON keys or qualified columns.
  const expected = helper(previous).replace(/(?<![.'\w])tax_before_credits(?!['\w])/g, "v_tax_before_credits");
  assert.equal(helper(corrected), expected);
  const update = helper(corrected).split("update public.mm_game_rounds as game_round")[1];
  assert.match(update, /'tax_before_credits', v_tax_before_credits/);
  assert.doesNotMatch(update, /(?<![.'\w])tax_before_credits(?!['\w])/);
  assert.match(corrected, /round\(v_tax_before_credits \* p_rate_pct \/ 100, 0\)/);
  assert.match(corrected, /PREPAYMENT_ALREADY_FIXED/);
  assert.match(corrected, /from public, anon, authenticated, service_role/);
  assert.doesNotMatch(corrected, /grant execute|alter table|finalize_round_results/);
  const caller = read("20261004100000_next_round.sql");
  assert.match(caller, /perform public\.mm_fix_round_prepayment\(\s*round_row\.id, history_row\.id, history_row\.card_id, catalog_row\.prepayment_rate_pct, null, false\s*\)/);
});

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

test("a $5,000 income tax before credits prepays the expected amounts", () => {
  assert.equal(calculatePrepaymentDollars(5000, PREPAYMENT_RATES_PCT["PRE-001"]), 2000);
  assert.equal(calculatePrepaymentDollars(5000, PREPAYMENT_RATES_PCT["PRE-005"]), 5000);
  assert.equal(calculatePrepaymentDollars(5000, PREPAYMENT_RATES_PCT["PRE-008"]), 6500);
  assert.equal(calculatePrepaymentDollars(5000, PREPAYMENT_RATES_PCT["PRE-010"]), 0);
});

test("new prepayment snapshot restores a positive payment and refund despite zero final tax", () => {
  for (const round of [1, 2, 3, 4, 5]) {
    const restored = summarizePrepayment({
      round_number: round, calculated_tax: 0, tax_before_credits: 1757, credits_applied: 1757,
      cards: [{ card_id: "PRE-003", rate_pct: 80 }],
      prepayment: {
        card_id: "PRE-003", rate_pct: 80, prepaid_amount: 1406, calculated_tax: 0,
        calculation_base: "income-tax-before-credits", tax_before_credits: 1757,
      },
    });
    assert.equal(restored?.taxBeforeCredits, 1757);
    assert.equal(restored?.creditsApplied, 1757);
    assert.equal(restored?.calculatedTax, 0);
    assert.equal(restored?.fixed?.baseAmount, 1757);
    assert.equal(restored?.fixed?.calculationBase, "income-tax-before-credits");
    assert.equal(restored?.fixed?.prepaidAmount, 1406);
    assert.deepEqual(settlementPreview(restored.calculatedTax, restored.fixed.prepaidAmount), { kind: "refund", amount: 1406 });
  }
});

test("legacy fixed prepayments restore unchanged instead of being recalculated", () => {
  const stored = {
    calculated_tax: 0, tax_before_credits: 1757, credits_applied: 1757,
    cards: [{ card_id: "PRE-003", rate_pct: 80 }],
    prepayment: { card_id: "PRE-003", rate_pct: 80, prepaid_amount: 0, calculated_tax: 0 },
  };
  const before = structuredClone(stored);
  const restored = summarizePrepayment(stored);
  assert.equal(restored?.fixed?.prepaidAmount, 0);
  assert.equal(restored?.fixed?.calculationBase, "legacy-final-tax");
  assert.equal(restored?.fixed?.baseAmount, 0);
  assert.deepEqual(stored, before);
  assert.equal(summarizePrepayment({
    ...stored, prepayment: { ...stored.prepayment, calculation_base: "income-tax-before-credits" },
  }), null);
});

test("global pre-credit migration preserves saved tax, historical guards and restricted access", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261005130000_precredit_tax_prepayment.sql", import.meta.url), "utf8");
  assert.match(sql, /prepaid := pg_catalog\.round\(tax_before_credits \* p_rate_pct \/ 100, 0\)/);
  assert.doesNotMatch(sql, /prepaid := pg_catalog\.round\(tax \*/);
  assert.match(sql, /tax_before_credits is distinct from round_row\.tax_before_credits/);
  assert.match(sql, /tax is distinct from round_row\.final_tax_liability/);
  assert.match(sql, /round_row\.status <> 'in_progress'/);
  assert.match(sql, /PREPAYMENT_ALREADY_FIXED/);
  assert.match(sql, /'calculated_tax', tax/);
  assert.match(sql, /'calculation_base', 'income-tax-before-credits'/);
  assert.match(sql, /'credits_applied'/);
  assert.match(sql, /security definer\s+set search_path = pg_catalog/);
  assert.match(sql, /grant execute on function public\.get_round_prepayment\(uuid, text\) to service_role/);
  assert.doesNotMatch(sql, /grant execute on function public\.mm_fix_round_prepayment/);
  assert.doesNotMatch(sql, /current_round\s*(?:=|<>|between)|round_number\s*(?:= \d|between)/);
  assert.doesNotMatch(sql, /set (?:final_tax_liability|tax_before_credits|credits_total)\s*=|alter table|insert into public\.mm_game/);
  assert.equal(dataset.gameRules.approved.taxPrepayment.calculationBase, "income-tax-before-credits");
  assert.equal(dataset.gameRules.approved.taxPrepayment.rounding, "nearest-whole-dollar-halves-up");
  for (const card of cards.filter((card) => card.id !== "PRE-010")) {
    assert.match(card.taxRule, /Income Tax Before Credits/);
  }
});

test("only a Corporate Climber with a first card below 90% may redraw", () => {
  for (const [id, rate] of Object.entries(PREPAYMENT_RATES_PCT)) {
    assert.equal(canRedraw("PATH-001", rate), rate < 90, id);
    for (const other of ["PATH-002", "PATH-003", "PATH-004", "PATH-005", "PATH-006"]) {
      assert.equal(canRedraw(other, rate), false, `${other} ${id}`);
    }
  }
});

test("Tax Prepayment is one card in Rounds 1-2 and a redraw choice is accepted only for PRE cards", () => {
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-003", 1), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 1), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-003", 2), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 2), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 3), { min: 0, max: 0 });
  assert.equal(isValidCardChoice("PRE-001", "redraw"), true);
  assert.equal(isValidCardChoice("PRE-001", null), true);
  assert.equal(isValidCardChoice("PRE-001", "keep"), false);
  assert.equal(isValidCardChoice("DED-001", "redraw"), false);
});

test("Deduction advances to Tax Prepayment, then Results (Audit is skipped), and no further", () => {
  assert.deepEqual(advanceTarget("deduction", 1), { stage: "tax-prepayment", label: "Tax Prepayment" });
  assert.deepEqual(advanceTarget("tax-prepayment", 1), {
    stage: "results-and-life-ledger",
    label: "Results and Life Ledger",
  });
  assert.equal(advanceTarget("results-and-life-ledger", 1), null);
  assert.equal(advanceTarget("tax-prepayment", 2), null);
  assert.deepEqual(advanceTarget("deduction", 2), { stage: "tax-prepayment", label: "Tax Prepayment" });
  assert.equal(advanceTarget("deduction", 3), null);
});

test("migration requires a saved tax calculation and never rewrites saved tax", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261004080000_tax_prepayment.sql", import.meta.url), "utf8");
  assert.match(sql, /TAX_CALCULATION_REQUIRED/);
  assert.match(sql, /PREPAYMENT_ALREADY_FIXED/);
  assert.match(sql, /REDRAW_NOT_ALLOWED/);
  assert.doesNotMatch(sql, /update[^;]*final_tax_liability\s*=/i);
});

test("Round 2 migration targets exactly the installed gates and preserves later-stage limits", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261005120000_round_two_tax_prepayment.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const installed = readFileSync(new URL("../supabase/migrations/20261004100000_next_round.sql", import.meta.url), "utf8");
  const prepayment = readFileSync(new URL("../supabase/migrations/20261004080000_tax_prepayment.sql", import.meta.url), "utf8");
  const extract = (source: string, name: string) => {
    const start = source.indexOf(`create or replace function public.${name}(`);
    assert.ok(start >= 0, name);
    const end = source.indexOf("\n$$;", start);
    assert.ok(end > start, name);
    return source.slice(start, end).replace(/\r\n/g, "\n");
  };
  const changes = [
    {
      name: "record_round_card", source: installed,
      old: "when life_row.current_round <> 1 then 0",
      next: "when life_row.current_round not between 1 and 2 then 0",
    },
    {
      name: "advance_round_stage", source: installed,
      old: "when 'deduction' then\n      if life_row.current_round = 1 then",
      next: "when 'deduction' then\n      if life_row.current_round between 1 and 2 then",
    },
    {
      name: "keep_round_prepayment_card", source: prepayment,
      old: "if life_row.current_round <> 1 then",
      next: "if life_row.current_round not between 1 and 2 then",
    },
  ];
  for (const change of changes) {
    const source = extract(change.source, change.name);
    assert.equal(source.split(change.old).length - 1, 1, change.name);
    assert.ok(sql.includes(change.old) && sql.includes(change.next), change.name);
    const extended = source.replace(change.old, change.next);
    assert.match(extended, /PLAYER_SETUP_NOT_AVAILABLE/);
    assert.match(extended, /NOT_CURRENT_STAGE/);
    assert.match(extended, /IDEMPOTENCY_KEY_REUSED/);
    if (change.name === "advance_round_stage") {
      assert.match(extended, /when 'tax-prepayment' then\s+if life_row.current_round = 1 then/);
      assert.match(extended, /TAX_CALCULATION_REQUIRED/);
    }
    if (change.name === "record_round_card") {
      assert.match(extended, /first_rate >= 90/);
      assert.match(extended, /PREPAYMENT_ALREADY_FIXED/);
      assert.match(extended, /public.mm_fix_round_prepayment/);
    }
  }
  assert.match(sql, /old_count <> 1/);
  assert.match(sql, /fn.prosecdef/);
  assert.match(sql, /search_path=pg_catalog/);
  assert.doesNotMatch(sql, /update public\.mm_game|insert into public\.mm_game|finalize_round_results/);
});

test("Round 2 restore uses the saved prepayment and retains both cards on a redraw", () => {
  const restored = summarizePrepayment({
    round_number: 2, pathway_id: "PATH-001", calculated_tax: 1000,
    cards: [
      { card_id: "PRE-002", order_in_stage: 1, rate_pct: 60 },
      { card_id: "PRE-002", order_in_stage: 2, rate_pct: 60 },
    ],
    prepayment: { card_id: "PRE-002", rate_pct: 60, prepaid_amount: 600, redraw_used: true, first_card_id: "PRE-002" },
  });
  assert.equal(restored?.status, "fixed");
  assert.equal(restored?.fixed?.prepaidAmount, 600);
  assert.equal(restored?.cards.length, 2);
  assert.equal(restored?.redrawEligible, false);
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
