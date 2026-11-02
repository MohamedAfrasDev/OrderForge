-- 0002_constraints: purchase, reservation, payment and preparation tables, plus the
-- uniqueness and immutability rules that later modules must not be able to forget.
-- State names are the brief's exact names. Column details beyond the constraints are a
-- first draft owned by reservation, payments and fulfillment.

-- purchases: created when a customer accepts one quote version ---------------
create table public.purchases (
  id               uuid primary key default gen_random_uuid(),
  merchant_id      uuid not null references public.merchants (id) on delete restrict,
  inquiry_id       uuid not null references public.inquiries (id) on delete restrict,
  quote_version_id uuid not null unique references public.quote_versions (id) on delete restrict,
  approval_id      uuid not null unique references public.approvals (id) on delete restrict,
  created_at       timestamptz not null default now()
);

create index purchases_merchant_id_idx on public.purchases (merchant_id);

-- reservations ---------------------------------------------------------------
create table public.reservations (
  id          uuid primary key default gen_random_uuid(),
  purchase_id uuid not null unique references public.purchases (id) on delete restrict,
  state       text not null default 'HELD'
              check (state in ('HELD', 'PAYMENT_IN_FLIGHT', 'AWAITING_CONFIRMATION',
                               'COMMITTED', 'RELEASED', 'REVIEW_REQUIRED')),
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger reservations_set_updated_at
  before update on public.reservations
  for each row execute function public.set_updated_at();

create table public.reservation_lines (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  product_id     uuid not null references public.products (id) on delete restrict,
  quantity       integer not null check (quantity > 0),
  unique (reservation_id, product_id)
);

-- payment attempts -----------------------------------------------------------
create table public.payment_attempts (
  id                uuid primary key default gen_random_uuid(),
  purchase_id       uuid not null references public.purchases (id) on delete restrict,
  state             text not null default 'CREATED'
                    check (state in ('CREATED', 'PROVIDER_CREATED', 'APPROVED', 'AUTHORIZE_IN_FLIGHT',
                                     'AUTHORIZED', 'CAPTURE_IN_FLIGHT', 'CAPTURED', 'VOID_IN_FLIGHT',
                                     'VOIDED', 'EXPIRED', 'FAILED', 'OUTCOME_UNKNOWN', 'EXCEPTION')),
  -- which operation is uncertain; required exactly while state is OUTCOME_UNKNOWN
  unknown_operation text check (unknown_operation in ('authorize', 'capture', 'void')),
  amount_minor      bigint not null check (amount_minor > 0),
  currency          char(3) not null default 'USD' check (currency = 'USD'),
  quote_hash        text not null check (quote_hash ~ '^[0-9a-f]{64}$'),
  paypal_order_id   text unique,
  authorization_id  text unique,
  capture_id        text unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((state = 'OUTCOME_UNKNOWN') = (unknown_operation is not null))
);

-- At most one active attempt per purchase. Active = not CAPTURED, VOIDED, EXPIRED or FAILED.
create unique index payment_attempts_one_active_per_purchase
  on public.payment_attempts (purchase_id)
  where state not in ('CAPTURED', 'VOIDED', 'EXPIRED', 'FAILED');

create trigger payment_attempts_set_updated_at
  before update on public.payment_attempts
  for each row execute function public.set_updated_at();

create table public.payment_events (
  id                 uuid primary key default gen_random_uuid(),
  payment_attempt_id uuid references public.payment_attempts (id) on delete restrict,
  -- null for locally generated events; unique when PayPal supplies one (webhook dedupe)
  provider_event_id  text unique,
  event_type         text not null,
  source             text not null check (source in ('webhook', 'api', 'reconcile', 'spike')),
  evidence_label     text not null check (evidence_label in ('mocked', 'replayed', 'real-sandbox')),
  payload            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create index payment_events_attempt_idx on public.payment_events (payment_attempt_id);

-- merchant decisions: one record per purchase, so confirm and decline cannot both win --
create table public.merchant_decisions (
  id                   uuid primary key default gen_random_uuid(),
  purchase_id          uuid not null unique references public.purchases (id) on delete restrict,
  quote_version_id     uuid not null references public.quote_versions (id) on delete restrict,
  merchant_id          uuid not null references public.merchants (id) on delete restrict,
  authorization_id     text,
  decision             text not null default 'pending' check (decision in ('pending', 'accepted', 'declined')),
  confirmed_conditions jsonb not null default '[]'::jsonb,
  reason               text,
  decided_at           timestamptz,
  created_at           timestamptz not null default now(),
  check (decision <> 'declined' or (reason is not null and length(reason) > 0)),
  check ((decision = 'pending') = (decided_at is null))
);

-- preparation: one job per paid purchase -------------------------------------
create table public.preparation_jobs (
  id          uuid primary key default gen_random_uuid(),
  purchase_id uuid not null unique references public.purchases (id) on delete restrict,
  status      text not null default 'QUEUED'
              check (status in ('QUEUED', 'PREPARING', 'READY_FOR_PICKUP', 'COLLECTED', 'ON_HOLD')),
  worksheet   jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger preparation_jobs_set_updated_at
  before update on public.preparation_jobs
  for each row execute function public.set_updated_at();

create table public.preparation_events (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.preparation_jobs (id) on delete cascade,
  status     text not null
             check (status in ('QUEUED', 'PREPARING', 'READY_FOR_PICKUP', 'COLLECTED', 'ON_HOLD')),
  note       text,
  created_at timestamptz not null default now()
);

-- immutability ---------------------------------------------------------------
-- A quote version that has left DRAFT may only change status, and never out of a terminal state.
create or replace function public.guard_quote_version_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then
      raise exception 'quote_versions: only DRAFT rows can be deleted';
    end if;
    return old;
  end if;

  if old.status = 'DRAFT' then
    return new;
  end if;

  if old.status in ('SUPERSEDED', 'EXPIRED', 'WITHDRAWN') and new.status <> old.status then
    raise exception 'quote_versions: % is a terminal state', old.status;
  end if;
  if new.status = 'DRAFT' then
    raise exception 'quote_versions: cannot return to DRAFT';
  end if;
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'quote_versions: a non-draft quote version is immutable; create a new version';
  end if;
  return new;
end;
$$;

create trigger quote_versions_immutable
  before update or delete on public.quote_versions
  for each row execute function public.guard_quote_version_immutable();

-- Approvals are evidence of what the customer accepted: never edited or removed.
create or replace function public.guard_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception '%: rows are append-only', tg_table_name;
end;
$$;

create trigger approvals_append_only
  before update or delete on public.approvals
  for each row execute function public.guard_append_only();

-- A decision, once made, cannot be changed or reversed.
create or replace function public.guard_decision_final()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'merchant_decisions: rows cannot be deleted';
  end if;
  if old.decision <> 'pending' then
    raise exception 'merchant_decisions: a recorded decision is final';
  end if;
  return new;
end;
$$;

create trigger merchant_decisions_final
  before update or delete on public.merchant_decisions
  for each row execute function public.guard_decision_final();
