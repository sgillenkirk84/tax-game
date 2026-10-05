import assert from "node:assert/strict";
import test from "node:test";
import { asTaxSummary, interpretTaxResponse, summarizeTaxCalculation } from "./tax-summary.ts";

const stored = {
  calculated_at: "2026-01-01T00:00:00Z",
  round: {
    gross_income: 50000,
    adjusted_gross_income: 50000,
    deduction_method: "itemized",
    standard_deduction: 15000,
    eligible_itemized_deduction: 24000,
    deduction_amount: 24000,
    taxable_income: 26000,
    tax_before_credits: 2800,
    final_tax_liability: 2300,
    input_snapshot_marker: "internal",
  },
  credits: { available: 700, applied: 500, unused: 200 },
  pending_effects: [{ secret: true }],
};

test("summarizes a stored calculation without internal details", () => {
  const summary = summarizeTaxCalculation(stored);
  assert.ok(summary);
  assert.equal(summary.deductionMethod, "itemized");
  assert.equal(summary.creditsApplied, 500);
  assert.equal(summary.finalTax, 2300);
  assert.deepEqual(Object.keys(summary).sort(), Object.keys(asTaxSummary(summary) ?? {}).sort());
  assert.equal(JSON.stringify(summary).includes("secret"), false);
  assert.equal(JSON.stringify(summary).includes("internal"), false);
});

test("rejects missing or malformed stored results", () => {
  assert.equal(summarizeTaxCalculation(null), null);
  assert.equal(summarizeTaxCalculation({ round: { ...stored.round, deduction_method: "other" }, credits: stored.credits }), null);
  assert.equal(summarizeTaxCalculation({ round: { ...stored.round, final_tax_liability: "5" }, credits: stored.credits }), null);
  assert.equal(asTaxSummary({ deductionMethod: "standard" }), null);
});

test("maps responses to friendly states and retry-key behaviour", () => {
  const summary = summarizeTaxCalculation(stored);
  assert.equal(interpretTaxResponse(200, { summary }).kind, "success");
  const unavailable = interpretTaxResponse(404, { error: "raw" });
  assert.equal(unavailable.kind, "unavailable");
  const notReady = interpretTaxResponse(422, { error: "DED-003 raw database text" });
  assert.equal(notReady.kind, "error");
  assert.equal(notReady.kind === "error" && notReady.keepKey, false);
  const failed = interpretTaxResponse(500, { error: "relation mm_game_rounds raw" });
  assert.equal(failed.kind === "error" && failed.keepKey, true);
  for (const outcome of [unavailable, notReady, failed]) {
    assert.equal("message" in outcome && /raw|DED-|mm_game/.test(outcome.message), false);
  }
  assert.equal(interpretTaxResponse(200, { summary: { finalTax: 1 } }).kind, "error");
});
