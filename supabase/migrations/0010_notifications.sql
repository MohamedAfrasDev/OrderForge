-- 0010_notifications: an optional customer email, and an outbox of the emails that were or will be sent.
--
-- inquiries.customer_email: nullable, lowercased, at most 254 characters, a simple format check. The customer may give it on the
-- store form; it is used only to email that customer about their own request.
-- notifications: one row per email event, never the message itself. The row says which inquiry, who it is for (the customer or the
-- shop), what happened, and a dedupe key that is unique, so an event is queued once however often the scheduled run looks at the
-- state. It stores no message text and no address: the customer's address is on the inquiry, the shop's is resolved when sending.
-- Only the service role reads or writes it: row level security is on, there is no policy, and no table privilege for anon or
-- authenticated.
-- Precondition: none (the column is new and null for every existing row; the table is new).

alter table public.inquiries
  add column customer_email text,
  add constraint inquiries_customer_email_valid check (
    customer_email is null
    or (
      length(customer_email) <= 254
      and customer_email = lower(customer_email)
      and customer_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  );

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  inquiry_id  uuid not null references public.inquiries (id) on delete cascade,
  recipient   text not null check (recipient in ('customer', 'shop')),
  kind        text not null check (kind in (
                'request_started', 'price_ready', 'shop_replied', 'order_accepted', 'order_declined', 'ready_for_pickup',
                'request_handed_over', 'order_awaiting_ok'
              )),
  dedupe_key  text not null check (length(dedupe_key) between 1 and 200),
  status      text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts    integer not null default 0 check (attempts between 0 and 10),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  sent_at     timestamptz,
  constraint notifications_dedupe_key_unique unique (dedupe_key),
  constraint notifications_sent_at_matches_status check ((status = 'SENT') = (sent_at is not null))
);

create index notifications_pending_idx on public.notifications (created_at) where status = 'PENDING';
create index notifications_inquiry_idx on public.notifications (inquiry_id);

create trigger notifications_set_updated_at
  before update on public.notifications
  for each row execute function public.set_updated_at();

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
