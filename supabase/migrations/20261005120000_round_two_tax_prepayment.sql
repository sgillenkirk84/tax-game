-- Round 2 Tax Prepayment milestone: reuse the installed round RPCs and physical-card rules.
-- Requires 20261004100000_next_round.sql and 20261004080000_tax_prepayment.sql.
-- Extends only three existing Round 1 gates to Rounds 1-2. No data backfill or stage
-- update is performed here. Results stays Round 1 only; Round 3 Prepayment stays closed.
-- Preserve complete installed function bodies, including credentials, locks, idempotency,
-- Climber keep/redraw, catalog rates and saved tax validation. Abort on unexpected bodies.
-- Run manually only after review; this file has not been executed by the application.

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
        'when life_row.current_round <> 1 then 0',
        'when life_row.current_round not between 1 and 2 then 0'
      ),
      (
        'public.advance_round_stage(uuid,text,integer,text,uuid)',
        $old$when 'deduction' then
      if life_row.current_round = 1 then$old$,
        $new$when 'deduction' then
      if life_row.current_round between 1 and 2 then$new$
      ),
      (
        'public.keep_round_prepayment_card(uuid,text,integer,uuid)',
        'if life_row.current_round <> 1 then',
        'if life_row.current_round not between 1 and 2 then'
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
