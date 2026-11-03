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
