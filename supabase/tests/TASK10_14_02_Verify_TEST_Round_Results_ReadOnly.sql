-- TASK 10.14.02 — READ-ONLY Supabase TEST verification of the Round 1 Results + Life Ledger migration
-- (20261004090000_round_results.sql). Run AFTER installing that migration in TEST.
-- A single SELECT: no writes, no function calls, no student-identifying data.
-- Every row should show PASS. Counts are aggregates only.

with fns as (
  select p.proname,
         array_to_string(p.proargtypes::oid[]::regtype[], ',') as argtypes,
         pg_get_userbyid(p.proowner) as owner,
         p.prosecdef,
         coalesce(array_to_string(p.proconfig, ','), '') as config,
         pg_get_functiondef(p.oid) as src,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
         has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('finalize_round_results', 'get_round_results', 'advance_round_stage',
                       'record_round_card', 'keep_round_prepayment_card', 'get_round_prepayment')
),
checks(check_name, passed, detail) as (
  values
    ('each function exists exactly once',
      (select count(*) = 6 and count(distinct proname) = 6 from fns),
      (select count(*)::text || ' found' from fns)),
    ('finalize_round_results signature',
      (select count(*) = 1 from fns where proname = 'finalize_round_results'
         and argtypes = 'uuid,text,integer,uuid,jsonb'), null),
    ('get_round_results signature',
      (select count(*) = 1 from fns where proname = 'get_round_results'
         and argtypes = 'uuid,text,integer'), null),
    ('advance_round_stage signature unchanged',
      (select count(*) = 1 from fns where proname = 'advance_round_stage'
         and argtypes = 'uuid,text,integer,text,uuid'), null),
    ('all six are SECURITY DEFINER, owned by postgres, search_path pg_catalog',
      (select count(*) = 6 from fns where prosecdef and owner = 'postgres' and config like '%search_path=pg_catalog%'),
      null),
    ('no function is executable by PUBLIC or authenticated',
      (select count(*) = 0 from fns where public_exec or auth_exec), null),
    ('finalize_round_results and get_round_results: service_role only',
      (select count(*) = 2 from fns
        where proname in ('finalize_round_results', 'get_round_results') and service_exec and not anon_exec),
      null),
    ('record_round_card, keep_round_prepayment_card, advance_round_stage: anon only (grants unchanged)',
      (select count(*) = 3 from fns
        where proname in ('record_round_card', 'keep_round_prepayment_card', 'advance_round_stage')
          and anon_exec and not service_exec), null),
    ('get_round_prepayment still service_role only',
      (select count(*) = 1 from fns where proname = 'get_round_prepayment' and service_exec and not anon_exec),
      null),
    ('advance_round_stage moves Tax Prepayment to Results and still requires a saved prepayment',
      (select count(*) = 1 from fns where proname = 'advance_round_stage'
         and src like '%results-and-life-ledger%' and src like '%PREPAYMENT_REQUIRED%'
         and src like '%TAX_CALCULATION_REQUIRED%'), null),
    ('finalize_round_results is idempotent and checks the reconciliation',
      (select count(*) = 1 from fns where proname = 'finalize_round_results'
         and src like '%IDEMPOTENCY_KEY_REUSED%' and src like '%RESULTS_MISMATCH%'
         and src like '%finalize-round%'), null),
    ('operation_type constraint still allows finalize-round and the other 5 types',
      (select count(*) = 1 from pg_constraint
        where conrelid = 'public.mm_game_operations'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%create-life%' and pg_get_constraintdef(oid) like '%record-card%'
          and pg_get_constraintdef(oid) like '%advance-stage%' and pg_get_constraintdef(oid) like '%finalize-round%'
          and pg_get_constraintdef(oid) like '%complete-life%' and pg_get_constraintdef(oid) like '%calculate-round-tax%'),
      null),
    ('Audit stage is still defined in the round stage constraints (not deleted)',
      (select count(*) >= 1 from pg_constraint
        where conrelid = 'public.mm_game_rounds'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%audit-if-triggered%'), null),
    ('Life Ledger table and its immutable/consistency triggers still exist',
      (select count(*) >= 1 from pg_trigger t
         where t.tgrelid = 'public.mm_game_life_ledger'::regclass and not t.tgisinternal), 
      (select count(*)::text || ' ledger triggers' from pg_trigger t
         where t.tgrelid = 'public.mm_game_life_ledger'::regclass and not t.tgisinternal)),
    ('Round triggers still exist (finalized rounds stay immutable)',
      (select count(*) >= 1 from pg_trigger t
         where t.tgrelid = 'public.mm_game_rounds'::regclass and not t.tgisinternal), null),
    ('at most one Life Ledger row per round',
      (select count(*) = 0 from (
         select round_number, life_id from public.mm_game_life_ledger group by life_id, round_number having count(*) > 1) d),
      null),
    ('every finalized round has exactly one ledger row',
      (select count(*) = 0 from public.mm_game_rounds r
        where r.status = 'finalized'
          and (select count(*) from public.mm_game_life_ledger l
                where l.life_id = r.life_id and l.round_number = r.round_number) <> 1), null),
    ('every finalized round has saved Results',
      (select count(*) = 0 from public.mm_game_rounds r
        where r.status = 'finalized' and r.calculation_details -> 'results' is null), null),
    ('at most one finalize-round operation per round',
      (select count(*) = 0 from (
         select life_id, response_snapshot ->> 'request_round_number' from public.mm_game_operations
          where operation_type = 'finalize-round'
          group by 1, 2 having count(*) > 1) d),
      null),
    ('no finalized round has an audit penalty',
      (select count(*) = 0 from public.mm_game_rounds r
        where r.status = 'finalized' and coalesce((r.calculation_details -> 'results' ->> 'audit_penalty')::numeric, 0) <> 0),
      null)
)
select check_name,
       case when passed then 'PASS' else 'FAIL' end as result,
       detail
  from checks
 order by result, check_name;
