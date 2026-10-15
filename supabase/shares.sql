-- Battlecalc — sharing units/armies between users by private link.
-- Run once in the Supabase SQL editor, AFTER schema.sql.
--
-- There is deliberately no browsable catalogue: a share is only reachable by
-- someone who has its random link token, it expires on its own, and the person
-- who created it can delete it at any time. Other users cannot list or search
-- shares; they can only open one through get_share() with the exact token.

create table if not exists public.shares (
  token text primary key check (token ~ '^[A-Za-z0-9_-]{16,64}$'),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '',
  payload jsonb not null,
  unit_count integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  constraint shares_payload_size check (pg_column_size(payload) < 3000000)
);
create index if not exists shares_owner_idx on public.shares (owner_id, created_at desc);

alter table public.shares enable row level security;

-- You see and manage only your own shares.
create policy "shares_owner_select"
  on public.shares for select to authenticated
  using (owner_id = auth.uid());

-- At most 30 active shares per person.
create policy "shares_owner_insert"
  on public.shares for insert to authenticated
  with check (
    owner_id = auth.uid()
    and (select count(*) from public.shares s where s.owner_id = auth.uid() and s.expires_at > now()) < 30
  );

create policy "shares_owner_delete"
  on public.shares for delete to authenticated
  using (owner_id = auth.uid());

-- Opening a share by its token (the only way another user can read one).
create or replace function public.get_share(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('title', title, 'payload', payload, 'created_at', created_at, 'expires_at', expires_at)
  from public.shares
  where token = p_token and expires_at > now();
$$;
revoke all on function public.get_share(text) from public;
grant execute on function public.get_share(text) to authenticated;

-- Optional housekeeping (needs the pg_cron extension): purge expired shares daily.
-- select cron.schedule('purge-expired-shares', '17 3 * * *', $$delete from public.shares where expires_at < now()$$);
