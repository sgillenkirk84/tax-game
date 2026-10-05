-- TASK 10.15.02 — READ-ONLY Supabase TEST verification of the Round 2/3 engine migration
-- (20261004100000_next_round.sql). Run AFTER installing that migration in TEST.
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
     and p.proname in ('start_next_round', 'get_current_round_state', 'record_round_card',
                       'advance_round_stage', 'get_round_tax_inputs', 'save_round_tax_result',
                       'finalize_round_results', 'start_or_resume_round_one')
),
checks(check_name, passed, detail) as (
  values
    ('each function exists exactly once',
      (select count(*) = 8 and count(distinct proname) = 8 from fns),
      (select count(*)::text || ' found' from fns)),
    ('start_next_round signature',
      (select count(*) = 1 from fns where proname = 'start_next_round' and argtypes = 'uuid,text,integer'), null),
    ('get_current_round_state signature',
      (select count(*) = 1 from fns where proname = 'get_current_round_state' and argtypes = 'uuid,text'), null),
    ('replaced function signatures unchanged',
      (select count(*) = 4 from fns
        where (proname = 'record_round_card' and argtypes = 'uuid,text,integer,text,text,text,uuid,text')
           or (proname = 'advance_round_stage' and argtypes = 'uuid,text,integer,text,uuid')
           or (proname = 'get_round_tax_inputs' and argtypes = 'uuid,text')
           or (proname = 'save_round_tax_result' and argtypes = 'uuid,text,integer,uuid,jsonb')), null),
    ('all eight are SECURITY DEFINER, owned by postgres, search_path pg_catalog',
      (select count(*) = 8 from fns where prosecdef and owner = 'postgres' and config like '%search_path=pg_catalog%'),
      null),
    ('no function is executable by PUBLIC or authenticated',
      (select count(*) = 0 from fns where public_exec or auth_exec), null),
    ('start_next_round, get_round_tax_inputs, save_round_tax_result, finalize_round_results: service_role only',
      (select count(*) = 4 from fns
        where proname in ('start_next_round', 'get_round_tax_inputs', 'save_round_tax_result', 'finalize_round_results')
          and service_exec and not anon_exec), null),
    ('get_current_round_state, record_round_card, advance_round_stage, start_or_resume_round_one: anon only',
      (select count(*) = 4 from fns
        where proname in ('get_current_round_state', 'record_round_card', 'advance_round_stage', 'start_or_resume_round_one')
          and anon_exec and not service_exec), null),
    ('get_current_round_state is read-only (no insert/update/delete)',
      (select count(*) = 1 from fns where proname = 'get_current_round_state'
         and src not ilike '%insert into%' and src not ilike '%update public.%' and src not ilike '%delete from%'), null),
    ('start_next_round supports Rounds 2 and 3 only and requires a finalized previous round',
      (select count(*) = 1 from fns where proname = 'start_next_round'
         and src like '%not between 2 and 3%' and src like '%PREVIOUS_ROUND_NOT_FINALIZED%'
         and src like '%previous_round.status <> ''finalized''%'), null),
    ('start_next_round returns the existing round on retry and carries ending cash and debt',
      (select count(*) = 1 from fns where proname = 'start_next_round'
         and src like '%was_replayed := true%'
         and src like '%previous_round.ending_cash_resources%'
         and src like '%previous_round.ending_student_loan_debt%'), null),
    ('start_next_round expires effects once and never touches removed effects',
      (select count(*) = 1 from fns where proname = 'start_next_round'
         and src like '%effect.status = ''active''%' and src like '%set status = ''expired''%'
         and src like '%effect.expires_after_round < p_round_number%'), null),
    ('record_round_card allows Rounds 1 to 3, Tax Prepayment stays Round 1 only',
      (select count(*) = 1 from fns where proname = 'record_round_card'
         and src like '%current_round between 1 and 3%' and src like '%current_round <> 1 then 0%'), null),
    ('advance_round_stage: Income/Life Event/Wildcard Rounds 1-3, Deduction onward Round 1 only',
      (select count(*) = 1 from fns where proname = 'advance_round_stage'
         and (length(src) - length(replace(src, 'current_round between 1 and 3', '')))
             / length('current_round between 1 and 3') = 3
         and src like '%results-and-life-ledger%' and src like '%PREPAYMENT_REQUIRED%'), null),
    ('save_round_tax_result accepts Rounds 1 to 3 and persists the Corporate Climber primary',
      (select count(*) = 1 from fns where proname = 'save_round_tax_result'
         and src like '%current_round not between 1 and 3%' and src like '%corporate_climber_primary%'), null),
    ('get_round_tax_inputs exposes the Corporate Climber primary',
      (select count(*) = 1 from fns where proname = 'get_round_tax_inputs'
         and src like '%corporate_climber_primary%'), null),
    ('finalize_round_results is still Round 1 only',
      (select count(*) = 1 from fns where proname = 'finalize_round_results'
         and src like '%current_round <> 1%'), null),
    ('operation_type constraint unchanged (still allows all six types)',
      (select count(*) = 1 from pg_constraint
        where conrelid = 'public.mm_game_operations'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%create-life%' and pg_get_constraintdef(oid) like '%record-card%'
          and pg_get_constraintdef(oid) like '%advance-stage%' and pg_get_constraintdef(oid) like '%finalize-round%'
          and pg_get_constraintdef(oid) like '%complete-life%' and pg_get_constraintdef(oid) like '%calculate-round-tax%'),
      null),
    ('Audit stage is still defined in the stage constraints (not deleted)',
      (select count(*) >= 1 from pg_constraint
        where conrelid = 'public.mm_game_rounds'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%audit-if-triggered%'), null),
    ('opening-finances and finalized-round triggers still exist on mm_game_rounds',
      (select count(*) >= 2 from pg_trigger t
         where t.tgrelid = 'public.mm_game_rounds'::regclass and not t.tgisinternal
           and t.tgname in ('mm_game_rounds_validate_opening_finances', 'mm_game_rounds_finalized_immutable')), null),
    ('Life Ledger and effects triggers still exist',
      (select count(*) >= 3 from pg_trigger t
         where t.tgrelid in ('public.mm_game_life_ledger'::regclass, 'public.mm_game_effects'::regclass)
           and not t.tgisinternal), null),
    ('no life has two rows for the same round number',
      (select count(*) = 0 from (
         select life_id, round_number from public.mm_game_rounds group by life_id, round_number having count(*) > 1) d),
      null),
    ('every life current_round has a round row',
      (select count(*) = 0 from public.mm_game_lives l
        where not exists (select 1 from public.mm_game_rounds r
                           where r.life_id = l.id and r.round_number = l.current_round)), null),
    ('a round beyond 1 only exists after the previous round is finalized',
      (select count(*) = 0 from public.mm_game_rounds r
        where r.round_number > 1
          and not exists (select 1 from public.mm_game_rounds p
                           where p.life_id = r.life_id and p.round_number = r.round_number - 1
                             and p.status = 'finalized')), null),
    ('a round beyond 1 begins with the previous round''s ending cash and debt',
      (select count(*) = 0 from public.mm_game_rounds r
        join public.mm_game_rounds p on p.life_id = r.life_id and p.round_number = r.round_number - 1
        where r.beginning_cash_resources is distinct from p.ending_cash_resources
           or r.beginning_student_loan_debt is distinct from p.ending_student_loan_debt), null),
    ('no active effect has passed its expiry for the life''s current round',
      (select count(*) = 0 from public.mm_game_effects e
        join public.mm_game_lives l on l.id = e.life_id
        where e.status = 'active' and e.expires_after_round is not null
          and e.expires_after_round < l.current_round), null),
    ('every Corporate Climber primary stores a card id and an established round',
      (select count(*) = 0 from public.mm_game_lives l
        where l.persistent_state ? 'corporate_climber_primary'
          and (jsonb_typeof(l.persistent_state -> 'corporate_climber_primary' -> 'card_id') <> 'string'
               or jsonb_typeof(l.persistent_state -> 'corporate_climber_primary' -> 'established_round') <> 'number')),
      null),
    ('Caregiver dependent is derived, not stored as an effect (no PATH-003 effect rows)',
      (select count(*) = 0 from public.mm_game_effects where source_card_id = 'PATH-003'), null)
)
select check_name,
       case when passed then 'PASS' else 'FAIL' end as result,
       detail
  from checks
 order by result, check_name;
