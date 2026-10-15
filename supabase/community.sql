-- Battlecalc — community unit library (goal 3).
-- Run once in the Supabase SQL editor, AFTER schema.sql.
--
-- Model: everybody who is signed in can READ and copy units into their own
-- library; only admins (rows in app_admins) can publish, update or delete.
-- Admins upload their own New Recruit imports from the app (Knihovna ->
-- Komunita -> "Nahrát mou knihovnu do komunity").

-- Who may publish. No policies on purpose: clients cannot read or change this
-- table, only the is_admin() function below can look into it.
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.app_admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- One row per distinct unit. `sig` is a hash of the unit's content (ids
-- stripped), so uploading the same unit twice just updates the row.
create table if not exists public.shared_units (
  id uuid primary key default gen_random_uuid(),
  sig text not null unique,
  faction text not null default '',
  name text not null,
  points text not null default '',
  model_count integer not null default 1,
  unit jsonb not null,
  published_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists shared_units_faction_name_idx on public.shared_units (faction, name);

alter table public.shared_units enable row level security;

create policy "shared_units_read_authenticated"
  on public.shared_units for select to authenticated
  using (true);

create policy "shared_units_admin_insert"
  on public.shared_units for insert to authenticated
  with check (public.is_admin());

create policy "shared_units_admin_update"
  on public.shared_units for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "shared_units_admin_delete"
  on public.shared_units for delete to authenticated
  using (public.is_admin());

-- Make yourself the admin (replace the e-mail with the one you sign in with):
-- insert into public.app_admins (user_id)
--   select id from auth.users where email = 'tvuj@email.cz';
