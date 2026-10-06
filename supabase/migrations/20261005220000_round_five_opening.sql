-- TASK 10.15.33: Shared Round 5 opening and universal Retirement-card recording.
-- Requires migrations through 20261005210000_round_four_results.sql.
-- Widen only finalized Round 4 -> start/recover Round 5 and first-card recording.
-- Reuse mm_round_income_deck: all pathways draw one physical Retirement card in 5.
-- Preserve authentication, locks, idempotency, balances, assets and effect lifecycle.
-- Stage advancement, tax, Prepayment, Results and final completion stay closed in 5.
-- No schema, financial calculation, history rewrite, backfill or environment change.
-- Local migration only; do not execute without separate installation authorization.

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
        'p_round_number not between 2 and 4',
        'p_round_number not between 2 and 5'
      ),
      (
        'public.record_round_card(uuid,text,integer,text,text,text,uuid,text)',
        $old$      required_deck := public.mm_round_income_deck(life_row.pathway_id, life_row.current_round);
      stage_card_limit := case
        when life_row.current_round not between 1 and 4 then 0
        when required_deck = 'Retirement' then 1$old$,
        $new$      required_deck := public.mm_round_income_deck(life_row.pathway_id, life_row.current_round);
      stage_card_limit := case
        when life_row.current_round not between 1 and 5 then 0
        when required_deck = 'Retirement' then 1$new$
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
