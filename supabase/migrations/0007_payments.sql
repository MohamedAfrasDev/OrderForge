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
