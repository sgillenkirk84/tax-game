-- TASK 10.10.65 ? Pathway-specific Round 1 Income draws. PREPARED FOR REVIEW; do not
-- install until explicitly approved. Requires 20261004050000_deduction_stage.sql.
--
-- No tables, constraints or data change. record_round_card and advance_round_stage are
-- replaced; each is identical to the 20261004050000 version except for the Round 1
-- income-or-retirement stage:
--   * PATH-006 Side Hustler: exactly TWO Income cards may be saved (limit 2) and both are
--     required before advancing (minimum 2).
--   * PATH-002 Entrepreneur: one Income card is required (minimum 1); ONE optional
--     additional card may be saved only if it is Business Income (catalog id INC-BIZ-*),
--     otherwise ADDITIONAL_INCOME_NOT_BUSINESS is raised and nothing is saved.
--   * All other pathways keep exactly one Income card.
-- Signatures, authentication, locking, idempotency identity, the WILD-004 choice and all
-- other stages are unchanged. Existing saved cards are never modified. Students who
-- already advanced past Income with fewer cards than the new minimum are not rewritten;
-- the tax calculation (20261004060000) rejects their round as incomplete.
-- Replacing both functions leaves their ownership and grants as before (re-applied below).

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
     or pg_catalog.to_regprocedure('public.advance_round_stage(uuid,text,integer,text,uuid)') is null then
    raise exception 'Migration 20261004050000 must be installed first.';
  end if;
end;
$preflight$;

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
  elsif p_choice is not null then
    raise exception using message = 'INVALID_CHOICE', errcode = '22023';
  end if;

  select pg_catalog.count(*)
    into saved_count
    from public.mm_game_card_history as history
   where history.round_id = round_row.id
     and history.stage = p_stage;

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
