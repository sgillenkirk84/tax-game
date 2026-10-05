-- TASK 10.15.09: Resolve PL/pgSQL variable/column ambiguity during prepayment save.
-- Requires 20261005130000_precredit_tax_prepayment.sql.
-- Rename only the helper's local pre-credit variable; keep its signature, snapshot,
-- rounding, saved-input checks, locks and permissions unchanged. No data backfill.
-- Local draft only: do not execute without separate installation approval.

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
  v_tax_before_credits numeric;
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
  v_tax_before_credits := (round_row.calculation_details -> 'tax_calculation' -> 'round' ->> 'tax_before_credits')::numeric;
  if tax is null or tax < 0 or tax is distinct from round_row.final_tax_liability
     or v_tax_before_credits is null or v_tax_before_credits < 0
     or v_tax_before_credits is distinct from round_row.tax_before_credits then
    raise exception using message = 'TAX_CALCULATION_REQUIRED', errcode = '23514';
  end if;
  prepaid := pg_catalog.round(v_tax_before_credits * p_rate_pct / 100, 0);

  update public.mm_game_rounds as game_round
     set fixed_tax_prepayment = prepaid,
         calculation_details = game_round.calculation_details || pg_catalog.jsonb_build_object(
           'tax_prepayment', pg_catalog.jsonb_build_object(
             'card_history_id', p_history_id,
             'card_id', p_card_id,
             'rate_pct', p_rate_pct,
             'calculated_tax', tax,
             'calculation_base', 'income-tax-before-credits',
             'tax_before_credits', v_tax_before_credits,
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
