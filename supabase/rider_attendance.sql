-- =====================================================================
-- DropEx Rider App — SHIFTS + ATTENDANCE
-- Run ONCE in Supabase SQL Editor AFTER supabase/rider_app.sql (safe to re-run).
--
-- Design
--   * Business time is always Asia/Karachi. Every timestamp is stored as timestamptz.
--   * The rider app never touches these tables. It calls RPCs that derive the rider from
--     auth.uid() (never from a parameter), so a rider cannot act for, or read, another rider.
--   * Shifts, per-day assignments, attendance locations and settings are plain tables that the
--     Ops / Rider-Manager system can manage later (staff RLS policies are included).
--   * Attendance rows are never deleted. Every insert/update is copied to
--     rider_attendance_audit (old row, new row, who, when, reason).
--
-- Tables      attendance_settings, attendance_locations, rider_shifts,
--             rider_shift_assignments, rider_attendance, rider_attendance_audit
-- Rider RPCs  rider_today_shift(), rider_check_in(lat,lng,accuracy,fix_at),
--             rider_check_out(lat,lng,accuracy,fix_at), rider_my_attendance(start,end)
-- Shared RPCs attendance_monthly_summary(month, rider_id)   (rider: own only; staff: anyone)
-- Staff RPCs  attendance_manual_override(...)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Configuration
-- ---------------------------------------------------------------------

-- One row of global policy. A shift can override grace_minutes and geofence_policy.
create table if not exists public.attendance_settings (
  id boolean primary key default true check (id),
  grace_minutes integer not null default 10 check (grace_minutes between 0 and 240),
  -- how long before the shift start a rider may check in
  checkin_early_minutes integer not null default 60 check (checkin_early_minutes between 0 and 720),
  -- an open (un-checked-out) attendance older than shift end + this many hours is closed as 'incomplete'
  checkout_grace_hours integer not null default 12 check (checkout_grace_hours between 1 and 48),
  -- GPS fixes worse than this (metres of uncertainty) are rejected
  max_accuracy_meters integer not null default 100 check (max_accuracy_meters between 10 and 5000),
  -- off = ignore location, warn = allow but flag, block = reject outside the radius (check-in only)
  geofence_policy text not null default 'off' check (geofence_policy in ('off', 'warn', 'block')),
  -- users.role values treated as attendance managers (read everything, apply overrides, edit config)
  staff_roles text[] not null default array['super_admin', 'operations_admin', 'admin', 'rider_manager', 'operations_manager'],
  updated_at timestamptz not null default now()
);
insert into public.attendance_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.attendance_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_meters integer not null default 200 check (radius_meters between 10 and 50000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A shift is a time window. end_time <= start_time means it runs past midnight
-- (e.g. Evening 16:00 -> 00:00, Night 22:00 -> 06:00).
create table if not exists public.rider_shifts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_time time not null,
  end_time time not null,
  attendance_location_id uuid references public.attendance_locations(id),
  geofence_policy text check (geofence_policy in ('off', 'warn', 'block')),
  grace_minutes integer check (grace_minutes between 0 and 240),
  active boolean not null default true,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rider_shifts_start_end_differ check (start_time <> end_time)
);

-- Which shift a rider works on which date (set by the manager, one shift per rider per day).
create table if not exists public.rider_shift_assignments (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references public.users(id),
  shift_id uuid not null references public.rider_shifts(id),
  work_date date not null,
  notes text,
  assigned_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rider_shift_assignments_one_per_day unique (rider_id, work_date)
);
create index if not exists rider_shift_assignments_rider_idx on public.rider_shift_assignments (rider_id, work_date desc);
create index if not exists rider_shift_assignments_date_idx on public.rider_shift_assignments (work_date);
create index if not exists rider_shift_assignments_shift_idx on public.rider_shift_assignments (shift_id);

-- ---------------------------------------------------------------------
-- 2. Attendance
-- ---------------------------------------------------------------------

create table if not exists public.rider_attendance (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references public.users(id),
  shift_id uuid not null references public.rider_shifts(id),
  assignment_id uuid references public.rider_shift_assignments(id) on delete set null,
  attendance_date date not null,                 -- Karachi work date of the shift

  -- Snapshot of the shift as it was, so later edits to the shift never rewrite history.
  shift_name text not null,
  shift_start_at timestamptz not null,
  shift_end_at timestamptz not null,

  check_in_at timestamptz,
  check_in_latitude double precision,
  check_in_longitude double precision,
  check_in_accuracy double precision,
  check_in_fix_at timestamptz,                   -- when the device says the GPS fix was taken
  check_in_distance_m double precision,          -- distance to the shift's attendance location, if any
  check_in_in_geofence boolean,                  -- null = geofence not applicable

  check_out_at timestamptz,
  check_out_latitude double precision,
  check_out_longitude double precision,
  check_out_accuracy double precision,
  check_out_fix_at timestamptz,
  check_out_distance_m double precision,
  check_out_in_geofence boolean,

  status text not null check (status in ('present', 'late', 'absent', 'leave', 'incomplete', 'manual_override')),
  -- When status = 'manual_override', how the manager wants the day counted in summaries.
  override_counts_as text check (override_counts_as in ('present', 'late', 'absent', 'leave')),
  effective_status text generated always as (
    case when status = 'manual_override' then coalesce(override_counts_as, 'present') else status end
  ) stored,
  late_minutes integer not null default 0 check (late_minutes >= 0),
  working_minutes integer check (working_minutes >= 0),

  override_reason text,
  overridden_by uuid references public.users(id),
  overridden_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One attendance row per rider per work date: duplicate check-ins are impossible.
  constraint rider_attendance_one_per_day unique (rider_id, attendance_date),
  constraint rider_attendance_checkout_needs_checkin check (check_out_at is null or check_in_at is not null),
  constraint rider_attendance_checkout_after_checkin check (check_out_at is null or check_out_at >= check_in_at),
  constraint rider_attendance_present_needs_checkin check (status not in ('present', 'late') or check_in_at is not null),
  constraint rider_attendance_override_needs_reason check (status <> 'manual_override' or nullif(trim(override_reason), '') is not null)
);
create index if not exists rider_attendance_rider_idx on public.rider_attendance (rider_id, attendance_date desc);
create index if not exists rider_attendance_date_idx on public.rider_attendance (attendance_date);
create index if not exists rider_attendance_shift_idx on public.rider_attendance (shift_id);
create index if not exists rider_attendance_open_idx on public.rider_attendance (rider_id)
  where check_in_at is not null and check_out_at is null;

-- Full history of every change (original values are always preserved here).
create table if not exists public.rider_attendance_audit (
  id bigint generated always as identity primary key,
  attendance_id uuid not null references public.rider_attendance(id),
  action text not null check (action in ('insert', 'update')),
  changed_by uuid,                               -- auth.uid(); null for system changes
  changed_at timestamptz not null default now(),
  reason text,
  old_data jsonb,
  new_data jsonb not null
);
create index if not exists rider_attendance_audit_att_idx on public.rider_attendance_audit (attendance_id, changed_at);

-- ---------------------------------------------------------------------
-- 3. Triggers: no deletes, immutable identity, updated_at, audit trail
-- ---------------------------------------------------------------------

create or replace function public._attendance_block_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'Attendance records and their history cannot be deleted or rewritten';
end;
$$;

drop trigger if exists rider_attendance_no_delete on public.rider_attendance;
create trigger rider_attendance_no_delete before delete on public.rider_attendance
  for each row execute function public._attendance_block_delete();

drop trigger if exists rider_attendance_audit_no_change on public.rider_attendance_audit;
create trigger rider_attendance_audit_no_change before update or delete on public.rider_attendance_audit
  for each row execute function public._attendance_block_delete();

create or replace function public._attendance_before_update()
returns trigger language plpgsql as $$
begin
  if new.rider_id is distinct from old.rider_id or new.attendance_date is distinct from old.attendance_date then
    raise exception 'The rider and date of an attendance record cannot be changed';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists rider_attendance_before_update on public.rider_attendance;
create trigger rider_attendance_before_update before update on public.rider_attendance
  for each row execute function public._attendance_before_update();

create or replace function public._attendance_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.rider_attendance_audit (attendance_id, action, changed_by, reason, old_data, new_data)
  values (
    new.id,
    lower(tg_op),
    auth.uid(),
    nullif(current_setting('dropex.attendance_reason', true), ''),
    case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
    to_jsonb(new)
  );
  return new;
end;
$$;

drop trigger if exists rider_attendance_audit_trg on public.rider_attendance;
create trigger rider_attendance_audit_trg after insert or update on public.rider_attendance
  for each row execute function public._attendance_audit();

-- ---------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------

-- Is the caller an attendance manager (a user whose role is listed in attendance_settings.staff_roles)?
create or replace function public._attendance_is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.users u
    cross join public.attendance_settings s
    where u.id = auth.uid()
      and u.status::text = 'active'
      and u.role::text = any (s.staff_roles)
  );
$$;

-- Business-rule failure: the message is shown to the rider, the hint is a stable code for the app.
create or replace function public._attendance_fail(p_code text, p_message text)
returns void language plpgsql as $$
begin
  raise exception '%', p_message using hint = p_code, errcode = 'P0001';
end;
$$;

create or replace function public._haversine_m(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371008.8 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
  )));
$$;

create or replace function public._shift_start_at(p_work_date date, p_start time)
returns timestamptz language sql stable as $$
  select (p_work_date + p_start) at time zone 'Asia/Karachi';
$$;

create or replace function public._shift_end_at(p_work_date date, p_start time, p_end time)
returns timestamptz language sql stable as $$
  select ((p_work_date + p_start) at time zone 'Asia/Karachi')
         + case when p_end > p_start then p_end - p_start else p_end - p_start + interval '24 hours' end;
$$;

-- Validates a GPS reading sent by the app. Returns nothing; raises a friendly error otherwise.
create or replace function public._attendance_check_fix(p_lat double precision, p_lng double precision, p_acc double precision, p_max_acc integer)
returns void language plpgsql as $$
begin
  if p_lat is null or p_lng is null or p_acc is null
     or p_lat not between -90 and 90 or p_lng not between -180 and 180 or p_acc < 0
     or (p_lat = 0 and p_lng = 0) then
    perform public._attendance_fail('invalid_location', 'Your location could not be read. Please try again.');
  end if;
  if p_acc > p_max_acc then
    perform public._attendance_fail(
      'poor_accuracy',
      format('GPS signal is too weak (accuracy %s m). Move to an open area and try again.', round(p_acc))
    );
  end if;
end;
$$;

-- The rider's current attendance situation as JSON. Which assignment applies:
--   1. an open attendance (checked in, not out) that has not gone stale;
--   2. otherwise today's (Karachi) assignment, or yesterday's if that overnight shift is still running,
--      preferring whichever one is inside its check-in window right now.
create or replace function public._attendance_context(p_uid uuid, p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  st public.attendance_settings%rowtype;
  today date := (p_now at time zone 'Asia/Karachi')::date;
  c record;
  loc record;
  opens_at timestamptz;
  window_state text;
  shift_state text;
  eff_policy text;
  can_in boolean;
  can_out boolean;
  msg text := null;
begin
  select * into st from public.attendance_settings limit 1;

  select a.id as attendance_id, a.attendance_date as work_date, a.assignment_id, a.shift_id,
         a.shift_name, a.shift_start_at, a.shift_end_at,
         a.status, a.effective_status, a.check_in_at, a.check_out_at, a.late_minutes, a.working_minutes,
         s.attendance_location_id, s.geofence_policy, s.grace_minutes, coalesce(s.active, false) as shift_active
    into c
    from public.rider_attendance a
    left join public.rider_shifts s on s.id = a.shift_id
   where a.rider_id = p_uid
     and a.check_in_at is not null and a.check_out_at is null
     and a.effective_status in ('present', 'late')
     and p_now <= a.shift_end_at + make_interval(hours => st.checkout_grace_hours)
   order by a.check_in_at desc
   limit 1;

  if not found then
    select att.id as attendance_id, x.work_date, x.assignment_id, x.shift_id,
           x.shift_name, x.start_at as shift_start_at, x.end_at as shift_end_at,
           att.status, att.effective_status, att.check_in_at, att.check_out_at,
           coalesce(att.late_minutes, 0) as late_minutes, att.working_minutes,
           x.attendance_location_id, x.geofence_policy, x.grace_minutes, x.active as shift_active
      into c
      from (
        select a.id as assignment_id, a.work_date, sh.id as shift_id, sh.name as shift_name,
               sh.attendance_location_id, sh.geofence_policy, sh.grace_minutes, sh.active,
               public._shift_start_at(a.work_date, sh.start_time) as start_at,
               public._shift_end_at(a.work_date, sh.start_time, sh.end_time) as end_at
          from public.rider_shift_assignments a
          join public.rider_shifts sh on sh.id = a.shift_id
         where a.rider_id = p_uid and a.work_date between today - 1 and today
      ) x
      left join public.rider_attendance att on att.rider_id = p_uid and att.attendance_date = x.work_date
     where x.work_date = today or p_now <= x.end_at
     order by (p_now >= x.start_at - make_interval(mins => st.checkin_early_minutes) and p_now <= x.end_at) desc,
              x.work_date desc
     limit 1;
  end if;

  if not found then
    return jsonb_build_object(
      'server_now', p_now,
      'timezone', 'Asia/Karachi',
      'work_date', today,
      'has_shift', false,
      'can_check_in', false,
      'can_check_out', false,
      'max_accuracy_meters', st.max_accuracy_meters,
      'message', 'No shift is assigned to you today. Please contact your manager.'
    );
  end if;

  opens_at := c.shift_start_at - make_interval(mins => st.checkin_early_minutes);
  window_state := case when p_now < opens_at then 'upcoming' when p_now > c.shift_end_at then 'ended' else 'open' end;
  shift_state := case when p_now < c.shift_start_at then 'upcoming' when p_now <= c.shift_end_at then 'in_progress' else 'ended' end;
  eff_policy := coalesce(c.geofence_policy, st.geofence_policy);

  can_in := c.attendance_id is null and c.shift_active and window_state = 'open';
  can_out := c.check_in_at is not null and c.check_out_at is null;

  if c.attendance_id is null then
    if not c.shift_active then
      msg := 'This shift is no longer active. Please contact your manager.';
    elsif window_state = 'upcoming' then
      msg := 'Check-in opens at ' || to_char(opens_at at time zone 'Asia/Karachi', 'HH12:MI AM') || '.';
    elsif window_state = 'ended' then
      msg := 'This shift has ended. Please contact your manager.';
    end if;
  elsif c.check_in_at is null then
    msg := 'Your attendance for this day was recorded as ' || replace(c.effective_status, '_', ' ') || ' by your manager.';
  end if;

  select name, radius_meters into loc
    from public.attendance_locations where id = c.attendance_location_id and active;

  return jsonb_build_object(
    'server_now', p_now,
    'timezone', 'Asia/Karachi',
    'work_date', c.work_date,
    'has_shift', true,
    'shift', jsonb_build_object(
      'id', c.shift_id,
      'name', c.shift_name,
      'start_at', c.shift_start_at,
      'end_at', c.shift_end_at,
      'state', shift_state,
      'active', c.shift_active,
      'grace_minutes', coalesce(c.grace_minutes, st.grace_minutes),
      'geofence_policy', case when loc.name is null then 'off' else eff_policy end,
      'location_name', loc.name,
      'location_radius_m', loc.radius_meters
    ),
    'check_in_opens_at', opens_at,
    'window_state', window_state,
    'attendance', case when c.attendance_id is null then null else jsonb_build_object(
      'id', c.attendance_id,
      'status', c.effective_status,
      'check_in_at', c.check_in_at,
      'check_out_at', c.check_out_at,
      'late_minutes', c.late_minutes,
      'working_minutes', c.working_minutes
    ) end,
    'can_check_in', can_in,
    'can_check_out', can_out,
    'max_accuracy_meters', st.max_accuracy_meters,
    'message', msg
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Rider RPCs
-- ---------------------------------------------------------------------

create or replace function public.rider_today_shift()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public._rider_guard(true);
begin
  return public._attendance_context(uid, now());
end;
$$;

create or replace function public.rider_check_in(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_fix_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public._rider_guard(true);
  now_ts timestamptz := clock_timestamp();
  st public.attendance_settings%rowtype;
  ctx jsonb;
  loc record;
  eff_policy text;
  grace integer;
  start_at timestamptz;
  late_limit timestamptz;
  late_min integer := 0;
  new_status text := 'present';
  dist double precision := null;
  inside boolean := null;
  warning text := null;
  new_id uuid;
begin
  -- Serialise this rider's attendance calls, so double-taps and parallel requests cannot race.
  perform pg_advisory_xact_lock(hashtextextended('rider_attendance:' || uid::text, 0));

  select * into st from public.attendance_settings limit 1;
  perform public._attendance_check_fix(p_latitude, p_longitude, p_accuracy, st.max_accuracy_meters);

  -- Housekeeping: an old attendance that was never checked out is closed as 'incomplete'.
  perform set_config('dropex.attendance_reason', 'Automatically marked incomplete: no check-out recorded', true);
  update public.rider_attendance
     set status = 'incomplete'
   where rider_id = uid
     and check_in_at is not null and check_out_at is null
     and status in ('present', 'late')
     and now_ts > shift_end_at + make_interval(hours => st.checkout_grace_hours);

  ctx := public._attendance_context(uid, now_ts);

  if not (ctx->>'has_shift')::boolean then
    perform public._attendance_fail('no_shift', 'No shift is assigned to you today. Please contact your manager.');
  end if;

  if ctx->'attendance' is not null and ctx->'attendance' <> 'null'::jsonb then
    if (ctx->'attendance'->>'check_out_at') is not null then
      perform public._attendance_fail('already_checked_out', 'You have already checked in and out for this shift.');
    elsif (ctx->'attendance'->>'check_in_at') is not null then
      perform public._attendance_fail('already_checked_in', 'You are already checked in.');
    else
      perform public._attendance_fail('attendance_locked', coalesce(ctx->>'message', 'Attendance for this day is already recorded.'));
    end if;
  end if;

  if not (ctx->'shift'->>'active')::boolean then
    perform public._attendance_fail('invalid_shift', 'This shift is no longer active. Please contact your manager.');
  end if;
  if ctx->>'window_state' = 'upcoming' then
    perform public._attendance_fail('too_early', coalesce(ctx->>'message', 'Check-in has not opened yet.'));
  elsif ctx->>'window_state' = 'ended' then
    perform public._attendance_fail('shift_ended', 'This shift has ended. Please contact your manager.');
  end if;

  -- Geofence (only when the shift has an active attendance location and the policy is not 'off').
  eff_policy := ctx->'shift'->>'geofence_policy';
  if eff_policy in ('warn', 'block') then
    select l.latitude, l.longitude, l.radius_meters into loc
      from public.rider_shifts s
      join public.attendance_locations l on l.id = s.attendance_location_id and l.active
     where s.id = (ctx->'shift'->>'id')::uuid;
    if found then
      dist := public._haversine_m(p_latitude, p_longitude, loc.latitude, loc.longitude);
      inside := dist <= loc.radius_meters;
      if not inside then
        if eff_policy = 'block' then
          perform public._attendance_fail('outside_geofence', 'You are outside the allowed attendance area.');
        end if;
        warning := 'You are outside the allowed attendance area. Your manager will see this.';
      end if;
    end if;
  end if;

  -- Late calculation: minutes after (shift start + grace).
  start_at := (ctx->'shift'->>'start_at')::timestamptz;
  grace := (ctx->'shift'->>'grace_minutes')::integer;
  late_limit := start_at + make_interval(mins => grace);
  if now_ts > late_limit then
    new_status := 'late';
    late_min := ceil(extract(epoch from (now_ts - late_limit)) / 60.0)::integer;
  end if;

  perform set_config('dropex.attendance_reason', 'Rider check-in', true);
  insert into public.rider_attendance (
    rider_id, shift_id, assignment_id, attendance_date,
    shift_name, shift_start_at, shift_end_at,
    check_in_at, check_in_latitude, check_in_longitude, check_in_accuracy, check_in_fix_at,
    check_in_distance_m, check_in_in_geofence, status, late_minutes
  )
  select uid, (ctx->'shift'->>'id')::uuid, a.id, (ctx->>'work_date')::date,
         ctx->'shift'->>'name', start_at, (ctx->'shift'->>'end_at')::timestamptz,
         now_ts, p_latitude, p_longitude, p_accuracy, p_fix_at,
         dist, inside, new_status, late_min
    from (select 1) one
    left join public.rider_shift_assignments a
      on a.rider_id = uid and a.work_date = (ctx->>'work_date')::date
  on conflict (rider_id, attendance_date) do nothing
  returning id into new_id;

  if new_id is null then
    perform public._attendance_fail('already_checked_in', 'You are already checked in.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'warning', warning,
    'context', public._attendance_context(uid, clock_timestamp())
  );
end;
$$;

create or replace function public.rider_check_out(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_fix_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public._rider_guard(true);
  now_ts timestamptz := clock_timestamp();
  st public.attendance_settings%rowtype;
  ctx jsonb;
  att public.rider_attendance%rowtype;
  loc record;
  eff_policy text;
  dist double precision := null;
  inside boolean := null;
  warning text := null;
begin
  perform pg_advisory_xact_lock(hashtextextended('rider_attendance:' || uid::text, 0));

  select * into st from public.attendance_settings limit 1;
  perform public._attendance_check_fix(p_latitude, p_longitude, p_accuracy, st.max_accuracy_meters);

  ctx := public._attendance_context(uid, now_ts);
  if not (ctx->>'has_shift')::boolean then
    perform public._attendance_fail('no_shift', 'No shift is assigned to you today. Please contact your manager.');
  end if;
  if ctx->'attendance' is null or ctx->'attendance' = 'null'::jsonb or (ctx->'attendance'->>'check_in_at') is null then
    perform public._attendance_fail('not_checked_in', 'You have not checked in yet.');
  end if;
  if (ctx->'attendance'->>'check_out_at') is not null then
    perform public._attendance_fail('already_checked_out', 'You have already checked out.');
  end if;

  select * into att from public.rider_attendance
   where id = (ctx->'attendance'->>'id')::uuid and rider_id = uid
   for update;
  if not found or att.check_out_at is not null then
    perform public._attendance_fail('already_checked_out', 'You have already checked out.');
  end if;

  -- Check-out never blocks (riders finish shifts away from base); location is recorded and flagged.
  eff_policy := ctx->'shift'->>'geofence_policy';
  if eff_policy in ('warn', 'block') then
    select l.latitude, l.longitude, l.radius_meters into loc
      from public.rider_shifts s
      join public.attendance_locations l on l.id = s.attendance_location_id and l.active
     where s.id = att.shift_id;
    if found then
      dist := public._haversine_m(p_latitude, p_longitude, loc.latitude, loc.longitude);
      inside := dist <= loc.radius_meters;
      if not inside then
        warning := 'You checked out outside the attendance area. Your manager will see this.';
      end if;
    end if;
  end if;

  perform set_config('dropex.attendance_reason', 'Rider check-out', true);
  update public.rider_attendance
     set check_out_at = now_ts,
         check_out_latitude = p_latitude,
         check_out_longitude = p_longitude,
         check_out_accuracy = p_accuracy,
         check_out_fix_at = p_fix_at,
         check_out_distance_m = dist,
         check_out_in_geofence = inside,
         working_minutes = greatest(0, floor(extract(epoch from (now_ts - att.check_in_at)) / 60.0)::integer)
   where id = att.id;

  return jsonb_build_object(
    'ok', true,
    'warning', warning,
    'context', public._attendance_context(uid, clock_timestamp())
  );
end;
$$;

-- The rider's own attendance between two Karachi dates (default: last 30 days).
-- Assigned days that ended without any attendance row appear as a derived 'absent'.
create or replace function public.rider_my_attendance(p_start_date date default null, p_end_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public._rider_guard(true);
  today date := (now() at time zone 'Asia/Karachi')::date;
  d1 date := coalesce(p_start_date, today - 30);
  d2 date := coalesce(p_end_date, today);
begin
  if d2 < d1 then
    perform public._attendance_fail('invalid_range', 'The end date must be after the start date.');
  end if;
  if d2 - d1 > 366 then
    perform public._attendance_fail('invalid_range', 'Please choose a range of one year or less.');
  end if;

  return coalesce((
    select jsonb_agg(u.j order by u.d desc)
    from (
      select a.attendance_date as d,
             jsonb_build_object(
               'id', a.id,
               'date', a.attendance_date,
               'shift_name', a.shift_name,
               'shift_start_at', a.shift_start_at,
               'shift_end_at', a.shift_end_at,
               'check_in_at', a.check_in_at,
               'check_out_at', a.check_out_at,
               'status', a.effective_status,
               'late_minutes', a.late_minutes,
               'working_minutes', a.working_minutes,
               'derived', false
             ) as j
        from public.rider_attendance a
       where a.rider_id = uid and a.attendance_date between d1 and d2
      union all
      select x.work_date,
             jsonb_build_object(
               'id', null,
               'date', x.work_date,
               'shift_name', x.name,
               'shift_start_at', x.start_at,
               'shift_end_at', x.end_at,
               'check_in_at', null,
               'check_out_at', null,
               'status', 'absent',
               'late_minutes', 0,
               'working_minutes', null,
               'derived', true
             )
        from (
          select asg.work_date, sh.name,
                 public._shift_start_at(asg.work_date, sh.start_time) as start_at,
                 public._shift_end_at(asg.work_date, sh.start_time, sh.end_time) as end_at
            from public.rider_shift_assignments asg
            join public.rider_shifts sh on sh.id = asg.shift_id
           where asg.rider_id = uid and asg.work_date between d1 and least(d2, today)
             and not exists (
               select 1 from public.rider_attendance a2
                where a2.rider_id = uid and a2.attendance_date = asg.work_date
             )
        ) x
       where x.end_at < now()
    ) u
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Monthly summary (rider: own only; staff: one rider or all riders)
-- ---------------------------------------------------------------------

create or replace function public.attendance_monthly_summary(p_month date default null, p_rider_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  staff boolean;
  target uuid;
  today date := (now() at time zone 'Asia/Karachi')::date;
  m1 date := date_trunc('month', coalesce(p_month, today)::timestamp)::date;
  m2 date := (date_trunc('month', coalesce(p_month, today)::timestamp) + interval '1 month - 1 day')::date;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  staff := public._attendance_is_staff();
  if staff then
    target := p_rider_id;                       -- null = every rider
  else
    perform public._rider_guard(true);
    if p_rider_id is not null and p_rider_id <> uid then
      perform public._attendance_fail('forbidden', 'You can only view your own attendance.');
    end if;
    target := uid;
  end if;

  return coalesce((
    select jsonb_agg(r.j order by r.name)
    from (
      select u.full_name as name,
             jsonb_build_object(
               'rider_id', t.rider_id,
               'rider_name', u.full_name,
               'month', m1,
               'scheduled_days', t.scheduled_days,
               'present_days', t.present_days,
               'late_days', t.late_days,
               'absent_days', t.absent_days,
               'leave_days', t.leave_days,
               'completed_shifts', t.completed_shifts,
               'attendance_percentage',
                 case when t.elapsed_days - t.leave_days > 0
                      then round(100.0 * (t.present_days + t.late_days) / (t.elapsed_days - t.leave_days), 1)
                      else null end,
               'total_working_minutes', t.working_minutes,
               'total_late_minutes', t.late_minutes
             ) as j
      from (
        select s.rider_id,
               count(*) as scheduled_days,
               -- days that have actually happened: already recorded, or the shift is over
               count(*) filter (where att.id is not null or s.end_at < now()) as elapsed_days,
               count(*) filter (where att.effective_status = 'present') as present_days,
               count(*) filter (where att.effective_status = 'late') as late_days,
               count(*) filter (where att.effective_status = 'absent'
                                  or (att.id is null and s.end_at < now())) as absent_days,
               count(*) filter (where att.effective_status = 'leave') as leave_days,
               count(*) filter (where att.check_out_at is not null) as completed_shifts,
               coalesce(sum(att.working_minutes), 0) as working_minutes,
               coalesce(sum(att.late_minutes) filter (where att.effective_status in ('present', 'late')), 0) as late_minutes
        from (
          select a.rider_id, a.work_date,
                 public._shift_end_at(a.work_date, sh.start_time, sh.end_time) as end_at
            from public.rider_shift_assignments a
            join public.rider_shifts sh on sh.id = a.shift_id
           where a.work_date between m1 and m2
             and (target is null or a.rider_id = target)
        ) s
        left join public.rider_attendance att
          on att.rider_id = s.rider_id and att.attendance_date = s.work_date
        group by s.rider_id
      ) t
      join public.users u on u.id = t.rider_id
    ) r
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Manager override (for the future Ops / Rider-Manager screens)
-- ---------------------------------------------------------------------
-- Creates or changes one rider's attendance for one work date. A reason is mandatory.
-- The previous values stay in rider_attendance_audit.
create or replace function public.attendance_manual_override(
  p_rider_id uuid,
  p_date date,
  p_status text,                       -- present | late | absent | leave | incomplete | manual_override
  p_reason text,
  p_check_in_at timestamptz default null,
  p_check_out_at timestamptz default null,
  p_counts_as text default null        -- only for manual_override: present | late | absent | leave
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  asg record;
  cur public.rider_attendance%rowtype;
  st public.attendance_settings%rowtype;
  grace integer;
  late_min integer := 0;
  late_limit timestamptz;
  work_min integer := null;
  new_id uuid;
begin
  if uid is null or not public._attendance_is_staff() then
    perform public._attendance_fail('forbidden', 'You are not allowed to change attendance.');
  end if;
  if nullif(trim(p_reason), '') is null then
    perform public._attendance_fail('reason_required', 'A reason is required for every attendance change.');
  end if;
  if p_status not in ('present', 'late', 'absent', 'leave', 'incomplete', 'manual_override') then
    perform public._attendance_fail('invalid_status', 'Unknown attendance status.');
  end if;
  if p_status = 'manual_override' and p_counts_as is null then
    perform public._attendance_fail('invalid_status', 'Choose how a manual override should be counted.');
  end if;
  if not exists (select 1 from public.riders where user_id = p_rider_id) then
    perform public._attendance_fail('invalid_rider', 'Rider not found.');
  end if;

  select * into st from public.attendance_settings limit 1;

  select a.id as assignment_id, a.shift_id, sh.name, sh.grace_minutes,
         public._shift_start_at(a.work_date, sh.start_time) as start_at,
         public._shift_end_at(a.work_date, sh.start_time, sh.end_time) as end_at
    into asg
    from public.rider_shift_assignments a
    join public.rider_shifts sh on sh.id = a.shift_id
   where a.rider_id = p_rider_id and a.work_date = p_date;
  if not found then
    perform public._attendance_fail('no_shift', 'That rider has no shift assigned on that date.');
  end if;

  if p_check_out_at is not null and (p_check_in_at is null or p_check_out_at < p_check_in_at) then
    perform public._attendance_fail('invalid_times', 'Check-out must be after check-in.');
  end if;
  if p_status in ('present', 'late') and p_check_in_at is null then
    perform public._attendance_fail('invalid_times', 'Present/Late needs a check-in time.');
  end if;

  if p_check_in_at is not null then
    grace := coalesce(asg.grace_minutes, st.grace_minutes);
    late_limit := asg.start_at + make_interval(mins => grace);
    if p_check_in_at > late_limit then
      late_min := ceil(extract(epoch from (p_check_in_at - late_limit)) / 60.0)::integer;
    end if;
  end if;
  if p_check_out_at is not null then
    work_min := greatest(0, floor(extract(epoch from (p_check_out_at - p_check_in_at)) / 60.0)::integer);
  end if;

  perform set_config('dropex.attendance_reason', trim(p_reason), true);

  select * into cur from public.rider_attendance where rider_id = p_rider_id and attendance_date = p_date for update;
  if found then
    update public.rider_attendance
       set status = p_status,
           override_counts_as = case when p_status = 'manual_override' then p_counts_as else null end,
           check_in_at = p_check_in_at,
           check_out_at = p_check_out_at,
           late_minutes = late_min,
           working_minutes = work_min,
           override_reason = trim(p_reason),
           overridden_by = uid,
           overridden_at = now()
     where id = cur.id
     returning id into new_id;
  else
    insert into public.rider_attendance (
      rider_id, shift_id, assignment_id, attendance_date, shift_name, shift_start_at, shift_end_at,
      check_in_at, check_out_at, status, override_counts_as, late_minutes, working_minutes,
      override_reason, overridden_by, overridden_at
    ) values (
      p_rider_id, asg.shift_id, asg.assignment_id, p_date, asg.name, asg.start_at, asg.end_at,
      p_check_in_at, p_check_out_at, p_status,
      case when p_status = 'manual_override' then p_counts_as else null end,
      late_min, work_min, trim(p_reason), uid, now()
    )
    returning id into new_id;
  end if;

  return jsonb_build_object('ok', true, 'attendance_id', new_id);
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Row Level Security
--   Riders get NO direct table access to shifts/locations/settings and may only SELECT their own
--   attendance rows / assignments. Nobody can write attendance except through the functions above.
-- ---------------------------------------------------------------------

alter table public.attendance_settings enable row level security;
alter table public.attendance_locations enable row level security;
alter table public.rider_shifts enable row level security;
alter table public.rider_shift_assignments enable row level security;
alter table public.rider_attendance enable row level security;
alter table public.rider_attendance_audit enable row level security;

revoke all on table public.attendance_settings, public.attendance_locations, public.rider_shifts,
  public.rider_shift_assignments, public.rider_attendance, public.rider_attendance_audit
  from public, anon, authenticated;

-- Configuration tables: managed by staff only (the RPCs read them as security definer).
grant select, insert, update on public.attendance_settings to authenticated;
grant select, insert, update, delete on public.attendance_locations, public.rider_shifts,
  public.rider_shift_assignments to authenticated;
-- Attendance + audit: read-only for everyone through RLS; writes happen only inside the functions.
grant select on public.rider_attendance, public.rider_attendance_audit to authenticated;

drop policy if exists attendance_settings_staff on public.attendance_settings;
create policy attendance_settings_staff on public.attendance_settings
  for all to authenticated using (public._attendance_is_staff()) with check (public._attendance_is_staff());

drop policy if exists attendance_locations_staff on public.attendance_locations;
create policy attendance_locations_staff on public.attendance_locations
  for all to authenticated using (public._attendance_is_staff()) with check (public._attendance_is_staff());

drop policy if exists rider_shifts_staff on public.rider_shifts;
create policy rider_shifts_staff on public.rider_shifts
  for all to authenticated using (public._attendance_is_staff()) with check (public._attendance_is_staff());

drop policy if exists rider_shift_assignments_staff on public.rider_shift_assignments;
create policy rider_shift_assignments_staff on public.rider_shift_assignments
  for all to authenticated using (public._attendance_is_staff()) with check (public._attendance_is_staff());

drop policy if exists rider_shift_assignments_own on public.rider_shift_assignments;
create policy rider_shift_assignments_own on public.rider_shift_assignments
  for select to authenticated using (rider_id = auth.uid());

drop policy if exists rider_attendance_own on public.rider_attendance;
create policy rider_attendance_own on public.rider_attendance
  for select to authenticated using (rider_id = auth.uid());

drop policy if exists rider_attendance_staff on public.rider_attendance;
create policy rider_attendance_staff on public.rider_attendance
  for select to authenticated using (public._attendance_is_staff());

drop policy if exists rider_attendance_audit_staff on public.rider_attendance_audit;
create policy rider_attendance_audit_staff on public.rider_attendance_audit
  for select to authenticated using (public._attendance_is_staff());

-- ---------------------------------------------------------------------
-- 9. Function privileges
-- ---------------------------------------------------------------------

revoke all on function public._attendance_block_delete() from public, anon, authenticated;
revoke all on function public._attendance_before_update() from public, anon, authenticated;
revoke all on function public._attendance_audit() from public, anon, authenticated;
revoke all on function public._attendance_fail(text, text) from public, anon, authenticated;
revoke all on function public._haversine_m(double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public._shift_start_at(date, time) from public, anon, authenticated;
revoke all on function public._shift_end_at(date, time, time) from public, anon, authenticated;
revoke all on function public._attendance_check_fix(double precision, double precision, double precision, integer) from public, anon, authenticated;
revoke all on function public._attendance_context(uuid, timestamptz) from public, anon, authenticated;

-- Used inside RLS policies, so signed-in users must be able to evaluate it.
revoke all on function public._attendance_is_staff() from public, anon;
grant execute on function public._attendance_is_staff() to authenticated;

revoke all on function public.rider_today_shift() from public, anon;
revoke all on function public.rider_check_in(double precision, double precision, double precision, timestamptz) from public, anon;
revoke all on function public.rider_check_out(double precision, double precision, double precision, timestamptz) from public, anon;
revoke all on function public.rider_my_attendance(date, date) from public, anon;
revoke all on function public.attendance_monthly_summary(date, uuid) from public, anon;
revoke all on function public.attendance_manual_override(uuid, date, text, text, timestamptz, timestamptz, text) from public, anon;

grant execute on function public.rider_today_shift() to authenticated;
grant execute on function public.rider_check_in(double precision, double precision, double precision, timestamptz) to authenticated;
grant execute on function public.rider_check_out(double precision, double precision, double precision, timestamptz) to authenticated;
grant execute on function public.rider_my_attendance(date, date) to authenticated;
grant execute on function public.attendance_monthly_summary(date, uuid) to authenticated;
grant execute on function public.attendance_manual_override(uuid, date, text, text, timestamptz, timestamptz, text) to authenticated;
