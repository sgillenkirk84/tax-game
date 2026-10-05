# Money Moves

Money Moves is an educational financial literacy simulation game for students
and classrooms. Players explore how income, family, housing, deductions,
investments, taxes, and retirement can shape a financial journey.

## Run locally

1. Install the project dependencies with `npm.cmd install`.
2. Configure the Supabase environment variables described in
   [SUPABASE_SETUP.md](./SUPABASE_SETUP.md).
3. Start the development server:

   ```powershell
   npm.cmd run dev
   ```

4. Open <http://localhost:3000>.

## Verify before deployment

```powershell
npm.cmd run lint
npm.cmd run build
```

See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) for teacher authentication,
session storage, student registration, and deployment configuration.

## Approved household correction (TASK 10.15.05)

Newly calculated Rounds 1-3 derive filing status after current Life Events:
married households use MFJ; unmarried households with an active qualifying
dependent use HOH; other unmarried households use Single. These educational
rules establish HOH eligibility without a home-cost questionnaire, superseding
the original workbook's stricter HOH and divorce-to-Single notes.

Temporary dependents count in the round gained and the following round.
Caregiver's permanent dependent never expires and establishes household
eligibility independently of credit eligibility. Married households receive
one derived spouse source matching the primary Income card's amount and tax
classification. Corporate Climber uses its retained primary; Entrepreneur and
Side Hustler use the first saved Income card. Additional Income cards,
Wildcards, investments, retirement income, credits and deductions are not
doubled. Business adjustments apply afterward, with WILD-004 retaining one
tax-income reduction and one $5,000 cash expense.

Existing saved calculations and finalized Results/Life Ledger snapshots are
not recalculated or backfilled. Round 2/3 Results and their persistent household
handoff remain outside the current through-Tax-Calculation foundation.

## Round 2 Tax Prepayment milestone

After saved Deduction and Tax Calculation, Round 2 offers Continue to Tax
Prepayment using the existing stage-advance RPC. The student physically draws
a card, selects its matching workbook entry, and confirms it. The existing
save RPC fixes prepayment from saved Income Tax Before Credits and the catalog rate, including the
Corporate Climber's optional one-time redraw below 90%. No cash is settled at
this stage. Refresh restores the same saved card and amount.

The additive `20261005120000_round_two_tax_prepayment.sql` migration must be
reviewed and manually installed before testing the transition. Existing stage
and prepayment flags plus the enabled-round limit still apply. TASK 10.15.11
adds Round 2 Results separately; Round 3 Tax Prepayment remains closed.

## Tax Prepayment calculation base (TASK 10.15.07)

Tax Prepayment is calculated as the selected Tax Prepayment percentage of
Income Tax Before Credits, rounded to the nearest whole dollar (halves up).
Credits still reduce Calculated Tax normally; they do not reduce Tax Prepayment.
Refund/Amount Due still compares the fixed prepaid amount with final applicable
tax. For example, $1,757 before credits, $1,757 credits and an 80% card produce
$0 Calculated Tax, $1,406 Tax Prepayment and a $1,406 refund before any audit.

The function-only `20261005130000_precredit_tax_prepayment.sql` migration is
required for database-authoritative saves and the expanded read-only summary.
It must be reviewed and manually installed; no schema alteration or backfill
is needed. It applies to newly fixed prepayments in any round using the shared
helper. Already-fixed prepayments (including unfinished rounds) and finalized
Results/Life Ledger snapshots are not recalculated. Legacy fixed payments
retain an explicit previous-basis label rather than being presented as corrected.
The normalized workbook rules record this approved override; the original
workbook file and source cells remain unchanged for provenance.

### Tax Prepayment save correction (TASK 10.15.09)

`20261005140000_fix_precredit_prepayment_save.sql` replaces only the internal
helper to rename its local pre-credit variable. Previously, `tax_before_credits`
collided with the table column of the same name inside the UPDATE, producing a
PL/pgSQL ambiguous-column error under the default conflict policy and rolling
back the card save. The signature, JSON keys, security, retry behavior and
pre-credit calculation rule are unchanged. $350 before credits, $350 credits
and PRE-006 (105%) produce $368 prepaid and a $368 refund before later adjustments.
This migration needs manual review/installation; no SQL has been executed.
Existing fixed payments and finalized history are not changed.

## Round 2 Results and Life Ledger (TASK 10.15.11)

After fixed Tax Prepayment, enabled Round 2 offers Continue to Results and Life
Ledger, then an explicit Finish Round 2. The existing finalizer re-verifies saved
inputs, settles the fixed prepaid amount, applies the shared living-cost/debt
rules and saved household changes once, and creates the immutable ledger snapshot.
It never recalculates Tax Prepayment. $350 before credits, $350 credits and $368
fixed prepayment remain $0 Calculated Tax and a $368 refund.

New Results snapshots include saved deduction/tax/credit, prepayment rate, asset
and household details. The saved tax household supplies the dependent count,
including the Caregiver permanent dependent. Existing finalized snapshots are
returned unchanged, including after a later round begins.

The user-approved temporary beta exception bypasses triggered Audit resolution.
No Audit tax adjustment or penalty is invented. Triggered audits remain recorded
as unresolved in the tax snapshot and are explicitly labeled `bypassed-beta` in
new Results/Ledger snapshots and the Results screen. This is not a resolved Audit.

Review and manually install `20261005150000_round_two_results.sql` before testing.
The function-only migration extends availability to Rounds 1-2 without replacing
financial formulas or backfilling data. Existing feature flags and max-round
settings still apply. Start Round 3 is offered only from finalized Results when
Round 3 is already enabled; its existing RPC requires the prior finalized round.
Round 3 Tax Prepayment/Results and Rounds 4-5 remain outside this milestone.
No migration is executed by the application.

## Life Ledger columns (TASK 10.15.13)

The finalized Results view includes a read-only Life Ledger table: categories
are rows and Rounds 1-5 are columns. Earlier finalized rounds are restored through
the existing Results endpoint; current Results and all financial calculations
remain unchanged. Unfinished rounds and fields absent from older snapshots show
a dash, never a recalculated value. The table preserves its columns on narrow
screens inside a keyboard-focusable horizontal scroll region.

## Round 3 beta rollout (TASK 10.15.16)

Unset or empty `MAX_ENABLED_ROUND` and `NEXT_PUBLIC_MAX_ENABLED_ROUND` now default
to 3. Explicit lower limits are respected, invalid values retain the safe Round 1
fallback, and the hard maximum remains 3. No environment settings are changed.
Deployments explicitly configured below 3 must raise both existing limits
separately to offer Round 3.

Round 3 starts only after finalized Round 2 and reuses the installed shared
Income, Life Event, Wildcard and Deduction flow. Opening cash/debt come from
Round 2 ending balances; household, pathway and investments remain on the same
life. Expired temporary effects are marked expired without rewriting historical
snapshots; Round 2 dependents remain active through Round 3 and the Caregiver
permanent dependent never expires. Early Retiree still draws Income in Round 3.

The existing shared tax calculation remains available after Deduction. The
round stays at Deduction: Round 3 Tax Prepayment and Results remain closed in
the existing application/database gates. Round 4 remains unavailable. No new
formulas, database changes or migration are required.

## Round 3 Tax Prepayment (TASK 10.15.21)

Enabled Round 3 can continue from a saved Tax Calculation to the existing physical
Tax Prepayment card flow. All applicable rounds share the same pre-credit basis,
whole-dollar halves-up rounding, card rates and fixed-payment persistence.
Credits independently reduce Calculated Tax; $350 before credits, $350 credits
and PRE-006 at 105% produce $368 prepaid. Refresh restores the saved payment,
and existing idempotency protects retries. Corporate Climber keep/redraw remains
unchanged. Round 3 stops after fixed Tax Prepayment; Results/Life Ledger remain
closed, and Round 4 is not enabled.

Review and manually install `20261005160000_round_three_tax_prepayment.sql`
before live testing. It extends only three existing database availability gates;
it does not replace the shared pre-credit helper or rewrite finalized history.
No SQL is executed by the application.

Manual Production rollout history: `MAX_ENABLED_ROUND` was found still set to 2.
The user changed it to 3, verified other relevant Vercel settings and manually
redeployed Production. Round 3 then opened for the existing player, who progressed
successfully to Round 3 Tax Calculation. This task changes no environment values.

## Round 3 Results and Life Ledger (TASK 10.15.23)

Enabled Round 3 can continue from fixed Tax Prepayment to shared Results, finalize
once, and restore its immutable snapshot after refresh. The finalizer consumes
the saved fixed payment without recalculating it, settles against Calculated Tax,
and uses unchanged progressive Living Costs and capped student-loan payments.
Saved household/dependent state (including the Caregiver permanent dependent),
investments and effect lifecycle remain shared. Triggered Audit stays recorded
as `bypassed-beta`, unresolved, with no adjustment or penalty.

The accepted Life Ledger layout now fills Round 3 from its saved Results alongside
Rounds 1 and 2; unfinished Rounds 4 and 5 remain dashes. Round 4 is still closed.
Review and manually install `20261005170000_round_three_results.sql` before live
testing. It widens only the two existing Results availability gates and does not
rewrite prior snapshots. This task executes no SQL and changes no environment values.

Verified live history: Production `MAX_ENABLED_ROUND` was manually corrected
from 2 to 3 and Production redeployed; Round 3 opened and progressed through Tax
Calculation. `20261005160000_round_three_tax_prepayment.sql` was then manually
installed successfully in TEST and Production. After refresh, live Round 3 Tax
Prepayment opened; an actual physical card was selected and saved, and the tax
due/settlement amount displayed successfully.

## Round 4 opening foundation (TASK 10.15.25)

Round 3 Results and Life Ledger were finalized and live-verified after
`20261005170000_round_three_results.sql` was manually installed successfully in
TEST and Production. Rounds 1-3 saved ledger history remains intact.

The shared opening path can start/recover Round 4 only after finalized Round 3.
It inherits ending cash/debt and preserves the same household, pathway,
investments and persistent state. Existing expiration applies only to active
effects whose last active round has passed; removed effects never reappear.

Retirement timing reuses the approved workbook rule: all pathways use Income in
Rounds 1-3; Early Retiree uses Retirement in Round 4; all pathways use Retirement
in Round 5. Round 5 is not enabled. Round 4 opens only the first physical-card
stage: one Retirement card for Early Retiree, existing Income counts/rules for
other pathways. Saved card IDs retain the authoritative workbook-backed component
identity; no retirement amount is treated as wages or calculated at card save.
Existing retirement tax/package helpers remain unchanged for later integration.
No Round 4 Life Event, tax calculation, Prepayment or Results is enabled.

The user manually installed `20261005180000_round_four_opening.sql` successfully
in Supabase TEST and Production. It adds the internal shared deck helper and widens only next-round start
and first-stage card saving; it does not widen stage advancement or rewrite history.
The maximum supported opening round is 4, but unset/empty round limits still
default to 3. Explicit limits of 1, 2 or 3 remain respected. The user manually
changed Vercel `NEXT_PUBLIC_MAX_ENABLED_ROUND` to 4 and `MAX_ENABLED_ROUND` to 4
before publication. Live Round 4 verification is pending the new Production
deployment; effective deployed values have not been independently verified.
TASK 10.15.26 changes no environment values and executes no SQL.

## Round 4 through Tax Calculation (TASK 10.15.27)

The opening foundation is now live-verified in Production: Early Retiree used
Retirement, Caregiver used Income, and both stopped before Life Event.

This local extension reuses the shared Life Event, Wildcard, Deduction and tax
engine through Round 4. After the saved tax calculation, the player stays at
Deduction with a Tax Prepayment coming-soon notice. Round 4 Tax Prepayment,
Results/Life Ledger and all Round 5 gameplay remain closed.

Early Retiree resolves the saved Retirement card from the authoritative workbook,
preserves its original components in the input snapshot, and uses the existing
protected-package rule (higher of the $42,000 guarantee and the complete card
package). The shared 2025 engine applies Social Security treatment to the winning
component mix; nothing is relabeled W-2. A married player retains MFJ without
doubling retirement income. Existing recurring investments are added once per
investment event; a new investment's income still begins the following round.

`supabase/migrations/20261005190000_round_four_tax_calculation.sql` widens only
the three card-recording gates, transitions leading to Deduction, and tax saving.
It preserves saved-calculation replay, security, household/effect persistence and
all later-stage gates. It has not been executed or installed by this task.
No environment variables, workbook values, tax formulas or finalized history change.

The mocked browser walkthrough did not complete because API interception was
ineffective. No browser E2E success is claimed; this is a validation limitation,
not a demonstrated game failure. Production verification of this extended flow
remains pending manual migration installation and live testing.
