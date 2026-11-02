-- 0006_reservation: the stock reservation state machine, as transactions and guards.
--
-- No new tables. Adds:
--   1. reservation columns that say which operation is in flight and why a hold was released,
--   2. a guard trigger that enforces the reservation transition table,
--   3. reservation_apply_stock (internal), reserve_stock and release_hold.
-- Lock order everywhere: purchase row, reservation row, then stock rows in product-id order, so
-- concurrent calls cannot deadlock. Business outcomes come back as jsonb {ok:false, code:'...'};
-- exceptions mean a bug. Time (p_now) is always passed in; nothing here reads the clock to decide.
-- The state machine itself lives in domain/reservation/state.ts; this file enforces the same table.
-- Precondition: existing reservations must already satisfy the new checks (no reservation can exist before this
-- module ships, so the table is expected to be empty); otherwise the migration fails and changes nothing.

-- 1. columns ---------------------------------------------------------------------------------
alter table public.reservations
  add column in_flight_operation text
    check (in_flight_operation in ('authorize', 'capture', 'void')),
  add column release_reason text
    check (release_reason in ('EXPIRED', 'SUPERSEDED', 'ABANDONED', 'DECLINED', 'VOIDED')),
  add column review_reason text
    check (review_reason is null or length(review_reason) between 1 and 200),
  add column state_changed_at timestamptz not null default now(),
  add constraint reservations_in_flight_matches_state
    check ((state = 'PAYMENT_IN_FLIGHT') = (in_flight_operation is not null)),
  add constraint reservations_release_reason_matches_state
    check ((state = 'RELEASED') = (release_reason is not null));

-- 2. transition guard ---------------------------------------------------------------------------
-- HELD                  -> PAYMENT_IN_FLIGHT (authorize) | RELEASED (expired, superseded, abandoned)
-- AWAITING_CONFIRMATION -> PAYMENT_IN_FLIGHT (capture, void) | REVIEW_REQUIRED
-- PAYMENT_IN_FLIGHT     -> AWAITING_CONFIRMATION | REVIEW_REQUIRED
--                          | HELD (from authorize) | COMMITTED (from capture) | RELEASED (from void: declined, voided)
-- REVIEW_REQUIRED       -> HELD | AWAITING_CONFIRMATION | COMMITTED | RELEASED
-- RELEASED              -> HELD, only when the release was an expiry
-- COMMITTED             -> nothing
-- Inside one state, the operation and the reason cannot change. A reservation never changes purchase.
create or replace function public.guard_reservation_transition()
returns trigger
language plpgsql
as $$
begin
  if new.purchase_id <> old.purchase_id then
    raise exception 'reservations: a reservation cannot move to another purchase';
  end if;

  if old.state = 'COMMITTED' then
    if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
      raise exception 'reservations: COMMITTED is final';
    end if;
    return new;
  end if;

  if new.state = old.state then
    if new.in_flight_operation is distinct from old.in_flight_operation
       or new.release_reason is distinct from old.release_reason then
      raise exception 'reservations: the operation and the release reason cannot change within %', old.state;
    end if;
    return new;
  end if;

  if not (
       (old.state = 'HELD' and new.state = 'PAYMENT_IN_FLIGHT' and new.in_flight_operation = 'authorize')
    or (old.state = 'HELD' and new.state = 'RELEASED' and new.release_reason in ('EXPIRED', 'SUPERSEDED', 'ABANDONED'))
    or (old.state = 'AWAITING_CONFIRMATION' and new.state = 'PAYMENT_IN_FLIGHT' and new.in_flight_operation in ('capture', 'void'))
    or (old.state = 'AWAITING_CONFIRMATION' and new.state = 'REVIEW_REQUIRED')
    or (old.state = 'PAYMENT_IN_FLIGHT' and new.state in ('AWAITING_CONFIRMATION', 'REVIEW_REQUIRED'))
    or (old.state = 'PAYMENT_IN_FLIGHT' and new.state = 'HELD' and old.in_flight_operation = 'authorize')
    or (old.state = 'PAYMENT_IN_FLIGHT' and new.state = 'COMMITTED' and old.in_flight_operation = 'capture')
    or (old.state = 'PAYMENT_IN_FLIGHT' and new.state = 'RELEASED' and old.in_flight_operation = 'void'
        and new.release_reason in ('DECLINED', 'VOIDED'))
    or (old.state = 'REVIEW_REQUIRED' and new.state in ('HELD', 'AWAITING_CONFIRMATION', 'COMMITTED', 'RELEASED'))
    or (old.state = 'RELEASED' and new.state = 'HELD' and old.release_reason = 'EXPIRED')
  ) then
    raise exception 'reservations: % cannot become %', old.state, new.state;
  end if;
  return new;
end;
$$;

-- Named so it runs before reservations_set_updated_at (triggers fire in name order).
create trigger reservations_guard_transition
  before update on public.reservations
  for each row execute function public.guard_reservation_transition();

-- 3a. internal: change stock for every line of one reservation ---------------------------------
-- RESERVE: reserved += q. RELEASE: reserved -= q. COMMIT: reserved -= q and on_hand -= q.
-- Stock rows are locked in product-id order. A missing stock row or a negative result is a bug and raises
-- (the stock table's own checks are the backstop). Callers hold the reservation's row lock.
create or replace function public.reservation_apply_stock(p_reservation_id uuid, p_effect text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
begin
  if p_effect not in ('RESERVE', 'RELEASE', 'COMMIT') then
    raise exception 'reservation_apply_stock: unknown effect %', p_effect;
  end if;

  for v_line in
    select rl.product_id, rl.quantity
      from public.reservation_lines rl
     where rl.reservation_id = p_reservation_id
     order by rl.product_id
  loop
    perform 1 from public.stock s where s.product_id = v_line.product_id for update;
    if not found then
      raise exception 'reservation_apply_stock: no stock row for product %', v_line.product_id;
    end if;

    if p_effect = 'RESERVE' then
      update public.stock set reserved = reserved + v_line.quantity where product_id = v_line.product_id;
    elsif p_effect = 'RELEASE' then
      update public.stock set reserved = reserved - v_line.quantity where product_id = v_line.product_id;
    else
      update public.stock
         set reserved = reserved - v_line.quantity, on_hand = on_hand - v_line.quantity
       where product_id = v_line.product_id;
    end if;
  end loop;
end;
$$;

-- 3b. reserve_stock -------------------------------------------------------------------------------
-- Holds every line or none. Idempotent per purchase. An EXPIRED release is taken up again (re-hold) if the purchase
-- has no active payment attempt, the lines are the same, and stock is still there.
create or replace function public.reserve_stock(
  p_purchase_id  uuid,
  p_lines        jsonb,
  p_now          timestamptz,
  p_hold_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_merchant_id uuid;
  v_res         public.reservations%rowtype;
  v_n           integer;
  v_distinct    integer;
  v_quantities  integer;
  v_min         integer;
  v_matching    integer;
  v_line        record;
  v_avail       integer;
  v_short       jsonb := '[]'::jsonb;
  v_id          uuid;
  v_reheld      boolean := false;
  v_expires     timestamptz;
begin
  if p_now is null or p_hold_minutes is null or p_hold_minutes < 1
     or p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  begin
    select count(*), count(distinct x.product_id), count(x.quantity), coalesce(min(x.quantity), 0)
      into v_n, v_distinct, v_quantities, v_min
      from jsonb_to_recordset(p_lines) as x(product_id uuid, quantity integer);
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end;
  if v_n <> jsonb_array_length(p_lines) or v_distinct <> v_n or v_quantities <> v_n or v_min < 1 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select merchant_id into v_merchant_id from public.purchases where id = p_purchase_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select count(*) into v_matching
    from public.products p
    join jsonb_to_recordset(p_lines) as x(product_id uuid, quantity integer) on x.product_id = p.id
   where p.merchant_id = v_merchant_id;
  if v_matching <> v_n then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select * into v_res from public.reservations where purchase_id = p_purchase_id for update;
  if found then
    if v_res.state <> 'RELEASED' then
      return jsonb_build_object('ok', true, 'already', true, 'reheld', false,
                                'reservation_id', v_res.id, 'expires_at', v_res.expires_at, 'state', v_res.state);
    end if;
    if v_res.release_reason <> 'EXPIRED' then
      return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION');
    end if;
    if exists (
      select 1 from public.payment_attempts pa
       where pa.purchase_id = p_purchase_id and pa.state not in ('CAPTURED', 'VOIDED', 'EXPIRED', 'FAILED')
    ) then
      return jsonb_build_object('ok', false, 'code', 'PAYMENT_ACTIVE');
    end if;
    if (select count(*) from public.reservation_lines where reservation_id = v_res.id) <> v_n
       or (select count(*)
             from public.reservation_lines rl
             join jsonb_to_recordset(p_lines) as x(product_id uuid, quantity integer)
               on x.product_id = rl.product_id and x.quantity = rl.quantity
            where rl.reservation_id = v_res.id) <> v_n then
      return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
    end if;
    v_reheld := true;
    v_id := v_res.id;
  end if;

  -- Check every product (locking its stock row in id order) before changing anything.
  for v_line in
    select x.product_id, x.quantity
      from jsonb_to_recordset(p_lines) as x(product_id uuid, quantity integer)
     order by x.product_id
  loop
    select s.on_hand - s.reserved into v_avail from public.stock s where s.product_id = v_line.product_id for update;
    if not found then
      v_avail := 0;
    end if;
    if v_avail < v_line.quantity then
      v_short := v_short || jsonb_build_array(jsonb_build_object(
        'product_id', v_line.product_id, 'needed', v_line.quantity, 'available', greatest(v_avail, 0)));
    end if;
  end loop;
  if jsonb_array_length(v_short) > 0 then
    return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_STOCK', 'shortages', v_short);
  end if;

  v_expires := p_now + make_interval(mins => p_hold_minutes);

  if v_reheld then
    update public.reservations
       set state = 'HELD', release_reason = null, expires_at = v_expires, state_changed_at = p_now
     where id = v_id;
  else
    insert into public.reservations (purchase_id, state, expires_at, state_changed_at)
    values (p_purchase_id, 'HELD', v_expires, p_now)
    returning id into v_id;
    insert into public.reservation_lines (reservation_id, product_id, quantity)
    select v_id, x.product_id, x.quantity
      from jsonb_to_recordset(p_lines) as x(product_id uuid, quantity integer);
  end if;

  perform public.reservation_apply_stock(v_id, 'RESERVE');

  return jsonb_build_object('ok', true, 'already', false, 'reheld', v_reheld,
                            'reservation_id', v_id, 'expires_at', v_expires, 'state', 'HELD');
end;
$$;

-- 3c. release_hold --------------------------------------------------------------------------------
-- Releases a plain HELD reservation (a hold nobody is acting on). DECLINED and VOIDED come only from a void settlement.
-- EXPIRED is accepted only once p_now has reached expires_at.
create or replace function public.release_hold(
  p_reservation_id uuid,
  p_reason         text,
  p_now            timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res public.reservations%rowtype;
begin
  if p_now is null or p_reason is null or p_reason not in ('EXPIRED', 'SUPERSEDED', 'ABANDONED') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  if v_res.state = 'RELEASED' then
    return jsonb_build_object('ok', true, 'already', true, 'state', 'RELEASED');
  end if;
  if v_res.state = 'PAYMENT_IN_FLIGHT' then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_IN_FLIGHT');
  end if;
  if v_res.state <> 'HELD' then
    return jsonb_build_object('ok', false, 'code', 'NOT_HELD');
  end if;
  if p_reason = 'EXPIRED' and (v_res.expires_at is null or p_now < v_res.expires_at) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  perform public.reservation_apply_stock(v_res.id, 'RELEASE');
  update public.reservations
     set state = 'RELEASED', release_reason = p_reason, state_changed_at = p_now
   where id = v_res.id;

  return jsonb_build_object('ok', true, 'already', false, 'state', 'RELEASED');
end;
$$;

-- Only the server (service role) may call the public ones; the stock helper is internal to them.
revoke all on function public.reservation_apply_stock(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.reserve_stock(uuid, jsonb, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.release_hold(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_stock(uuid, jsonb, timestamptz, integer) to service_role;
grant execute on function public.release_hold(uuid, text, timestamptz) to service_role;
