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
