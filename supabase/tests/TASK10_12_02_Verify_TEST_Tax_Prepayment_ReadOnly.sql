-- TASK 10.12.02 — READ-ONLY Supabase TEST verification of the Round 1 Tax Prepayment migration
-- (20261004080000_tax_prepayment.sql). Run AFTER installing that migration in TEST.
-- A single SELECT: no writes, no function calls that write data, no student-identifying data.
-- Every row should show PASS. Counts are aggregates only.

with expected_rates(card_id, rate) as (
  values ('PRE-001', 40), ('PRE-002', 60), ('PRE-003', 80), ('PRE-004', 90), ('PRE-005', 100),
         ('PRE-006', 105), ('PRE-007', 115), ('PRE-008', 130), ('PRE-009', 100), ('PRE-010', 0)
),
fns as (
  select p.proname,
         array_to_string(p.proargtypes::oid[]::regtype[], ',') as argtypes,
         pg_get_userbyid(p.proowner) as owner,
         p.prosecdef,
         coalesce(array_to_string(p.proconfig, ','), '') as config,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
         has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('record_round_card', 'keep_round_prepayment_card', 'advance_round_stage',
                       'get_round_prepayment', 'mm_fix_round_prepayment')
),
checks(check_name, passed, detail) as (
  values
    ('column prepayment_rate_pct exists (smallint)',
      (select count(*) = 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'mm_card_catalog'
          and column_name = 'prepayment_rate_pct' and data_type = 'smallint'),
      null),
    ('rate check constraint exists',
      (select count(*) = 1 from pg_constraint
        where conrelid = 'public.mm_card_catalog'::regclass and conname = 'mm_card_catalog_prepayment_rate_check'),
      null),
    ('10 Tax Prepayment rates match the approved cards',
      (select count(*) = 10 from expected_rates e
         join public.mm_card_catalog c on c.card_id = e.card_id
        where c.deck = 'Tax Prepayment' and c.prepayment_rate_pct = e.rate),
      null),
    ('no non-Tax-Prepayment card has a rate',
      (select count(*) = 0 from public.mm_card_catalog
        where deck <> 'Tax Prepayment' and prepayment_rate_pct is not null),
      null),
    ('each function exists exactly once',
      (select count(*) = 5 and count(distinct proname) = 5 from fns),
      (select count(*)::text || ' found' from fns)),
    ('record_round_card signature',
      (select count(*) = 1 from fns where proname = 'record_round_card'
         and argtypes = 'uuid,text,integer,text,text,text,uuid,text'), null),
    ('keep_round_prepayment_card signature',
      (select count(*) = 1 from fns where proname = 'keep_round_prepayment_card'
         and argtypes = 'uuid,text,integer,uuid'), null),
    ('advance_round_stage signature',
      (select count(*) = 1 from fns where proname = 'advance_round_stage'
         and argtypes = 'uuid,text,integer,text,uuid'), null),
    ('get_round_prepayment signature',
      (select count(*) = 1 from fns where proname = 'get_round_prepayment'
         and argtypes = 'uuid,text'), null),
    ('mm_fix_round_prepayment signature',
      (select count(*) = 1 from fns where proname = 'mm_fix_round_prepayment'
         and argtypes = 'uuid,uuid,text,smallint,text,boolean'), null),
    ('all five are SECURITY DEFINER, owned by postgres, search_path pg_catalog',
      (select count(*) = 5 from fns where prosecdef and owner = 'postgres' and config like '%search_path=pg_catalog%'),
      null),
    ('no function is executable by PUBLIC or authenticated',
      (select count(*) = 0 from fns where public_exec or auth_exec), null),
    ('record_round_card, keep_round_prepayment_card, advance_round_stage: anon only',
      (select count(*) = 3 from fns
        where proname in ('record_round_card', 'keep_round_prepayment_card', 'advance_round_stage')
          and anon_exec and not service_exec), null),
    ('get_round_prepayment: service_role only',
      (select count(*) = 1 from fns where proname = 'get_round_prepayment' and service_exec and not anon_exec),
      null),
    ('mm_fix_round_prepayment: internal, no grants',
      (select count(*) = 1 from fns where proname = 'mm_fix_round_prepayment'
         and not anon_exec and not service_exec), null),
    ('operation_type constraint unchanged (still 6 allowed types)',
      (select count(*) = 1 from pg_constraint
        where conrelid = 'public.mm_game_operations'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%create-life%' and pg_get_constraintdef(oid) like '%record-card%'
          and pg_get_constraintdef(oid) like '%advance-stage%' and pg_get_constraintdef(oid) like '%finalize-round%'
          and pg_get_constraintdef(oid) like '%complete-life%' and pg_get_constraintdef(oid) like '%calculate-round-tax%'),
      null),
    ('Tax Prepayment fixed only when a saved tax calculation and prepayment record exist',
      (select count(*) = 0 from public.mm_game_rounds
        where (fixed_tax_prepayment is not null and fixed_tax_prepayment > 0
               and calculation_details -> 'tax_prepayment' is null)
           or (calculation_details -> 'tax_prepayment' is not null
               and calculation_details -> 'tax_calculation' is null)),
      null),
    ('no round has more than 2 Tax Prepayment cards',
      (select count(*) = 0 from (
         select round_id from public.mm_game_card_history
          where stage = 'tax-prepayment' group by round_id having count(*) > 2) t),
      null)
)
select check_name,
       case when passed then 'PASS' else 'FAIL' end as result,
       detail
  from checks
 order by result, check_name;
