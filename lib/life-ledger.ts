import type { StoredResults } from "./round-results";

export const LEDGER_ROUNDS = [1, 2, 3, 4, 5] as const;

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const missing = "\u2014";
const filingLabels: Record<string, string> = {
  SINGLE: "Single",
  MFJ: "Married filing jointly",
  HOH: "Head of household",
  single: "Single",
  married_filing_jointly: "Married filing jointly",
  head_of_household: "Head of household",
  married_filing_separately: "Married filing separately",
};

type LedgerCategory = { label: string; value: (result: StoredResults) => string };

const categories: LedgerCategory[] = [
  { label: "Beginning cash/resources", value: (r) => money(r.beginningCash) },
  { label: "Gross income", value: (r) => money(r.grossIncome) },
  { label: "Adjusted gross income", value: (r) => r.details ? money(r.details.adjustedGrossIncome) : missing },
  { label: "Filing status", value: (r) => filingLabels[r.filingStatus] ?? r.filingStatus },
  { label: "Active dependents", value: (r) => String(r.activeDependents) },
  { label: "Homeowner", value: (r) => r.homeowner ? "Yes" : "No" },
  { label: "Deduction used", value: (r) => r.details ? `${money(r.details.deductionAmount)} (${r.details.deductionMethod})` : missing },
  { label: "Taxable income", value: (r) => r.details ? money(r.details.taxableIncome) : missing },
  { label: "Income Tax Before Credits", value: (r) => r.details ? money(r.details.taxBeforeCredits) : missing },
  { label: "Tax credits applied", value: (r) => r.details ? money(r.details.creditsApplied) : missing },
  { label: "Calculated tax after credits", value: (r) => money(r.calculatedTax) },
  { label: "Tax Prepayment percentage", value: (r) => r.details ? `${r.details.prepaymentRatePct}%` : missing },
  { label: "Tax you prepaid", value: (r) => money(r.taxPrepaid) },
  { label: "Tax refund", value: (r) => money(r.taxRefund) },
  { label: "Tax amount due", value: (r) => money(r.taxAmountDue) },
  { label: "Living costs", value: (r) => money(r.livingCosts) },
  { label: "Other cash inflows", value: (r) => money(r.otherCashInflows) },
  { label: "Personal expenses", value: (r) => money(r.personalExpenses) },
  { label: "Student-loan payment", value: (r) => money(r.studentLoanPayment) },
  { label: "Ending cash/resources", value: (r) => money(r.endingCash) },
  { label: "Student-loan debt", value: (r) => money(r.endingDebt) },
  { label: "Investment income", value: (r) => r.details ? money(r.details.investmentIncome) : missing },
  { label: "Investment asset value", value: (r) => r.details ? money(r.details.investmentAssetValue) : missing },
  { label: "Audit penalty", value: (r) => r.details ? money(r.details.auditPenalty) : missing },
  { label: "Audit resolution", value: (r) => r.details ? r.details.auditResolution === "bypassed-beta" ? "bypassed-beta (temporary; unresolved)" : "Not triggered" : missing },
];

export function lifeLedgerRows(results: readonly StoredResults[]) {
  const byRound = new Map(results.map((result) => [result.roundNumber, result]));
  return categories.map(({ label, value }) => ({
    label,
    values: LEDGER_ROUNDS.map((round) => {
      const result = byRound.get(round);
      return result ? value(result) : missing;
    }),
  }));
}

export async function loadEarlierLedgerRounds(
  player: { id: string; resumeToken: string },
  currentRound: number,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<StoredResults[]> {
  return Promise.all(LEDGER_ROUNDS.filter((round) => round < currentRound).map(async (round) => {
    const response = await request("/api/rounds/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...player, round }),
      signal,
    });
    const body = await response.json() as { finalized?: boolean; results?: StoredResults; error?: string };
    if (!response.ok || !body.finalized || !body.results || body.results.roundNumber !== round) {
      throw new Error(body.error ?? `Could not load Life Ledger Round ${round}.`);
    }
    return body.results;
  }));
}
