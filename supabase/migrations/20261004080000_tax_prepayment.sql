-- TASK 10.12.02 — Round 1 Tax Prepayment. PREPARED FOR REVIEW; run manually in Supabase TEST
-- first. Do not install in production until TEST results are reported and approved.
-- Requires 20261004060000_round_tax_calculation.sql (and everything before it); install order is
-- this file last: ... 070000, 060000, 080000.
--
-- What changes (no existing rows are modified):
--   1. mm_card_catalog gains prepayment_rate_pct, set only for PRE-001..PRE-010 (the approved
--      workbook rates, in whole percent). Card descriptions are not duplicated.
--   2. mm_fix_round_prepayment (internal, no grants) fixes the prepayment exactly once:
--      saved final_tax_liability x rate, rounded to the nearest whole dollar (halves round up),
--      stored in mm_game_rounds.fixed_tax_prepayment and calculation_details->'tax_prepayment'.
--      The saved tax calculation is never rewritten. No cash, settlement, refund, amount due,
--      audit or Life Ledger change is made.
--   3. record_round_card is replaced: identical to the 20261004070000 version except it also
--      supports the Round 1 'tax-prepayment' stage. One card for every pathway; Corporate Climber
--      (PATH-001) may save ONE second card only with p_choice = 'redraw' and only when the first
--      card's rate is below 90%. The second card is recorded in history with
--      choices = {"prepayment_decision": "redraw"}; the first stays in history. Any other second
--      card raises REDRAW_NOT_ALLOWED. After the prepayment is fixed, saving raises
--      PREPAYMENT_ALREADY_FIXED.
--   4. keep_round_prepayment_card (new, anon) lets an eligible Climber keep the first card.
--   5. advance_round_stage is replaced: identical except Deduction -> Tax Prepayment is allowed
--      in Round 1, and only when a saved tax calculation exists (TAX_CALCULATION_REQUIRED).
--   6. get_round_prepayment (new, service_role only) is a read-only restore of the stored result.
-- The final card is identified by calculation_details->'tax_prepayment'->>'card_history_id'.
-- Replaced functions keep their ownership and grants (re-applied below).

do $preflight$
begin
  if pg_catalog.to_regclass('public.mm_game_lives') is null
     or pg_catalog.to_regclass('public.mm_game_rounds') is null
     or pg_catalog.to_regclass('public.mm_game_card_history') is null
     or pg_catalog.to_regclass('public.mm_game_operations') is null
     or pg_catalog.to_regclass('public.mm_card_catalog') is null
     or pg_catalog.to_regclass('public."00_players"') is null then
    raise exception 'Required replayable-game tables or the card catalog are missing.';
  end if;
  if pg_catalog.to_regprocedure('public.record_round_card(uuid,text,integer,text,text,text,uuid,text)') is null
     or pg_catalog.to_regprocedure('public.advance_round_stage(uuid,text,integer,text,uuid)') is null
     or pg_catalog.to_regprocedure('public.save_round_tax_result(uuid,text,integer,uuid,jsonb)') is null
     or pg_catalog.to_regprocedure('public.get_round_tax_inputs(uuid,text)') is null then
    raise exception 'Migrations through 20261004060000 and 20261004070000 must be installed first.';
  end if;
  if (select pg_catalog.count(*) from public.mm_card_catalog where deck = 'Tax Prepayment' and stage = 'tax-prepayment') <> 10 then
    raise exception 'Expected exactly 10 Tax Prepayment cards in mm_card_catalog.';
  end if;
end;
$preflight$;

-- 1. Authoritative prepayment rates (whole percent) for the ten approved cards.
alter table public.mm_card_catalog add column if not exists prepayment_rate_pct smallint;

update public.mm_card_catalog as catalog
   set prepayment_rate_pct = rates.pct
  from (values
    ('PRE-001', 40), ('PRE-002', 60), ('PRE-003', 80), ('PRE-004', 90), ('PRE-005', 100),
    ('PRE-006', 105), ('PRE-007', 115), ('PRE-008', 130), ('PRE-009', 100), ('PRE-010', 0)
  ) as rates(card_id, pct)
 where catalog.card_id = rates.card_id;

do $constraint$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.mm_card_catalog'::pg_catalog.regclass
       and conname = 'mm_card_catalog_prepayment_rate_check'
  ) then
    alter table public.mm_card_catalog
      add constraint mm_card_catalog_prepayment_rate_check
      check (
        (deck = 'Tax Prepayment') = (prepayment_rate_pct is not null)
        and (prepayment_rate_pct is null or prepayment_rate_pct between 0 and 130)
      );
  end if;
end;
$constraint$;

-- 2. Internal helper: fixes the prepayment exactly once. Called only by the RPCs below.
create or replace function public.mm_fix_round_prepayment(
  p_round_id uuid,
  p_history_id uuid,
  p_card_id text,
  p_rate_pct smallint,
  p_first_card_id text,
  p_redraw_used boolean
)
returns numeric
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  round_row public.mm_game_rounds%rowtype;
  tax numeric;
  prepaid numeric;
begin
  select game_round.* into round_row
    from public.mm_game_rounds as game_round
   where game_round.id = p_round_id
   for update;

  if not found
     or round_row.status <> 'in_progress'
     or round_row.current_stage <> 'tax-prepayment' then
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;
  if round_row.calculation_details -> 'tax_calculation' is null then
    raise exception using message = 'TAX_CALCULATION_REQUIRED', errcode = '23514';
  end if;
  if round_row.calculation_details -> 'tax_prepayment' is not null then
    raise exception using message = 'PREPAYMENT_ALREADY_FIXED', errcode = '23514';
  end if;
  if p_rate_pct is null or p_rate_pct < 0 or p_rate_pct > 130 then
    raise exception using message = 'CARD_WRONG_DECK', errcode = '23514';
  end if;

  -- The saved calculated tax is the only tax input; the rate comes from the catalog.
  tax := (round_row.calculation_details -> 'tax_calculation' -> 'round' ->> 'final_tax_liability')::numeric;
  if tax is null or tax < 0 or tax <> round_row.final_tax_liability then
    raise exception using message = 'TAX_CALCULATION_REQUIRED', errcode = '23514';
  end if;
  prepaid := pg_catalog.round(tax * p_rate_pct / 100, 0);

  update public.mm_game_rounds as game_round
     set fixed_tax_prepayment = prepaid,
         calculation_details = game_round.calculation_details || pg_catalog.jsonb_build_object(
           'tax_prepayment', pg_catalog.jsonb_build_object(
             'card_history_id', p_history_id,
             'card_id', p_card_id,
             'rate_pct', p_rate_pct,
             'calculated_tax', tax,
             'prepaid_amount', prepaid,
             'redraw_used', p_redraw_used,
             'first_card_id', p_first_card_id,
             'fixed_at', pg_catalog.now()
           )
         ),
         updated_at = pg_catalog.now()
   where game_round.id = round_row.id;

  return prepaid;
end;
$$;

alter function public.mm_fix_round_prepayment(uuid, uuid, text, smallint, text, boolean) owner to postgres;
revoke all on function public.mm_fix_round_prepayment(uuid, uuid, text, smallint, text, boolean)
  from public, anon, authenticated, service_role;

-- 3. record_round_card (adds the Tax Prepayment stage).
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
        when life_row.current_round <> 1 then 0
        when life_row.pathway_id in ('PATH-002', 'PATH-006') then 2
        else 1
      end;
    when 'life-event' then
      required_deck := 'Life Event';
      stage_card_limit := case when life_row.current_round = 1 then 1 else 0 end;
    when 'wildcard' then
      required_deck := 'Wildcard';
      stage_card_limit := case when life_row.current_round = 1 then 1 else 0 end;
    when 'deduction' then
      required_deck := 'Deduction';
      stage_card_limit := case when life_row.current_round = 1 then 1 else 0 end;
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

-- 4. Corporate Climber keeps the first card instead of redrawing.
create or replace function public.keep_round_prepayment_card(
  p_player_id uuid,
  p_resume_token_hash text,
  p_round_number integer,
  p_idempotency_key uuid
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
  first_row public.mm_game_card_history%rowtype;
  first_rate smallint;
  card_count integer;
  fingerprint text;
  prepaid numeric;
  response jsonb;
begin
  if p_player_id is null
     or p_resume_token_hash is null
     or p_resume_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;
  if p_idempotency_key is null or p_round_number is null then
    raise exception using message = 'INVALID_CARD_REQUEST', errcode = '22023';
  end if;

  select player.* into player_row
    from public."00_players" as player
   where player.id = p_player_id
     and player.resume_token_hash = p_resume_token_hash
   for update;
  if not found then
    raise exception using message = 'PLAYER_SETUP_NOT_AVAILABLE', errcode = '28000';
  end if;

  fingerprint :=
    pg_catalog.md5(pg_catalog.concat_ws('|', 'keep-prepayment', p_round_number::text))
    || pg_catalog.md5(pg_catalog.concat_ws('|', 'keep-prepayment-recheck', p_round_number::text));

  select op.* into operation_row
    from public.mm_game_operations as op
   where op.player_id = player_row.id
     and op.idempotency_key = p_idempotency_key;
  if found then
    if operation_row.operation_type <> 'record-card'
       or operation_row.request_fingerprint <> fingerprint
       or operation_row.response_snapshot ->> 'request_kind' is distinct from 'keep-prepayment'
       or operation_row.response_snapshot ->> 'request_round_number' is distinct from p_round_number::text then
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
     or round_row.current_stage <> 'tax-prepayment'
     or life_row.current_stage <> 'tax-prepayment' then
    raise exception using message = 'NOT_CURRENT_STAGE', errcode = '23514';
  end if;
  if life_row.current_round <> 1 then
    raise exception using message = 'STAGE_NOT_SUPPORTED', errcode = '0A000';
  end if;
  if round_row.calculation_details -> 'tax_prepayment' is not null then
    raise exception using message = 'PREPAYMENT_ALREADY_FIXED', errcode = '23514';
  end if;

  select pg_catalog.count(*) into card_count
    from public.mm_game_card_history as history
   where history.round_id = round_row.id
     and history.stage = 'tax-prepayment';
  select history.* into first_row
    from public.mm_game_card_history as history
   where history.round_id = round_row.id
     and history.stage = 'tax-prepayment'
     and history.order_in_stage = 1;
  select catalog.prepayment_rate_pct into first_rate
    from public.mm_card_catalog as catalog
   where catalog.card_id = first_row.card_id;

  -- Only an eligible Climber with one provisional card below 90% has a decision to make.
  if card_count <> 1
     or life_row.pathway_id <> 'PATH-001'
     or first_rate is null
     or first_rate >= 90 then
    raise exception using message = 'REDRAW_NOT_ALLOWED', errcode = '23514';
  end if;

  prepaid := public.mm_fix_round_prepayment(round_row.id, first_row.id, first_row.card_id, first_rate, null, false);

  response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'round_number', round_row.round_number,
    'card_id', first_row.card_id,
    'rate_pct', first_rate,
    'prepaid_amount', prepaid
  );

  insert into public.mm_game_operations (
    player_id, life_id, idempotency_key, operation_type, request_fingerprint, response_snapshot
  )
  values (
    player_row.id, life_row.id, p_idempotency_key, 'record-card', fingerprint,
    pg_catalog.jsonb_build_object(
      'request_kind', 'keep-prepayment',
      'request_round_number', p_round_number,
      'response', response
    )
  );

  return response;
end;
$$;

alter function public.keep_round_prepayment_card(uuid, text, integer, uuid) owner to postgres;
revoke all on function public.keep_round_prepayment_card(uuid, text, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.keep_round_prepayment_card(uuid, text, integer, uuid) to anon;

-- 5. advance_round_stage (adds Deduction -> Tax Prepayment).
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

-- 6. Read-only restore of the stored prepayment state (no writes, no calculation).
create or replace function public.get_round_prepayment(
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
  cards jsonb;
  card_count integer;
  first_rate smallint;
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

  select coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'card_id', history.card_id,
             'order_in_stage', history.order_in_stage,
             'rate_pct', catalog.prepayment_rate_pct
           ) order by history.order_in_stage), '[]'::jsonb),
         pg_catalog.count(*),
         pg_catalog.min(catalog.prepayment_rate_pct) filter (where history.order_in_stage = 1)
    into cards, card_count, first_rate
    from public.mm_game_card_history as history
    join public.mm_card_catalog as catalog on catalog.card_id = history.card_id
   where history.round_id = round_row.id
     and history.stage = 'tax-prepayment';

  return pg_catalog.jsonb_build_object(
    'round_number', round_row.round_number,
    'current_stage', round_row.current_stage,
    'pathway_id', life_row.pathway_id,
    'calculated_tax', case
      when round_row.calculation_details -> 'tax_calculation' is null then null
      else round_row.final_tax_liability
    end,
    'cards', cards,
    'prepayment', round_row.calculation_details -> 'tax_prepayment',
    'redraw_eligible', (
      round_row.current_stage = 'tax-prepayment'
      and life_row.pathway_id = 'PATH-001'
      and round_row.calculation_details -> 'tax_prepayment' is null
      and card_count = 1
      and first_rate is not null
      and first_rate < 90
    )
  );
end;
$$;

alter function public.get_round_prepayment(uuid, text) owner to postgres;
revoke all on function public.get_round_prepayment(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_round_prepayment(uuid, text) to service_role;
