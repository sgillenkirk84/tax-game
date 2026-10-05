-- TASK 10.15.07: Tax Prepayment uses Income Tax Before Credits, not final tax.
-- Additive function-only correction for all rounds using this shared mechanic.
-- Requires 20261004080000_tax_prepayment.sql. No schema change or data backfill.
-- Existing fixed prepayments, saved tax calculations and finalized results remain unchanged.
-- Preserve whole-dollar rounding, trusted saved inputs, locks and restricted permissions.
-- Draft for manual review/installation only; not executed by the application.

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
  tax_before_credits numeric;
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

  tax := (round_row.calculation_details -> 'tax_calculation' -> 'round' ->> 'final_tax_liability')::numeric;
  tax_before_credits := (round_row.calculation_details -> 'tax_calculation' -> 'round' ->> 'tax_before_credits')::numeric;
  if tax is null or tax < 0 or tax is distinct from round_row.final_tax_liability
     or tax_before_credits is null or tax_before_credits < 0
     or tax_before_credits is distinct from round_row.tax_before_credits then
    raise exception using message = 'TAX_CALCULATION_REQUIRED', errcode = '23514';
  end if;
  prepaid := pg_catalog.round(tax_before_credits * p_rate_pct / 100, 0);

  update public.mm_game_rounds as game_round
     set fixed_tax_prepayment = prepaid,
         calculation_details = game_round.calculation_details || pg_catalog.jsonb_build_object(
           'tax_prepayment', pg_catalog.jsonb_build_object(
             'card_history_id', p_history_id,
             'card_id', p_card_id,
             'rate_pct', p_rate_pct,
             'calculated_tax', tax,
             'calculation_base', 'income-tax-before-credits',
             'tax_before_credits', tax_before_credits,
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
    'tax_before_credits', case
      when round_row.calculation_details -> 'tax_calculation' is null then null
      else round_row.tax_before_credits
    end,
    'credits_applied', case
      when round_row.calculation_details -> 'tax_calculation' is null then null
      else round_row.credits_total
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
