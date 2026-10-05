-- TASK 10.10.92 — Read-only Supabase TEST verification of the Round 1 tax-calculation foundation.
-- Run in the Supabase TEST SQL Editor (project xstqmtivdxdaytpygvva). SELECT only: no writes, no function
-- calls, no schema changes, and no student identifiers or tokens. It returns one result table of
-- (check, status, detail); student data appears only as aggregate counts.
-- Status values: PASS, FAIL, INFO (informational; review any non-zero compatibility count).

with expected_functions(name, args) as (
  values
    ('record_round_card',     'uuid,text,integer,text,text,text,uuid,text'),
    ('advance_round_stage',   'uuid,text,integer,text,uuid'),
    ('get_round_tax_inputs',  'uuid,text'),
    ('save_round_tax_result', 'uuid,text,integer,uuid,jsonb')
),
fn as (
  select p.oid, p.proname, pg_catalog.array_to_string(p.proargtypes::oid[]::regtype[], ',') as args,
         pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig,
         coalesce((select array_agg(distinct (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end))
                     from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE'), '{}'::text[]) as grantees
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('record_round_card', 'advance_round_stage', 'get_round_tax_inputs', 'save_round_tax_result')
),
checks as (
  -- 1. Each function exists exactly once (no unintended overloads).
  select 10 as sort, 'function exists once: ' || e.name as chk,
         case when (select count(*) from fn where fn.proname = e.name) = 1
                   and exists (select 1 from fn where fn.proname = e.name and fn.args = e.args) then 'PASS' else 'FAIL' end as status,
         (select count(*) from fn where fn.proname = e.name)::text || ' overload(s); signature '
           || case when exists (select 1 from fn where fn.proname = e.name and fn.args = e.args) then 'matches' else 'DIFFERS (see signature rows)' end as detail
    from expected_functions e
  union all
  -- 2. Signatures: shown for review (argument names are part of the identity string).
  select 20, 'argument types: ' || fn.proname, 'INFO', fn.args from fn
  union all
  -- 3. Security properties, owner and grants.
  select 30, 'security definer + owner postgres + search_path: ' || fn.proname,
         case when fn.prosecdef and fn.owner = 'postgres' and fn.proconfig @> array['search_path=pg_catalog'] then 'PASS' else 'FAIL' end,
         'owner=' || fn.owner || ', secdef=' || fn.prosecdef || ', config=' || coalesce(fn.proconfig::text, 'none')
    from fn
  union all
  select 40, 'tax functions executable by service_role only: ' || fn.proname,
         case when 'service_role' = any (fn.grantees) and fn.grantees <@ array['postgres', 'service_role'] then 'PASS' else 'FAIL' end,
         array_to_string(fn.grantees, ',')
    from fn where fn.proname in ('get_round_tax_inputs', 'save_round_tax_result')
  union all
  -- Existing gameplay RPCs keep their original browser-facing grants (anon expected).
  select 45, 'gameplay RPC grants unchanged (anon expected): ' || fn.proname,
         case when 'anon' = any (fn.grantees) and not 'PUBLIC' = any (fn.grantees) then 'PASS' else 'FAIL' end,
         array_to_string(fn.grantees, ',')
    from fn where fn.proname in ('record_round_card', 'advance_round_stage')
  union all
  -- 4. operation_type constraint.
  select 50, 'operation_type constraint',
         case when count(*) = 1 and bool_and(pg_get_constraintdef(c.oid) like '%calculate-round-tax%'
                                        and pg_get_constraintdef(c.oid) like '%create-life%') then 'PASS' else 'FAIL' end,
         coalesce(string_agg(pg_get_constraintdef(c.oid), ' | '), 'no constraint found')
    from pg_constraint c
   where c.conrelid = 'public.mm_game_operations'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%operation_type%'
  union all
  -- 5. Triggers.
  select 60, 'trigger: ' || t.name,
         case when exists (select 1 from pg_trigger g
                            where g.tgname = t.name and g.tgrelid = t.rel::regclass and not g.tgisinternal and g.tgenabled <> 'D')
              then 'PASS' else 'FAIL' end,
         t.rel
    from (values ('mm_game_lives_set_starting_homeowner', 'public.mm_game_lives'),
                 ('mm_game_card_history_enforce_eligibility', 'public.mm_game_card_history')) as t(name, rel)
  union all
  -- 6. Persistence indexes used for duplicate protection.
  select 70, 'unique index (card_history_id, investment_ordinal): ' || i.name,
         case when exists (select 1 from pg_indexes x where x.schemaname = 'public' and x.indexname = i.name
                              and x.indexdef like 'CREATE UNIQUE%(card_history_id, investment_ordinal)%') then 'PASS' else 'FAIL' end,
         ''
    from (values ('mm_game_investments_card_event_ordinal')) as i(name)
  union all
  select 71, 'unique constraint (card_history_id, effect_ordinal) on mm_game_effects',
         case when exists (select 1 from pg_constraint c where c.conrelid = 'public.mm_game_effects'::regclass
                              and c.contype = 'u' and pg_get_constraintdef(c.oid) = 'UNIQUE (card_history_id, effect_ordinal)')
              then 'PASS' else 'FAIL' end, ''
  union all
  -- 7. Compatibility counts (aggregate only).
  select 80, 'PATH-006 lives past Income with exactly 1 Income card (need a decision)', 'INFO',
         (select count(*) from public.mm_game_lives l
           where l.pathway_id = 'PATH-006' and l.status = 'in_progress' and l.current_round = 1
             and l.current_stage <> 'income-or-retirement'
             and (select count(*) from public.mm_game_card_history h
                   where h.life_id = l.id and h.round_id in (select r.id from public.mm_game_rounds r where r.life_id = l.id and r.round_number = 1)
                     and h.stage = 'income-or-retirement' and h.validation_status = 'accepted') = 1)::text
  union all
  select 81, 'PATH-004 in-progress Round 1 lives still homeowner = false (expected 0 unless a LIFE-005/009 was saved)', 'INFO',
         (select count(*) from public.mm_game_lives l
           where l.pathway_id = 'PATH-004' and l.status = 'in_progress' and l.current_round = 1 and not l.homeowner
             and not exists (select 1 from public.mm_game_card_history h where h.life_id = l.id and h.card_id in ('LIFE-005', 'LIFE-009')))::text
  union all
  select 82, 'PATH-004 lives with saved LIFE-005 or LIFE-009 (manual review if calculating)', 'INFO',
         (select count(distinct l.id) from public.mm_game_lives l join public.mm_game_card_history h on h.life_id = l.id
           where l.pathway_id = 'PATH-004' and h.card_id in ('LIFE-005', 'LIFE-009'))::text
  union all
  select 83, 'Saved Round 1 tax calculations / calculate-round-tax operations', 'INFO',
         (select count(*) from public.mm_game_rounds r where r.calculation_details -> 'tax_calculation' is not null)::text || ' / ' ||
         (select count(*) from public.mm_game_operations o where o.operation_type = 'calculate-round-tax')::text
)
select chk as "check", status, detail from checks order by sort, chk;
