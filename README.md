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

## Round 4 Tax Prepayment (TASK 10.15.29)

The user manually installed `20261005190000_round_four_tax_calculation.sql` successfully in
TEST and Production, redeployed commit `aa66f710d272b052460619abd16df4a73544db49`,
and live-verified Round 4 through saved Tax Calculation.

This local extension opens the shared physical Tax Prepayment stage in Round 4.
Every pathway, including Early Retiree, uses the saved Income Tax Before Credits
times the authoritative card percentage with whole-dollar halves-up rounding.
Retirement components and saved tax are not recomputed. The existing $350 basis,
$350 credits, $0 calculated tax, 105% card regression still fixes $368.
Existing Corporate Climber keep/redraw and fixed-state restore remain unchanged.
After fixed Prepayment, Round 4 stops; Results/Life Ledger and Round 5 stay closed.

`supabase/migrations/20261005200000_round_four_tax_prepayment.sql` widens only
recording Prepayment, Deduction-to-Prepayment advancement, and Climber keep gates.
No formula, rate, tax, history or environment changes are made. This local migration
has not been executed or installed by this task.
At TASK 10.15.30 publication, Round 4 Tax Prepayment was locally validated but
not yet live-verified. Its subsequent live verification is recorded below.

## Round 4 Results and Life Ledger (TASK 10.15.31)

The opening transition was live-verified: Early Retiree received Retirement cards
and a regular pathway received Income cards. Round 4 through saved Tax Calculation
was live-verified after manual installation in TEST/Production and redeployment.
Tax Prepayment was subsequently published and is now publicly live-verified on
the Production Vercel deployment. At TASK 10.15.31, Round 4 Results/Life Ledger
were not yet live-verified and completion was not claimed. The subsequent
Round 4 completion is recorded below.

This local extension reuses the shared atomic finalizer and rounds-as-columns
ledger. It consumes saved tax outputs and the persisted fixed Tax Prepayment,
never rerunning retirement taxation or payment arithmetic. Settlement, progressive
AGI-based Living Costs, loan principal, household handoff, investments and effect
lifecycle are unchanged. Triggered Audit remains unresolved `bypassed-beta`,
with no adjustment or penalty.

`supabase/migrations/20261005210000_round_four_results.sql` widens only the
Tax Prepayment-to-Results advancement and shared finalization gates through Round 4.
The existing immutable `{round, cards}` snapshot and read path need no schema change.
Rounds 1-3 history is untouched. Round 5 start/gameplay remain closed.
The migration has not been executed; no environment values change.

## Round 5 opening and universal Retirement (TASK 10.15.33)

The Round 4 Results migration was manually installed successfully in TEST and
Production. The live Production game finalized Round 4, saved its Life Ledger
state, and reached the ready-for-Round-5 boundary. Round 4 is now complete.
At TASK 10.15.33, Round 5 gameplay had not yet been enabled or live-verified.
Its subsequent opening verification is recorded below.

This locally implemented opening reuses the shared next-round/recovery RPC and
card-entry flow. Every pathway draws one physical card from the Retirement deck
in Round 5. Side Hustler's two Income cards, Entrepreneur's extra Business Income
opportunity, and Corporate Climber's working-life replacement do not apply.
The saved authoritative card ID/category resolve to the unchanged workbook-backed
Retirement components; no tax calculation occurs during opening.

Finalized Round 4 cash/debt become Round 5 beginning balances. Household, pathway,
Caregiver's permanent dependent, homeowner state, investments and persistent
state remain in the same life. Only the normal new-round expiration applies to
active effects past their last round; permanent and removed effects are untouched.
Investment income is not calculated or duplicated during opening.

`supabase/migrations/20261005220000_round_five_opening.sql` widens only
`start_next_round` through Round 5 and the first-card branch of `record_round_card`.
After the Retirement card is saved/restored, play stops. Round 5 Life Event and
all later stages, including final completion/story, remain closed.
Finalized Rounds 1-4 are not rewritten.

The code-supported hard maximum becomes 5; unset/empty round limits default to 4.
Explicit lower values remain respected. A later authorized rollout must set
**both** `NEXT_PUBLIC_MAX_ENABLED_ROUND=5` and `MAX_ENABLED_ROUND=5`, after migration
installation and publication. This task changes neither environment variable,
executes no SQL, and does not commit, push or deploy.

## Round 5 through saved Tax Calculation (TASK 10.15.35)

Round 4 is complete and live-verified. The Round 5 opening migration was installed
successfully in TEST and Production, both round-limit rollout settings were
enabled, and Round 5 opened successfully in Production. Early Retiree and Caregiver
both received Retirement cards, validating continuing and newly entering retirement.
Round 5 Life Event through Tax Calculation are locally implemented/validated,
not yet live-verified.

The shared stage flow now allows Retirement -> Life Event -> Wildcard -> Deduction
-> saved Tax Calculation. All pathways use one authoritative Retirement card.
The shared protected-package calculation is reused without changing its arithmetic,
guarantee or Social Security rules. Newly retired pathways use the higher complete
card-or-$42,000 package; Early Retiree also retains its existing protected Round 4
winner through the existing helper's Round 5 rule. That prior package is read from
the immutable finalized Round 4 input snapshot, never recalculated.

Original Retirement components and the winning package remain separately saved.
Corporate Climber's working-income replacement, Entrepreneur's extra Business
card and Side Hustler's two-Income-card requirement do not apply to Retirement.
Shared household/Caregiver/homeowner, Wildcard, deduction and Tax Year 2025 rules
remain unchanged. Existing investments contribute recurring income once; new
Round 5 investments retain next-round activation metadata (6), but no Round 6
gameplay or post-game income is created. The schema already permits activation 6.
Audit triggers remain recorded and unassessed for the later beta Results milestone.

`supabase/migrations/20261005230000_round_five_tax_calculation.sql` extends the
three card-recording gates, three transitions through Deduction, and tax-save
authorization through 5. It also makes advancement/tax card counts and Climber
persistence deck-aware, and extends the authenticated tax-input reader with the
saved Early Retiree prior package. Existing signatures, restricted grants, locks,
idempotency and finalized history are preserved. No schema or history rewrite occurs.

After saved Tax Calculation, Round 5 stops. Tax Prepayment, Results/Life Ledger,
final completion and My Tax Life Story remain closed in application/database code.
Hard maximum 5, unset/empty default 4, and both rollout gates are unchanged.
This task executes no SQL and changes no environment variables; no commit,
push or deployment is performed.

TASK 10.15.36 publication history: the user manually installed
`20261005230000_round_five_tax_calculation.sql` successfully in both TEST and
Production before publication. The committed migration records that exact
validated version; it must not be reinstalled by this publication task.
Round 5 Life Event, Wildcard, Deduction and Tax Calculation remain locally
validated, not yet live/browser verified. Publication uses the normal push-triggered
Production deployment without SQL execution, environment changes or manual deployment.

## Round 5 Tax Prepayment (TASK 10.15.37)

Round 5 through saved Tax Calculation is complete and live-verified in Production
on commit `1862187fe050fdf16af8ef5015c2af17dcf9af5b`. This includes opening,
universal Retirement (including Early Retiree and Caregiver), Life Event, Wildcard,
Deduction and retirement-aware Tax Calculation. The Tax Calculation migration
`20261005230000_round_five_tax_calculation.sql` was already installed successfully
in TEST and Production. Earlier local-only verification notes above are historical.

The locally implemented next segment reuses the shared physical Tax Prepayment
card flow: saved tax -> Continue to Tax Prepayment -> select the physically drawn
card -> save/recover its fixed payment -> stop. Every pathway uses saved Income
Tax Before Credits times the authoritative card rate, with unchanged whole-dollar
halves-up rounding. Credits do not reduce this basis: $350 with $350 credits and
105% fixes $368; the saved $3,391.50 Retirement basis at 105% fixes $3,561.
No Retirement/package, Social Security, deduction, credit or tax calculation runs
again during Prepayment. All ten rates and Corporate Climber's current-round
keep/redraw decision remain unchanged. Restore consumes the saved payment,
rate, card and basis rather than recalculating them.

`supabase/migrations/20261005240000_round_five_tax_prepayment.sql` widens only
Tax Prepayment card recording, Deduction -> Tax Prepayment advancement, and
Corporate Climber's keep action from Rounds 1-4 to 1-5. It preserves existing
signatures, permissions, locks, saved-tax prerequisites and idempotency.
The shared payment helper and recovery RPC are unchanged.

Round 5 Results/finalization and final completion/My Tax Life Story stay closed.
The fixed-payment screen does not calculate a settlement preview while Results
is closed; Rounds 1-4 retain their existing preview. No settlement, Living Costs,
ending cash, Round 5 ledger snapshot or final Audit resolution is applied.
Round 6 stays unavailable, rollout defaults/limits and feature flags are unchanged,
and finalized Rounds 1-4 are not rewritten. This local task performs no SQL,
commit, push, deployment or environment change. Round 5 Tax Prepayment has not
yet been live-verified.

TASK 10.15.38 publication history: the user manually installed
`20261005240000_round_five_tax_prepayment.sql` successfully in both TEST and
Production before publication. Publication records the exact validated migration
without reinstallation, SQL execution, environment changes or manual deployment.
Round 5 Tax Prepayment remains locally validated, not yet browser/live-verified;
Results/finalization and final completion/My Tax Life Story remain closed.

## Round 5 Results and final Life Ledger (TASK 10.15.39)

Round 4 is complete and live-verified. Round 5 opening, universal Retirement,
Life Event, Wildcard, Deduction, retirement-aware Tax Calculation and Tax
Prepayment are now live-verified in Production. Tax Prepayment is published on
commit `808ed16408fd56e59abf6354aa662f18619f801c`; its migration
`20261005240000_round_five_tax_prepayment.sql` was already installed successfully
in TEST and Production. Earlier local-only notes above are historical.

The next locally implemented segment reuses the shared Results APIs,
`computeRoundResults`, atomic `finalize_round_results` and immutable `{round, cards}`
ledger snapshot: fixed Round 5 Tax Prepayment -> Results -> shared settlement,
AGI-based Living Costs and applicable financial effects -> ending state -> saved
Round 5 snapshot -> fifth Life Ledger column -> stop. Saved final Calculated Tax
and fixed Tax Prepayment are consumed, not recomputed. A $0 final tax with $368
prepaid refunds $368; $3,391.50 final tax with $3,561 prepaid refunds $169.50.
Retirement, Social Security, protected packages, deductions and credits are not
rerun. Debt, household, permanent Caregiver dependent, homeowner, assets and
effect lifecycle retain their shared behavior. Investment income is not added
again and activation-round-6 metadata does not apply future income or gameplay.
Audit remains unresolved `bypassed-beta`, with zero adjustment and penalty.

`supabase/migrations/20261005250000_round_five_results.sql` widens only
Tax Prepayment -> Results advancement and Results finalization from Rounds 1-4
to 1-5. It preserves all financial logic, snapshot structure, permissions,
credentials, locking and idempotency. No schema change or backfill is required.
Retries and refresh return saved Results instead of applying effects again;
finalized Rounds 1-4 remain immutable.

As explicitly approved, the saved finalized Round 5 snapshot is the deterministic
five-round financial-game completion boundary. The UI confirms that Results and
Life Ledger are saved and that there is no next round. Database life status
remains unchanged; this is not a new database `completed` lifecycle transition.
Existing hard maximum 5, configured rollout limits and feature flags remain in
force. My Tax Life Story, AI generation and Round 6 are not implemented/enabled.
Round 5 Results and full five-round financial completion are locally validated,
not yet live-verified. This task executes no SQL and performs no commit, push,
deployment or environment change.

TASK 10.15.40 publication history: the user manually installed
`20261005250000_round_five_results.sql` successfully in both TEST and Production
before publication. Publication records the exact validated migration already
installed; no SQL execution, reinstallation, Supabase modification, environment
change or manual deployment is performed. Round 5 Results/final Life Ledger
and full five-round financial completion remain locally validated, not yet
browser/live-verified. Finalized Round 5 remains the application completion
boundary with database life status unchanged. My Tax Life Story remains
unimplemented and Round 6 remains unavailable.
