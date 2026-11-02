-- 0001_core_tables: merchant, catalog, inquiry and quote tables.
-- Money is bigint minor units (USD cents); currency is fixed to USD in v1.
-- Column details are a first draft; owning modules may change them via a new migration.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- merchants ---------------------------------------------------------------
create table public.merchants (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name          text not null check (length(name) between 1 and 120),
  owner_user_id uuid references auth.users (id) on delete set null,
  currency      char(3) not null default 'USD' check (currency = 'USD'),
  created_at    timestamptz not null default now()
);

-- catalog -----------------------------------------------------------------
create table public.products (
  id               uuid primary key default gen_random_uuid(),
  merchant_id      uuid not null references public.merchants (id) on delete cascade,
  sku              text not null check (length(sku) between 1 and 64),
  name             text not null check (length(name) between 1 and 120),
  category         text not null check (length(category) between 1 and 64),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  currency         char(3) not null default 'USD' check (currency = 'USD'),
  is_food          boolean not null default false,
  attributes       jsonb not null default '{}'::jsonb,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (merchant_id, sku)
);

-- reserved is maintained only by the reservation function (reservation module).
create table public.stock (
  product_id uuid primary key references public.products (id) on delete cascade,
  on_hand    integer not null default 0 check (on_hand >= 0),
  reserved   integer not null default 0 check (reserved >= 0),
  updated_at timestamptz not null default now(),
  check (reserved <= on_hand)
);

create trigger stock_set_updated_at
  before update on public.stock
  for each row execute function public.set_updated_at();

create table public.business_rules (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  key         text not null check (length(key) between 1 and 64),
  value       jsonb not null,
  created_at  timestamptz not null default now(),
  unique (merchant_id, key)
);

-- inquiries and conversation ----------------------------------------------
create table public.inquiries (
  id             uuid primary key default gen_random_uuid(),
  merchant_id    uuid not null references public.merchants (id) on delete cascade,
  status         text not null default 'NEW'
                 check (status in ('NEW', 'CLARIFYING', 'CONFIGURING', 'REVIEW_REQUIRED', 'QUOTE_READY')),
  -- bump to revoke every customer access link issued for this inquiry
  access_version integer not null default 1 check (access_version >= 1),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index inquiries_merchant_id_idx on public.inquiries (merchant_id);

create trigger inquiries_set_updated_at
  before update on public.inquiries
  for each row execute function public.set_updated_at();

create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.inquiries (id) on delete cascade,
  role       text not null check (role in ('customer', 'assistant', 'merchant', 'system')),
  body       text not null check (length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);

create index messages_inquiry_id_idx on public.messages (inquiry_id, created_at);

create table public.requirement_versions (
  id                uuid primary key default gen_random_uuid(),
  inquiry_id        uuid not null references public.inquiries (id) on delete cascade,
  version           integer not null check (version >= 1),
  -- each field carries its source message and a confirmed / needs_confirmation / conflicted / unknown status
  requirements      jsonb not null,
  source_message_id uuid references public.messages (id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (inquiry_id, version)
);

-- quotes and approvals ----------------------------------------------------
create table public.quote_versions (
  id                     uuid primary key default gen_random_uuid(),
  inquiry_id             uuid not null references public.inquiries (id) on delete cascade,
  version                integer not null check (version >= 1),
  status                 text not null default 'DRAFT'
                         check (status in ('DRAFT', 'PUBLISHED', 'ACCEPTED', 'SUPERSEDED', 'EXPIRED', 'WITHDRAWN')),
  requirement_version_id uuid references public.requirement_versions (id) on delete restrict,
  lines                  jsonb not null,
  total_minor            bigint not null check (total_minor >= 0),
  currency               char(3) not null default 'USD' check (currency = 'USD'),
  -- SHA-256 over canonical JSON; required once the quote leaves DRAFT
  quote_hash             text check (quote_hash ~ '^[0-9a-f]{64}$'),
  pending_conditions     jsonb not null default '[]'::jsonb,
  published_at           timestamptz,
  created_at             timestamptz not null default now(),
  unique (inquiry_id, version),
  check (status = 'DRAFT' or quote_hash is not null)
);

create table public.approvals (
  id               uuid primary key default gen_random_uuid(),
  quote_version_id uuid not null unique references public.quote_versions (id) on delete restrict,
  quote_hash       text not null check (quote_hash ~ '^[0-9a-f]{64}$'),
  terms_text       text not null,
  approved_at      timestamptz not null default now()
);

-- assets (private Storage objects) -----------------------------------------
create table public.assets (
  id           uuid primary key default gen_random_uuid(),
  inquiry_id   uuid not null references public.inquiries (id) on delete cascade,
  storage_path text not null unique,
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes >= 0),
  created_at   timestamptz not null default now()
);

create index assets_inquiry_id_idx on public.assets (inquiry_id);

-- audit -------------------------------------------------------------------
-- Columns match AuditRow in lib/audit.ts.
create table public.audit_events (
  id             bigint generated always as identity primary key,
  actor          text not null,
  action         text not null,
  entity         text not null,
  entity_id      text not null,
  correlation_id text not null,
  data           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index audit_events_entity_idx on public.audit_events (entity, entity_id);
create index audit_events_correlation_idx on public.audit_events (correlation_id);
