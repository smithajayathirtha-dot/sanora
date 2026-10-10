-- Sanora: photo workflow schema
-- Run this once in Supabase → SQL Editor → New query → Run.
-- Safe to re-run.

-- ---------------------------------------------------------------
-- Staff allowlist: only these Google accounts can use the app.
-- Add a teacher:    insert into public.staff (email) values ('name@gmail.com');
-- Remove a teacher: delete from public.staff where email = 'name@gmail.com';
-- ---------------------------------------------------------------
create table if not exists public.staff (
  email      text primary key,
  added_at   timestamptz not null default now()
);
insert into public.staff (email) values
  ('smitha.jayathirtha@gmail.com'),
  ('santosh.kikkeri@gmail.com')
on conflict (email) do nothing;

-- True when the signed-in user's verified email is on the allowlist
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.staff
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_staff() to authenticated;

alter table public.staff enable row level security;   -- no policies: not readable from the app

-- Children and their parent's WhatsApp contact
create table if not exists public.children (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  parent_name   text not null,
  parent_phone  text not null,          -- with country code, e.g. +14085551234
  created_at    timestamptz not null default now()
);

-- One row per uploaded photo, filed by child and date
create table if not exists public.photos (
  id           uuid primary key default gen_random_uuid(),
  child_id     uuid not null references public.children(id) on delete cascade,
  taken_on     date not null,
  path         text not null unique,    -- storage path: <child_id>/<taken_on>/<uuid>.jpg
  uploaded_by  uuid references auth.users(id) default auth.uid(),
  shared_at    timestamptz,             -- set when the teacher shares it
  created_at   timestamptz not null default now()
);
create index if not exists photos_child_date on public.photos (child_id, taken_on);

-- Only allowlisted staff can read or write. Parents never sign in;
-- they receive photos over WhatsApp.
alter table public.children enable row level security;
alter table public.photos   enable row level security;

drop policy if exists "staff all children" on public.children;
create policy "staff all children" on public.children
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "staff all photos" on public.photos;
create policy "staff all photos" on public.photos
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- Private storage bucket for the photo files
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "staff read photos"   on storage.objects;
drop policy if exists "staff upload photos" on storage.objects;
drop policy if exists "staff delete photos" on storage.objects;
create policy "staff read photos" on storage.objects
  for select to authenticated using (bucket_id = 'photos' and public.is_staff());
create policy "staff upload photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'photos' and public.is_staff());
create policy "staff delete photos" on storage.objects
  for delete to authenticated using (bucket_id = 'photos' and public.is_staff());
