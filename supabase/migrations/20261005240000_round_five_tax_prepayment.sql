-- TASK 10.15.37: Enable Round 5 through shared fixed Tax Prepayment only.
-- Requires migrations through 20261005230000_round_five_tax_calculation.sql.
-- Widen only recording, Deduction -> Tax Prepayment and Corporate Climber keep gates.
-- Preserve the saved Income Tax Before Credits basis, authoritative rates,
-- whole-dollar halves-up rounding, fixed-payment restore, locks and idempotency.
-- No retirement/tax recalculation, data rewrite, backfill or environment change.
-- Round 5 Results/finalization, final completion/story and Round 6 stay closed.
-- Local migration only; do not execute without separate installation authorization.

do $migration$
declare
  change_row record;
  function_id oid;
  definition text;
  old_gate text;
  new_gate text;
  old_count integer;
begin
  for change_row in
    select * from (values
      (
        'public.record_round_card(uuid,text,integer,text,text,text,uuid,text)',
        'when life_row.current_round not between 1 and 4 then 0',
        'when life_row.current_round not between 1 and 5 then 0'
      ),
      (
        'public.advance_round_stage(uuid,text,integer,text,uuid)',
        $old$when 'deduction' then
      if life_row.current_round between 1 and 4 then$old$,
        $new$when 'deduction' then
      if life_row.current_round between 1 and 5 then$new$
      ),
      (
        'public.keep_round_prepayment_card(uuid,text,integer,uuid)',
        'if life_row.current_round not between 1 and 4 then',
        'if life_row.current_round not between 1 and 5 then'
      )
    ) as changes(signature, old_gate, new_gate)
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
    old_gate := pg_catalog.replace(change_row.old_gate, E'\r\n', E'\n');
    new_gate := pg_catalog.replace(change_row.new_gate, E'\r\n', E'\n');
    old_count := (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_gate, '')))
      / pg_catalog.length(old_gate);
    if old_count <> 1 then
      raise exception 'Expected exactly one installed gate in %; found %',
        change_row.signature, old_count;
    end if;
    execute pg_catalog.replace(definition, old_gate, new_gate);
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

alter function public.keep_round_prepayment_card(uuid, text, integer, uuid) owner to postgres;
revoke all on function public.keep_round_prepayment_card(uuid, text, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.keep_round_prepayment_card(uuid, text, integer, uuid) to anon;
