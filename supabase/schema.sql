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
  ('smitha.jayathirtha@gmail.com')
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
  parent_email  text,                   -- the parent signs in with this email
  created_at    timestamptz not null default now()
);
alter table public.children add column if not exists parent_email text;

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

-- Parents: a signed-in user whose email matches a child's parent_email
create or replace function public.is_parent_of(child uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.children c
    where c.id = child
      and c.parent_email is not null
      and lower(c.parent_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_parent_of(uuid) to authenticated;

-- Storage paths start with the child id: <child_id>/<date>/<file>.jpg
create or replace function public.is_parent_of_path(object_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.children c
    where c.id::text = split_part(object_name, '/', 1)
      and c.parent_email is not null
      and lower(c.parent_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_parent_of_path(text) to authenticated;

-- 'staff', 'parent', or null (no access)
create or replace function public.my_role()
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when public.is_staff() then 'staff'
    when exists (
      select 1 from public.children c
      where c.parent_email is not null
        and lower(c.parent_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    ) then 'parent'
  end;
$$;
grant execute on function public.my_role() to authenticated;

-- Allowlisted staff can read and write everything.
-- Parents can only READ their own children and those children's photos.
alter table public.children enable row level security;
alter table public.photos   enable row level security;

drop policy if exists "staff all children" on public.children;
create policy "staff all children" on public.children
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "staff all photos" on public.photos;
create policy "staff all photos" on public.photos
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "parent read own children" on public.children;
create policy "parent read own children" on public.children
  for select to authenticated
  using (parent_email is not null and lower(parent_email) = lower(coalesce(auth.jwt() ->> 'email', '')));

drop policy if exists "parent read own photos" on public.photos;
create policy "parent read own photos" on public.photos
  for select to authenticated using (public.is_parent_of(child_id));

-- Daily note (one per child per day): lunch, snack, bowel movement, nap, notes
create table if not exists public.daily_notes (
  id            uuid primary key default gen_random_uuid(),
  child_id      uuid not null references public.children(id) on delete cascade,
  note_date     date not null,
  lunch         text check (lunch in ('none', 'some', 'most', 'all')),
  snack         boolean,
  bowel         boolean,
  bowel_times   int check (bowel_times between 0 and 20),
  nap           boolean,
  nap_duration  text,                   -- e.g. "1h 30m"
  notes         text,
  teacher_name  text,                   -- the teacher's sign
  updated_by    uuid references auth.users(id) default auth.uid(),
  updated_at    timestamptz not null default now(),
  unique (child_id, note_date)
);
alter table public.daily_notes enable row level security;

drop policy if exists "staff all notes" on public.daily_notes;
create policy "staff all notes" on public.daily_notes
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "parent read own notes" on public.daily_notes;
create policy "parent read own notes" on public.daily_notes
  for select to authenticated using (public.is_parent_of(child_id));

-- Private storage bucket for the photo files
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "staff read photos"   on storage.objects;
drop policy if exists "staff upload photos" on storage.objects;
drop policy if exists "staff delete photos" on storage.objects;
drop policy if exists "parent read photos"  on storage.objects;
create policy "parent read photos" on storage.objects
  for select to authenticated using (bucket_id = 'photos' and public.is_parent_of_path(name));
create policy "staff read photos" on storage.objects
  for select to authenticated using (bucket_id = 'photos' and public.is_staff());
create policy "staff upload photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'photos' and public.is_staff());
create policy "staff delete photos" on storage.objects
  for delete to authenticated using (bucket_id = 'photos' and public.is_staff());
