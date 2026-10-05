-- TASK 10.14.02 — Round 1 Results + Life Ledger finalization. PREPARED FOR REVIEW; NOT installed in
-- TEST or production. Requires 20261004080000_tax_prepayment.sql.
--
-- Audit is intentionally omitted: Tax Prepayment now advances directly to Results and Life Ledger.
-- The Audit stage value and schema are untouched and remain available for later work.
--
-- 1. advance_round_stage is replaced: identical to the 20261004080000 version plus Round 1
--    Tax Prepayment -> results-and-life-ledger, allowed only once the prepayment is fixed
--    (PREPAYMENT_REQUIRED). Signature, ownership and grants are unchanged.
-- 2. finalize_round_results (service_role only) atomically and idempotently finalizes Round 1. It
--    locks player -> life -> round, re-derives every amount from saved round data, compares the
--    route-supplied figures with its own, writes the settlement and ending balances, applies the
--    saved filing/homeowner changes, marks a LIFE-006 dependent removed, updates the life's cash
--    and debt, inserts the Life Ledger snapshot in its enforced {round, cards} shape and records
--    one 'finalize-round' operation. A finalized round is returned unchanged under any new key.
--    Ending cash = beginning cash + gross income + other cash inflows - living costs - personal
--    expenses - fixed Tax Prepayment + tax refund - tax amount due - audit penalty (0 here)
--    - student-loan principal payment (least($4,000, beginning debt)).
-- 3. get_round_results (service_role only, read-only) returns the stored Results of a finalized
--    round, or the saved inputs the server needs to finalize an eligible round.
-- No tables, constraints or other functions are changed. Round 2 is not started.

do $preflight$
begin
  if pg_catalog.to_regclass('public.mm_game_lives') is null
     or pg_catalog.to_regclass('public.mm_game_rounds') is null
     or pg_catalog.to_regclass('public.mm_game_card_history') is null
     or pg_catalog.to_regclass('public.mm_game_operations') is null
     or pg_catalog.to_regclass('public.mm_game_effects') is null
     or pg_catalog.to_regclass('public.mm_game_life_ledger') is null
     or pg_catalog.to_regclass('public."00_players"') is null then
    raise exception 'Required replayable-game tables are missing.';
  end if;
  if pg_catalog.to_regprocedure('public.keep_round_prepayment_card(uuid,text,integer,uuid)') is null
     or pg_catalog.to_regprocedure('public.get_round_prepayment(uuid,text)') is null then
    raise exception 'Migration 20261004080000 must be installed first.';
  end if;
  if (select pg_catalog.count(*)
        from pg_catalog.pg_constraint as con
       where con.conrelid = 'public.mm_game_operations'::pg_catalog.regclass
         and con.contype = 'c'
         and pg_catalog.pg_get_constraintdef(con.oid) like '%finalize-round%') <> 1 then
    raise exception 'Expected exactly one operation_type CHECK allowing finalize-round.';
  end if;
end;
$preflight$;

-- 1. advance_round_stage (adds Tax Prepayment -> Results and Life Ledger).
create or replace function public.advance_round_stage(
  p_player_id uuid,
  p_resume_token_hash text,
  p_round_number integer,
  p_from_stage text,
  p_idempotency_key uuid
)
returns table (
  result_round_number smallint,
  result_from_stage text,
  result_current_stage text,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  player_row public."00_players"%rowtype;
  life_row public.mm_game_lives%rowtype;
  round_row public.mm_game_rounds%rowtype;
  operation_row public.mm_game_operations%rowtype;
  fingerprint text;
  next_stage text;
  minimum_cards integer;
  saved_count integer;
begin
  if p_player_id is null
     or p_resume_token_hash is null
     or p_resume_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;

  if p_idempotency_key is null or p_round_number is null or p_from_stage is null then
    raise exception using message = 'INVALID_STAGE_REQUEST', errcode = '22023';
  end if;

  -- Locking the verified player serializes every save and advance for that student.
  select player.*
    into player_row
    from public."00_players" as player
   where player.id = p_player_id
     and player.resume_token_hash = p_resume_token_hash
   for update;

  if not found then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;

  -- The operations schema requires 64 hex characters; the exact request fields
  -- are also stored and compared below, so this fingerprint is not an auth check.
  fingerprint :=
    pg_catalog.md5(pg_catalog.concat_ws('|', 'advance-stage', p_round_number::text, p_from_stage))
    || pg_catalog.md5(pg_catalog.concat_ws('|', 'advance-stage-recheck', p_round_number::text, p_from_stage));

  select op.*
    into operation_row
    from public.mm_game_operations as op
   where op.player_id = player_row.id
     and op.idempotency_key = p_idempotency_key;

  if found then
    if operation_row.operation_type <> 'advance-stage'
       or operation_row.request_fingerprint <> fingerprint
       or operation_row.response_snapshot ->> 'request_round_number' is distinct from p_round_number::text
       or operation_row.response_snapshot ->> 'request_from_stage' is distinct from p_from_stage then
      raise exception using message = 'IDEMPOTENCY_KEY_REUSED', errcode = '23505';
    end if;

    return query
    select
      (operation_row.response_snapshot ->> 'round_number')::smallint,
      operation_row.response_snapshot ->> 'from_stage',
      operation_row.response_snapshot ->> 'to_stage',
      true;
    return;
  end if;

  select life.*
    into life_row
    from public.mm_game_lives as life
   where life.player_id = player_row.id
   order by life.life_number desc
   limit 1
   for update;

  if not found or life_row.status <> 'in_progress' then
    raise exception using message = 'GAME_LIFE_NOT_ACTIVE', errcode = '23514';
  end if;

  select game_round.*
    into round_row
    from public.mm_game_rounds as game_round
   where game_round.life_id = life_row.id
     and game_round.round_number = life_row.current_round
   for update;

  -- A repeat with a new key after a successful advance fails here: the stage
  -- is no longer p_from_stage. The next stage is never supplied by the browser.
  if not found
     or round_row.status <> 'in_progress'
     or p_round_number <> life_row.current_round
     or p_from_stage <> round_row.current_stage
     or p_from_stage <> life_row.current_stage then
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;

  -- Approved transitions and minimum saved cards. Extend as stages are approved.
  case p_from_stage
    when 'income-or-retirement' then
      if life_row.current_round = 1 then
        next_stage := 'life-event';
        minimum_cards := case when life_row.pathway_id = 'PATH-006' then 2 else 1 end;
      end if;
    when 'life-event' then
      if life_row.current_round = 1 then
        next_stage := 'wildcard';
        minimum_cards := 1;
      end if;
    when 'wildcard' then
      if life_row.current_round = 1 then
        next_stage := 'deduction';
        minimum_cards := 1;
      end if;
    when 'deduction' then
      if life_row.current_round = 1 then
        next_stage := 'tax-prepayment';
        minimum_cards := 1;
      end if;
    when 'tax-prepayment' then
      if life_row.current_round = 1 then
        next_stage := 'results-and-life-ledger';
        minimum_cards := 1;
      end if;
    else
      null;
  end case;

  if next_stage is null then
    raise exception using message = 'STAGE_NOT_SUPPORTED', errcode = '0A000';
  end if;

  select pg_catalog.count(*)
    into saved_count
    from public.mm_game_card_history as history
   where history.round_id = round_row.id
     and history.stage = p_from_stage;

  if saved_count < minimum_cards then
    raise exception using message = 'STAGE_CARDS_INCOMPLETE', errcode = '23514';
  end if;

  -- Tax Prepayment opens only after the tax calculation has been saved.
  if p_from_stage = 'deduction'
     and round_row.calculation_details -> 'tax_calculation' is null then
    raise exception using message = 'TAX_CALCULATION_REQUIRED', errcode = '23514';
  end if;

  -- Results opens only after the Tax Prepayment is fixed. Audit is skipped for now.
  if p_from_stage = 'tax-prepayment'
     and round_row.calculation_details -> 'tax_prepayment' is null then
    raise exception using message = 'PREPAYMENT_REQUIRED', errcode = '23514';
  end if;

  update public.mm_game_rounds
     set current_stage = next_stage,
         updated_at = pg_catalog.now()
   where id = round_row.id;

  update public.mm_game_lives
     set current_stage = next_stage,
         version = version + 1,
         updated_at = pg_catalog.now()
   where id = life_row.id;

  insert into public.mm_game_operations (
    player_id,
    life_id,
    idempotency_key,
    operation_type,
    request_fingerprint,
    response_snapshot
  )
  values (
    player_row.id,
    life_row.id,
    p_idempotency_key,
    'advance-stage',
    fingerprint,
    pg_catalog.jsonb_build_object(
      'request_round_number', p_round_number,
      'request_from_stage', p_from_stage,
      'round_number', round_row.round_number,
      'from_stage', p_from_stage,
      'to_stage', next_stage
    )
  );

  return query
  select round_row.round_number, p_from_stage, next_stage, false;
end;
$$;

alter function public.advance_round_stage(uuid, text, integer, text, uuid) owner to postgres;
revoke all on function public.advance_round_stage(uuid, text, integer, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.advance_round_stage(uuid, text, integer, text, uuid) to anon;

-- 2. Atomic, idempotent Round finalization.
create or replace function public.finalize_round_results(
  p_player_id uuid,
  p_resume_token_hash text,
  p_round_number integer,
  p_idempotency_key uuid,
  p_results jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  player_row public."00_players"%rowtype;
  life_row public.mm_game_lives%rowtype;
  round_row public.mm_game_rounds%rowtype;
  operation_row public.mm_game_operations%rowtype;
  fingerprint text;
  results_md5 text;
  tax jsonb;
  pending jsonb;
  v_gross numeric;
  v_agi numeric;
  v_final numeric;
  v_prepaid numeric;
  v_other numeric;
  v_personal numeric;
  v_business_reduction numeric;
  v_living numeric;
  v_refund numeric;
  v_due numeric;
  v_loan numeric;
  v_ending_debt numeric;
  v_ending_cash numeric;
  v_filing text;
  v_homeowner boolean;
  v_finalized_at timestamptz;
  v_dependents integer;
  v_removed_effect uuid;
  v_cards jsonb;
  v_results jsonb;
  response jsonb;
begin
  if p_player_id is null
     or p_resume_token_hash is null
     or p_resume_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;
  if p_idempotency_key is null
     or p_round_number is null
     or p_results is null
     or pg_catalog.jsonb_typeof(p_results) <> 'object' then
    raise exception using message = 'INVALID_RESULTS', errcode = '22023';
  end if;

  select player.* into player_row
    from public."00_players" as player
   where player.id = p_player_id
     and player.resume_token_hash = p_resume_token_hash
   for update;
  if not found then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;

  results_md5 := pg_catalog.md5(p_results::text);
  fingerprint :=
    pg_catalog.md5(pg_catalog.concat_ws('|', 'finalize-round', p_round_number::text, results_md5))
    || pg_catalog.md5(pg_catalog.concat_ws('|', 'finalize-round-recheck', p_round_number::text, results_md5));

  select op.* into operation_row
    from public.mm_game_operations as op
   where op.player_id = player_row.id
     and op.idempotency_key = p_idempotency_key;
  if found then
    if operation_row.operation_type <> 'finalize-round'
       or operation_row.request_fingerprint <> fingerprint
       or operation_row.response_snapshot ->> 'request_round_number' is distinct from p_round_number::text
       or operation_row.response_snapshot ->> 'request_results_md5' is distinct from results_md5 then
      raise exception using message = 'IDEMPOTENCY_KEY_REUSED', errcode = '23505';
    end if;
    return (operation_row.response_snapshot -> 'response') || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select life.* into life_row
    from public.mm_game_lives as life
   where life.player_id = player_row.id
   order by life.life_number desc
   limit 1
   for update;
  if not found or life_row.status <> 'in_progress' then
    raise exception using message = 'GAME_LIFE_NOT_ACTIVE', errcode = '23514';
  end if;

  select game_round.* into round_row
    from public.mm_game_rounds as game_round
   where game_round.life_id = life_row.id
     and game_round.round_number = p_round_number
   for update;
  if not found then
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('stage', history.stage, 'card_id', history.card_id)
             order by case history.stage
                        when 'income-or-retirement' then 1
                        when 'life-event' then 2
                        when 'wildcard' then 3
                        when 'deduction' then 4
                        when 'tax-prepayment' then 5
                        else 6
                      end,
                      history.order_in_stage
           ),
           '[]'::jsonb
         )
    into v_cards
    from public.mm_game_card_history as history
   where history.round_id = round_row.id
     and history.validation_status = 'accepted';

  -- A finalized round is returned as saved, never changed again, under any new key.
  if round_row.status = 'finalized' then
    return pg_catalog.jsonb_build_object(
      'finalized', true,
      'replayed', true,
      'round_number', round_row.round_number,
      'results', round_row.calculation_details -> 'results',
      'cards', v_cards
    );
  end if;

  if p_round_number <> life_row.current_round
     or round_row.current_stage <> 'results-and-life-ledger'
     or life_row.current_stage <> 'results-and-life-ledger' then
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;
  if life_row.current_round <> 1 then
    raise exception using message = 'STAGE_NOT_SUPPORTED', errcode = '0A000';
  end if;

  tax := round_row.calculation_details -> 'tax_calculation';
  if tax is null then
    raise exception using message = 'TAX_CALCULATION_REQUIRED', errcode = '23514';
  end if;
  if round_row.calculation_details -> 'tax_prepayment' is null then
    raise exception using message = 'PREPAYMENT_REQUIRED', errcode = '23514';
  end if;

  v_final := round_row.final_tax_liability;
  v_prepaid := round_row.fixed_tax_prepayment;
  if (tax -> 'round' ->> 'final_tax_liability')::numeric is distinct from v_final
     or (round_row.calculation_details -> 'tax_prepayment' ->> 'calculated_tax')::numeric is distinct from v_final
     or (round_row.calculation_details -> 'tax_prepayment' ->> 'prepaid_amount')::numeric is distinct from v_prepaid then
    raise exception using message = 'INVALID_RESULTS', errcode = '22023';
  end if;

  -- Round 1 opens with the life's own balances; anything else means it was already applied.
  if life_row.cash_resources is distinct from round_row.beginning_cash_resources
     or life_row.student_loan_debt is distinct from round_row.beginning_student_loan_debt then
    raise exception using message = 'INCONSISTENT_ROUND_STATE', errcode = '23514';
  end if;

  v_gross := round_row.gross_income;
  v_agi := round_row.adjusted_gross_income;
  pending := tax -> 'pending_effects';
  if pending is null or pg_catalog.jsonb_typeof(pending) <> 'array' then
    raise exception using message = 'INVALID_RESULTS', errcode = '22023';
  end if;

  select coalesce(pg_catalog.sum((t.e ->> 'cash_delta')::numeric)
           filter (where t.e ->> 'source_card_id' = 'WILD-003' and t.e ->> 'type' = 'cash-increase'), 0),
         coalesce(pg_catalog.sum(-(t.e ->> 'cash_delta')::numeric)
           filter (where t.e ->> 'source_card_id' = 'WILD-004' and t.e ->> 'type' = 'cash-expense'), 0),
         coalesce(pg_catalog.sum(coalesce((t.e ->> 'business_income_reduction')::numeric, 0))
           filter (where t.e ->> 'source_card_id' = 'WILD-004' and t.e ->> 'type' = 'cash-expense'), 0)
    into v_other, v_personal, v_business_reduction
    from pg_catalog.jsonb_array_elements(pending) as t(e);
  if v_other < 0 or v_personal < 0 or v_business_reduction < 0 or v_business_reduction > v_personal then
    raise exception using message = 'INVALID_RESULTS', errcode = '22023';
  end if;
  -- The saved gross income is already reduced by WILD-004's tax-only business
  -- treatment. Cash reconciliation uses the actual income, so add it back; the
  -- $5,000 expense is then charged exactly once.
  v_gross := v_gross + v_business_reduction;

  -- Approved progressive living-cost bands, applied to AGI.
  v_living :=
      pg_catalog.round(least(v_agi, 30000) * 0.85, 2)
    + pg_catalog.round(greatest(0, least(v_agi, 50000) - 30000) * 0.55, 2)
    + pg_catalog.round(greatest(0, least(v_agi, 75000) - 50000) * 0.45, 2)
    + pg_catalog.round(greatest(0, least(v_agi, 100000) - 75000) * 0.35, 2)
    + pg_catalog.round(greatest(0, v_agi - 100000) * 0.25, 2);

  v_refund := greatest(0, v_prepaid - v_final);
  v_due := greatest(0, v_final - v_prepaid);
  v_loan := least(4000, round_row.beginning_student_loan_debt);
  v_ending_debt := round_row.beginning_student_loan_debt - v_loan;
  v_ending_cash :=
      round_row.beginning_cash_resources + v_gross + v_other
    - v_living - v_personal - v_prepaid + v_refund - v_due - v_loan;

  if (p_results ->> 'other_cash_inflows')::numeric is distinct from v_other
     or (p_results ->> 'living_costs')::numeric is distinct from v_living
     or (p_results ->> 'personal_expenses')::numeric is distinct from v_personal
     or (p_results ->> 'tax_refund')::numeric is distinct from v_refund
     or (p_results ->> 'tax_amount_due')::numeric is distinct from v_due
     or (p_results ->> 'audit_penalty')::numeric is distinct from 0
     or (p_results ->> 'student_loan_payment')::numeric is distinct from v_loan
     or (p_results ->> 'ending_student_loan_debt')::numeric is distinct from v_ending_debt
     or (p_results ->> 'ending_cash')::numeric is distinct from v_ending_cash then
    raise exception using message = 'RESULTS_MISMATCH', errcode = '22023';
  end if;

  v_filing := coalesce(tax -> 'pending_state_changes' ->> 'filing_status', life_row.filing_status);
  v_homeowner := coalesce((tax -> 'pending_state_changes' ->> 'homeowner')::boolean, life_row.homeowner);
  if v_filing not in ('SINGLE', 'MFJ', 'HOH') then
    raise exception using message = 'INVALID_RESULTS', errcode = '22023';
  end if;

  -- LIFE-006 removed the first active Life Event dependent for tax purposes; persist that
  -- removal on the same (earliest) effect so Round 2 does not see the dependent.
  if exists (
    select 1
      from public.mm_game_card_history as history
     where history.round_id = round_row.id
       and history.stage = 'life-event'
       and history.card_id = 'LIFE-006'
       and history.validation_status = 'accepted'
  ) then
    select effect.id into v_removed_effect
      from public.mm_game_effects as effect
     where effect.life_id = life_row.id
       and effect.effect_type = 'add-dependent'
       and effect.status = 'active'
       and effect.starts_round <= round_row.round_number
       and (effect.expires_after_round is null or effect.expires_after_round >= round_row.round_number)
     order by effect.created_at, effect.id
     limit 1
     for update;
    if v_removed_effect is null then
      raise exception using message = 'INVALID_RESULTS', errcode = '22023';
    end if;
    update public.mm_game_effects set status = 'removed' where id = v_removed_effect;
  end if;

  select pg_catalog.count(*) into v_dependents
    from public.mm_game_effects as effect
   where effect.life_id = life_row.id
     and effect.effect_type = 'add-dependent'
     and effect.status = 'active'
     and effect.starts_round <= round_row.round_number
     and (effect.expires_after_round is null or effect.expires_after_round >= round_row.round_number);

  v_finalized_at := pg_catalog.now();
  v_results := pg_catalog.jsonb_build_object(
    'version', 1,
    'pathway_id', life_row.pathway_id,
    'scenario_id', life_row.starting_decision_id,
    'beginning_cash', round_row.beginning_cash_resources,
    'gross_income', v_gross,
    'adjusted_gross_income', v_agi,
    'other_cash_inflows', v_other,
    'living_costs', v_living,
    'personal_expenses', v_personal,
    'calculated_tax', v_final,
    'tax_prepaid', v_prepaid,
    'tax_refund', v_refund,
    'tax_amount_due', v_due,
    'audit_penalty', 0,
    'beginning_student_loan_debt', round_row.beginning_student_loan_debt,
    'student_loan_payment', v_loan,
    'ending_student_loan_debt', v_ending_debt,
    'ending_cash', v_ending_cash,
    'filing_status', v_filing,
    'homeowner', v_homeowner,
    'active_dependents', v_dependents
  );

  update public.mm_game_rounds
     set tax_refund = v_refund,
         tax_amount_due = v_due,
         audit_adjustment_income = 0,
         audit_penalty = 0,
         living_costs = v_living,
         personal_expenses = v_personal,
         student_loan_payment = v_loan,
         ending_cash_resources = v_ending_cash,
         ending_student_loan_debt = v_ending_debt,
         calculation_details = calculation_details || pg_catalog.jsonb_build_object('results', v_results),
         status = 'finalized',
         finalized_at = v_finalized_at,
         updated_at = v_finalized_at
   where id = round_row.id;

  -- The ledger trigger requires the life's balances to match the round's ending values.
  update public.mm_game_lives
     set filing_status = v_filing,
         homeowner = v_homeowner,
         cash_resources = v_ending_cash,
         student_loan_debt = v_ending_debt,
         version = version + 1,
         updated_at = v_finalized_at
   where id = life_row.id;

  select game_round.* into round_row
    from public.mm_game_rounds as game_round
   where game_round.id = round_row.id;

  insert into public.mm_game_life_ledger (
    life_id, round_id, player_id, session_id, round_number, snapshot, finalized_at
  )
  values (
    life_row.id, round_row.id, life_row.player_id, life_row.session_id, round_row.round_number,
    pg_catalog.jsonb_build_object(
      'round', pg_catalog.to_jsonb(round_row),
      'cards', (
        select coalesce(
                 pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ch) order by ch.stage, ch.order_in_stage),
                 '[]'::jsonb
               )
          from public.mm_game_card_history as ch
         where ch.round_id = round_row.id
           and ch.life_id = life_row.id
      )
    ),
    v_finalized_at
  );

  response := pg_catalog.jsonb_build_object(
    'finalized', true,
    'replayed', false,
    'round_number', round_row.round_number,
    'results', v_results,
    'cards', v_cards
  );

  insert into public.mm_game_operations (
    player_id, life_id, idempotency_key, operation_type, request_fingerprint, response_snapshot
  )
  values (
    player_row.id, life_row.id, p_idempotency_key, 'finalize-round', fingerprint,
    pg_catalog.jsonb_build_object(
      'request_round_number', p_round_number,
      'request_results_md5', results_md5,
      'response', response
    )
  );

  return response;
end;
$$;

alter function public.finalize_round_results(uuid, text, integer, uuid, jsonb) owner to postgres;
revoke all on function public.finalize_round_results(uuid, text, integer, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_round_results(uuid, text, integer, uuid, jsonb) to service_role;

-- 3. Read-only Results restore and finalization inputs.
create or replace function public.get_round_results(
  p_player_id uuid,
  p_resume_token_hash text,
  p_round_number integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  player_row public."00_players"%rowtype;
  life_row public.mm_game_lives%rowtype;
  round_row public.mm_game_rounds%rowtype;
  v_cards jsonb;
begin
  if p_player_id is null
     or p_resume_token_hash is null
     or p_resume_token_hash !~ '^[0-9a-f]{64}$'
     or p_round_number is null then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;

  select player.* into player_row
    from public."00_players" as player
   where player.id = p_player_id
     and player.resume_token_hash = p_resume_token_hash;
  if not found then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;

  select life.* into life_row
    from public.mm_game_lives as life
   where life.player_id = player_row.id
   order by life.life_number desc
   limit 1;
  if not found then
    raise exception using message = 'GAME_LIFE_NOT_ACTIVE', errcode = '23514';
  end if;

  select game_round.* into round_row
    from public.mm_game_rounds as game_round
   where game_round.life_id = life_row.id
     and game_round.round_number = p_round_number;
  if not found then
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('stage', history.stage, 'card_id', history.card_id)
             order by case history.stage
                        when 'income-or-retirement' then 1
                        when 'life-event' then 2
                        when 'wildcard' then 3
                        when 'deduction' then 4
                        when 'tax-prepayment' then 5
                        else 6
                      end,
                      history.order_in_stage
           ),
           '[]'::jsonb
         )
    into v_cards
    from public.mm_game_card_history as history
   where history.round_id = round_row.id
     and history.validation_status = 'accepted';

  if round_row.status = 'finalized' then
    return pg_catalog.jsonb_build_object(
      'finalized', true,
      'round_number', round_row.round_number,
      'results', round_row.calculation_details -> 'results',
      'cards', v_cards
    );
  end if;

  if round_row.current_stage <> 'results-and-life-ledger'
     or round_row.calculation_details -> 'tax_calculation' is null
     or round_row.calculation_details -> 'tax_prepayment' is null then
    return pg_catalog.jsonb_build_object(
      'finalized', false,
      'round_number', round_row.round_number,
      'current_stage', round_row.current_stage,
      'inputs', null
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'finalized', false,
    'round_number', round_row.round_number,
    'current_stage', round_row.current_stage,
    'inputs', pg_catalog.jsonb_build_object(
      'beginning_cash', round_row.beginning_cash_resources,
      'beginning_student_loan_debt', round_row.beginning_student_loan_debt,
      'gross_income', round_row.gross_income + coalesce((
        select pg_catalog.sum(coalesce((t.e ->> 'business_income_reduction')::numeric, 0))
          from pg_catalog.jsonb_array_elements(
            round_row.calculation_details -> 'tax_calculation' -> 'pending_effects') as t(e)
         where t.e ->> 'source_card_id' = 'WILD-004' and t.e ->> 'type' = 'cash-expense'), 0),
      'adjusted_gross_income', round_row.adjusted_gross_income,
      'final_tax_liability', round_row.final_tax_liability,
      'fixed_tax_prepayment', round_row.fixed_tax_prepayment,
      'pending_effects', round_row.calculation_details -> 'tax_calculation' -> 'pending_effects'
    )
  );
end;
$$;

alter function public.get_round_results(uuid, text, integer) owner to postgres;
revoke all on function public.get_round_results(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_round_results(uuid, text, integer) to service_role;
