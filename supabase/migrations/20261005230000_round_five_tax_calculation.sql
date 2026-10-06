-- TASK 10.15.35: Extend shared Round 5 stages through saved Tax Calculation.
-- Requires migrations through 20261005220000_round_five_opening.sql.
-- All pathways use one authoritative Retirement card. Preserve shared household,
-- Wildcard, deduction, investment timing, authentication, locks and idempotency.
-- Read Early Retiree's immutable finalized Round 4 protected package, never rebuild it.
-- Make Income counts/Climber persistence deck-aware; no working-life rules in Retirement.
-- Tax Prepayment, Results/finalization and final completion/story stay closed in 5.
-- No formula, schema, history rewrite, backfill or environment change.
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
        'public.record_round_card(uuid,text,integer,text,text,text,uuid,text)',
        $old$when 'life-event' then
      required_deck := 'Life Event';
      stage_card_limit := case when life_row.current_round between 1 and 4 then 1 else 0 end;$old$,
        $new$when 'life-event' then
      required_deck := 'Life Event';
      stage_card_limit := case when life_row.current_round between 1 and 5 then 1 else 0 end;$new$
      ),
      (
        'public.record_round_card(uuid,text,integer,text,text,text,uuid,text)',
        $old$when 'wildcard' then
      required_deck := 'Wildcard';
      stage_card_limit := case when life_row.current_round between 1 and 4 then 1 else 0 end;$old$,
        $new$when 'wildcard' then
      required_deck := 'Wildcard';
      stage_card_limit := case when life_row.current_round between 1 and 5 then 1 else 0 end;$new$
      ),
      (
        'public.record_round_card(uuid,text,integer,text,text,text,uuid,text)',
        $old$when 'deduction' then
      required_deck := 'Deduction';
      stage_card_limit := case when life_row.current_round between 1 and 4 then 1 else 0 end;$old$,
        $new$when 'deduction' then
      required_deck := 'Deduction';
      stage_card_limit := case when life_row.current_round between 1 and 5 then 1 else 0 end;$new$
      ),
      (
        'public.advance_round_stage(uuid,text,integer,text,uuid)',
        $old$when 'income-or-retirement' then
      if life_row.current_round between 1 and 4 then
        next_stage := 'life-event';
        minimum_cards := case when life_row.pathway_id = 'PATH-006' then 2 else 1 end;$old$,
        $new$when 'income-or-retirement' then
      if life_row.current_round between 1 and 5 then
        next_stage := 'life-event';
        minimum_cards := case
          when public.mm_round_income_deck(life_row.pathway_id, life_row.current_round) = 'Retirement' then 1
          when life_row.pathway_id = 'PATH-006' then 2 else 1 end;$new$
      ),
      (
        'public.advance_round_stage(uuid,text,integer,text,uuid)',
        $old$when 'life-event' then
      if life_row.current_round between 1 and 4 then$old$,
        $new$when 'life-event' then
      if life_row.current_round between 1 and 5 then$new$
      ),
      (
        'public.advance_round_stage(uuid,text,integer,text,uuid)',
        $old$when 'wildcard' then
      if life_row.current_round between 1 and 4 then$old$,
        $new$when 'wildcard' then
      if life_row.current_round between 1 and 5 then$new$
      ),
      (
        'public.save_round_tax_result(uuid,text,integer,uuid,jsonb)',
        'if life_row.current_round not between 1 and 4 then',
        'if life_row.current_round not between 1 and 5 then'
      ),
      (
        'public.save_round_tax_result(uuid,text,integer,uuid,jsonb)',
        $old$income_min := case when life_row.pathway_id = 'PATH-006' then 2 else 1 end;
  income_max := case when life_row.pathway_id in ('PATH-002', 'PATH-006') then 2 else 1 end;$old$,
        $new$income_min := case
    when public.mm_round_income_deck(life_row.pathway_id, life_row.current_round) = 'Retirement' then 1
    when life_row.pathway_id = 'PATH-006' then 2 else 1 end;
  income_max := case
    when public.mm_round_income_deck(life_row.pathway_id, life_row.current_round) = 'Retirement' then 1
    when life_row.pathway_id in ('PATH-002', 'PATH-006') then 2 else 1 end;$new$
      ),
      (
        'public.save_round_tax_result(uuid,text,integer,uuid,jsonb)',
        $old$if life_row.pathway_id = 'PATH-001' then
    climber :=$old$,
        $new$if life_row.pathway_id = 'PATH-001'
     and public.mm_round_income_deck(life_row.pathway_id, life_row.current_round) = 'Income' then
    climber :=$new$
      ),
      (
        'public.get_round_tax_inputs(uuid,text)',
        $old$'corporate_climber_primary', life_row.persistent_state -> 'corporate_climber_primary'$old$,
        $new$'corporate_climber_primary', life_row.persistent_state -> 'corporate_climber_primary',
      'previous_retirement_package', (
        select previous.input_snapshot -> 'retirement_package'
          from public.mm_game_rounds as previous
         where life_row.pathway_id = 'PATH-008'
           and life_row.current_round = 5
           and previous.life_id = life_row.id
           and previous.round_number = 4
           and previous.status = 'finalized'
      )$new$
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

alter function public.record_round_card(uuid, text, integer, text, text, text, uuid, text) owner to postgres;
revoke all on function public.record_round_card(uuid, text, integer, text, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_round_card(uuid, text, integer, text, text, text, uuid, text) to anon;

alter function public.advance_round_stage(uuid, text, integer, text, uuid) owner to postgres;
revoke all on function public.advance_round_stage(uuid, text, integer, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.advance_round_stage(uuid, text, integer, text, uuid) to anon;

alter function public.save_round_tax_result(uuid, text, integer, uuid, jsonb) owner to postgres;
revoke all on function public.save_round_tax_result(uuid, text, integer, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_round_tax_result(uuid, text, integer, uuid, jsonb) to service_role;

alter function public.get_round_tax_inputs(uuid, text) owner to postgres;
revoke all on function public.get_round_tax_inputs(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_round_tax_inputs(uuid, text) to service_role;
