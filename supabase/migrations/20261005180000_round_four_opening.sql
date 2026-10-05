-- TASK 10.15.25: Shared Round 4 opening and Income/Retirement card foundation.
-- Requires migrations through 20261005170000_round_three_results.sql.
-- Start from finalized Round 3 using unchanged locks, balances and expiration.
-- Early Retiree draws Retirement in Round 4; all pathways retire in Round 5.
-- Round 5 stays closed. Round 4 cannot advance beyond income-or-retirement.
-- No financial calculation, data rewrite, backfill or environment change.
-- Local migration only; do not execute without separate installation authorization.

create or replace function public.mm_round_income_deck(p_pathway_id text, p_round_number integer)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  if p_pathway_id is null
     or p_pathway_id not in ('PATH-001', 'PATH-002', 'PATH-003', 'PATH-004', 'PATH-005', 'PATH-006', 'PATH-007', 'PATH-008')
     or p_round_number is null or p_round_number not between 1 and 5 then
    raise exception using message = 'INVALID_CARD_REQUEST', errcode = '22023';
  end if;
  return case
    when p_round_number = 5 or (p_pathway_id = 'PATH-008' and p_round_number = 4)
      then 'Retirement'
    else 'Income'
  end;
end;
$$;

alter function public.mm_round_income_deck(text, integer) owner to postgres;
revoke all on function public.mm_round_income_deck(text, integer)
  from public, anon, authenticated, service_role;

do $migration$
declare
  change_row record;
  function_id oid;
  definition text;
  old_text text;
  new_text text;
  old_count integer;
begin
  for change_row in
    select * from (values
      (
        'public.start_next_round(uuid,text,integer)',
        'p_round_number not between 2 and 3',
        'p_round_number not between 2 and 4'
      ),
      (
        'public.record_round_card(uuid,text,integer,text,text,text,uuid,text)',
        $old$      required_deck :=
        case when life_row.pathway_id = 'PATH-008' and life_row.current_round >= 4
          then 'Retirement' else 'Income' end;
      stage_card_limit := case
        when life_row.current_round not between 1 and 3 then 0
        when life_row.pathway_id in ('PATH-002', 'PATH-006') then 2
        else 1
      end;$old$,
        $new$      required_deck := public.mm_round_income_deck(life_row.pathway_id, life_row.current_round);
      stage_card_limit := case
        when life_row.current_round not between 1 and 4 then 0
        when required_deck = 'Retirement' then 1
        when life_row.pathway_id in ('PATH-002', 'PATH-006') then 2
        else 1
      end;$new$
      )
    ) as changes(signature, old_text, new_text)
  loop
    function_id := pg_catalog.to_regprocedure(change_row.signature);
    if function_id is null then
      raise exception 'Required RPC missing: %', change_row.signature;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_proc as fn
       where fn.oid = function_id
         and fn.prosecdef
         and pg_catalog.pg_get_userbyid(fn.proowner) = 'postgres'
         and fn.proconfig @> array['search_path=pg_catalog']::text[]
    ) then
      raise exception 'Unexpected RPC security contract: %', change_row.signature;
    end if;
    definition := pg_catalog.replace(pg_catalog.pg_get_functiondef(function_id), E'\r\n', E'\n');
    old_text := pg_catalog.replace(change_row.old_text, E'\r\n', E'\n');
    new_text := pg_catalog.replace(change_row.new_text, E'\r\n', E'\n');
    old_count := (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_text, '')))
      / pg_catalog.length(old_text);
    if old_count <> 1 then
      raise exception 'Expected exactly one installed snippet in %; found %',
        change_row.signature, old_count;
    end if;
    execute pg_catalog.replace(definition, old_text, new_text);
  end loop;
end;
$migration$;

alter function public.start_next_round(uuid, text, integer) owner to postgres;
revoke all on function public.start_next_round(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.start_next_round(uuid, text, integer) to service_role;

alter function public.record_round_card(uuid, text, integer, text, text, text, uuid, text) owner to postgres;
revoke all on function public.record_round_card(uuid, text, integer, text, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_round_card(uuid, text, integer, text, text, text, uuid, text) to anon;
