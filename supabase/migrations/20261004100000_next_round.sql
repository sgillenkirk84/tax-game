-- TASK 10.15.02 ? Reusable Round 2 and Round 3 engine through Tax Calculation.
-- Additive migration; not executed by the application and not installed automatically.
-- Requires 20261004090000_round_results.sql. Changes:
-- 1. start_next_round (service_role only): starts or resumes Round 2 or 3. The previous round must be
--    finalized; the new round opens with the previous round's ending cash and student-loan debt;
--    active effects whose expires_after_round has passed are marked expired; repeats return the
--    existing round. Rounds above 3 are rejected.
-- 2. get_current_round_state (anon, token verified, read only): the current round's state row.
-- 3. record_round_card and advance_round_stage are replaced: Income, Life Event and Wildcard
--    work in Rounds 1 to 3 and Deduction cards in Rounds 1 to 3 (the Deduction -> Tax Prepayment
--    advance and everything after it stay Round 1 only). Signatures, owner and grants unchanged.
-- 4. get_round_tax_inputs adds the retained Corporate Climber primary card id; save_round_tax_result
--    accepts Rounds 1 to 3 and persists that card id in mm_game_lives.persistent_state.
-- 5. A one-time backfill sets the Corporate Climber primary for Round 1 calculations saved earlier.
-- No table, constraint or trigger is changed. Audit schema is untouched.

do $preflight$
begin
  if pg_catalog.to_regprocedure('public.finalize_round_results(uuid,text,integer,uuid,jsonb)') is null then
    raise exception 'Round Results migration 20261004090000 must be installed first.';
  end if;
  if pg_catalog.to_regclass('public.mm_game_lives') is null
     or pg_catalog.to_regclass('public.mm_game_rounds') is null
     or pg_catalog.to_regclass('public.mm_game_effects') is null then
    raise exception 'Required game tables are missing.';
  end if;
end;
$preflight$;

create or replace function public.start_next_round(
  p_player_id uuid,
  p_resume_token_hash text,
  p_round_number integer
)
returns table (
  game_life_id uuid,
  game_round_id uuid,
  pathway_id text,
  starting_decision_id text,
  life_status text,
  life_current_round smallint,
  life_current_stage text,
  round_status text,
  round_current_stage text,
  beginning_cash_resources numeric,
  beginning_student_loan_debt numeric,
  cash_resources numeric,
  student_loan_debt numeric,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  player_row public."00_players"%rowtype;
  life_row public.mm_game_lives%rowtype;
  previous_round public.mm_game_rounds%rowtype;
  round_row public.mm_game_rounds%rowtype;
  was_replayed boolean := false;
begin
  if p_player_id is null
     or p_resume_token_hash is null
     or p_resume_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;
  if p_round_number is null or p_round_number not between 2 and 3 then
    raise exception using message = 'STAGE_NOT_SUPPORTED', errcode = '0A000';
  end if;

  select player.* into player_row
    from public."00_players" as player
   where player.id = p_player_id
     and player.resume_token_hash = p_resume_token_hash
   for update;
  if not found then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
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

  if life_row.current_round = p_round_number then
    -- Already started: a retry or refresh returns the existing round and changes nothing.
    select game_round.* into round_row
      from public.mm_game_rounds as game_round
     where game_round.life_id = life_row.id
       and game_round.round_number = p_round_number;
    if not found then
      raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
    end if;
    was_replayed := true;
  elsif life_row.current_round = p_round_number - 1 then
    select game_round.* into previous_round
      from public.mm_game_rounds as game_round
     where game_round.life_id = life_row.id
       and game_round.round_number = life_row.current_round
     for update;
    if not found or previous_round.status <> 'finalized' then
      raise exception using message = 'PREVIOUS_ROUND_NOT_FINALIZED', errcode = '23514';
    end if;

    -- The round trigger requires the life to already be on the new round number.
    update public.mm_game_lives
       set current_round = p_round_number,
           current_stage = 'income-or-retirement',
           version = version + 1,
           updated_at = pg_catalog.now()
     where id = life_row.id
    returning * into life_row;

    -- Effects past their last active round expire once; removed effects are untouched.
    update public.mm_game_effects as effect
       set status = 'expired'
     where effect.life_id = life_row.id
       and effect.status = 'active'
       and effect.expires_after_round is not null
       and effect.expires_after_round < p_round_number;

    insert into public.mm_game_rounds (
      life_id,
      round_number,
      beginning_cash_resources,
      beginning_student_loan_debt
    )
    values (
      life_row.id,
      p_round_number,
      previous_round.ending_cash_resources,
      previous_round.ending_student_loan_debt
    )
    returning * into round_row;
  else
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;

  return query
  select
    life_row.id,
    round_row.id,
    life_row.pathway_id,
    life_row.starting_decision_id,
    life_row.status,
    life_row.current_round,
    life_row.current_stage,
    round_row.status,
    round_row.current_stage,
    round_row.beginning_cash_resources,
    round_row.beginning_student_loan_debt,
    life_row.cash_resources,
    life_row.student_loan_debt,
    was_replayed;
end;
$$;

alter function public.start_next_round(uuid, text, integer) owner to postgres;
revoke all on function public.start_next_round(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.start_next_round(uuid, text, integer) to service_role;

create or replace function public.get_current_round_state(
  p_player_id uuid,
  p_resume_token_hash text
)
returns table (
  game_life_id uuid,
  game_round_id uuid,
  pathway_id text,
  starting_decision_id text,
  life_status text,
  life_current_round smallint,
  life_current_stage text,
  round_status text,
  round_current_stage text,
  beginning_cash_resources numeric,
  beginning_student_loan_debt numeric,
  cash_resources numeric,
  student_loan_debt numeric
)
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

  return query
  select
    life_row.id,
    round_row.id,
    life_row.pathway_id,
    life_row.starting_decision_id,
    life_row.status,
    life_row.current_round,
    life_row.current_stage,
    round_row.status,
    round_row.current_stage,
    round_row.beginning_cash_resources,
    round_row.beginning_student_loan_debt,
    life_row.cash_resources,
    life_row.student_loan_debt;
end;
$$;

alter function public.get_current_round_state(uuid, text) owner to postgres;
revoke all on function public.get_current_round_state(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_current_round_state(uuid, text) to anon;

create or replace function public.record_round_card(
  p_player_id uuid,
  p_resume_token_hash text,
  p_round_number integer,
  p_stage text,
  p_expected_deck text,
  p_card_id text,
  p_idempotency_key uuid,
  p_choice text default null
)
returns table (
  card_history_id uuid,
  card_id text,
  deck text,
  stage text,
  round_number smallint,
  order_in_stage smallint,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  normalized_card_id text;
  player_row public."00_players"%rowtype;
  life_row public.mm_game_lives%rowtype;
  round_row public.mm_game_rounds%rowtype;
  catalog_row public.mm_card_catalog%rowtype;
  operation_row public.mm_game_operations%rowtype;
  history_row public.mm_game_card_history%rowtype;
  fingerprint text;
  required_deck text;
  stage_card_limit integer;
  saved_count integer;
  choice_json jsonb := '{}'::jsonb;
  first_card_id text;
  first_rate smallint;
begin
  if p_player_id is null
     or p_resume_token_hash is null
     or p_resume_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;

  normalized_card_id := pg_catalog.upper(pg_catalog.btrim(coalesce(p_card_id, '')));
  if p_idempotency_key is null
     or p_round_number is null
     or p_stage is null
     or p_expected_deck is null
     or normalized_card_id !~ '^[A-Z0-9][A-Z0-9-]{1,38}[A-Z0-9]$' then
    raise exception using message = 'INVALID_CARD_REQUEST', errcode = '22023';
  end if;

  -- Locking the verified player serializes every save for that student.
  select player.*
    into player_row
    from public."00_players" as player
   where player.id = p_player_id
     and player.resume_token_hash = p_resume_token_hash
   for update;

  if not found then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;

  -- The operations schema requires 64 hex characters; exact request fields
  -- are also stored and compared below, so this fingerprint is not an auth check.
  fingerprint :=
    pg_catalog.md5(pg_catalog.concat_ws('|', 'record-card', p_round_number::text, p_stage, p_expected_deck, normalized_card_id, p_choice))
    || pg_catalog.md5(pg_catalog.concat_ws('|', 'record-card-recheck', p_round_number::text, p_stage, p_expected_deck, normalized_card_id, p_choice));

  select op.*
    into operation_row
    from public.mm_game_operations as op
   where op.player_id = player_row.id
     and op.idempotency_key = p_idempotency_key;

  if found then
    if operation_row.operation_type <> 'record-card'
       or operation_row.request_fingerprint <> fingerprint then
      raise exception using message = 'IDEMPOTENCY_KEY_REUSED', errcode = '23505';
    end if;
    if operation_row.response_snapshot ->> 'request_round_number' is distinct from p_round_number::text
       or operation_row.response_snapshot ->> 'request_stage' is distinct from p_stage
       or operation_row.response_snapshot ->> 'request_expected_deck' is distinct from p_expected_deck
       or operation_row.response_snapshot ->> 'request_card_id' is distinct from normalized_card_id
       or operation_row.response_snapshot ->> 'request_choice' is distinct from p_choice then
      raise exception using message = 'IDEMPOTENCY_KEY_REUSED', errcode = '23505';
    end if;

    return query
    select
      (operation_row.response_snapshot ->> 'card_history_id')::uuid,
      operation_row.response_snapshot ->> 'card_id',
      operation_row.response_snapshot ->> 'deck',
      operation_row.response_snapshot ->> 'stage',
      (operation_row.response_snapshot ->> 'round_number')::smallint,
      (operation_row.response_snapshot ->> 'order_in_stage')::smallint,
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

  if not found
     or round_row.status <> 'in_progress'
     or p_round_number <> life_row.current_round
     or p_stage <> round_row.current_stage
     or p_stage <> life_row.current_stage then
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;

  -- Stage rules. Round 1 Income/Retirement, Life Event, Wildcard and Deduction are open for saving;
  -- extend this CASE as other stages are approved.
  case p_stage
    when 'income-or-retirement' then
      required_deck :=
        case when life_row.pathway_id = 'PATH-008' and life_row.current_round >= 4
          then 'Retirement' else 'Income' end;
      stage_card_limit := case
        when life_row.current_round not between 1 and 3 then 0
        when life_row.pathway_id in ('PATH-002', 'PATH-006') then 2
        else 1
      end;
    when 'life-event' then
      required_deck := 'Life Event';
      stage_card_limit := case when life_row.current_round between 1 and 3 then 1 else 0 end;
    when 'wildcard' then
      required_deck := 'Wildcard';
      stage_card_limit := case when life_row.current_round between 1 and 3 then 1 else 0 end;
    when 'deduction' then
      required_deck := 'Deduction';
      stage_card_limit := case when life_row.current_round between 1 and 3 then 1 else 0 end;
    when 'tax-prepayment' then
      required_deck := 'Tax Prepayment';
      -- Corporate Climber may save a second card, but only through the approved redraw below.
      stage_card_limit := case
        when life_row.current_round <> 1 then 0
        when life_row.pathway_id = 'PATH-001' then 2
        else 1
      end;
    else
      required_deck := null;
      stage_card_limit := 0;
  end case;

  if stage_card_limit = 0 then
    raise exception using message = 'STAGE_NOT_SUPPORTED', errcode = '0A000';
  end if;

  if p_expected_deck <> required_deck then
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;

  select catalog.*
    into catalog_row
    from public.mm_card_catalog as catalog
   where catalog.card_id = normalized_card_id
     and catalog.active;

  if not found then
    raise exception using message = 'CARD_NOT_FOUND', errcode = '23514';
  end if;
  if catalog_row.deck <> required_deck or catalog_row.stage <> p_stage then
    raise exception using message = 'CARD_WRONG_DECK', errcode = '23514';
  end if;

  -- Card-specific choices. Only WILD-004 needs one; any other card rejects it.
  if normalized_card_id = 'WILD-004' then
    if p_choice is null or p_choice not in ('business', 'personal') then
      raise exception using message = 'INVALID_CHOICE', errcode = '22023';
    end if;
    choice_json := pg_catalog.jsonb_build_object('expense_type', p_choice);
  elsif p_choice is not null and not (p_stage = 'tax-prepayment' and p_choice = 'redraw') then
    raise exception using message = 'INVALID_CHOICE', errcode = '22023';
  end if;

  select pg_catalog.count(*)
    into saved_count
    from public.mm_game_card_history as history
   where history.round_id = round_row.id
     and history.stage = p_stage;

  if p_stage = 'tax-prepayment' then
    if round_row.calculation_details -> 'tax_calculation' is null then
      raise exception using message = 'TAX_CALCULATION_REQUIRED', errcode = '23514';
    end if;
    -- Once the prepayment is fixed, no card may be added or changed.
    if round_row.calculation_details -> 'tax_prepayment' is not null then
      raise exception using message = 'PREPAYMENT_ALREADY_FIXED', errcode = '23514';
    end if;
    if saved_count = 0 then
      if p_choice is not null then
        raise exception using message = 'INVALID_CHOICE', errcode = '22023';
      end if;
    elsif saved_count = 1 then
      select history.card_id, catalog.prepayment_rate_pct
        into first_card_id, first_rate
        from public.mm_game_card_history as history
        join public.mm_card_catalog as catalog on catalog.card_id = history.card_id
       where history.round_id = round_row.id
         and history.stage = p_stage
         and history.order_in_stage = 1;
      -- A second card is only the optional Corporate Climber redraw after a first rate below 90%.
      if life_row.pathway_id <> 'PATH-001'
         or p_choice is distinct from 'redraw'
         or first_rate is null
         or first_rate >= 90 then
        raise exception using message = 'REDRAW_NOT_ALLOWED', errcode = '23514';
      end if;
      choice_json := pg_catalog.jsonb_build_object('prepayment_decision', 'redraw');
    end if;
  end if;

  -- Physical decks recycle cards, so the same card ID may be saved again as a
  -- new row; only the per-stage count is limited.
  if saved_count >= stage_card_limit then
    raise exception using message = 'STAGE_CARD_LIMIT_REACHED', errcode = '23514';
  end if;

  -- Entrepreneur's additional draw is kept only if it is Business Income.
  if p_stage = 'income-or-retirement'
     and life_row.pathway_id = 'PATH-002'
     and saved_count >= 1
     and normalized_card_id not like 'INC-BIZ-%' then
    raise exception using message = 'ADDITIONAL_INCOME_NOT_BUSINESS', errcode = '23514';
  end if;

  insert into public.mm_game_card_history (
    life_id,
    round_id,
    card_id,
    stage,
    order_in_stage,
    idempotency_key,
    validation_status,
    validation_result,
    choices
  )
  values (
    life_row.id,
    round_row.id,
    catalog_row.card_id,
    p_stage,
    saved_count + 1,
    p_idempotency_key,
    'accepted',
    pg_catalog.jsonb_build_object('catalog_deck', catalog_row.deck, 'catalog_stage', catalog_row.stage),
    choice_json
  )
  returning * into history_row;

  -- The final card fixes the prepayment in this same transaction. A Corporate Climber's first
  -- card below 90% stays provisional until the student keeps it or redraws.
  if p_stage = 'tax-prepayment' then
    if saved_count = 1 then
      perform public.mm_fix_round_prepayment(
        round_row.id, history_row.id, history_row.card_id, catalog_row.prepayment_rate_pct, first_card_id, true
      );
    elsif not (life_row.pathway_id = 'PATH-001' and catalog_row.prepayment_rate_pct < 90) then
      perform public.mm_fix_round_prepayment(
        round_row.id, history_row.id, history_row.card_id, catalog_row.prepayment_rate_pct, null, false
      );
    end if;
  end if;

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
    'record-card',
    fingerprint,
    pg_catalog.jsonb_build_object(
      'request_round_number', p_round_number,
      'request_stage', p_stage,
      'request_expected_deck', p_expected_deck,
      'request_card_id', normalized_card_id,
      'request_choice', p_choice,
      'card_history_id', history_row.id,
      'card_id', history_row.card_id,
      'deck', catalog_row.deck,
      'stage', history_row.stage,
      'round_number', round_row.round_number,
      'order_in_stage', history_row.order_in_stage
    )
  );

  return query
  select
    history_row.id,
    history_row.card_id,
    catalog_row.deck,
    history_row.stage,
    round_row.round_number,
    history_row.order_in_stage,
    false;
end;
$$;

alter function public.record_round_card(uuid, text, integer, text, text, text, uuid, text) owner to postgres;
revoke all on function public.record_round_card(uuid, text, integer, text, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_round_card(uuid, text, integer, text, text, text, uuid, text) to anon;

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
      if life_row.current_round between 1 and 3 then
        next_stage := 'life-event';
        minimum_cards := case when life_row.pathway_id = 'PATH-006' then 2 else 1 end;
      end if;
    when 'life-event' then
      if life_row.current_round between 1 and 3 then
        next_stage := 'wildcard';
        minimum_cards := 1;
      end if;
    when 'wildcard' then
      if life_row.current_round between 1 and 3 then
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
      'student_loan_debt', life_row.student_loan_debt,
      'corporate_climber_primary', life_row.persistent_state -> 'corporate_climber_primary'
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
  climber jsonb;
  climber_card text;
  climber_established integer;
  prior_climber_card text;
  income_card_ids text[];
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
  if life_row.current_round not between 1 and 3 then
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
             'persistent_updates', coalesce(p_calculation -> 'persistent_updates', '{}'::jsonb),
             'audit_trigger', p_calculation -> 'audit_trigger',
             'rules_version', life_row.rules_version
           )
         ),
         updated_at = pg_catalog.now()
   where game_round.id = round_row.id;

  -- Corporate Climber: persist the retained primary Income card (card id only). It must be this
  -- round's saved Income card or the card already retained; amounts are never stored or trusted.
  if life_row.pathway_id = 'PATH-001' then
    climber := p_calculation #> '{persistent_updates,corporate_climber_primary}';
    if climber is null
       or pg_catalog.jsonb_typeof(climber) <> 'object'
       or pg_catalog.jsonb_typeof(climber -> 'card_id') <> 'string'
       or pg_catalog.jsonb_typeof(climber -> 'established_round') <> 'number' then
      raise exception using message = 'INVALID_TAX_CALCULATION', errcode = '22023';
    end if;
    climber_card := climber ->> 'card_id';
    climber_established := (climber ->> 'established_round')::integer;
    prior_climber_card := life_row.persistent_state -> 'corporate_climber_primary' ->> 'card_id';
    select pg_catalog.array_agg(history.card_id)
      into income_card_ids
      from public.mm_game_card_history as history
     where history.round_id = round_row.id
       and history.stage = 'income-or-retirement'
       and history.validation_status = 'accepted';
    if climber_established not between 1 and round_row.round_number
       or not (climber_card = any (coalesce(income_card_ids, array[]::text[]))
               or climber_card is not distinct from prior_climber_card) then
      raise exception using message = 'INVALID_TAX_CALCULATION', errcode = '22023';
    end if;
    update public.mm_game_lives
       set persistent_state = persistent_state || pg_catalog.jsonb_build_object(
             'corporate_climber_primary',
             pg_catalog.jsonb_build_object('card_id', climber_card, 'established_round', climber_established)
           ),
           version = version + 1,
           updated_at = pg_catalog.now()
     where id = life_row.id;
  end if;

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

-- One-time backfill: Corporate Climber lives that already saved a Round 1 calculation keep that
-- Round 1 Income card as the retained primary. Lives that already have a value are not touched.
update public.mm_game_lives as life
   set persistent_state = life.persistent_state || pg_catalog.jsonb_build_object(
         'corporate_climber_primary',
         pg_catalog.jsonb_build_object('card_id', history.card_id, 'established_round', 1)
       ),
       version = life.version + 1,
       updated_at = pg_catalog.now()
  from public.mm_game_rounds as game_round
  join public.mm_game_card_history as history
    on history.round_id = game_round.id
   and history.stage = 'income-or-retirement'
   and history.validation_status = 'accepted'
 where life.pathway_id = 'PATH-001'
   and game_round.life_id = life.id
   and game_round.round_number = 1
   and game_round.calculation_details ? 'tax_calculation'
   and not (life.persistent_state ? 'corporate_climber_primary');
