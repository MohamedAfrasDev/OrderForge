-- 0007_payments: the payment attempt state machine, as evidence columns, a guard and transactions.
--
-- No new tables. Part 1 adds:
--   1. payment_attempts columns and checks: where the money stands, and the evidence that proves it,
--   2. a guard trigger that enforces the attempt transition table and keeps the money facts and PayPal ids fixed,
--   3. payment_create_attempt, payment_record_order, payment_mark_approved and payment_fail.
-- Business outcomes come back as jsonb {ok:false, code:'...'}; exceptions mean a bug. Time (p_now) is always passed in.
-- Lock order everywhere: purchase row, then attempt row (then reservation and decision rows, in later parts), so
-- concurrent calls cannot deadlock and the order matches the reservation module's.
-- The state machine itself lives in domain/payments/state.ts; this file enforces the same table.
-- Precondition: existing payment_attempts rows must already satisfy the new checks (no attempt can exist before this
-- module ships, so the table is expected to be empty); otherwise the migration fails and changes nothing.

-- 1. columns and checks -------------------------------------------------------------------------
alter table public.payment_attempts
  add column approve_url text
    check (
      approve_url is null
      or (length(approve_url) <= 2000 and approve_url ~ '^https://([a-z0-9-]+\.)*paypal\.com(/[^[:space:]]*)?$')
    ),
  add column authorized_at timestamptz,
  add column authorization_expires_at timestamptz,
  add column state_changed_at timestamptz not null default now(),
  add column failure_code text
    check (failure_code is null or length(failure_code) between 1 and 64),
  add column exception_reason text
    check (exception_reason in ('ORDER_MISMATCH', 'AUTHORIZATION_MISMATCH', 'STATUS_NOT_AS_EXPECTED', 'AMOUNT_MISMATCH',
                                'CURRENCY_MISMATCH', 'PAYEE_MISMATCH', 'EVIDENCE_MISSING')),
  -- Evidence: nothing is past CREATED without an order, nothing authorized without an authorization, and nothing
  -- CAPTURED without a capture. These are what "paid only on verified evidence" rests on in the database.
  add constraint payment_attempts_order_after_create
    check (state not in ('PROVIDER_CREATED', 'APPROVED', 'AUTHORIZE_IN_FLIGHT', 'AUTHORIZED', 'CAPTURE_IN_FLIGHT',
                         'CAPTURED', 'VOID_IN_FLIGHT', 'VOIDED') or paypal_order_id is not null),
  add constraint payment_attempts_authorization_after_authorize
    check (state not in ('AUTHORIZED', 'CAPTURE_IN_FLIGHT', 'CAPTURED', 'VOID_IN_FLIGHT', 'VOIDED') or authorization_id is not null),
  add constraint payment_attempts_capture_when_captured
    check (state <> 'CAPTURED' or capture_id is not null),
  add constraint payment_attempts_authorized_at_with_authorization
    check ((authorization_id is null) = (authorized_at is null)),
  add constraint payment_attempts_exception_reason_matches_state
    check ((state = 'EXCEPTION') = (exception_reason is not null));

-- 2. transition guard ------------------------------------------------------------------------------
-- CREATED          -> PROVIDER_CREATED (an order id is recorded) | FAILED | EXPIRED
-- PROVIDER_CREATED -> APPROVED | EXPIRED | FAILED
-- APPROVED         -> AUTHORIZE_IN_FLIGHT | EXPIRED | FAILED
-- AUTHORIZE_IN_FLIGHT -> AUTHORIZED | FAILED | APPROVED (reconciled as not done) | EXCEPTION | OUTCOME_UNKNOWN (authorize)
-- AUTHORIZED       -> CAPTURE_IN_FLIGHT | VOID_IN_FLIGHT | EXPIRED | EXCEPTION
-- CAPTURE_IN_FLIGHT -> CAPTURED | AUTHORIZED | EXCEPTION | OUTCOME_UNKNOWN (capture)
-- VOID_IN_FLIGHT   -> VOIDED | AUTHORIZED | EXCEPTION | OUTCOME_UNKNOWN (void)
-- OUTCOME_UNKNOWN  -> by the uncertain operation: authorize: AUTHORIZED | APPROVED | FAILED | EXCEPTION;
--                     capture: CAPTURED | AUTHORIZED | EXCEPTION; void: VOIDED | AUTHORIZED | EXCEPTION
-- CAPTURED, VOIDED, EXPIRED, FAILED, EXCEPTION -> nothing (nothing in them can change at all)
-- The purchase, amount, currency and quote hash never change. The PayPal ids are set once. Inside one state the
-- uncertain operation cannot change.
create or replace function public.guard_payment_attempt()
returns trigger
language plpgsql
as $$
begin
  if new.purchase_id <> old.purchase_id or new.amount_minor <> old.amount_minor
     or new.currency <> old.currency or new.quote_hash <> old.quote_hash then
    raise exception 'payment_attempts: the purchase, amount, currency and quote hash of an attempt never change';
  end if;

  if (old.paypal_order_id is not null and new.paypal_order_id is distinct from old.paypal_order_id)
     or (old.authorization_id is not null and new.authorization_id is distinct from old.authorization_id)
     or (old.authorized_at is not null and new.authorized_at is distinct from old.authorized_at)
     or (old.capture_id is not null and new.capture_id is distinct from old.capture_id) then
    raise exception 'payment_attempts: a PayPal id, once recorded, is never replaced';
  end if;

  if old.state in ('CAPTURED', 'VOIDED', 'EXPIRED', 'FAILED', 'EXCEPTION') then
    if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
      raise exception 'payment_attempts: % is final', old.state;
    end if;
    return new;
  end if;

  if new.state = old.state then
    if new.unknown_operation is distinct from old.unknown_operation then
      raise exception 'payment_attempts: the uncertain operation cannot change within %', old.state;
    end if;
    return new;
  end if;

  if not (
       (old.state = 'CREATED' and new.state = 'PROVIDER_CREATED' and old.paypal_order_id is null and new.paypal_order_id is not null)
    or (old.state = 'CREATED' and new.state in ('FAILED', 'EXPIRED'))
    or (old.state = 'PROVIDER_CREATED' and new.state in ('APPROVED', 'EXPIRED', 'FAILED'))
    or (old.state = 'APPROVED' and new.state in ('AUTHORIZE_IN_FLIGHT', 'EXPIRED', 'FAILED'))
    or (old.state = 'AUTHORIZE_IN_FLIGHT'
        and (new.state in ('AUTHORIZED', 'FAILED', 'APPROVED', 'EXCEPTION')
             or (new.state = 'OUTCOME_UNKNOWN' and new.unknown_operation = 'authorize')))
    or (old.state = 'AUTHORIZED' and new.state in ('CAPTURE_IN_FLIGHT', 'VOID_IN_FLIGHT', 'EXPIRED', 'EXCEPTION'))
    or (old.state = 'CAPTURE_IN_FLIGHT'
        and (new.state in ('CAPTURED', 'AUTHORIZED', 'EXCEPTION')
             or (new.state = 'OUTCOME_UNKNOWN' and new.unknown_operation = 'capture')))
    or (old.state = 'VOID_IN_FLIGHT'
        and (new.state in ('VOIDED', 'AUTHORIZED', 'EXCEPTION')
             or (new.state = 'OUTCOME_UNKNOWN' and new.unknown_operation = 'void')))
    or (old.state = 'OUTCOME_UNKNOWN'
        and ((old.unknown_operation = 'authorize' and new.state in ('AUTHORIZED', 'APPROVED', 'FAILED', 'EXCEPTION'))
             or (old.unknown_operation = 'capture' and new.state in ('CAPTURED', 'AUTHORIZED', 'EXCEPTION'))
             or (old.unknown_operation = 'void' and new.state in ('VOIDED', 'AUTHORIZED', 'EXCEPTION'))))
  ) then
    raise exception 'payment_attempts: % cannot become %', old.state, new.state;
  end if;
  return new;
end;
$$;

-- Named so it runs before payment_attempts_set_updated_at (triggers fire in name order).
create trigger payment_attempts_guard_transition
  before update on public.payment_attempts
  for each row execute function public.guard_payment_attempt();

-- 3a. payment_create_attempt -----------------------------------------------------------------------
-- The amount and the quote hash must be exactly the accepted quote's: they are checked against the purchase's approval
-- and quote here, so a caller cannot start a payment for any other amount. Idempotent for the same purchase, amount and
-- hash while the checkout is still before authorization. Any other active attempt (authorized, in flight, uncertain or an
-- exception) is refused as ATTEMPT_ACTIVE, and the response says which state it is in.
create or replace function public.payment_create_attempt(
  p_purchase_id  uuid,
  p_amount_minor bigint,
  p_quote_hash   text,
  p_now          timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash     text;
  v_total    bigint;
  v_existing record;
  v_id       uuid;
begin
  if p_now is null or p_amount_minor is null or p_amount_minor <= 0
     or p_quote_hash is null or p_quote_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select a.quote_hash, q.total_minor into v_hash, v_total
    from public.purchases p
    join public.approvals a on a.id = p.approval_id
    join public.quote_versions q on q.id = p.quote_version_id
   where p.id = p_purchase_id
     for update of p;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if p_quote_hash <> v_hash or p_amount_minor <> v_total then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select id, state, quote_hash, amount_minor into v_existing
    from public.payment_attempts
   where purchase_id = p_purchase_id and state not in ('CAPTURED', 'VOIDED', 'EXPIRED', 'FAILED')
     for update;
  if found then
    -- Only a checkout that has not reached authorization can be resumed. Money in motion, an authorization waiting for
    -- the merchant, an uncertain outcome or an exception is reported as active, never handed back as "already".
    if v_existing.state not in ('CREATED', 'PROVIDER_CREATED', 'APPROVED')
       or v_existing.quote_hash <> p_quote_hash or v_existing.amount_minor <> p_amount_minor then
      return jsonb_build_object('ok', false, 'code', 'ATTEMPT_ACTIVE', 'attempt_id', v_existing.id, 'state', v_existing.state);
    end if;
    return jsonb_build_object('ok', true, 'already', true, 'attempt_id', v_existing.id, 'state', v_existing.state);
  end if;

  insert into public.payment_attempts (purchase_id, amount_minor, quote_hash, state, state_changed_at)
  values (p_purchase_id, p_amount_minor, p_quote_hash, 'CREATED', p_now)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'already', false, 'attempt_id', v_id, 'state', 'CREATED');
end;
$$;

-- 3b. payment_record_order -------------------------------------------------------------------------
-- PayPal created the order: store its id and the approval link (an https PayPal address, or none) and move to
-- PROVIDER_CREATED. The same order recorded again is a no-op; a different one is refused.
create or replace function public.payment_record_order(
  p_attempt_id  uuid,
  p_order_id    text,
  p_approve_url text,
  p_now         timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_id uuid;
  v_att         public.payment_attempts%rowtype;
begin
  if p_now is null or p_order_id is null or p_order_id !~ '^[A-Za-z0-9_-]{1,64}$'
     or (p_approve_url is not null and (length(p_approve_url) > 2000
         or p_approve_url !~ '^https://([a-z0-9-]+\.)*paypal\.com(/[^[:space:]]*)?$')) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select purchase_id into v_purchase_id from public.payment_attempts where id = p_attempt_id;
  if v_purchase_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  perform 1 from public.purchases where id = v_purchase_id for update;
  select * into v_att from public.payment_attempts where id = p_attempt_id for update;

  if v_att.state = 'PROVIDER_CREATED' and v_att.paypal_order_id = p_order_id then
    return jsonb_build_object('ok', true, 'already', true, 'attempt_id', v_att.id, 'state', v_att.state);
  end if;
  if v_att.state <> 'CREATED' then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state);
  end if;

  begin
    update public.payment_attempts
       set state = 'PROVIDER_CREATED', paypal_order_id = p_order_id, approve_url = p_approve_url, state_changed_at = p_now
     where id = v_att.id;
  exception when unique_violation then
    -- Another attempt already uses this PayPal order id.
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end;

  return jsonb_build_object('ok', true, 'already', false, 'attempt_id', v_att.id, 'state', 'PROVIDER_CREATED');
end;
$$;

-- 3c. payment_mark_approved ------------------------------------------------------------------------
-- Only after the caller has asked PayPal and PayPal reported the order approved. A return URL proves nothing.
create or replace function public.payment_mark_approved(
  p_attempt_id uuid,
  p_now        timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_id uuid;
  v_att         public.payment_attempts%rowtype;
begin
  if p_now is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select purchase_id into v_purchase_id from public.payment_attempts where id = p_attempt_id;
  if v_purchase_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  perform 1 from public.purchases where id = v_purchase_id for update;
  select * into v_att from public.payment_attempts where id = p_attempt_id for update;

  if v_att.state = 'APPROVED' then
    return jsonb_build_object('ok', true, 'already', true, 'attempt_id', v_att.id, 'state', 'APPROVED');
  end if;
  if v_att.state <> 'PROVIDER_CREATED' then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state);
  end if;

  update public.payment_attempts set state = 'APPROVED', state_changed_at = p_now where id = v_att.id;
  return jsonb_build_object('ok', true, 'already', false, 'attempt_id', v_att.id, 'state', 'APPROVED');
end;
$$;

-- 3d. payment_fail ----------------------------------------------------------------------------------
-- PayPal refused definitively, or reports the order void or expired, before any authorization exists. The reservation is
-- not touched here: nothing was in flight, so the hold simply runs out if the customer does not start again.
create or replace function public.payment_fail(
  p_attempt_id   uuid,
  p_failure_code text,
  p_now          timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_id uuid;
  v_att         public.payment_attempts%rowtype;
  v_code        text := left(btrim(coalesce(p_failure_code, '')), 65);
begin
  if p_now is null or length(v_code) < 1 or length(v_code) > 64 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select purchase_id into v_purchase_id from public.payment_attempts where id = p_attempt_id;
  if v_purchase_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  perform 1 from public.purchases where id = v_purchase_id for update;
  select * into v_att from public.payment_attempts where id = p_attempt_id for update;

  if v_att.state = 'FAILED' then
    return jsonb_build_object('ok', true, 'already', true, 'attempt_id', v_att.id, 'state', 'FAILED');
  end if;
  if v_att.state not in ('CREATED', 'PROVIDER_CREATED', 'APPROVED') then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state);
  end if;

  update public.payment_attempts set state = 'FAILED', failure_code = v_code, state_changed_at = p_now where id = v_att.id;
  return jsonb_build_object('ok', true, 'already', false, 'attempt_id', v_att.id, 'state', 'FAILED');
end;
$$;

-- Only the server (service role) may call these.
revoke all on function public.payment_create_attempt(uuid, bigint, text, timestamptz) from public, anon, authenticated;
revoke all on function public.payment_record_order(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.payment_mark_approved(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.payment_fail(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.payment_create_attempt(uuid, bigint, text, timestamptz) to service_role;
grant execute on function public.payment_record_order(uuid, text, text, timestamptz) to service_role;
grant execute on function public.payment_mark_approved(uuid, timestamptz) to service_role;
grant execute on function public.payment_fail(uuid, text, timestamptz) to service_role;

-- ================================================================================================
-- Part 2: begin and settle. These change the attempt, the reservation and the merchant decision together.
-- All of them take the purchase row lock first, so everything for one purchase is serialized, then the attempt row,
-- then the reservation row (the reservation functions lock it themselves), then the decision row.
-- ================================================================================================

-- 4a. internal: settle the reservation that is paired with an attempt -----------------------------
-- Normally the reservation is PAYMENT_IN_FLIGHT and settle_operation does it. If the reservation sweep already sent a
-- stuck operation to REVIEW_REQUIRED, the late-arriving evidence resolves it through resolve_review instead. A
-- reservation in any other state is out of step with the attempt, which is a bug, so it raises and rolls everything back.
create or replace function public.payment_settle_reservation(
  p_reservation_id uuid,
  p_outcome        text,
  p_now            timestamptz,
  p_hold_minutes   integer,
  p_release_reason text,
  p_note           text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state        text;
  v_out          jsonb;
  v_res_outcome  text;
  v_target       text;
begin
  select state into v_state from public.reservations where id = p_reservation_id;

  if v_state = 'PAYMENT_IN_FLIGHT' then
    v_res_outcome := case p_outcome
      when 'AUTHORIZE_NOT_DONE' then 'AUTHORIZE_FAILED'
      when 'EXCEPTION' then 'UNKNOWN'
      else p_outcome end;
    v_out := public.settle_operation(p_reservation_id, v_res_outcome, p_now, p_hold_minutes, p_release_reason, p_note);
  elsif v_state = 'REVIEW_REQUIRED' then
    v_target := case p_outcome
      when 'AUTHORIZED' then 'AWAITING_CONFIRMATION'
      when 'AUTHORIZE_FAILED' then 'HELD'
      when 'AUTHORIZE_NOT_DONE' then 'HELD'
      when 'CAPTURED' then 'COMMITTED'
      when 'CAPTURE_FAILED' then 'AWAITING_CONFIRMATION'
      when 'VOID_FAILED' then 'AWAITING_CONFIRMATION'
      when 'VOIDED' then 'RELEASED'
      else null end;
    if v_target is null then
      return; -- UNKNOWN and EXCEPTION: already in review
    end if;
    v_out := public.resolve_review(
      p_reservation_id, v_target, 'payment settled: ' || p_outcome, p_now, p_hold_minutes,
      case when v_target = 'RELEASED' then p_release_reason else null end);
  else
    raise exception 'payment_settle: the reservation is % while a payment operation was in flight', v_state;
  end if;

  if not coalesce((v_out ->> 'ok')::boolean, false) then
    raise exception 'payment_settle: the reservation refused the settlement (%)', v_out ->> 'code';
  end if;
end;
$$;

-- 4b. payment_begin ----------------------------------------------------------------------------------
-- Payments calls this BEFORE any PayPal request that could move money. It moves the attempt into its in-flight state and
-- the reservation into PAYMENT_IN_FLIGHT in one transaction. If it returns a failure, nothing may be sent.
--   authorize: attempt APPROVED, no final decision yet.   capture: AUTHORIZED, decision accepted for this authorization,
--   authorization not expired.   void: AUTHORIZED, decision declined for this authorization.
-- A hold that has run out is released here and the attempt is EXPIRED (the customer starts again).
create or replace function public.payment_begin(
  p_attempt_id uuid,
  p_operation  text,
  p_now        timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_id uuid;
  v_att         public.payment_attempts%rowtype;
  v_res         public.reservations%rowtype;
  v_dec         public.merchant_decisions%rowtype;
  v_have_dec    boolean;
  v_target      text;
  v_out         jsonb;
begin
  if p_now is null or p_operation is null or p_operation not in ('authorize', 'capture', 'void') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select purchase_id into v_purchase_id from public.payment_attempts where id = p_attempt_id;
  if v_purchase_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  perform 1 from public.purchases where id = v_purchase_id for update;
  select * into v_att from public.payment_attempts where id = p_attempt_id for update;

  if v_att.state in ('AUTHORIZE_IN_FLIGHT', 'CAPTURE_IN_FLIGHT', 'VOID_IN_FLIGHT') then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_IN_FLIGHT', 'state', v_att.state);
  end if;
  if (p_operation = 'authorize' and v_att.state <> 'APPROVED')
     or (p_operation in ('capture', 'void') and v_att.state <> 'AUTHORIZED') then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state);
  end if;

  select * into v_dec from public.merchant_decisions where purchase_id = v_purchase_id;
  v_have_dec := found;

  if p_operation = 'authorize' then
    if v_have_dec and v_dec.decision <> 'pending' then
      return jsonb_build_object('ok', false, 'code', 'DECISION_ALREADY_MADE');
    end if;
  elsif p_operation = 'capture' then
    if not v_have_dec or v_dec.decision <> 'accepted' then
      return jsonb_build_object('ok', false, 'code', 'CAPTURE_BLOCKED', 'cause', 'the merchant has not accepted');
    end if;
    if v_dec.authorization_id is distinct from v_att.authorization_id then
      return jsonb_build_object('ok', false, 'code', 'CAPTURE_BLOCKED', 'cause', 'the decision is for another authorization');
    end if;
    if v_att.authorization_expires_at is not null and p_now >= v_att.authorization_expires_at then
      return jsonb_build_object('ok', false, 'code', 'CAPTURE_BLOCKED', 'cause', 'the authorization has expired');
    end if;
  else
    if not v_have_dec or v_dec.decision <> 'declined' then
      return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'cause', 'there is no declined decision');
    end if;
    if v_dec.authorization_id is distinct from v_att.authorization_id then
      return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'cause', 'the decision is for another authorization');
    end if;
  end if;

  select * into v_res from public.reservations where purchase_id = v_purchase_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RESERVATION_REFUSED', 'reservation_code', 'NOT_FOUND');
  end if;

  v_out := public.begin_operation(v_res.id, p_operation, p_now);
  if not coalesce((v_out ->> 'ok')::boolean, false) then
    if v_out ->> 'code' = 'HOLD_EXPIRED' then
      -- The reservation already released the hold. The order can no longer be authorized, so the attempt ends too.
      update public.payment_attempts set state = 'EXPIRED', state_changed_at = p_now where id = v_att.id;
      return jsonb_build_object('ok', false, 'code', 'RESERVATION_REFUSED', 'reservation_code', 'HOLD_EXPIRED', 'attempt_state', 'EXPIRED');
    end if;
    return jsonb_build_object('ok', false, 'code', 'RESERVATION_REFUSED', 'reservation_code', v_out ->> 'code');
  end if;

  v_target := case p_operation when 'authorize' then 'AUTHORIZE_IN_FLIGHT' when 'capture' then 'CAPTURE_IN_FLIGHT' else 'VOID_IN_FLIGHT' end;
  update public.payment_attempts set state = v_target, state_changed_at = p_now where id = v_att.id;

  return jsonb_build_object('ok', true, 'state', v_target, 'operation', p_operation, 'attempt_id', v_att.id);
end;
$$;

-- 4c. internal: apply an outcome to the attempt, the reservation and the decision -------------------------------
-- The one place the effects of an outcome are written, shared by payment_settle (an operation that was in flight) and
-- payment_resolve_unknown (an uncertain one resolved by PayPal's evidence). Callers have validated the inputs, checked
-- that the outcome fits, and hold the purchase and attempt row locks. The reservation settles first: if it refuses, the
-- whole transaction rolls back. Returns the attempt's new state.
create or replace function public.payment_apply_outcome(
  p_attempt_id               uuid,
  p_outcome                  text,
  p_op                       text,
  p_now                      timestamptz,
  p_authorization_id         text default null,
  p_authorization_expires_at timestamptz default null,
  p_capture_id               text default null,
  p_failure_code             text default null,
  p_exception_reason         text default null,
  p_release_reason           text default null,
  p_note                     text default null,
  p_hold_minutes             integer default 30
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_att      public.payment_attempts%rowtype;
  v_purchase public.purchases%rowtype;
  v_dec      public.merchant_decisions%rowtype;
  v_res_id   uuid;
  v_failure  text := left(btrim(coalesce(p_failure_code, '')), 65);
  v_note     text;
  v_state    text;
begin
  select * into v_att from public.payment_attempts where id = p_attempt_id;
  select * into v_purchase from public.purchases where id = v_att.purchase_id;

  v_note := coalesce(
    nullif(left(btrim(coalesce(p_note, '')), 200), ''),
    case when p_outcome = 'EXCEPTION' then 'financial exception: ' || p_exception_reason else null end);

  select id into v_res_id from public.reservations where purchase_id = v_att.purchase_id for update;
  if v_res_id is null then
    raise exception 'payment_settle: purchase % has a payment in doubt or in flight but no reservation', v_att.purchase_id;
  end if;
  perform public.payment_settle_reservation(v_res_id, p_outcome, p_now, p_hold_minutes, coalesce(p_release_reason, 'DECLINED'), v_note);

  if p_outcome = 'AUTHORIZED' then
    update public.payment_attempts
       set state = 'AUTHORIZED', unknown_operation = null, authorization_id = p_authorization_id, authorized_at = p_now,
           authorization_expires_at = p_authorization_expires_at, state_changed_at = p_now
     where id = v_att.id;

    select * into v_dec from public.merchant_decisions where purchase_id = v_att.purchase_id for update;
    if not found then
      insert into public.merchant_decisions (purchase_id, quote_version_id, merchant_id, authorization_id)
      values (v_att.purchase_id, v_purchase.quote_version_id, v_purchase.merchant_id, p_authorization_id);
    elsif v_dec.decision = 'pending' then
      update public.merchant_decisions set authorization_id = p_authorization_id where id = v_dec.id;
    else
      raise exception 'payment_settle: purchase % already has a final decision', v_att.purchase_id;
    end if;
    v_state := 'AUTHORIZED';

  elsif p_outcome = 'AUTHORIZE_FAILED' then
    update public.payment_attempts set state = 'FAILED', unknown_operation = null, failure_code = v_failure, state_changed_at = p_now where id = v_att.id;
    v_state := 'FAILED';

  elsif p_outcome = 'AUTHORIZE_NOT_DONE' then
    update public.payment_attempts set state = 'APPROVED', unknown_operation = null, state_changed_at = p_now where id = v_att.id;
    v_state := 'APPROVED';

  elsif p_outcome = 'CAPTURED' then
    update public.payment_attempts set state = 'CAPTURED', unknown_operation = null, capture_id = p_capture_id, state_changed_at = p_now where id = v_att.id;
    v_state := 'CAPTURED';

  elsif p_outcome in ('CAPTURE_FAILED', 'VOID_FAILED') then
    update public.payment_attempts set state = 'AUTHORIZED', unknown_operation = null, state_changed_at = p_now where id = v_att.id;
    v_state := 'AUTHORIZED';

  elsif p_outcome = 'VOIDED' then
    update public.payment_attempts set state = 'VOIDED', unknown_operation = null, state_changed_at = p_now where id = v_att.id;
    v_state := 'VOIDED';

  elsif p_outcome = 'UNKNOWN' then
    update public.payment_attempts set state = 'OUTCOME_UNKNOWN', unknown_operation = p_op, state_changed_at = p_now where id = v_att.id;
    v_state := 'OUTCOME_UNKNOWN';

  else
    -- EXCEPTION: keep whatever evidence PayPal gave, so a person can find it.
    update public.payment_attempts
       set state = 'EXCEPTION', unknown_operation = null, exception_reason = p_exception_reason, state_changed_at = p_now,
           authorization_id = coalesce(authorization_id, p_authorization_id),
           authorized_at = case when authorization_id is null and p_authorization_id is not null then p_now else authorized_at end,
           capture_id = coalesce(capture_id, p_capture_id)
     where id = v_att.id;
    v_state := 'EXCEPTION';
  end if;

  return v_state;
end;
$$;

-- 4d. payment_settle ---------------------------------------------------------------------------------
-- Payments calls this after PayPal's own answer says what happened to an operation that was IN FLIGHT. The attempt, the
-- reservation and, for AUTHORIZED, the pending merchant decision are changed in one transaction. Outcomes:
--   AUTHORIZED          needs p_authorization_id; the reservation awaits the merchant; the pending decision is created
--   AUTHORIZE_FAILED    needs p_failure_code; the attempt FAILED, the hold restarts (p_hold_minutes)
--   AUTHORIZE_NOT_DONE  nothing was authorized; back to APPROVED, the hold restarts
--   CAPTURED            needs p_capture_id; the stock is committed
--   CAPTURE_FAILED / VOID_FAILED  back to AUTHORIZED, awaiting the merchant
--   VOIDED              the stock is released (p_release_reason DECLINED by default, or VOIDED)
--   UNKNOWN             OUTCOME_UNKNOWN for the operation in flight; the reservation goes to review (p_note kept)
--   EXCEPTION           needs p_exception_reason; final; the reservation goes to review, stock held
-- Repeating a success outcome whose state is already reached returns the same result and changes nothing. An attempt that is
-- OUTCOME_UNKNOWN is refused here: payment_resolve_unknown is the only way out of doubt.
create or replace function public.payment_settle(
  p_attempt_id               uuid,
  p_outcome                  text,
  p_now                      timestamptz,
  p_authorization_id         text default null,
  p_authorization_expires_at timestamptz default null,
  p_capture_id               text default null,
  p_failure_code             text default null,
  p_exception_reason         text default null,
  p_release_reason           text default null,
  p_note                     text default null,
  p_hold_minutes             integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_id uuid;
  v_att         public.payment_attempts%rowtype;
  v_op          text;
  v_owner       text;
  v_failure     text := left(btrim(coalesce(p_failure_code, '')), 65);
  v_state       text;
begin
  if p_now is null or p_outcome is null
     or p_outcome not in ('AUTHORIZED', 'AUTHORIZE_FAILED', 'AUTHORIZE_NOT_DONE', 'CAPTURED', 'CAPTURE_FAILED',
                          'VOIDED', 'VOID_FAILED', 'UNKNOWN', 'EXCEPTION')
     or p_hold_minutes is null or p_hold_minutes < 1
     or (p_authorization_id is not null and p_authorization_id !~ '^[A-Za-z0-9_-]{1,64}$')
     or (p_capture_id is not null and p_capture_id !~ '^[A-Za-z0-9_-]{1,64}$')
     or (p_exception_reason is not null and p_exception_reason not in (
           'ORDER_MISMATCH', 'AUTHORIZATION_MISMATCH', 'STATUS_NOT_AS_EXPECTED', 'AMOUNT_MISMATCH',
           'CURRENCY_MISMATCH', 'PAYEE_MISMATCH', 'EVIDENCE_MISSING'))
     or (p_release_reason is not null and p_release_reason not in ('DECLINED', 'VOIDED'))
     or (p_outcome = 'AUTHORIZED' and p_authorization_id is null)
     or (p_outcome = 'CAPTURED' and p_capture_id is null)
     or (p_outcome = 'EXCEPTION' and p_exception_reason is null)
     or (p_outcome = 'AUTHORIZE_FAILED' and (length(v_failure) < 1 or length(v_failure) > 64)) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select purchase_id into v_purchase_id from public.payment_attempts where id = p_attempt_id;
  if v_purchase_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  perform 1 from public.purchases where id = v_purchase_id for update;
  select * into v_att from public.payment_attempts where id = p_attempt_id for update;

  -- A success outcome whose state was already reached is a no-op.
  if (p_outcome = 'AUTHORIZED' and v_att.state = 'AUTHORIZED' and v_att.authorization_id = p_authorization_id)
     or (p_outcome = 'CAPTURED' and v_att.state = 'CAPTURED' and v_att.capture_id = p_capture_id)
     or (p_outcome = 'VOIDED' and v_att.state = 'VOIDED')
     or (p_outcome = 'UNKNOWN' and v_att.state = 'OUTCOME_UNKNOWN')
     or (p_outcome = 'EXCEPTION' and v_att.state = 'EXCEPTION') then
    return jsonb_build_object('ok', true, 'already', true, 'attempt_id', v_att.id, 'state', v_att.state);
  end if;

  v_op := case v_att.state
    when 'AUTHORIZE_IN_FLIGHT' then 'authorize'
    when 'CAPTURE_IN_FLIGHT' then 'capture'
    when 'VOID_IN_FLIGHT' then 'void'
    else null end;
  if v_op is null then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state);
  end if;

  v_owner := case p_outcome
    when 'AUTHORIZED' then 'authorize' when 'AUTHORIZE_FAILED' then 'authorize' when 'AUTHORIZE_NOT_DONE' then 'authorize'
    when 'CAPTURED' then 'capture' when 'CAPTURE_FAILED' then 'capture'
    when 'VOIDED' then 'void' when 'VOID_FAILED' then 'void'
    else null end;
  if v_owner is not null and v_owner <> v_op then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state);
  end if;

  v_state := public.payment_apply_outcome(
    v_att.id, p_outcome, v_op, p_now, p_authorization_id, p_authorization_expires_at, p_capture_id,
    p_failure_code, p_exception_reason, p_release_reason, p_note, p_hold_minutes);

  return jsonb_build_object('ok', true, 'already', false, 'attempt_id', v_att.id, 'state', v_state);
end;
$$;

-- Only the server (service role) may call the public ones; the reservation helper is internal to them.
revoke all on function public.payment_settle_reservation(uuid, text, timestamptz, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.payment_begin(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.payment_settle(uuid, text, timestamptz, text, timestamptz, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.payment_begin(uuid, text, timestamptz) to service_role;
grant execute on function public.payment_settle(uuid, text, timestamptz, text, timestamptz, text, text, text, text, text, integer) to service_role;
revoke all on function public.payment_apply_outcome(uuid, text, text, timestamptz, text, timestamptz, text, text, text, text, text, integer) from public, anon, authenticated, service_role;

-- ================================================================================================
-- Part 3: the merchant decision, resolving doubt, and expiry.
-- Lock order stays: purchase row (the serializer for everything about one purchase), then the decision row, then the
-- attempt row, then the reservation row.
-- ================================================================================================

-- 5a. payment_decide ---------------------------------------------------------------------------------
-- The merchant's single decision on an authorized order. Under the decision row's lock it moves pending to accepted or
-- declined and, in the same transaction, begins the capture or the void (payment_begin). If the begin is refused, the
-- decision is rolled back to pending and the refusal is returned, so a decision is never recorded that cannot be acted
-- on. A second decision, the same or the opposite, is DECISION_ALREADY_MADE and begins nothing: a confirm racing a
-- decline has exactly one winner, and a capture and a void can never both start.
--   accepted: every pending condition on the quote (production slot, artwork) must be in p_confirmed_conditions.
--   declined: a reason is required.
create or replace function public.payment_decide(
  p_purchase_id          uuid,
  p_merchant_id          uuid,
  p_decision             text,
  p_confirmed_conditions jsonb,
  p_reason               text,
  p_now                  timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase  public.purchases%rowtype;
  v_dec       public.merchant_decisions%rowtype;
  v_att       public.payment_attempts%rowtype;
  v_reason    text := left(btrim(coalesce(p_reason, '')), 501);
  v_confirmed jsonb := coalesce(p_confirmed_conditions, '[]'::jsonb);
  v_missing   jsonb;
  v_begin     jsonb;
  v_failure   jsonb;
  v_op        text;
begin
  if p_now is null or p_merchant_id is null or p_decision is null or p_decision not in ('accepted', 'declined') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if jsonb_typeof(v_confirmed) <> 'array' or jsonb_array_length(v_confirmed) > 10
     or exists (select 1 from jsonb_array_elements(v_confirmed) e
                 where jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 64) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if p_decision = 'declined' then
    if length(v_reason) < 1 then
      return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
    end if;
    if length(v_reason) > 500 then
      return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
    end if;
  end if;

  select * into v_purchase from public.purchases where id = p_purchase_id and merchant_id = p_merchant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select * into v_dec from public.merchant_decisions where purchase_id = p_purchase_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'cause', 'no payment is waiting for a decision');
  end if;
  if v_dec.decision <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'DECISION_ALREADY_MADE', 'decision', v_dec.decision);
  end if;

  select * into v_att from public.payment_attempts where purchase_id = p_purchase_id and state = 'AUTHORIZED' for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'cause', 'the payment is not waiting for a decision');
  end if;

  if p_decision = 'accepted' then
    select coalesce(jsonb_agg(g.code order by g.ord), '[]'::jsonb) into v_missing
      from (
        select c ->> 'code' as code, min(t.ord) as ord
          from public.quote_versions q
          cross join lateral jsonb_array_elements(q.pending_conditions) with ordinality as t(c, ord)
         where q.id = v_purchase.quote_version_id
           and c ->> 'code' in ('PRODUCTION_SLOT_CONFIRMATION', 'ARTWORK_ACCEPTANCE')
         group by c ->> 'code'
      ) g
     where not (v_confirmed ? g.code);
    if jsonb_array_length(v_missing) > 0 then
      return jsonb_build_object('ok', false, 'code', 'CONDITIONS_UNCONFIRMED', 'missing', v_missing);
    end if;
  end if;

  v_op := case p_decision when 'accepted' then 'capture' else 'void' end;

  begin
    update public.merchant_decisions
       set decision = p_decision, decided_at = p_now,
           confirmed_conditions = case when p_decision = 'accepted' then v_confirmed else '[]'::jsonb end,
           reason = case when p_decision = 'declined' then v_reason else null end
     where id = v_dec.id;

    v_begin := public.payment_begin(v_att.id, v_op, p_now);
    if not coalesce((v_begin ->> 'ok')::boolean, false) then
      v_failure := v_begin;
      -- Roll the decision back: it must never be recorded if the operation cannot begin.
      raise exception 'payment_decide: the operation could not begin' using errcode = 'P0001';
    end if;
  exception when raise_exception then
    if v_failure is null then
      raise;
    end if;
    return v_failure;
  end;

  return jsonb_build_object('ok', true, 'already', false, 'decision', p_decision, 'state', v_begin ->> 'state',
                            'operation', v_op, 'attempt_id', v_att.id, 'authorization_id', v_att.authorization_id);
end;
$$;

-- 5b. payment_resolve_unknown ---------------------------------------------------------------------------
-- The only way out of OUTCOME_UNKNOWN. The caller has asked PayPal what really happened and passes its evidence. Which
-- resolutions fit depends on the operation that was uncertain:
--   authorize: AUTHORIZED (needs p_authorization_id) | APPROVED (it never happened) | FAILED (needs p_failure_code) | EXCEPTION
--   capture:   CAPTURED (needs p_capture_id) | AUTHORIZED (it never happened) | EXCEPTION
--   void:      VOIDED | AUTHORIZED (it never happened) | EXCEPTION
-- EXCEPTION needs p_exception_reason. Effects on the reservation and the decision are the same as for payment_settle.
create or replace function public.payment_resolve_unknown(
  p_attempt_id               uuid,
  p_resolution               text,
  p_now                      timestamptz,
  p_authorization_id         text default null,
  p_authorization_expires_at timestamptz default null,
  p_capture_id               text default null,
  p_failure_code             text default null,
  p_exception_reason         text default null,
  p_release_reason           text default null,
  p_note                     text default null,
  p_hold_minutes             integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_id uuid;
  v_att         public.payment_attempts%rowtype;
  v_op          text;
  v_outcome     text;
  v_failure     text := left(btrim(coalesce(p_failure_code, '')), 65);
  v_state       text;
begin
  if p_now is null or p_resolution is null
     or p_resolution not in ('AUTHORIZED', 'APPROVED', 'FAILED', 'CAPTURED', 'VOIDED', 'EXCEPTION')
     or p_hold_minutes is null or p_hold_minutes < 1
     or (p_authorization_id is not null and p_authorization_id !~ '^[A-Za-z0-9_-]{1,64}$')
     or (p_capture_id is not null and p_capture_id !~ '^[A-Za-z0-9_-]{1,64}$')
     or (p_exception_reason is not null and p_exception_reason not in (
           'ORDER_MISMATCH', 'AUTHORIZATION_MISMATCH', 'STATUS_NOT_AS_EXPECTED', 'AMOUNT_MISMATCH',
           'CURRENCY_MISMATCH', 'PAYEE_MISMATCH', 'EVIDENCE_MISSING'))
     or (p_release_reason is not null and p_release_reason not in ('DECLINED', 'VOIDED'))
     or (p_resolution = 'CAPTURED' and p_capture_id is null)
     or (p_resolution = 'EXCEPTION' and p_exception_reason is null)
     or (p_resolution = 'FAILED' and (length(v_failure) < 1 or length(v_failure) > 64)) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select purchase_id into v_purchase_id from public.payment_attempts where id = p_attempt_id;
  if v_purchase_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  perform 1 from public.purchases where id = v_purchase_id for update;
  select * into v_att from public.payment_attempts where id = p_attempt_id for update;

  if v_att.state <> 'OUTCOME_UNKNOWN' then
    -- Already resolved to the same thing: a no-op.
    if v_att.state = p_resolution
       and (p_resolution <> 'CAPTURED' or v_att.capture_id = p_capture_id)
       and (p_resolution <> 'AUTHORIZED' or p_authorization_id is null or v_att.authorization_id = p_authorization_id) then
      return jsonb_build_object('ok', true, 'already', true, 'attempt_id', v_att.id, 'state', v_att.state);
    end if;
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state);
  end if;

  v_op := v_att.unknown_operation;
  v_outcome := case
    when v_op = 'authorize' and p_resolution = 'AUTHORIZED' then 'AUTHORIZED'
    when v_op = 'authorize' and p_resolution = 'APPROVED' then 'AUTHORIZE_NOT_DONE'
    when v_op = 'authorize' and p_resolution = 'FAILED' then 'AUTHORIZE_FAILED'
    when v_op = 'capture' and p_resolution = 'CAPTURED' then 'CAPTURED'
    when v_op = 'capture' and p_resolution = 'AUTHORIZED' then 'CAPTURE_FAILED'
    when v_op = 'void' and p_resolution = 'VOIDED' then 'VOIDED'
    when v_op = 'void' and p_resolution = 'AUTHORIZED' then 'VOID_FAILED'
    when p_resolution = 'EXCEPTION' then 'EXCEPTION'
    else null end;
  if v_outcome is null then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state, 'cause', 'that resolution does not fit the uncertain operation');
  end if;
  if v_outcome = 'AUTHORIZED' and p_authorization_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  v_state := public.payment_apply_outcome(
    v_att.id, v_outcome, v_op, p_now, p_authorization_id, p_authorization_expires_at, p_capture_id,
    p_failure_code, p_exception_reason, p_release_reason, p_note, p_hold_minutes);

  return jsonb_build_object('ok', true, 'already', false, 'attempt_id', v_att.id, 'state', v_state);
end;
$$;

-- 5c. payment_expire ----------------------------------------------------------------------------------
-- Ends an attempt that can no longer succeed because time ran out:
--   before authorization (CREATED, PROVIDER_CREATED, APPROVED): only once the reservation's hold has run out (or the
--     reservation is already released). The reservation itself is left to the sweep.
--   AUTHORIZED: only once PayPal's authorization expiry on file has been reached. The reservation is sent to review and
--     resolved as released (EXPIRED) with the evidence, so the stock goes back. The pending decision is left pending: a
--     new attempt can authorize again on it.
create or replace function public.payment_expire(
  p_attempt_id uuid,
  p_evidence   text,
  p_now        timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_id uuid;
  v_att         public.payment_attempts%rowtype;
  v_res         public.reservations%rowtype;
  v_evidence    text := left(btrim(coalesce(p_evidence, '')), 201);
  v_out         jsonb;
begin
  if p_now is null or length(v_evidence) < 1 or length(v_evidence) > 200 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select purchase_id into v_purchase_id from public.payment_attempts where id = p_attempt_id;
  if v_purchase_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  perform 1 from public.purchases where id = v_purchase_id for update;
  select * into v_att from public.payment_attempts where id = p_attempt_id for update;

  if v_att.state = 'EXPIRED' then
    return jsonb_build_object('ok', true, 'already', true, 'attempt_id', v_att.id, 'state', 'EXPIRED');
  end if;

  if v_att.state in ('CREATED', 'PROVIDER_CREATED', 'APPROVED') then
    select * into v_res from public.reservations where purchase_id = v_purchase_id for update;
    if found and v_res.state = 'HELD' and v_res.expires_at is not null and v_res.expires_at > p_now then
      return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state, 'cause', 'the hold has not run out');
    end if;
    update public.payment_attempts set state = 'EXPIRED', state_changed_at = p_now where id = v_att.id;
    return jsonb_build_object('ok', true, 'already', false, 'attempt_id', v_att.id, 'state', 'EXPIRED');
  end if;

  if v_att.state = 'AUTHORIZED' then
    if v_att.authorization_expires_at is null or p_now < v_att.authorization_expires_at then
      return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state, 'cause', 'the authorization has not expired');
    end if;

    select * into v_res from public.reservations where purchase_id = v_purchase_id for update;
    if not found or v_res.state <> 'AWAITING_CONFIRMATION' then
      raise exception 'payment_expire: the reservation of purchase % is not awaiting confirmation', v_purchase_id;
    end if;
    v_out := public.flag_for_review(v_res.id, 'authorization expired', p_now);
    if not coalesce((v_out ->> 'ok')::boolean, false) then
      raise exception 'payment_expire: the reservation refused review (%)', v_out ->> 'code';
    end if;
    v_out := public.resolve_review(v_res.id, 'RELEASED', v_evidence, p_now, 30, 'EXPIRED');
    if not coalesce((v_out ->> 'ok')::boolean, false) then
      raise exception 'payment_expire: the reservation refused release (%)', v_out ->> 'code';
    end if;

    update public.payment_attempts set state = 'EXPIRED', state_changed_at = p_now where id = v_att.id;
    return jsonb_build_object('ok', true, 'already', false, 'attempt_id', v_att.id, 'state', 'EXPIRED');
  end if;

  return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', v_att.state);
end;
$$;

revoke all on function public.payment_decide(uuid, uuid, text, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.payment_resolve_unknown(uuid, text, timestamptz, text, timestamptz, text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.payment_expire(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.payment_decide(uuid, uuid, text, jsonb, text, timestamptz) to service_role;
grant execute on function public.payment_resolve_unknown(uuid, text, timestamptz, text, timestamptz, text, text, text, text, text, integer) to service_role;
grant execute on function public.payment_expire(uuid, text, timestamptz) to service_role;
