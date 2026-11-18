create table if not exists public.builder_timers (
  id uuid primary key default gen_random_uuid(),
  account text not null,
  village text not null check (village in ('Home Village', 'Night Village')),
  builder_type text not null default 'Builder',
  builder_number integer not null check (builder_number > 0),
  finish_at timestamptz not null,
  discord_alert_enabled boolean not null default false,
  discord_alert_sent_at timestamptz,
  discord_alert_claimed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.builder_timers
  add column if not exists builder_type text not null default 'Builder',
  add column if not exists discord_alert_enabled boolean not null default false,
  add column if not exists discord_alert_sent_at timestamptz,
  add column if not exists discord_alert_claimed_at timestamptz;

alter table public.builder_timers
  drop constraint if exists builder_timers_unique_builder;

create unique index if not exists builder_timers_unique_typed_builder
  on public.builder_timers (account, village, builder_type, builder_number);

update public.builder_timers
set discord_alert_enabled = true
where finish_at > now()
  and discord_alert_sent_at is null
  and not discord_alert_enabled;

create index if not exists builder_timers_alert_queue_idx
  on public.builder_timers (finish_at)
  where discord_alert_enabled and discord_alert_sent_at is null;

create or replace function public.claim_due_builder_alerts(batch_size integer default 50)
returns setof public.builder_timers
language sql
security definer
set search_path = ''
as $$
  with due as (
    select id
    from public.builder_timers
    where discord_alert_enabled
      and discord_alert_sent_at is null
      and finish_at <= now()
      and (
        discord_alert_claimed_at is null
        or discord_alert_claimed_at < now() - interval '5 minutes'
      )
    order by finish_at
    limit least(greatest(batch_size, 1), 100)
    for update skip locked
  )
  update public.builder_timers as timers
  set discord_alert_claimed_at = now()
  from due
  where timers.id = due.id
  returning timers.*;
$$;

revoke all on function public.claim_due_builder_alerts(integer) from public, anon, authenticated;
grant execute on function public.claim_due_builder_alerts(integer) to service_role;

alter table public.builder_timers enable row level security;

grant select, insert, update, delete on public.builder_timers to anon;

drop policy if exists "Public can read builder timers" on public.builder_timers;
create policy "Public can read builder timers"
  on public.builder_timers for select to anon using (true);

drop policy if exists "Public can add builder timers" on public.builder_timers;
create policy "Public can add builder timers"
  on public.builder_timers for insert to anon with check (true);

drop policy if exists "Public can update builder timers" on public.builder_timers;
create policy "Public can update builder timers"
  on public.builder_timers for update to anon using (true) with check (true);

drop policy if exists "Public can delete builder timers" on public.builder_timers;
create policy "Public can delete builder timers"
  on public.builder_timers for delete to anon using (true);

create table if not exists public.lab_assistants (
  account_key text primary key check (length(btrim(account_key)) > 0),
  level integer not null default 1 check (level between 1 and 12),
  timer_id uuid references public.builder_timers(id) on delete set null,
  started_at timestamptz,
  workday_end_at timestamptz,
  work_until_at timestamptz,
  next_session_at timestamptz,
  base_finish_at timestamptz,
  projected_finish_at timestamptz,
  keep_assigned boolean not null default false,
  saved_seconds double precision not null default 0
);

alter table public.lab_assistants
  add column if not exists helper_type text not null default 'Lab';

-- Preserve existing Lab Assistant records while allowing one Apprentice per account too.
alter table if exists public.lab_assistant_alerts
  drop constraint if exists lab_assistant_alerts_account_key_fkey;
alter table public.lab_assistants drop constraint if exists lab_assistants_pkey;
alter table public.lab_assistants add primary key (account_key, helper_type);
alter table public.lab_assistants drop constraint if exists lab_assistants_helper_type_check;
alter table public.lab_assistants add constraint lab_assistants_helper_type_check
  check (helper_type in ('Lab', 'Builder') and (helper_type <> 'Builder' or level <= 8));

alter table public.lab_assistants enable row level security;
grant select on public.lab_assistants to anon;
drop policy if exists "Public can read lab assistants" on public.lab_assistants;
create policy "Public can read lab assistants"
  on public.lab_assistants for select to anon using (true);

create or replace function public.lab_assistant_last_start(a public.lab_assistants, at_time timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case
    when a.keep_assigned and a.timer_id is not null
      and a.projected_finish_at > a.next_session_at and at_time >= a.next_session_at
    then a.next_session_at + (
      floor(extract(epoch from (least(at_time, a.projected_finish_at - interval '1 microsecond') - a.next_session_at)) / 82800)
      * interval '23 hours'
    )
    else a.started_at
  end;
$$;

create or replace function public.guard_assigned_lab_timer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'DELETE' or new.finish_at is distinct from old.finish_at)
    and exists (
      select 1 from public.lab_assistants
      where timer_id = old.id and projected_finish_at > clock_timestamp()
    ) then
    raise exception 'Stop helper tracking before changing or removing this timer.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_assigned_lab_timer on public.builder_timers;
create trigger guard_assigned_lab_timer
  before update or delete on public.builder_timers
  for each row execute function public.guard_assigned_lab_timer();

create or replace function public.assign_village_helper(
  p_helper_type text, p_timer_id uuid, p_level integer, p_keep_assigned boolean,
  p_workday_seconds integer, p_expected_finish timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.builder_timers%rowtype;
  a public.lab_assistants%rowtype;
  now_at timestamptz := clock_timestamp();
  last_start timestamptz;
  ready_at timestamptz;
  day_end timestamptz;
  next_session timestamptz;
  cursor_at timestamptz;
  v_finish_at timestamptz;
  remaining double precision;
  work_seconds double precision;
  gap_seconds double precision;
  cycles double precision;
  previous_saved double precision := 0;
  helper_name text;
  max_level integer;
begin
  if p_helper_type is null or p_helper_type not in ('Lab', 'Builder') then
    raise exception 'Select a Home Village Builder or Lab timer.';
  end if;
  helper_name := case when p_helper_type = 'Builder' then 'Builder''s Apprentice' else 'Lab Assistant' end;
  max_level := case when p_helper_type = 'Builder' then 8 else 12 end;
  if p_level is null or p_level < 1 or p_level > max_level or p_keep_assigned is null
    or (p_workday_seconds is not null and (p_workday_seconds < 1 or p_workday_seconds > 82800)) then
    raise exception 'Choose a % level from 1 to % and a workday of at most 23 hours.', helper_name, max_level;
  end if;
  select * into t from public.builder_timers where id = p_timer_id;
  if not found or t.village <> 'Home Village' or t.builder_type <> p_helper_type then
    raise exception 'Select a Home Village % timer.', p_helper_type;
  end if;
  -- Serialize assignments for both helpers so they agree on the shared workday.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(btrim(t.account)), 0));
  insert into public.lab_assistants (account_key, helper_type)
  values (lower(btrim(t.account)), p_helper_type) on conflict (account_key, helper_type) do nothing;
  select * into a from public.lab_assistants
    where account_key = lower(btrim(t.account)) and helper_type = p_helper_type for update;
  select * into t from public.builder_timers where id = p_timer_id for update;
  now_at := clock_timestamp();
  if not found or t.village <> 'Home Village' or t.builder_type <> p_helper_type
    or lower(btrim(t.account)) <> a.account_key or t.finish_at is distinct from p_expected_finish then
    raise exception 'The timer changed. Reload and try again.';
  end if;
  if t.finish_at <= now_at then raise exception 'Start an upgrade before assigning the helper.'; end if;
  if a.started_at is not null then
    if a.keep_assigned and a.timer_id is not null and a.projected_finish_at > now_at then
      raise exception 'The % is already kept assigned to an upgrade.', helper_name;
    end if;
    if a.timer_id is distinct from p_timer_id and a.projected_finish_at > now_at then
      raise exception 'The % is assigned to another timer.', helper_name;
    end if;
    last_start := public.lab_assistant_last_start(a, now_at);
    if last_start = a.started_at then
      ready_at := greatest(a.workday_end_at, a.work_until_at);
    else
      ready_at := greatest(last_start + interval '23 hours', least(last_start + interval '1 hour', a.projected_finish_at));
    end if;
    if now_at < ready_at then raise exception 'The % is still on cooldown.', helper_name; end if;
  end if;
  if a.timer_id = p_timer_id and coalesce(a.projected_finish_at, a.base_finish_at) = t.finish_at then
    previous_saved := a.saved_seconds;
    if a.projected_finish_at is not null then
      previous_saved := previous_saved + a.level * greatest(0, least(3600, extract(epoch from (least(now_at, a.projected_finish_at) - a.started_at))));
    end if;
  end if;
  select max(case when public.lab_assistant_last_start(h, now_at) = h.started_at
    then h.workday_end_at else public.lab_assistant_last_start(h, now_at) + interval '23 hours' end)
    into day_end from public.lab_assistants h where h.account_key = a.account_key;
  if day_end is null or day_end <= now_at then
    day_end := now_at + coalesce(p_workday_seconds, 82800) * interval '1 second';
  end if;
  next_session := greatest(day_end, now_at + interval '1 hour');
  remaining := extract(epoch from (t.finish_at - now_at));
  work_seconds := least(3600, remaining / (p_level + 1));
  remaining := greatest(0, remaining - work_seconds * (p_level + 1));
  cursor_at := now_at + work_seconds * interval '1 second';
  if remaining > 0 and p_keep_assigned then
    gap_seconds := extract(epoch from (next_session - cursor_at));
    if remaining > gap_seconds then
      remaining := remaining - gap_seconds;
      cycles := greatest(0, ceil(remaining / (82800 + p_level * 3600)) - 1);
      remaining := remaining - cycles * (82800 + p_level * 3600);
      cursor_at := next_session + cycles * interval '23 hours';
      work_seconds := least(3600, remaining / (p_level + 1));
      remaining := greatest(0, remaining - work_seconds * (p_level + 1));
      cursor_at := cursor_at + work_seconds * interval '1 second';
    end if;
  end if;
  v_finish_at := cursor_at + remaining * interval '1 second';
  update public.lab_assistants
    set timer_id = null, projected_finish_at = null, keep_assigned = false
    where account_key = a.account_key and helper_type = p_helper_type;
  update public.builder_timers
    set finish_at = v_finish_at, discord_alert_enabled = true,
        discord_alert_sent_at = null, discord_alert_claimed_at = null
    where id = p_timer_id returning * into t;
  update public.lab_assistants
    set level = p_level, timer_id = p_timer_id, started_at = now_at,
        workday_end_at = day_end, work_until_at = least(now_at + interval '1 hour', v_finish_at),
        next_session_at = next_session, base_finish_at = p_expected_finish,
        projected_finish_at = v_finish_at, keep_assigned = p_keep_assigned, saved_seconds = previous_saved
    where account_key = a.account_key and helper_type = p_helper_type returning * into a;
  return jsonb_build_object('timer', to_jsonb(t), 'assistant', to_jsonb(a));
end;
$$;

create or replace function public.stop_village_helper(p_helper_type text, p_timer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.builder_timers%rowtype;
  a public.lab_assistants%rowtype;
  now_at timestamptz := clock_timestamp();
  last_start timestamptz;
  end_at timestamptz;
  saved double precision;
  elapsed double precision;
  restored_finish timestamptz;
begin
  select * into a from public.lab_assistants where timer_id = p_timer_id and helper_type = p_helper_type for update;
  if not found or a.projected_finish_at is null or a.projected_finish_at <= now_at then
    raise exception 'There is no active helper assignment for this timer.';
  end if;
  select * into t from public.builder_timers where id = p_timer_id for update;
  now_at := clock_timestamp();
  if a.projected_finish_at <= now_at then
    raise exception 'There is no active helper assignment for this timer.';
  end if;
  if not found or t.finish_at is distinct from a.projected_finish_at then
    raise exception 'The timer changed. Reload and try again.';
  end if;
  end_at := least(now_at, a.projected_finish_at);
  saved := a.level * greatest(0, least(3600, extract(epoch from (end_at - a.started_at))));
  if a.keep_assigned and end_at > a.next_session_at then
    elapsed := extract(epoch from (end_at - a.next_session_at));
    saved := saved + a.level * (floor(elapsed / 82800) * 3600 + least(3600, mod(elapsed::numeric, 82800)::double precision));
  end if;
  restored_finish := greatest(now_at, a.base_finish_at - saved * interval '1 second');
  saved := saved + a.saved_seconds;
  last_start := public.lab_assistant_last_start(a, now_at);
  update public.lab_assistants
    set timer_id = p_timer_id, started_at = last_start,
        workday_end_at = case when last_start = a.started_at then a.workday_end_at else last_start + interval '23 hours' end,
        work_until_at = now_at, next_session_at = null, base_finish_at = restored_finish,
        projected_finish_at = null, keep_assigned = false, saved_seconds = saved
    where account_key = a.account_key and helper_type = p_helper_type returning * into a;
  update public.builder_timers
    set finish_at = restored_finish, discord_alert_enabled = restored_finish > now_at,
        discord_alert_sent_at = null, discord_alert_claimed_at = null
    where id = p_timer_id returning * into t;
  return jsonb_build_object('timer', to_jsonb(t), 'assistant', to_jsonb(a));
end;
$$;

create or replace function public.assign_lab_assistant(
  p_timer_id uuid, p_level integer, p_keep_assigned boolean,
  p_workday_seconds integer, p_expected_finish timestamptz
)
returns jsonb language sql security definer set search_path = ''
as $$
  select public.assign_village_helper('Lab', p_timer_id, p_level, p_keep_assigned, p_workday_seconds, p_expected_finish);
$$;

create or replace function public.stop_lab_assistant(p_timer_id uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select public.stop_village_helper('Lab', p_timer_id); $$;

revoke all on function public.assign_village_helper(text, uuid, integer, boolean, integer, timestamptz) from public;
revoke all on function public.stop_village_helper(text, uuid) from public;
grant execute on function public.assign_village_helper(text, uuid, integer, boolean, integer, timestamptz) to anon;
grant execute on function public.stop_village_helper(text, uuid) to anon;
revoke all on function public.assign_lab_assistant(uuid, integer, boolean, integer, timestamptz) from public;
revoke all on function public.stop_lab_assistant(uuid) from public;
grant execute on function public.assign_lab_assistant(uuid, integer, boolean, integer, timestamptz) to anon;
grant execute on function public.stop_lab_assistant(uuid) to anon;

create table if not exists public.lab_assistant_alerts (
  id uuid primary key default gen_random_uuid(),
  account_key text not null,
  helper_type text not null default 'Lab',
  assignment_started_at timestamptz not null,
  event_type text not null check (event_type in ('work_finished', 'available', 'upgrade_finished')),
  due_at timestamptz not null,
  account text not null,
  builder_number integer,
  sent_at timestamptz,
  claimed_at timestamptz
);

alter table public.lab_assistant_alerts add column if not exists helper_type text not null default 'Lab';
-- Replace the legacy unique constraint regardless of PostgreSQL's truncated generated name.
do $$
declare legacy_name text;
begin
  for legacy_name in select conname from pg_catalog.pg_constraint
    where conrelid = 'public.lab_assistant_alerts'::regclass and contype = 'u'
      and pg_catalog.pg_get_constraintdef(oid) not like '%helper_type%'
  loop
    execute format('alter table public.lab_assistant_alerts drop constraint %I', legacy_name);
  end loop;
end;
$$;
create unique index if not exists lab_assistant_alerts_helper_event_idx
  on public.lab_assistant_alerts(account_key, helper_type, assignment_started_at, event_type, due_at);
alter table public.lab_assistant_alerts add constraint lab_assistant_alerts_account_key_fkey
  foreign key (account_key, helper_type) references public.lab_assistants(account_key, helper_type) on delete cascade;

alter table public.lab_assistant_alerts enable row level security;
revoke all on public.lab_assistant_alerts from anon, authenticated;
grant select, update on public.lab_assistant_alerts to service_role;
create index if not exists lab_assistant_alerts_due_idx
  on public.lab_assistant_alerts (due_at) where sent_at is null;

create or replace function public.schedule_lab_assistant_alerts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.builder_timers%rowtype;
  last_start timestamptz;
  ready_at timestamptz;
begin
  delete from public.lab_assistant_alerts where account_key = new.account_key and helper_type = new.helper_type and sent_at is null;
  if new.started_at is null then return new; end if;
  select * into t from public.builder_timers where id = new.timer_id;
  last_start := public.lab_assistant_last_start(new, coalesce(new.projected_finish_at, new.started_at));
  ready_at := case when last_start = new.started_at
    then greatest(new.workday_end_at, new.work_until_at)
    else greatest(last_start + interval '23 hours', least(last_start + interval '1 hour', new.projected_finish_at))
  end;
  insert into public.lab_assistant_alerts
    (account_key, helper_type, assignment_started_at, event_type, due_at, account, builder_number)
  values
    (new.account_key, new.helper_type, new.started_at, 'available', ready_at, coalesce(t.account, new.account_key), t.builder_number)
  on conflict do nothing;
  if new.projected_finish_at is not null and t.finish_at = new.projected_finish_at then
    insert into public.lab_assistant_alerts
      (account_key, helper_type, assignment_started_at, event_type, due_at, account, builder_number)
    values
      (new.account_key, new.helper_type, new.started_at, 'work_finished', new.work_until_at, t.account, t.builder_number),
      (new.account_key, new.helper_type, new.started_at, 'upgrade_finished', new.projected_finish_at, t.account, t.builder_number)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_lab_assistant_alerts on public.lab_assistants;
create trigger schedule_lab_assistant_alerts
  after insert or update of started_at, timer_id, projected_finish_at, keep_assigned on public.lab_assistants
  for each row execute function public.schedule_lab_assistant_alerts();

-- Seed assignments that were already tracked before this migration.
update public.lab_assistants set started_at = started_at where started_at is not null;

create or replace function public.claim_due_lab_assistant_alerts(batch_size integer default 50)
returns setof public.lab_assistant_alerts
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Repeated sessions are materialized only once they finish, not for the entire upgrade in advance.
  insert into public.lab_assistant_alerts
    (account_key, helper_type, assignment_started_at, event_type, due_at, account, builder_number)
  select a.account_key, a.helper_type, a.started_at, 'work_finished',
    least(session_start + interval '1 hour', a.projected_finish_at), t.account, t.builder_number
  from public.lab_assistants a
  join public.builder_timers t on t.id = a.timer_id and t.finish_at = a.projected_finish_at
  cross join lateral generate_series(
    a.next_session_at, least(now(), a.projected_finish_at - interval '1 microsecond'), interval '23 hours'
  ) as sessions(session_start)
  where a.keep_assigned and a.projected_finish_at > a.next_session_at
    and least(session_start + interval '1 hour', a.projected_finish_at) <= now()
  on conflict do nothing;

  return query
  with due as (
    select e.id
    from public.lab_assistant_alerts e
    join public.lab_assistants a on a.account_key = e.account_key and a.helper_type = e.helper_type and a.started_at = e.assignment_started_at
    left join public.builder_timers t on t.id = a.timer_id
    where e.sent_at is null and e.due_at <= now()
      and (e.claimed_at is null or e.claimed_at < now() - interval '5 minutes')
      and (e.event_type = 'available' or t.finish_at = a.projected_finish_at)
    order by e.due_at, e.id
    limit least(greatest(batch_size, 1), 100)
    for update of e skip locked
  )
  update public.lab_assistant_alerts e set claimed_at = now()
  from due where e.id = due.id returning e.*;
end;
$$;

revoke all on function public.claim_due_lab_assistant_alerts(integer) from public, anon, authenticated;
grant execute on function public.claim_due_lab_assistant_alerts(integer) to service_role;

create table if not exists public.account_order (
  id integer primary key check (id = 1),
  accounts text[] not null default '{}'
);

alter table public.account_order
  add column if not exists local_import_disabled boolean not null default false;

alter table public.account_order enable row level security;
grant select, insert, update on public.account_order to anon;

drop policy if exists "Public can read account order" on public.account_order;
create policy "Public can read account order"
  on public.account_order for select to anon using (true);

drop policy if exists "Public can add account order" on public.account_order;
create policy "Public can add account order"
  on public.account_order for insert to anon with check (true);

drop policy if exists "Public can update account order" on public.account_order;
create policy "Public can update account order"
  on public.account_order for update to anon using (true) with check (true);

create table if not exists public.discord_webhooks (
  account text primary key check (length(btrim(account)) > 0),
  webhook_url text not null check (
    webhook_url ~ '^https://(discord\.com|discordapp\.com)/api/webhooks/[0-9]+/[^[:space:]]+$'
  ),
  created_at timestamptz not null default now()
);

create unique index if not exists discord_webhooks_account_normalized_idx
  on public.discord_webhooks (lower(btrim(account)));

alter table public.discord_webhooks enable row level security;
revoke all on public.discord_webhooks from anon, authenticated;
grant select, insert, update, delete on public.discord_webhooks to service_role;

create table if not exists public.clock_towers (
  account_key text primary key check (length(btrim(account_key)) > 0),
  started_at timestamptz not null,
  ends_at timestamptz not null,
  available_at timestamptz not null,
  check (ends_at > started_at and available_at >= ends_at)
);

alter table public.clock_towers enable row level security;
grant select on public.clock_towers to anon;
drop policy if exists "Public can read clock towers" on public.clock_towers;
create policy "Public can read clock towers"
  on public.clock_towers for select to anon using (true);

alter table public.builder_timers
  add column if not exists clock_started_at timestamptz,
  add column if not exists clock_ends_at timestamptz,
  add column if not exists clock_base_finish_at timestamptz,
  add column if not exists clock_saved_seconds double precision not null default 0;

create table if not exists public.clock_tower_alerts (
  id uuid primary key default gen_random_uuid(),
  account text not null,
  due_at timestamptz not null,
  sent_at timestamptz,
  claimed_at timestamptz,
  unique (account, due_at)
);
alter table public.clock_tower_alerts enable row level security;
revoke all on public.clock_tower_alerts from public, anon, authenticated;
grant select, update on public.clock_tower_alerts to service_role;

create or replace function public.apply_clock_tower()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.clock_towers%rowtype;
  at_time timestamptz;
  keep_saved double precision := 0;
  new_boost boolean := false;
begin
  if new.village = 'Night Village' and new.builder_type in ('Builder', 'Lab') then
    perform pg_advisory_xact_lock(hashtextextended(lower(btrim(new.account)), 22));
    select * into c from public.clock_towers
      where account_key = lower(btrim(new.account));
  end if;
  at_time := date_trunc('milliseconds', clock_timestamp());
  if tg_op = 'UPDATE' then
    new_boost := c.ends_at > at_time and (old.clock_started_at is null or c.started_at > old.clock_started_at);
    if new.finish_at is not distinct from old.finish_at
      and new.account = old.account and new.village = old.village and new.builder_type = old.builder_type
      and not coalesce(new_boost, false) then
      new.clock_started_at := old.clock_started_at;
      new.clock_ends_at := old.clock_ends_at;
      new.clock_base_finish_at := old.clock_base_finish_at;
      new.clock_saved_seconds := old.clock_saved_seconds;
      return new;
    end if;
    if new_boost and new.finish_at = old.finish_at then
      keep_saved := old.clock_saved_seconds + case when old.clock_started_at is null then 0 else
        greatest(0, extract(epoch from (least(at_time, old.clock_ends_at, old.finish_at) - old.clock_started_at))) * 9 end;
    end if;
  end if;
  new.clock_started_at := null;
  new.clock_ends_at := null;
  new.clock_base_finish_at := null;
  new.clock_saved_seconds := 0;
  if c.ends_at > at_time and new.finish_at > clock_timestamp() then
    new.clock_started_at := at_time;
    new.clock_ends_at := c.ends_at;
    new.clock_base_finish_at := new.finish_at;
    new.clock_saved_seconds := keep_saved;
    new.finish_at := date_trunc('milliseconds', new.finish_at
      - least(c.ends_at - at_time, (new.finish_at - at_time) / 10) * 9);
    new.discord_alert_enabled := true;
    new.discord_alert_sent_at := null;
    new.discord_alert_claimed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists apply_clock_tower on public.builder_timers;
create trigger apply_clock_tower before insert or update on public.builder_timers
  for each row execute function public.apply_clock_tower();

create or replace function public.activate_clock_tower(p_account text, p_duration_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_key_value text := lower(btrim(p_account));
  at_time timestamptz;
  c public.clock_towers%rowtype;
  timers jsonb;
begin
  if p_account is null or account_key_value = '' or p_duration_seconds is null
    or p_duration_seconds < 1 or p_duration_seconds > 79200 then
    raise exception 'Enter a boost duration between 1 second and 22 hours.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(account_key_value, 22));
  at_time := date_trunc('milliseconds', clock_timestamp());
  if not exists (select 1 from public.builder_timers where lower(btrim(account)) = account_key_value
    and village = 'Night Village' and builder_type in ('Builder', 'Lab')) then
    raise exception 'Add Night Village Builders or Lab timers for this account first.';
  end if;
  select * into c from public.clock_towers where account_key = account_key_value for update;
  if c.available_at > at_time then raise exception 'The Clock Tower is still on cooldown.'; end if;
  insert into public.clock_towers (account_key, started_at, ends_at, available_at)
    values (account_key_value, at_time, at_time + make_interval(secs => p_duration_seconds), at_time + interval '22 hours')
    on conflict (account_key) do update set started_at = excluded.started_at,
      ends_at = excluded.ends_at, available_at = excluded.available_at
    returning * into c;
  -- The trigger applies this account-wide boost and also handles timers set during it.
  with updated as (
    update public.builder_timers set finish_at = finish_at
    where lower(btrim(account)) = account_key_value and village = 'Night Village'
      and builder_type in ('Builder', 'Lab') and finish_at > at_time
    returning *
  ) select coalesce(jsonb_agg(to_jsonb(updated)), '[]'::jsonb) into timers from updated;
  insert into public.clock_tower_alerts (account, due_at) values (btrim(p_account), c.available_at);
  return jsonb_build_object('boost', to_jsonb(c), 'timers', timers);
end;
$$;
revoke all on function public.activate_clock_tower(text, integer) from public, anon, authenticated;
grant execute on function public.activate_clock_tower(text, integer) to anon;

create or replace function public.claim_due_clock_tower_alerts(batch_size integer default 50)
returns setof public.clock_tower_alerts
language sql
security definer
set search_path = ''
as $$
  with due as (
    select id from public.clock_tower_alerts
    where due_at <= now() and sent_at is null
      and (claimed_at is null or claimed_at < now() - interval '5 minutes')
    order by due_at limit least(greatest(batch_size, 1), 100)
    for update skip locked
  )
  update public.clock_tower_alerts a set claimed_at = now()
  from due where a.id = due.id returning a.*;
$$;
revoke all on function public.claim_due_clock_tower_alerts(integer) from public, anon, authenticated;
grant execute on function public.claim_due_clock_tower_alerts(integer) to service_role;

create or replace function public.remove_builder_account(p_account text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  key_value text := lower(btrim(p_account));
begin
  if key_value is null or key_value = '' then
    raise exception 'Choose an account to remove.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(key_value, 0));
  perform pg_advisory_xact_lock(hashtextextended(key_value, 22));
  -- Remove helper reservations first so active timers can be deleted normally.
  delete from public.lab_assistants where lower(btrim(account_key)) = key_value;
  delete from public.clock_tower_alerts where lower(btrim(account)) = key_value;
  delete from public.clock_towers where lower(btrim(account_key)) = key_value;
  delete from public.builder_timers where lower(btrim(account)) = key_value;
  delete from public.discord_webhooks where lower(btrim(account)) = key_value;
  -- An intentionally empty cloud must not be repopulated by another browser's old cache.
  insert into public.account_order (id, accounts, local_import_disabled)
    values (1, '{}', true)
    on conflict (id) do update set
      accounts = array(
        select entry from unnest(public.account_order.accounts) with ordinality as entries(entry, position)
        where lower(btrim(entry)) <> key_value order by position
      ),
      local_import_disabled = true;
end;
$$;
revoke all on function public.remove_builder_account(text) from public, anon, authenticated;
grant execute on function public.remove_builder_account(text) to anon;