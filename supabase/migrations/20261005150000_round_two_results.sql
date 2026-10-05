-- TASK 10.15.11: Reuse shared Results/Life Ledger finalization in Rounds 1-2.
-- Requires migrations through 20261005140000. Local draft; no SQL executed.
-- User-approved temporary beta rule: triggered Audit resolution is bypassed,
-- explicitly recorded as bypassed-beta, not assessed. No adjustment/penalty invented.
-- Keep saved prepayment, settlement formulas, locks, idempotency, immutable ledger,
-- household handoff and ending balances. No historical mutation or backfill.
-- Future round availability is unchanged; Round 3 Results remains closed.
-- Patch only exact installed snippets, aborting on unexpected definitions/security.

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
        'public.advance_round_stage(uuid,text,integer,text,uuid)',
        $old$when 'tax-prepayment' then
      if life_row.current_round = 1 then$old$,
        $new$when 'tax-prepayment' then
      if life_row.current_round between 1 and 2 then$new$
      ),
      (
        'public.finalize_round_results(uuid,text,integer,uuid,jsonb)',
        '  v_finalized_at := pg_catalog.now();',
        $new$  if pg_catalog.jsonb_typeof(tax -> 'audit_trigger' -> 'triggered') is distinct from 'boolean' then
    raise exception using message = 'INVALID_RESULTS', errcode = '22023';
  end if;
  v_finalized_at := pg_catalog.now();$new$
      ),
      (
        'public.finalize_round_results(uuid,text,integer,uuid,jsonb)',
        'if life_row.current_round <> 1 then',
        'if life_row.current_round not between 1 and 2 then'
      ),
      (
        'public.finalize_round_results(uuid,text,integer,uuid,jsonb)',
        $old$  select pg_catalog.count(*) into v_dependents
    from public.mm_game_effects as effect
   where effect.life_id = life_row.id
     and effect.effect_type = 'add-dependent'
     and effect.status = 'active'
     and effect.starts_round <= round_row.round_number
     and (effect.expires_after_round is null or effect.expires_after_round >= round_row.round_number);$old$,
        $new$  -- Use the saved tax household, including the Caregiver permanent dependent.
  -- Effects already saved at tax calculation retain their own expiry lifecycle.
  if pg_catalog.jsonb_typeof(round_row.input_snapshot -> 'dependents') is distinct from 'array' then
    raise exception using message = 'INVALID_RESULTS', errcode = '22023';
  end if;
  v_dependents := pg_catalog.jsonb_array_length(round_row.input_snapshot -> 'dependents');$new$
      ),
      (
        'public.finalize_round_results(uuid,text,integer,uuid,jsonb)',
        $old$    'version', 1,$old$,
        $new$    'version', 2,$new$
      ),
      (
        'public.finalize_round_results(uuid,text,integer,uuid,jsonb)',
        $old$    'active_dependents', v_dependents
  );$old$,
        $new$    'active_dependents', v_dependents,
    'deduction_method', round_row.deduction_method,
    'deduction_amount', round_row.deduction_amount,
    'taxable_income', round_row.taxable_income,
    'tax_before_credits', round_row.tax_before_credits,
    'credits_applied', round_row.credits_total,
    'prepayment_rate_pct', round_row.calculation_details -> 'tax_prepayment' -> 'rate_pct',
    'investment_income', round_row.investment_income,
    'investment_asset_value', round_row.investment_asset_value,
    'audit_trigger', tax -> 'audit_trigger',
    'audit_resolution', case
      when (tax -> 'audit_trigger' ->> 'triggered')::boolean
      then 'bypassed-beta' else 'not-triggered' end
  );$new$
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

alter function public.advance_round_stage(uuid, text, integer, text, uuid) owner to postgres;
revoke all on function public.advance_round_stage(uuid, text, integer, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.advance_round_stage(uuid, text, integer, text, uuid) to anon;

alter function public.finalize_round_results(uuid, text, integer, uuid, jsonb) owner to postgres;
revoke all on function public.finalize_round_results(uuid, text, integer, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_round_results(uuid, text, integer, uuid, jsonb) to service_role;
