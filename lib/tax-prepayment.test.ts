import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import dataset from "./game-data/workbook-data.json" with { type: "json" };
import { isValidCardChoice, stageCardRules } from "./card-entry.ts";
import { advanceTarget } from "./round-stages.ts";
import { computeRoundResults, resultsAvailableForRound } from "./round-results.ts";
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

test("Tax Prepayment is one card in Rounds 1-3 and a redraw choice is accepted only for PRE cards", () => {
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-003", 1), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 1), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-003", 2), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 2), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 3), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-003", 3), { min: 1, max: 1 });
  assert.deepEqual(stageCardRules("tax-prepayment", "PATH-001", 4), { min: 0, max: 0 });
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
  assert.deepEqual(advanceTarget("tax-prepayment", 2), { stage: "results-and-life-ledger", label: "Results and Life Ledger" });
  assert.deepEqual(advanceTarget("deduction", 2), { stage: "tax-prepayment", label: "Tax Prepayment" });
  assert.deepEqual(advanceTarget("deduction", 3), { stage: "tax-prepayment", label: "Tax Prepayment" });
  assert.deepEqual(advanceTarget("tax-prepayment", 3), { stage: "results-and-life-ledger", label: "Results and Life Ledger" });
});

test("Round 3 shares all pre-credit card rates and restores fixed payments without mutating history", () => {
  const expected: Record<string, number> = {
    "PRE-001": 140, "PRE-002": 210, "PRE-003": 280, "PRE-004": 315,
    "PRE-005": 350, "PRE-006": 368, "PRE-007": 403, "PRE-008": 455,
    "PRE-009": 350, "PRE-010": 0,
  };
  for (const card of cards) {
    const id = String(card.id);
    const rate = PREPAYMENT_RATES_PCT[id];
    const fixed = calculatePrepaymentDollars(350, rate);
    assert.equal(fixed, expected[id]);
    const stored = {
      round_number: 3, pathway_id: "PATH-003", calculated_tax: 0,
      tax_before_credits: 350, credits_applied: 350,
      cards: [{ card_id: id, rate_pct: rate }],
      prepayment: {
        card_id: id, rate_pct: rate, prepaid_amount: fixed, calculated_tax: 0,
        calculation_base: "income-tax-before-credits", tax_before_credits: 350,
        card_history_id: "saved-history", redraw_used: false, first_card_id: null,
      },
    };
    const before = structuredClone(stored);
    const restored = summarizePrepayment(JSON.parse(JSON.stringify(stored)));
    assert.equal(restored?.fixed?.cardId, id);
    assert.equal(restored?.fixed?.ratePct, rate);
    assert.equal(restored?.fixed?.baseAmount, 350);
    assert.equal(restored?.fixed?.prepaidAmount, expected[id]);
    assert.equal(restored?.calculatedTax, 0);
    assert.equal(restored?.creditsApplied, 350);
    assert.equal(restored?.status, "fixed");
    assert.deepEqual(settlementPreview(0, fixed), { kind: fixed > 0 ? "refund" : "settled", amount: fixed });
    assert.deepEqual(summarizePrepayment(stored), restored);
    assert.deepEqual(stored, before);
  }
  assert.equal(resultsAvailableForRound(3, 3), true);
  assert.equal(resultsAvailableForRound(4, 3), false);
});

test("Round 3 gate migration extends exact installed definitions without touching shared formulas or Results", () => {
  const read = (name: string) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const extract = (source: string, name: string) => {
    const start = source.indexOf(`create or replace function public.${name}(`);
    const end = source.indexOf("\n$$;", start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end);
  };
  const next = read("20261004100000_next_round.sql");
  const prepayment = read("20261004080000_tax_prepayment.sql");
  const definitions = new Map([
    ["public.record_round_card(uuid,text,integer,text,text,text,uuid,text)", extract(next, "record_round_card")],
    ["public.advance_round_stage(uuid,text,integer,text,uuid)", extract(next, "advance_round_stage")],
    ["public.keep_round_prepayment_card(uuid,text,integer,uuid)", extract(prepayment, "keep_round_prepayment_card")],
    ["public.finalize_round_results(uuid,text,integer,uuid,jsonb)", extract(read("20261004090000_round_results.sql"), "finalize_round_results")],
  ]);
  const patch = (sql: string, count: number) => {
    const changes = [...sql.matchAll(/\(\s*'([^']+)',\s*(?:\$old\$([\s\S]*?)\$old\$|'([^']*)'),\s*(?:\$new\$([\s\S]*?)\$new\$|'([^']*)')\s*\)/g)];
    assert.equal(changes.length, count);
    for (const [, signature, oldBlock, oldString, newBlock, newString] of changes) {
      const source = definitions.get(signature);
      assert.ok(source, signature);
      const oldText = oldBlock ?? oldString;
      assert.equal(source.split(oldText).length - 1, 1, signature);
      definitions.set(signature, source.replace(oldText, newBlock ?? newString));
    }
  };
  patch(read("20261005120000_round_two_tax_prepayment.sql"), 3);
  patch(read("20261005150000_round_two_results.sql"), 6);
  const previous = new Map(definitions);
  const sql = read("20261005160000_round_three_tax_prepayment.sql");
  patch(sql, 3);
  const record = definitions.get("public.record_round_card(uuid,text,integer,text,text,text,uuid,text)")!;
  const advance = definitions.get("public.advance_round_stage(uuid,text,integer,text,uuid)")!;
  const keep = definitions.get("public.keep_round_prepayment_card(uuid,text,integer,uuid)")!;
  assert.equal(record, previous.get("public.record_round_card(uuid,text,integer,text,text,text,uuid,text)")!.replace("when life_row.current_round not between 1 and 2 then 0", "when life_row.current_round not between 1 and 3 then 0"));
  assert.match(advance, /when 'deduction' then\s+if life_row.current_round between 1 and 3 then/);
  assert.match(advance, /p_from_stage = 'deduction'[\s\S]*TAX_CALCULATION_REQUIRED/);
  assert.match(advance, /when 'tax-prepayment' then\s+if life_row.current_round between 1 and 2 then/);
  for (const source of [record, advance, keep]) {
    assert.match(source, /PLAYER_SETUP_NOT_AVAILABLE/);
    assert.match(source, /NOT_CURRENT_STAGE/);
    assert.match(source, /for update/);
    assert.match(source, /IDEMPOTENCY_KEY_REUSED/);
  }
  assert.ok(record.indexOf("if found then") < record.indexOf("insert into public.mm_game_card_history"));
  assert.match(record, /TAX_CALCULATION_REQUIRED/);
  assert.match(record, /PREPAYMENT_ALREADY_FIXED/);
  assert.match(record, /catalog_row\.prepayment_rate_pct/);
  assert.match(record, /first_rate >= 90/);
  assert.match(record, /perform public\.mm_fix_round_prepayment/);
  assert.match(keep, /if life_row.current_round not between 1 and 3 then/);
  assert.match(keep, /public\.mm_fix_round_prepayment/);
  const helper = read("20261005140000_fix_precredit_prepayment_save.sql");
  assert.match(helper, /round\(v_tax_before_credits \* p_rate_pct \/ 100, 0\)/);
  assert.doesNotMatch(helper, /current_round|round_number/);
  assert.equal(definitions.get("public.finalize_round_results(uuid,text,integer,uuid,jsonb)"), previous.get("public.finalize_round_results(uuid,text,integer,uuid,jsonb)"));
  assert.match(sql, /old_count <> 1/);
  assert.match(sql, /fn.prosecdef/);
  assert.match(sql, /search_path=pg_catalog/);
  assert.doesNotMatch(sql, /alter table|update public\.mm_game|insert into public\.mm_game|mm_fix_round_prepayment|finalize_round_results|rate_pct/);
});

test("Round 3 UI requires saved tax and fixed physical Prepayment before offering Results", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const dashboard = read("../components/round-dashboard.tsx");
  assert.match(dashboard, /taxCalculated && prepaymentEnabled && round <= 3/);
  assert.match(dashboard, /prepaymentFixed && resultsEnabled && advanceEnabled && target/);
  assert.match(dashboard, /round >= 2 && round <= 3 && prepaymentFixed && \(!resultsEnabled \|\| !advanceEnabled\)/);
  const ui = read("../components/tax-prepayment.tsx");
  assert.match(ui, /<CardEntry[\s\S]*stage="tax-prepayment"/);
  assert.match(ui, /physically draw/);
  assert.doesNotMatch(ui, /Math\.random|calculatePrepaymentDollars|round === 3/);
  const entry = read("../components/card-entry.tsx");
  assert.match(entry, /idempotencyKey/);
  assert.doesNotMatch(entry, /Math\.random/);
  for (const route of ["prepayment", "prepayment-keep"]) {
    assert.match(read(`../app/api/rounds/${route}/route.ts`), /serverRoundEnabled\(body.round\).*body.round > 3/);
  }
  for (const route of ["results", "results-finalize"]) {
    assert.match(read(`../app/api/rounds/${route}/route.ts`), /resultsAvailableForRound\(body.round, serverMaxEnabledRound\(\)\)/);
  }
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
