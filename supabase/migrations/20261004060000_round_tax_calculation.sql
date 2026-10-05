-- TASK 10.10.64 — Round 1 tax-calculation foundation. PREPARED FOR REVIEW; do not install
-- until explicitly approved. Requires 20261004050000_deduction_stage.sql.
-- TASK 10.10.65 revision: save_round_tax_result accepts the pathway Income count (PATH-006 two,
-- PATH-002 one or two, others one) and compares saved card ids per stage in saved order. Install
-- 20261004070000_pathway_income_draws.sql with it so those cards can actually be saved.
--
-- Backend only. Nothing here enables Deduction -> Tax Prepayment, changes a stage,
-- finalizes a round, writes the Life Ledger, processes an audit, or touches opening cash/debt.
--
-- 1. PATH-004 starts as a homeowner: a BEFORE INSERT trigger on mm_game_lives sets it for new
--    lives (start_or_resume_round_one is NOT replaced), plus a backfill for existing Round 1
--    PATH-004 lives that have not yet saved a homeowner-changing Life Event.
-- 2. Card eligibility is enforced by a BEFORE INSERT trigger on mm_game_card_history, so
--    record_round_card (and its signature, grants and idempotency) is unchanged. Only new
--    rows are checked; existing history is never rewritten.
--      LIFE-003/007 need an unmarried player; LIFE-004 a married one; LIFE-005 a non-homeowner;
--      LIFE-009 a homeowner; LIFE-006 a removable Life Event dependent;
--      DED-003/DED-007 active homeowner status (approved cardApplicability rules).
-- 3. mm_game_operations.operation_type CHECK gains 'calculate-round-tax' (the only constraint
--    change; needed so the calculation can use the existing idempotency table).
-- 4. get_round_tax_inputs (read-only) and save_round_tax_result are granted to service_role ONLY.
--    The server computes the tax with the approved engine from authoritative history; because a
--    student must never be able to post a forged result, no anon/authenticated grant exists.
--    save_round_tax_result re-verifies credentials, life, round, stage and the exact saved card
--    IDs, sanity-checks the arithmetic, then writes the result to the in-progress round row,
--    creates WILD-007..010 investments and Life Event dependent effects (derived here from the
--    card IDs, not trusted from the caller), and records one operation.
--    WILD-004/WILD-003 cash effects and filing/homeowner changes are stored as PENDING
--    entries in calculation_details; lives, opening cash and debt are not modified.

do $preflight$
begin
  if pg_catalog.to_regclass('public.mm_game_lives') is null
     or pg_catalog.to_regclass('public.mm_game_rounds') is null
     or pg_catalog.to_regclass('public.mm_game_card_history') is null
     or pg_catalog.to_regclass('public.mm_game_operations') is null
     or pg_catalog.to_regclass('public.mm_game_investments') is null
     or pg_catalog.to_regclass('public.mm_game_effects') is null
     or pg_catalog.to_regclass('public."00_players"') is null then
    raise exception 'Required replayable-game tables are missing.';
  end if;
  if pg_catalog.to_regprocedure('public.record_round_card(uuid,text,integer,text,text,text,uuid,text)') is null
     or pg_catalog.to_regprocedure('public.advance_round_stage(uuid,text,integer,text,uuid)') is null then
    raise exception 'Migration 20261004050000 must be installed first.';
  end if;
  if (select pg_catalog.count(*)
        from pg_catalog.pg_constraint as con
       where con.conrelid = 'public.mm_game_operations'::pg_catalog.regclass
         and con.contype = 'c'
         and pg_catalog.pg_get_constraintdef(con.oid) like '%create-life%') <> 1 then
    raise exception 'Expected exactly one operation_type CHECK constraint on mm_game_operations.';
  end if;
end;
$preflight$;

-- 3. Allow the new operation type.
do $constraint$
declare
  old_name text;
begin
  select con.conname
    into old_name
    from pg_catalog.pg_constraint as con
   where con.conrelid = 'public.mm_game_operations'::pg_catalog.regclass
     and con.contype = 'c'
     and pg_catalog.pg_get_constraintdef(con.oid) like '%create-life%';

  execute pg_catalog.format('alter table public.mm_game_operations drop constraint %I', old_name);
  alter table public.mm_game_operations
    add constraint mm_game_operations_operation_type_check
    check (operation_type in (
      'create-life',
      'record-card',
      'advance-stage',
      'finalize-round',
      'complete-life',
      'calculate-round-tax'
    ));
end;
$constraint$;

-- 1. PATH-004 homeowner initialization.
create or replace function public.mm_set_pathway_starting_homeowner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.pathway_id = 'PATH-004' then
    new.homeowner := true;
  end if;
  return new;
end;
$$;

alter function public.mm_set_pathway_starting_homeowner() owner to postgres;

drop trigger if exists mm_game_lives_set_starting_homeowner on public.mm_game_lives;
create trigger mm_game_lives_set_starting_homeowner
before insert on public.mm_game_lives
for each row execute function public.mm_set_pathway_starting_homeowner();

update public.mm_game_lives as life
   set homeowner = true
 where life.pathway_id = 'PATH-004'
   and life.homeowner = false
   and life.status = 'in_progress'
   and life.current_round = 1
   and not exists (
     select 1
       from public.mm_game_card_history as history
      where history.life_id = life.id
        and history.card_id in ('LIFE-005', 'LIFE-009')
   );

-- 2. Card eligibility (new rows only).
create or replace function public.mm_enforce_card_eligibility()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  life_row public.mm_game_lives%rowtype;
  card_round smallint;
  removable_dependents integer;
  homeowner_now boolean;
begin
  if new.validation_status <> 'accepted' or new.stage not in ('life-event', 'deduction') then
    return new;
  end if;

  select life.* into life_row from public.mm_game_lives as life where life.id = new.life_id;
  select game_round.round_number into card_round
    from public.mm_game_rounds as game_round where game_round.id = new.round_id;
  if life_row.id is null or card_round is null then
    return new;
  end if;

  if new.stage = 'life-event' then
    if (new.card_id in ('LIFE-003', 'LIFE-007') and life_row.filing_status = 'MFJ')
       or (new.card_id = 'LIFE-004' and life_row.filing_status <> 'MFJ')
       or (new.card_id = 'LIFE-005' and life_row.homeowner)
       or (new.card_id = 'LIFE-009' and not life_row.homeowner) then
      raise exception using message = 'LIFE_EVENT_INELIGIBLE', errcode = '23514';
    end if;

    if new.card_id = 'LIFE-006' then
      select pg_catalog.count(*)
        into removable_dependents
        from public.mm_game_effects as effect
       where effect.life_id = new.life_id
         and effect.effect_type = 'add-dependent'
         and effect.status = 'active'
         and effect.starts_round <= card_round
         and (effect.expires_after_round is null or effect.expires_after_round >= card_round);
      if removable_dependents = 0 then
        raise exception using message = 'LIFE_EVENT_INELIGIBLE', errcode = '23514';
      end if;
    end if;
  elsif new.card_id in ('DED-003', 'DED-007') then
    homeowner_now := life_row.homeowner;
    if exists (
      select 1 from public.mm_game_card_history as history
       where history.round_id = new.round_id
         and history.stage = 'life-event'
         and history.validation_status = 'accepted'
         and history.card_id = 'LIFE-005'
    ) then
      homeowner_now := true;
    end if;
    if exists (
      select 1 from public.mm_game_card_history as history
       where history.round_id = new.round_id
         and history.stage = 'life-event'
         and history.validation_status = 'accepted'
         and history.card_id = 'LIFE-009'
    ) then
      homeowner_now := false;
    end if;
    if not homeowner_now then
      raise exception using message = 'DEDUCTION_INELIGIBLE', errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

alter function public.mm_enforce_card_eligibility() owner to postgres;

drop trigger if exists mm_game_card_history_enforce_eligibility on public.mm_game_card_history;
create trigger mm_game_card_history_enforce_eligibility
before insert on public.mm_game_card_history
for each row execute function public.mm_enforce_card_eligibility();

-- 4a. Read-only authoritative inputs.
create or replace function public.get_round_tax_inputs(
  p_player_id uuid,
  p_resume_token_hash text
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
begin
  if p_player_id is null
     or p_resume_token_hash is null
     or p_resume_token_hash !~ '^[0-9a-f]{64}$' then
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
  if not found or life_row.status <> 'in_progress' then
    raise exception using message = 'GAME_LIFE_NOT_ACTIVE', errcode = '23514';
  end if;

  select game_round.* into round_row
    from public.mm_game_rounds as game_round
   where game_round.life_id = life_row.id
     and game_round.round_number = life_row.current_round;
  if not found then
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;

  return pg_catalog.jsonb_build_object(
    'life', pg_catalog.jsonb_build_object(
      'id', life_row.id,
      'status', life_row.status,
      'pathway_id', life_row.pathway_id,
      'starting_decision_id', life_row.starting_decision_id,
      'tax_year', life_row.tax_year,
      'rules_version', life_row.rules_version,
      'current_round', life_row.current_round,
      'current_stage', life_row.current_stage,
      'filing_status', life_row.filing_status,
      'homeowner', life_row.homeowner,
      'cash_resources', life_row.cash_resources,
      'student_loan_debt', life_row.student_loan_debt
    ),
    'round', pg_catalog.jsonb_build_object(
      'id', round_row.id,
      'round_number', round_row.round_number,
      'status', round_row.status,
      'current_stage', round_row.current_stage,
      'beginning_cash_resources', round_row.beginning_cash_resources,
      'beginning_student_loan_debt', round_row.beginning_student_loan_debt,
      'calculation', round_row.calculation_details -> 'tax_calculation'
    ),
    'cards', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'history_id', history.id,
            'card_id', history.card_id,
            'stage', history.stage,
            'order_in_stage', history.order_in_stage,
            'choices', history.choices
          )
          order by history.stage, history.order_in_stage
        ),
        '[]'::jsonb
      )
        from public.mm_game_card_history as history
       where history.round_id = round_row.id
         and history.validation_status = 'accepted'
    ),
    'investments', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'source_type', investment.source_type,
            'source_card_id', investment.source_card_id,
            'acquired_round', investment.acquired_round,
            'activation_round', investment.activation_round,
            'asset_value', investment.asset_value,
            'recurring_income_per_round', investment.recurring_income_per_round,
            'status', investment.status
          )
          order by investment.created_at, investment.id
        ),
        '[]'::jsonb
      )
        from public.mm_game_investments as investment
       where investment.life_id = life_row.id
    ),
    'effects', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'source_card_id', effect.source_card_id,
            'effect_type', effect.effect_type,
            'starts_round', effect.starts_round,
            'expires_after_round', effect.expires_after_round,
            'status', effect.status,
            'details', effect.details
          )
          order by effect.created_at, effect.id
        ),
        '[]'::jsonb
      )
        from public.mm_game_effects as effect
       where effect.life_id = life_row.id
    )
  );
end;
$$;

alter function public.get_round_tax_inputs(uuid, text) owner to postgres;
revoke all on function public.get_round_tax_inputs(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_round_tax_inputs(uuid, text) to service_role;

-- 4b. Trusted persistence of a Round 1 tax result.
create or replace function public.save_round_tax_result(
  p_player_id uuid,
  p_resume_token_hash text,
  p_round_number integer,
  p_idempotency_key uuid,
  p_calculation jsonb
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
  calc_md5 text;
  saved_cards jsonb;
  saved_count integer;
  income_min integer;
  income_max integer;
  r jsonb;
  credits jsonb;
  v_gross numeric;
  v_adjustment numeric;
  v_agi numeric;
  v_deduction numeric;
  v_taxable numeric;
  v_before numeric;
  v_credits_applied numeric;
  v_final numeric;
  v_available numeric;
  v_unused numeric;
  v_category_total numeric;
  wildcard_row public.mm_game_card_history%rowtype;
  life_event_row public.mm_game_card_history%rowtype;
  investment_value numeric;
  investment_income numeric;
  dependent_category text;
  stored jsonb;
  response jsonb;
begin
  if p_player_id is null
     or p_resume_token_hash is null
     or p_resume_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;
  if p_idempotency_key is null
     or p_round_number is null
     or p_calculation is null
     or pg_catalog.jsonb_typeof(p_calculation) <> 'object'
     or pg_catalog.jsonb_typeof(p_calculation -> 'round') <> 'object'
     or pg_catalog.jsonb_typeof(p_calculation -> 'credits') <> 'object'
     or pg_catalog.jsonb_typeof(p_calculation -> 'input_snapshot') <> 'object'
     or pg_catalog.jsonb_typeof(p_calculation -> 'pending_effects') <> 'array'
     or pg_catalog.jsonb_typeof(p_calculation -> 'pending_state_changes') <> 'object'
     or pg_catalog.jsonb_typeof(p_calculation -> 'audit_trigger') <> 'object' then
    raise exception using message = 'INVALID_TAX_CALCULATION', errcode = '22023';
  end if;

  select player.* into player_row
    from public."00_players" as player
   where player.id = p_player_id
     and player.resume_token_hash = p_resume_token_hash
   for update;
  if not found then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;

  calc_md5 := pg_catalog.md5(p_calculation::text);
  fingerprint :=
    pg_catalog.md5(pg_catalog.concat_ws('|', 'calculate-round-tax', p_round_number::text, calc_md5))
    || pg_catalog.md5(pg_catalog.concat_ws('|', 'calculate-round-tax-recheck', p_round_number::text, calc_md5));

  select op.* into operation_row
    from public.mm_game_operations as op
   where op.player_id = player_row.id
     and op.idempotency_key = p_idempotency_key;
  if found then
    if operation_row.operation_type <> 'calculate-round-tax'
       or operation_row.request_fingerprint <> fingerprint
       or operation_row.response_snapshot ->> 'request_round_number' is distinct from p_round_number::text
       or operation_row.response_snapshot ->> 'request_calculation_md5' is distinct from calc_md5 then
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
     and game_round.round_number = life_row.current_round
   for update;
  if not found
     or round_row.status <> 'in_progress'
     or p_round_number <> life_row.current_round
     or round_row.current_stage <> 'deduction'
     or life_row.current_stage <> 'deduction' then
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;
  if life_row.current_round <> 1 then
    raise exception using message = 'STAGE_NOT_SUPPORTED', errcode = '0A000';
  end if;

  -- A stored calculation is returned unchanged under any new key; effects apply once.
  stored := round_row.calculation_details -> 'tax_calculation';
  if stored is not null then
    return pg_catalog.jsonb_build_object('replayed', true, 'round_number', round_row.round_number, 'calculation', stored);
  end if;

  -- The saved cards must be exactly the ones the server used, and complete for the
  -- pathway: Side Hustler two Income cards, Entrepreneur one or two, others one; one card
  -- at every other stage. Saved ids are compared per stage in saved order.
  select pg_catalog.jsonb_object_agg(per_stage.stage, per_stage.ids), pg_catalog.sum(per_stage.card_count)
    into saved_cards, saved_count
    from (
      select history.stage,
             pg_catalog.jsonb_agg(history.id order by history.order_in_stage) as ids,
             pg_catalog.count(*) as card_count
        from public.mm_game_card_history as history
       where history.round_id = round_row.id
         and history.validation_status = 'accepted'
       group by history.stage
    ) as per_stage;
  income_min := case when life_row.pathway_id = 'PATH-006' then 2 else 1 end;
  income_max := case when life_row.pathway_id in ('PATH-002', 'PATH-006') then 2 else 1 end;
  if saved_cards is null
     or saved_cards is distinct from (p_calculation -> 'input_snapshot' -> 'card_history_ids')
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(saved_cards)) <> 4
     or pg_catalog.jsonb_array_length(saved_cards -> 'income-or-retirement') not between income_min and income_max
     or pg_catalog.jsonb_array_length(saved_cards -> 'life-event') <> 1
     or pg_catalog.jsonb_array_length(saved_cards -> 'wildcard') <> 1
     or pg_catalog.jsonb_array_length(saved_cards -> 'deduction') <> 1 then
    raise exception using message = 'INCOMPLETE_ROUND', errcode = '23514';
  end if;

  r := p_calculation -> 'round';
  credits := p_calculation -> 'credits';
  v_gross := (r ->> 'gross_income')::numeric;
  v_adjustment := (r ->> 'business_income_adjustment')::numeric;
  v_agi := (r ->> 'adjusted_gross_income')::numeric;
  v_deduction := (r ->> 'deduction_amount')::numeric;
  v_taxable := (r ->> 'taxable_income')::numeric;
  v_before := (r ->> 'tax_before_credits')::numeric;
  v_credits_applied := (r ->> 'credits_total')::numeric;
  v_final := (r ->> 'final_tax_liability')::numeric;
  v_available := (credits ->> 'available')::numeric;
  v_unused := (credits ->> 'unused')::numeric;

  select coalesce(pg_catalog.sum((entry.value)::numeric), 0)
    into v_category_total
    from pg_catalog.jsonb_each_text(r -> 'income_by_category') as entry;

  if r ->> 'deduction_method' not in ('standard', 'itemized')
     or v_gross < 0 or v_adjustment < 0 or v_agi < 0 or v_deduction < 0
     or v_taxable < 0 or v_before < 0 or v_credits_applied < 0 or v_final < 0
     or v_unused < 0
     or v_category_total <> v_gross
     or v_taxable <> greatest(0, v_agi - v_deduction)
     or v_credits_applied <> least(v_available, v_before)
     or v_unused <> v_available - v_credits_applied
     or v_final <> v_before - v_credits_applied then
    raise exception using message = 'INVALID_TAX_CALCULATION', errcode = '22023';
  end if;

  update public.mm_game_rounds as game_round
     set income_by_category = r -> 'income_by_category',
         gross_income = v_gross,
         business_income_adjustment = v_adjustment,
         social_security_included = (r ->> 'social_security_included')::numeric,
         adjusted_gross_income = v_agi,
         investment_income = (r ->> 'investment_income')::numeric,
         investment_asset_value = (r ->> 'investment_asset_value')::numeric,
         deduction_method = r ->> 'deduction_method',
         standard_deduction = (r ->> 'standard_deduction')::numeric,
         eligible_itemized_deduction = (r ->> 'eligible_itemized_deduction')::numeric,
         medical_expenses = (r ->> 'medical_expenses')::numeric,
         medical_deduction = (r ->> 'medical_deduction')::numeric,
         deduction_amount = v_deduction,
         taxable_income = v_taxable,
         tax_before_credits = v_before,
         credits_total = v_credits_applied,
         credit_details = r -> 'credit_details',
         final_tax_liability = v_final,
         applied_deductions = r -> 'applied_deductions',
         input_snapshot = p_calculation -> 'input_snapshot',
         calculation_details = game_round.calculation_details || pg_catalog.jsonb_build_object(
           'tax_calculation', pg_catalog.jsonb_build_object(
             'calculated_at', pg_catalog.now(),
             'round', r,
             'credits', credits,
             'pending_effects', p_calculation -> 'pending_effects',
             'pending_state_changes', p_calculation -> 'pending_state_changes',
             'audit_trigger', p_calculation -> 'audit_trigger',
             'rules_version', life_row.rules_version
           )
         ),
         updated_at = pg_catalog.now()
   where game_round.id = round_row.id;

  -- Investments and dependent effects are derived here from the saved card IDs.
  select history.* into wildcard_row
    from public.mm_game_card_history as history
   where history.round_id = round_row.id and history.stage = 'wildcard';

  investment_value := case wildcard_row.card_id
    when 'WILD-007' then 10000
    when 'WILD-008' then 25000
    when 'WILD-009' then 50000
    when 'WILD-010' then 100000
    else null
  end;
  investment_income := case wildcard_row.card_id
    when 'WILD-007' then 500
    when 'WILD-008' then 1000
    when 'WILD-009' then 2000
    when 'WILD-010' then 4000
    else null
  end;
  if investment_value is not null then
    -- Recurring income starts the following round; there is no purchase cost.
    insert into public.mm_game_investments (
      life_id, source_type, card_history_id, investment_ordinal, source_card_id,
      acquired_round, activation_round, asset_value, recurring_income_per_round,
      retirement_resource_value, status, details
    )
    values (
      life_row.id, 'card-history', wildcard_row.id, 1, wildcard_row.card_id,
      round_row.round_number, round_row.round_number + 1, investment_value, investment_income,
      0, 'active',
      pg_catalog.jsonb_build_object('purchase_cost', 0, 'recurring_income_starts', 'following-round')
    )
    on conflict do nothing;
  end if;

  select history.* into life_event_row
    from public.mm_game_card_history as history
   where history.round_id = round_row.id and history.stage = 'life-event';

  dependent_category := case life_event_row.card_id
    when 'LIFE-001' then 'qualifying-child'
    when 'LIFE-002' then 'other-dependent'
    when 'LIFE-008' then 'other-dependent'
    when 'LIFE-010' then 'other-dependent'
    else null
  end;
  if dependent_category is not null then
    insert into public.mm_game_effects (
      life_id, card_history_id, effect_ordinal, source_card_id, effect_type,
      applied_round, starts_round, expires_after_round, status, details
    )
    values (
      life_row.id, life_event_row.id, 1, life_event_row.card_id, 'add-dependent',
      round_row.round_number, round_row.round_number,
      least(5, round_row.round_number + 1), 'active',
      pg_catalog.jsonb_build_object('category', dependent_category, 'duration_rounds', 2)
    )
    on conflict do nothing;
  end if;

  response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'round_number', round_row.round_number,
    'calculation', (
      select game_round.calculation_details -> 'tax_calculation'
        from public.mm_game_rounds as game_round
       where game_round.id = round_row.id
    )
  );

  insert into public.mm_game_operations (
    player_id, life_id, idempotency_key, operation_type, request_fingerprint, response_snapshot
  )
  values (
    player_row.id, life_row.id, p_idempotency_key, 'calculate-round-tax', fingerprint,
    pg_catalog.jsonb_build_object(
      'request_round_number', p_round_number,
      'request_calculation_md5', calc_md5,
      'response', response
    )
  );

  return response;
end;
$$;

alter function public.save_round_tax_result(uuid, text, integer, uuid, jsonb) owner to postgres;
revoke all on function public.save_round_tax_result(uuid, text, integer, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_round_tax_result(uuid, text, integer, uuid, jsonb) to service_role;
