-- 0009_intake: one assistant reply per customer message.
--
-- No new tables. Adds messages.reply_to (the customer message an assistant message answers), a unique index so a customer
-- message has at most one assistant reply, and a guard so a reply can only answer a customer message of its own inquiry.
-- That makes the intake turn safe to repeat: two requests for the same turn, a double click or a retry after a timeout
-- cannot produce two replies; the loser reads the winner's answer. Customer, merchant and system messages never carry it.
-- Precondition: none (the column is new and null for every existing row).

alter table public.messages
  add column reply_to uuid references public.messages (id) on delete cascade,
  add constraint messages_reply_to_assistant_only check (reply_to is null or role = 'assistant');

create unique index messages_one_reply_per_message on public.messages (reply_to) where reply_to is not null;

create or replace function public.guard_message_reply()
returns trigger
language plpgsql
as $$
declare
  v_target public.messages%rowtype;
begin
  if new.reply_to is null then
    return new;
  end if;
  select * into v_target from public.messages where id = new.reply_to;
  if not found then
    -- The foreign key reports a message that does not exist.
    return new;
  end if;
  if v_target.role <> 'customer' or v_target.inquiry_id <> new.inquiry_id then
    raise exception 'messages: a reply must answer a customer message of the same inquiry';
  end if;
  return new;
end;
$$;

create trigger messages_guard_reply
  before insert on public.messages
  for each row execute function public.guard_message_reply();

-- intake_post_message ------------------------------------------------------------------------------
-- Stores one more customer message, atomically. The inquiry row is locked first, so two submits at the same instant are
-- handled one after the other: the cap on messages and the double-submit check (an identical customer message right after the
-- last message of the inquiry, within the window, is the same message) see a consistent state, and exactly one message is
-- stored. Anything else about the turn (the model, the state) is the caller's business.
create or replace function public.intake_post_message(
  p_inquiry_id     uuid,
  p_body           text,
  p_now            timestamptz,
  p_max_messages   integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status  text;
  v_count   integer;
  v_last    public.messages%rowtype;
  v_id      uuid;
begin
  if p_inquiry_id is null or p_now is null or p_body is null or btrim(p_body) = '' or length(p_body) > 10000
     or p_max_messages is null or p_max_messages < 1 or p_window_seconds is null or p_window_seconds < 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;

  select status into v_status from public.inquiries where id = p_inquiry_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'INQUIRY_NOT_FOUND');
  end if;

  select count(*) into v_count from public.messages where inquiry_id = p_inquiry_id;
  if v_count >= p_max_messages then
    return jsonb_build_object('ok', false, 'code', 'LIMIT_REACHED', 'status', v_status);
  end if;

  select * into v_last from public.messages where inquiry_id = p_inquiry_id order by created_at desc, id desc limit 1;
  if found and v_last.role = 'customer' and v_last.body = p_body and v_last.created_at >= p_now - make_interval(secs => p_window_seconds) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'message_id', v_last.id);
  end if;

  insert into public.messages (inquiry_id, role, body, created_at) values (p_inquiry_id, 'customer', p_body, p_now) returning id into v_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'message_id', v_id);
end;
$$;

revoke all on function public.intake_post_message(uuid, text, timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.intake_post_message(uuid, text, timestamptz, integer, integer) to service_role;
