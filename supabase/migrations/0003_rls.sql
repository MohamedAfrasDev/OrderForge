-- 0003_rls: row level security on every table, plus the demo reset function.
--
-- Model: server code writes with the service-role key (which bypasses RLS). A signed-in
-- merchant (role authenticated) may only READ rows that belong to a merchant they own.
-- anon gets nothing. Customers never query the database directly: the server verifies
-- their signed link and reads with the service role, filtered on the verified inquiry id.

-- Which merchants does the current user own? SECURITY DEFINER so policies on other
-- tables do not depend on the caller's policies for public.merchants.
create or replace function public.my_merchant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.merchants where owner_user_id = auth.uid()
$$;

revoke all on function public.my_merchant_ids() from public, anon;
grant execute on function public.my_merchant_ids() to authenticated, service_role;

-- Defense in depth: no direct writes from the client roles, and no access at all for anon.
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke insert, update, delete, truncate on tables from authenticated;

alter table public.merchants            enable row level security;
alter table public.products             enable row level security;
alter table public.stock                enable row level security;
alter table public.business_rules       enable row level security;
alter table public.inquiries            enable row level security;
alter table public.messages             enable row level security;
alter table public.requirement_versions enable row level security;
alter table public.quote_versions       enable row level security;
alter table public.approvals            enable row level security;
alter table public.assets               enable row level security;
alter table public.audit_events         enable row level security;
alter table public.purchases            enable row level security;
alter table public.reservations         enable row level security;
alter table public.reservation_lines    enable row level security;
alter table public.payment_attempts     enable row level security;
alter table public.payment_events       enable row level security;
alter table public.merchant_decisions   enable row level security;
alter table public.preparation_jobs     enable row level security;
alter table public.preparation_events   enable row level security;

-- Direct merchant_id ----------------------------------------------------------
create policy merchants_select_own on public.merchants
  for select to authenticated using (id in (select public.my_merchant_ids()));

create policy products_select_own on public.products
  for select to authenticated using (merchant_id in (select public.my_merchant_ids()));

create policy business_rules_select_own on public.business_rules
  for select to authenticated using (merchant_id in (select public.my_merchant_ids()));

create policy inquiries_select_own on public.inquiries
  for select to authenticated using (merchant_id in (select public.my_merchant_ids()));

create policy purchases_select_own on public.purchases
  for select to authenticated using (merchant_id in (select public.my_merchant_ids()));

create policy merchant_decisions_select_own on public.merchant_decisions
  for select to authenticated using (merchant_id in (select public.my_merchant_ids()));

-- Through products -------------------------------------------------------------
create policy stock_select_own on public.stock
  for select to authenticated using (
    product_id in (select id from public.products where merchant_id in (select public.my_merchant_ids()))
  );

-- Through inquiries ------------------------------------------------------------
create policy messages_select_own on public.messages
  for select to authenticated using (
    inquiry_id in (select id from public.inquiries where merchant_id in (select public.my_merchant_ids()))
  );

create policy requirement_versions_select_own on public.requirement_versions
  for select to authenticated using (
    inquiry_id in (select id from public.inquiries where merchant_id in (select public.my_merchant_ids()))
  );

create policy quote_versions_select_own on public.quote_versions
  for select to authenticated using (
    inquiry_id in (select id from public.inquiries where merchant_id in (select public.my_merchant_ids()))
  );

create policy assets_select_own on public.assets
  for select to authenticated using (
    inquiry_id in (select id from public.inquiries where merchant_id in (select public.my_merchant_ids()))
  );

-- Through purchases ------------------------------------------------------------
create policy approvals_select_own on public.approvals
  for select to authenticated using (
    id in (select approval_id from public.purchases where merchant_id in (select public.my_merchant_ids()))
  );

create policy reservations_select_own on public.reservations
  for select to authenticated using (
    purchase_id in (select id from public.purchases where merchant_id in (select public.my_merchant_ids()))
  );

create policy reservation_lines_select_own on public.reservation_lines
  for select to authenticated using (
    reservation_id in (
      select r.id from public.reservations r
      join public.purchases p on p.id = r.purchase_id
      where p.merchant_id in (select public.my_merchant_ids())
    )
  );

create policy payment_attempts_select_own on public.payment_attempts
  for select to authenticated using (
    purchase_id in (select id from public.purchases where merchant_id in (select public.my_merchant_ids()))
  );

create policy payment_events_select_own on public.payment_events
  for select to authenticated using (
    payment_attempt_id in (
      select pa.id from public.payment_attempts pa
      join public.purchases p on p.id = pa.purchase_id
      where p.merchant_id in (select public.my_merchant_ids())
    )
  );

create policy preparation_jobs_select_own on public.preparation_jobs
  for select to authenticated using (
    purchase_id in (select id from public.purchases where merchant_id in (select public.my_merchant_ids()))
  );

create policy preparation_events_select_own on public.preparation_events
  for select to authenticated using (
    job_id in (
      select j.id from public.preparation_jobs j
      join public.purchases p on p.id = j.purchase_id
      where p.merchant_id in (select public.my_merchant_ids())
    )
  );

-- audit_events has no merchant column: no policy, so it is service-role only.

-- Demo reset ----------------------------------------------------------------------
-- Wipes all application data (not auth users) so the seed script can restore the fixtures.
-- Callable only with the service-role key; the script also refuses to run unless SANDBOX_MODE=true.
create or replace function public.demo_reset()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  truncate table
    public.preparation_events,
    public.preparation_jobs,
    public.merchant_decisions,
    public.payment_events,
    public.payment_attempts,
    public.reservation_lines,
    public.reservations,
    public.purchases,
    public.approvals,
    public.quote_versions,
    public.requirement_versions,
    public.assets,
    public.messages,
    public.inquiries,
    public.stock,
    public.business_rules,
    public.products,
    public.audit_events,
    public.merchants
  restart identity cascade;
end;
$$;

revoke all on function public.demo_reset() from public, anon, authenticated;
grant execute on function public.demo_reset() to service_role;
