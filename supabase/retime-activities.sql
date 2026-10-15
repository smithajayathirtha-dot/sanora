-- One-time: move existing activities to their typical-day block's start time.
-- For each activity, the center's schedule blocks that list its kind are candidates; the block whose
-- time range contains the current time wins, otherwise the block starting closest to it
-- (an activity with no time gets the first matching block). Kinds with no block are left as they are.
-- Run it once in the Supabase SQL Editor. Running it again changes nothing.
with blocks as (
  select c.id as center_id, (b->>'start')::time as b_start, (b->>'end')::time as b_end, k.kind
  from public.centers c
  cross join lateral jsonb_array_elements(coalesce(c.schedule, '[]'::jsonb)) b
  cross join lateral jsonb_array_elements_text(coalesce(b->'kinds', '[]'::jsonb)) k(kind)
  where (b->>'activity')::boolean
),
pick as (
  select distinct on (a.id) a.id, bl.b_start
  from public.activities a
  join blocks bl on bl.center_id = a.center_id and bl.kind = a.kind
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
