-- 0005_quote_approval: the transactions and guards behind quote versions and acceptance.
--
-- No new tables. Adds:
--   1. a tighter quote status guard (the foundation trigger let ACCEPTED return to PUBLISHED),
--   2. a partial unique index: at most one live (PUBLISHED or ACCEPTED) quote per inquiry,
--   3. create_quote_draft, publish_quote and accept_quote as single transactions.
-- Every function locks the inquiry row first and the quote row second, so concurrent calls
-- for one inquiry are serialized and cannot deadlock.
-- Business outcomes come back as jsonb {ok:false, code:'...'}; exceptions mean a bug.
-- The hash is computed in application code (canonical JSON + SHA-256) and only stored and
-- compared here.

-- A draft that is withdrawn never had a hash.
alter table public.quote_versions drop constraint quote_versions_check;
alter table public.quote_versions
  add constraint quote_versions_hash_after_draft_check
  check (status in ('DRAFT', 'WITHDRAWN') or quote_hash is not null);

-- 1. status guard -----------------------------------------------------------------
-- Allowed: DRAFT -> PUBLISHED | WITHDRAWN; PUBLISHED -> ACCEPTED | SUPERSEDED | EXPIRED | WITHDRAWN;
-- ACCEPTED -> SUPERSEDED. A row that has left DRAFT may change nothing but its status.
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

  if new.status = 'DRAFT' and old.status <> 'DRAFT' then
    raise exception 'quote_versions: cannot return to DRAFT';
  end if;

  if old.status = 'DRAFT' then
    if new.status not in ('DRAFT', 'PUBLISHED', 'WITHDRAWN') then
      raise exception 'quote_versions: DRAFT cannot become %', new.status;
    end if;
    return new;
  end if;

  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'quote_versions: a non-draft quote version is immutable; create a new version';
  end if;

  if new.status = old.status then
    return new;
  end if;

  if not (
    (old.status = 'PUBLISHED' and new.status in ('ACCEPTED', 'SUPERSEDED', 'EXPIRED', 'WITHDRAWN'))
    or (old.status = 'ACCEPTED' and new.status = 'SUPERSEDED')
  ) then
    raise exception 'quote_versions: % cannot become %', old.status, new.status;
  end if;
  return new;
end;
$$;

-- 2. one live quote per inquiry ----------------------------------------------------
create unique index quote_versions_one_live_per_inquiry
  on public.quote_versions (inquiry_id)
  where status in ('PUBLISHED', 'ACCEPTED');

-- 3a. create_quote_draft -------------------------------------------------------------
create or replace function public.create_quote_draft(
  p_inquiry_id             uuid,
  p_requirement_version_id uuid,
  p_lines                  jsonb,
  p_total_minor            bigint,
  p_pending_conditions     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locked  uuid;
  v_version integer;
  v_id      uuid;
begin
  select id into v_locked from public.inquiries where id = p_inquiry_id for update;
  if v_locked is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select coalesce(max(version), 0) + 1 into v_version
    from public.quote_versions where inquiry_id = p_inquiry_id;

  insert into public.quote_versions (inquiry_id, version, requirement_version_id, lines, total_minor, pending_conditions)
  values (p_inquiry_id, v_version, p_requirement_version_id, p_lines, p_total_minor, coalesce(p_pending_conditions, '[]'::jsonb))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'quote_id', v_id, 'version', v_version);
end;
$$;

-- 3b. publish_quote ------------------------------------------------------------------
-- Publishes a draft and supersedes the inquiry's live quote. An ACCEPTED live quote is only
-- superseded while no payment attempt for its purchase is in progress or finished by capture.
create or replace function public.publish_quote(
  p_quote_id uuid,
  p_hash     text,
  p_now      timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inquiry_id uuid;
  v_status     text;
  v_live       record;
  v_purchases  uuid[] := '{}';
begin
  select inquiry_id into v_inquiry_id from public.quote_versions where id = p_quote_id;
  if v_inquiry_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  perform 1 from public.inquiries where id = v_inquiry_id for update;
  select status into v_status from public.quote_versions where id = p_quote_id for update;
  if v_status <> 'DRAFT' then
    return jsonb_build_object('ok', false, 'code', 'NOT_DRAFT');
  end if;

  select id, status into v_live
    from public.quote_versions
   where inquiry_id = v_inquiry_id and status in ('PUBLISHED', 'ACCEPTED')
   for update;

  if found then
    if v_live.status = 'ACCEPTED' then
      if exists (
        select 1
          from public.payment_attempts pa
          join public.purchases p on p.id = pa.purchase_id
         where p.quote_version_id = v_live.id
           and pa.state not in ('CREATED', 'VOIDED', 'EXPIRED', 'FAILED')
      ) then
        return jsonb_build_object('ok', false, 'code', 'PAYMENT_STARTED');
      end if;
      select coalesce(array_agg(id), '{}') into v_purchases
        from public.purchases where quote_version_id = v_live.id;
    end if;
    update public.quote_versions set status = 'SUPERSEDED' where id = v_live.id;
  end if;

  update public.quote_versions
     set status = 'PUBLISHED', quote_hash = p_hash, published_at = p_now
   where id = p_quote_id;

  update public.inquiries set status = 'QUOTE_READY' where id = v_inquiry_id;

  return jsonb_build_object(
    'ok', true,
    'quote_id', p_quote_id,
    'superseded_quote_id', v_live.id,
    'invalidated_purchase_ids', to_jsonb(v_purchases)
  );
end;
$$;

-- 3c. accept_quote -------------------------------------------------------------------
-- Creates the approval and the purchase together and marks the quote ACCEPTED. Idempotent for
-- the same quote and hash. A published quote past its validity window becomes EXPIRED here.
create or replace function public.accept_quote(
  p_quote_id       uuid,
  p_expected_hash  text,
  p_terms_text     text,
  p_now            timestamptz,
  p_validity_hours integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inquiry_id  uuid;
  v_merchant_id uuid;
  v_quote       public.quote_versions%rowtype;
  v_approval_id uuid;
  v_purchase_id uuid;
begin
  if p_validity_hours is null or p_validity_hours < 1 then
    raise exception 'accept_quote: p_validity_hours must be at least 1';
  end if;

  select inquiry_id into v_inquiry_id from public.quote_versions where id = p_quote_id;
  if v_inquiry_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select merchant_id into v_merchant_id from public.inquiries where id = v_inquiry_id for update;
  select * into v_quote from public.quote_versions where id = p_quote_id for update;

  if v_quote.status = 'ACCEPTED' then
    if v_quote.quote_hash <> p_expected_hash then
      return jsonb_build_object('ok', false, 'code', 'HASH_MISMATCH');
    end if;
    select a.id, p.id into v_approval_id, v_purchase_id
      from public.approvals a
      join public.purchases p on p.approval_id = a.id
     where a.quote_version_id = p_quote_id;
    return jsonb_build_object('ok', true, 'already', true, 'approval_id', v_approval_id, 'purchase_id', v_purchase_id);
  end if;

  if v_quote.status <> 'PUBLISHED' then
    return jsonb_build_object('ok', false, 'code',
      case v_quote.status when 'DRAFT' then 'NOT_PUBLISHED' else v_quote.status end);
  end if;

  if p_now > v_quote.published_at + make_interval(hours => p_validity_hours) then
    update public.quote_versions set status = 'EXPIRED' where id = p_quote_id;
    return jsonb_build_object('ok', false, 'code', 'EXPIRED');
  end if;

  if v_quote.quote_hash <> p_expected_hash then
    return jsonb_build_object('ok', false, 'code', 'HASH_MISMATCH');
  end if;

  insert into public.approvals (quote_version_id, quote_hash, terms_text, approved_at)
  values (p_quote_id, v_quote.quote_hash, p_terms_text, p_now)
  returning id into v_approval_id;

  insert into public.purchases (merchant_id, inquiry_id, quote_version_id, approval_id)
  values (v_merchant_id, v_inquiry_id, p_quote_id, v_approval_id)
  returning id into v_purchase_id;

  update public.quote_versions set status = 'ACCEPTED' where id = p_quote_id;

  return jsonb_build_object('ok', true, 'already', false, 'approval_id', v_approval_id, 'purchase_id', v_purchase_id);
end;
$$;

-- Only the server (service role) may call these.
revoke all on function public.create_quote_draft(uuid, uuid, jsonb, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.publish_quote(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.accept_quote(uuid, text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.create_quote_draft(uuid, uuid, jsonb, bigint, jsonb) to service_role;
grant execute on function public.publish_quote(uuid, text, timestamptz) to service_role;
grant execute on function public.accept_quote(uuid, text, text, timestamptz, integer) to service_role;
