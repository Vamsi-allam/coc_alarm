create table if not exists public.builder_timers (
  id uuid primary key default gen_random_uuid(),
  account text not null,
  village text not null check (village in ('Home Village', 'Night Village')),
  builder_number integer not null check (builder_number > 0),
  finish_at timestamptz not null,
  discord_alert_enabled boolean not null default false,
  discord_alert_sent_at timestamptz,
  discord_alert_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint builder_timers_unique_builder unique (account, village, builder_number)
);

alter table public.builder_timers
  add column if not exists discord_alert_enabled boolean not null default false,
  add column if not exists discord_alert_sent_at timestamptz,
  add column if not exists discord_alert_claimed_at timestamptz;

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