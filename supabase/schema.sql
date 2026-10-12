-- Sanora schema
-- Run this in Supabase → SQL Editor → New query → Run.
-- Safe to re-run: it creates what's missing and updates rules in place.

-- ===============================================================
-- 1. Tables
-- ===============================================================

-- Centers (each has its own page, staff and children)
create table if not exists public.centers (
  id         text primary key,             -- slug, also the page path: /<id>/
  name       text not null,
  created_at timestamptz not null default now()
);
-- Where the center is, for parent arrival reminders (set by the head from the app)
alter table public.centers add column if not exists lat double precision;
alter table public.centers add column if not exists lng double precision;
alter table public.centers add column if not exists radius_m int not null default 150;

insert into public.centers (id, name) values
  ('smiles-and-imagination', 'Smiles and Imagination')
on conflict (id) do update set name = excluded.name;

-- Staff allowlist: only these Google accounts can use the teacher app.
--   admin   = Sanora super user: every center, every action
--   head    = runs one center: adds/removes teachers and heads there
--   teacher = works in one center: adds teachers and children there
create table if not exists public.staff (
  email      text primary key,
  added_at   timestamptz not null default now()
);
alter table public.staff add column if not exists role text not null default 'teacher';
alter table public.staff add column if not exists center_id text references public.centers(id) on delete cascade;
alter table public.staff add column if not exists added_by text;
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff drop constraint if exists staff_center_check;
-- earlier versions: Santosh is a parent only now; any other teacher belongs to Smiles and Imagination
delete from public.staff where email = 'santosh.kikkeri@gmail.com';
update public.staff set center_id = 'smiles-and-imagination' where role <> 'admin' and center_id is null;
alter table public.staff add constraint staff_role_check check (role in ('admin', 'head', 'teacher'));
alter table public.staff add constraint staff_center_check check (role = 'admin' or center_id is not null);

insert into public.staff (email, role, center_id) values
  ('smitha.jayathirtha@gmail.com', 'admin',   null),
  ('pleasanton.sai@gmail.com',     'head',    'smiles-and-imagination')
on conflict (email) do update set role = excluded.role, center_id = excluded.center_id;

-- Children and their parent's contact
create table if not exists public.children (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  parent_name   text not null,
  parent_phone  text not null,          -- with country code, e.g. +14085551234
  parent_email  text,                   -- the parent signs in with this email
  created_at    timestamptz not null default now()
);
alter table public.children add column if not exists parent_email text;
alter table public.children add column if not exists parent2_email text;  -- optional second parent who can also sign in
alter table public.children add column if not exists allergies text;    -- free text; empty = none known
alter table public.children add column if not exists center_id text references public.centers(id) on delete cascade;
update public.children set center_id = 'smiles-and-imagination' where center_id is null;
alter table public.children alter column center_id set default 'smiles-and-imagination';
alter table public.children alter column center_id set not null;

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

-- Check-in / check-out, signed by the parent (one row per child per day)
create table if not exists public.attendance (
  id                 uuid primary key default gen_random_uuid(),
  child_id           uuid not null references public.children(id) on delete cascade,
  att_date           date not null,
  check_in           time,
  check_in_name      text,
  check_in_sig       text,              -- signature as a PNG data URL
  check_in_by        text,              -- signed-in email that made the entry
  check_out          time,
  check_out_name     text,
  check_out_sig      text,
  check_out_by       text,
  updated_at         timestamptz not null default now(),
  unique (child_id, att_date)
);

-- Activities: what the class (or some children) did, logged by teachers
create table if not exists public.activities (
  id          uuid primary key default gen_random_uuid(),
  center_id   text not null references public.centers(id) on delete cascade,
  act_date    date not null,
  act_time    time,
  kind        text not null,             -- e.g. 'Circle time', 'Art & craft', 'Outdoor play'
  title       text,
  details     text,
  child_ids   uuid[],                    -- null = the whole class
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists activities_center_date on public.activities (center_id, act_date);

-- ===============================================================
-- 2. Who is signed in (all keyed on the verified sign-in email)
-- ===============================================================

create or replace function public.my_email()
returns text language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where lower(email) = public.my_email());
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where role = 'admin' and lower(email) = public.my_email());
$$;

create or replace function public.my_staff_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.staff where lower(email) = public.my_email();
$$;

create or replace function public.my_center()
returns text language sql stable security definer set search_path = public as $$
  select center_id from public.staff where lower(email) = public.my_email();
$$;

-- Staff may work with a center: admins anywhere, others only in their own
create or replace function public.can_staff_center(center text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or (center is not null and center = public.my_center());
$$;

create or replace function public.can_staff_child(child uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.children c where c.id = child and public.can_staff_center(c.center_id));
$$;

-- Storage paths start with the child id: <child_id>/<date>/<file>.jpg
create or replace function public.can_staff_path(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.children c
    where c.id::text = split_part(object_name, '/', 1) and public.can_staff_center(c.center_id)
  );
$$;

-- Parents: a signed-in user whose email matches a child's parent_email or parent2_email
create or replace function public.is_my_email(e1 text, e2 text)
returns boolean language sql stable as $$
  select public.my_email() <> '' and public.my_email() in (lower(coalesce(e1, '')), lower(coalesce(e2, '')));
$$;

create or replace function public.is_parent_of(child uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.children c
    where c.id = child and public.is_my_email(c.parent_email, c.parent2_email)
  );
$$;

-- A parent sees an activity for the whole class at their child's center, or one tagged with their child
create or replace function public.can_parent_see_activity(center text, kids uuid[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.children c
    where public.is_my_email(c.parent_email, c.parent2_email)
      and c.center_id = center and (kids is null or c.id = any(kids))
  );
$$;

create or replace function public.is_parent_of_path(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.children c
    where c.id::text = split_part(object_name, '/', 1)
      and public.is_my_email(c.parent_email, c.parent2_email)
  );
$$;

-- 'admin', 'head', 'teacher', 'parent', or null (no access)
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    public.my_staff_role(),
    case when exists (
      select 1 from public.children c
      where public.is_my_email(c.parent_email, c.parent2_email)
    ) then 'parent' end
  );
$$;

-- Everything the app needs to know about the signed-in person, in one call
create or replace function public.my_profile()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'role', public.my_role(),
    'center_id', public.my_center(),
    'center_name', (select name from public.centers where id = public.my_center())
  );
$$;

grant execute on function
  public.my_email(), public.is_staff(), public.is_admin(), public.my_staff_role(), public.my_center(),
  public.can_staff_center(text), public.can_staff_child(uuid), public.can_staff_path(text),
  public.is_parent_of(uuid), public.is_parent_of_path(text), public.my_role(), public.my_profile(),
  public.can_parent_see_activity(text, uuid[]), public.is_my_email(text, text)
to authenticated;

-- ===============================================================
-- 3. Access rules
-- ===============================================================

-- Centers: names are public (shown on the sign-in screen); only admins change them
alter table public.centers enable row level security;
drop policy if exists "anyone read centers" on public.centers;
create policy "anyone read centers" on public.centers for select to anon, authenticated using (true);
drop policy if exists "admin manage centers" on public.centers;
create policy "admin manage centers" on public.centers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "head update own center" on public.centers;
create policy "head update own center" on public.centers
  for update to authenticated
  using (id = public.my_center() and public.my_staff_role() = 'head')
  with check (id = public.my_center());

-- Staff list
alter table public.staff enable row level security;
drop policy if exists "admin manage staff"      on public.staff;
drop policy if exists "staff read colleagues"   on public.staff;
drop policy if exists "staff add teachers"      on public.staff;
drop policy if exists "head update staff"       on public.staff;
drop policy if exists "head remove staff"       on public.staff;
create policy "admin manage staff" on public.staff
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- everyone on staff sees the people in their own center
create policy "staff read colleagues" on public.staff
  for select to authenticated using (center_id is not null and center_id = public.my_center());
-- teachers add teachers; heads add teachers or heads — only into their own center
create policy "staff add teachers" on public.staff
  for insert to authenticated with check (
    center_id = public.my_center()
    and (role = 'teacher' or (role = 'head' and public.my_staff_role() = 'head'))
  );
-- heads change and remove people in their own center (never themselves, never admins)
create policy "head update staff" on public.staff
  for update to authenticated
  using (public.my_staff_role() = 'head' and center_id = public.my_center() and lower(email) <> public.my_email())
  with check (center_id = public.my_center() and role in ('teacher', 'head'));
create policy "head remove staff" on public.staff
  for delete to authenticated
  using (public.my_staff_role() = 'head' and center_id = public.my_center() and lower(email) <> public.my_email());

-- Children, photos, notes, attendance: staff see only their own center; parents only their own children
alter table public.children    enable row level security;
alter table public.photos      enable row level security;
alter table public.daily_notes enable row level security;
alter table public.attendance  enable row level security;

drop policy if exists "staff all children" on public.children;
create policy "staff all children" on public.children
  for all to authenticated using (public.can_staff_center(center_id)) with check (public.can_staff_center(center_id));
drop policy if exists "parent read own children" on public.children;
create policy "parent read own children" on public.children
  for select to authenticated using (public.is_my_email(parent_email, parent2_email));

drop policy if exists "staff all photos" on public.photos;
create policy "staff all photos" on public.photos
  for all to authenticated using (public.can_staff_child(child_id)) with check (public.can_staff_child(child_id));
drop policy if exists "parent read own photos" on public.photos;
create policy "parent read own photos" on public.photos
  for select to authenticated using (public.is_parent_of(child_id));

drop policy if exists "staff all notes" on public.daily_notes;
create policy "staff all notes" on public.daily_notes
  for all to authenticated using (public.can_staff_child(child_id)) with check (public.can_staff_child(child_id));
drop policy if exists "parent read own notes" on public.daily_notes;
create policy "parent read own notes" on public.daily_notes
  for select to authenticated using (public.is_parent_of(child_id));

drop policy if exists "staff all attendance" on public.attendance;
create policy "staff all attendance" on public.attendance
  for all to authenticated using (public.can_staff_child(child_id)) with check (public.can_staff_child(child_id));
drop policy if exists "parent read own attendance"   on public.attendance;
drop policy if exists "parent insert own attendance" on public.attendance;
drop policy if exists "parent update own attendance" on public.attendance;
create policy "parent read own attendance" on public.attendance
  for select to authenticated using (public.is_parent_of(child_id));
create policy "parent insert own attendance" on public.attendance
  for insert to authenticated with check (public.is_parent_of(child_id));
create policy "parent update own attendance" on public.attendance
  for update to authenticated using (public.is_parent_of(child_id)) with check (public.is_parent_of(child_id));

alter table public.activities enable row level security;
drop policy if exists "staff all activities" on public.activities;
create policy "staff all activities" on public.activities
  for all to authenticated using (public.can_staff_center(center_id)) with check (public.can_staff_center(center_id));
drop policy if exists "parent read activities" on public.activities;
create policy "parent read activities" on public.activities
  for select to authenticated using (public.can_parent_see_activity(center_id, child_ids));

-- Once a check-in (or check-out) is recorded, parents can't change it; staff can correct or clear it
create or replace function public.lock_attendance()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_staff() then return new; end if;
  if old.check_in is not null and new.check_in is distinct from old.check_in then
    raise exception 'Already checked in for this day' using errcode = 'P0001';
  end if;
  if old.check_out is not null and new.check_out is distinct from old.check_out then
    raise exception 'Already checked out for this day' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists attendance_lock on public.attendance;
create trigger attendance_lock before update on public.attendance
  for each row execute function public.lock_attendance();

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
  for select to authenticated using (bucket_id = 'photos' and public.can_staff_path(name));
create policy "staff upload photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'photos' and public.can_staff_path(name));
create policy "staff delete photos" on storage.objects
  for delete to authenticated using (bucket_id = 'photos' and public.can_staff_path(name));
