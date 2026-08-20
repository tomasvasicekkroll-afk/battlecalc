-- Battlecalc — Supabase schema for goal 2 (user accounts + database)
--
-- Keeps the same key/value shape the app already uses (library_v2, armies_v1,
-- history_v1 — each a JSON-stringified blob), just scoped per user instead of
-- per Claude.ai session. Run this once in the Supabase SQL editor.

create table if not exists public.user_data (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.user_data enable row level security;

create policy "user_data_select_own"
  on public.user_data for select
  using (auth.uid() = user_id);

create policy "user_data_insert_own"
  on public.user_data for insert
  with check (auth.uid() = user_id);

create policy "user_data_update_own"
  on public.user_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_data_delete_own"
  on public.user_data for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Goal 3 (later): community-shared units. Each row is one unit a user chose
-- to publish from their own library — never an official GW datasheet dump.
-- Left here as a placeholder so the shape is decided up front; not wired into
-- the app yet.
-- ---------------------------------------------------------------------------
-- create table if not exists public.shared_units (
--   id uuid primary key default gen_random_uuid(),
--   owner_id uuid not null references auth.users(id) on delete cascade,
--   unit jsonb not null,
--   created_at timestamptz not null default now()
-- );
-- alter table public.shared_units enable row level security;
-- create policy "shared_units_public_read" on public.shared_units for select using (true);
-- create policy "shared_units_owner_write" on public.shared_units for insert with check (auth.uid() = owner_id);
-- create policy "shared_units_owner_delete" on public.shared_units for delete using (auth.uid() = owner_id);
