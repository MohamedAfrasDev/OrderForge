-- 0008_fulfillment: one preparation job per paid purchase, its frozen worksheet, and an append-only event log.
--
-- No new tables. Part 1 adds:
--   1. preparation_events columns: who moved the job and from which status,
--   2. guard triggers: a job moves only along the transition table, its worksheet and purchase never change, COLLECTED is
--      final; events are append-only,
--   3. fulfillment_create_job: the one idempotent step that creates a job, and only for a verified capture.
-- Business outcomes come back as jsonb {ok:false, code:'...'}; exceptions mean a bug. Time (p_now) is always passed in.
-- Lock order: the purchase row first (the serializer for everything about one purchase), then the job row.
-- The job state machine itself lives in domain/fulfillment/state.ts; this file enforces the same table. The trigger lets an
-- ON_HOLD job go back to any of the three holdable statuses; narrowing a resume to the status the job left is the move
-- function's job (part 2).
-- Precondition: existing preparation rows (none are expected before this module ships) must satisfy the new checks.

-- 1. event columns ----------------------------------------------------------------------------------
alter table public.preparation_events
  add column from_status text
    check (from_status is null or from_status in ('QUEUED', 'PREPARING', 'READY_FOR_PICKUP', 'COLLECTED', 'ON_HOLD')),
  add column actor text
    check (actor is null or length(actor) between 1 and 200);

-- 2. guard triggers ---------------------------------------------------------------------------------
create or replace function public.guard_preparation_job()
returns trigger
language plpgsql
as $$
begin
  if new.purchase_id <> old.purchase_id or new.worksheet is distinct from old.worksheet then
    raise exception 'preparation_jobs: the purchase and the worksheet of a job never change';
  end if;

  if old.status = 'COLLECTED' then
    if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
      raise exception 'preparation_jobs: COLLECTED is final';
    end if;
    return new;
  end if;

  if new.status = old.status then
    return new;
  end if;

  if not (
       (old.status = 'QUEUED' and new.status in ('PREPARING', 'ON_HOLD'))
    or (old.status = 'PREPARING' and new.status in ('READY_FOR_PICKUP', 'ON_HOLD'))
    or (old.status = 'READY_FOR_PICKUP' and new.status in ('COLLECTED', 'ON_HOLD'))
    or (old.status = 'ON_HOLD' and new.status in ('QUEUED', 'PREPARING', 'READY_FOR_PICKUP'))
  ) then
    raise exception 'preparation_jobs: % -> % is not an allowed move', old.status, new.status;
  end if;
  return new;
end;
$$;

-- Named so it runs before preparation_jobs_set_updated_at (triggers fire in name order).
create trigger preparation_jobs_guard_transition
  before update on public.preparation_jobs
  for each row execute function public.guard_preparation_job();

-- The log only grows. A delete that comes from a foreign key action on the job (trigger depth above 1) is let through so the
-- cascade keeps working; a direct delete or any update is refused.
create or replace function public.guard_preparation_event()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'preparation_events: the log is append-only';
end;
$$;

create trigger preparation_events_append_only
  before update or delete on public.preparation_events
  for each row execute function public.guard_preparation_event();

-- 3. fulfillment_create_job -------------------------------------------------------------------------
-- Creates the one job of a paid purchase, with its worksheet and a first QUEUED event, in one transaction. "Paid" is decided
-- here, not by the caller: an attempt of the purchase is CAPTURED and the purchase's reservation is COMMITTED. A purchase
-- that already has a job returns it unchanged (already = true): the first worksheet stands. The worksheet is stored as
-- given after checks of its tag, its purchase and its size; its contents are built and validated in TypeScript.
create or replace function public.fulfillment_create_job(
  p_purchase_id uuid,
  p_worksheet   jsonb,
  p_now         timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_status text;
begin
  if p_now is null or p_purchase_id is null or p_worksheet is null
     or jsonb_typeof(p_worksheet) <> 'object'
     or p_worksheet ->> 'schema' is distinct from 'orderforge.worksheet.v1'
     or p_worksheet ->> 'purchaseId' is distinct from p_purchase_id::text
     or octet_length(p_worksheet::text) > 20000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  perform 1 from public.purchases where id = p_purchase_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select id, status into v_job_id, v_status from public.preparation_jobs where purchase_id = p_purchase_id;
  if found then
    return jsonb_build_object('ok', true, 'already', true, 'job_id', v_job_id, 'status', v_status);
  end if;

  if not exists (select 1 from public.payment_attempts where purchase_id = p_purchase_id and state = 'CAPTURED')
     or not exists (select 1 from public.reservations where purchase_id = p_purchase_id and state = 'COMMITTED') then
    return jsonb_build_object('ok', false, 'code', 'NOT_PAID');
  end if;

  insert into public.preparation_jobs (purchase_id, status, worksheet, created_at, updated_at)
  values (p_purchase_id, 'QUEUED', p_worksheet, p_now, p_now)
  returning id into v_job_id;

  insert into public.preparation_events (job_id, status, from_status, actor, note, created_at)
  values (v_job_id, 'QUEUED', null, 'system', null, p_now);

  return jsonb_build_object('ok', true, 'already', false, 'job_id', v_job_id, 'status', 'QUEUED');
end;
$$;

revoke all on function public.fulfillment_create_job(uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.fulfillment_create_job(uuid, jsonb, timestamptz) to service_role;
