-- TASK 10.15.23: Extend shared Results/Life Ledger availability to Round 3.
-- Requires migrations through 20261005160000_round_three_tax_prepayment.sql.
-- Widen only stage advancement and finalization gates. Preserve saved fixed
-- prepayment, settlement, Living Costs, debt, household, beta Audit representation,
-- credentials, locks, idempotency and immutable snapshots. No history/backfill.
-- Round 4 remains closed. Local migration; manual installation only.

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
        'public.advance_round_stage(uuid,text,integer,text,uuid)',
        $old$when 'tax-prepayment' then
      if life_row.current_round between 1 and 2 then$old$,
        $new$when 'tax-prepayment' then
      if life_row.current_round between 1 and 3 then$new$
      ),
      (
        'public.finalize_round_results(uuid,text,integer,uuid,jsonb)',
        'if life_row.current_round not between 1 and 2 then',
        'if life_row.current_round not between 1 and 3 then'
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

alter function public.advance_round_stage(uuid, text, integer, text, uuid) owner to postgres;
revoke all on function public.advance_round_stage(uuid, text, integer, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.advance_round_stage(uuid, text, integer, text, uuid) to anon;

alter function public.finalize_round_results(uuid, text, integer, uuid, jsonb) owner to postgres;
revoke all on function public.finalize_round_results(uuid, text, integer, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_round_results(uuid, text, integer, uuid, jsonb) to service_role;
