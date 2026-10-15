-- One-time: move existing activities to their typical-day block's start time.
-- For each activity, the center's schedule blocks that list its kind are candidates; the block whose
-- time range contains the current time wins, otherwise the block starting closest to it
-- (an activity with no time gets the first matching block). Kinds with no block are left as they are.
-- Activities only for half-day children (picked up after lunch, 12:45) only use morning blocks.
-- Run it in the Supabase SQL Editor. Running it again changes nothing.

-- The typical day comes from centers.schedule, which supabase/schema.sql saves
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'centers' and column_name = 'schedule')
     or not exists (select 1 from public.centers where jsonb_array_length(coalesce(schedule, '[]'::jsonb)) > 0) then
    raise exception 'No typical-day schedule saved yet. Run all of supabase/schema.sql first, then run this again.';
  end if;
end $$;

-- Each kind has its own block (same as schema.sql): Circle time = circle/story/music;
-- Hands-on activity = art/sensory/learning; Indoor / outdoor play = outdoor/other
update public.centers c set schedule = (
  select jsonb_agg(case
           when b->>'title' = 'Circle time' then jsonb_set(b, '{kinds}', '["Circle time", "Story time", "Music & movement"]')
           when b->>'title' = 'Indoor / outdoor play' then jsonb_set(b, '{kinds}', '["Outdoor play", "Other"]')
           else b end order by ord)
  from jsonb_array_elements(c.schedule) with ordinality t(b, ord))
where c.id = 'smiles-and-imagination' and jsonb_typeof(c.schedule) = 'array';

alter table public.children add column if not exists half_day boolean not null default false;

-- Sanmay is on a half day for now (change it any time in the app: Children → Edit → Half day)
update public.children set half_day = true where name ilike 'sanmay%';

with blocks as (
  select c.id as center_id, (b->>'start')::time as b_start, (b->>'end')::time as b_end, k.kind
  from public.centers c
  cross join lateral jsonb_array_elements(coalesce(c.schedule, '[]'::jsonb)) b
  cross join lateral jsonb_array_elements_text(coalesce(b->'kinds', '[]'::jsonb)) k(kind)
  where (b->>'activity')::boolean
),
acts as (
  select a.*,
    (coalesce(array_length(a.child_ids, 1), 0) > 0 and not exists (
       select 1 from unnest(a.child_ids) cid
       where not exists (select 1 from public.children ch where ch.id = cid and ch.half_day))) as half_only
  from public.activities a
),
pick as (
  select distinct on (a.id) a.id, bl.b_start
  from acts a
  join blocks bl on bl.center_id = a.center_id and bl.kind = a.kind
  where not a.half_only or bl.b_start < time '12:45'
  order by a.id,
    case when a.act_time is not null and a.act_time >= bl.b_start and a.act_time < bl.b_end then 0 else 1 end,
    abs(extract(epoch from (coalesce(a.act_time, bl.b_start) - bl.b_start))),
    bl.b_start
)
update public.activities a
set act_time = pick.b_start
from pick
where a.id = pick.id and a.act_time is distinct from pick.b_start
returning a.act_date, a.kind, a.title, a.act_time as new_time;
