-- 0004_cron: schedule the reconcile job inside Supabase (pg_cron + pg_net), because Vercel Hobby
-- cannot run cron at this frequency.
--
-- Every 5 minutes: pg_cron -> public.invoke_reconcile() -> pg_net HTTP POST -> /api/cron/reconcile
-- with "Authorization: Bearer <cron_secret>". The app URL and the secret are read from Supabase
-- Vault (names: app_base_url, cron_secret), so neither is written into a migration or this repo.
-- Evidence of runs: cron.job_run_details (scheduler) and net._http_response (HTTP answers).
--
-- Safe to apply anywhere: if the extensions are unavailable the schedule is skipped with a
-- notice, and if the Vault secrets are missing a run does nothing, so local resets and CI pass.

create or replace function public.invoke_reconcile()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_url text;
  cron_secret text;
begin
  select decrypted_secret into base_url from vault.decrypted_secrets where name = 'app_base_url';
  select decrypted_secret into cron_secret from vault.decrypted_secrets where name = 'cron_secret';

  if base_url is null or cron_secret is null then
    raise notice 'reconcile skipped: Vault secrets app_base_url and cron_secret are not both set';
    return;
  end if;

  perform net.http_post(
    url := rtrim(base_url, '/') || '/api/cron/reconcile',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || cron_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
end;
$$;

-- Only the scheduler (running as postgres) calls this; it reads secrets, so nobody else may.
revoke all on function public.invoke_reconcile() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from pg_available_extensions where name = 'supabase_vault') then

    create extension if not exists supabase_vault;
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron;

    -- Re-running the migration must not create a second job.
    perform cron.unschedule(jobid) from cron.job where jobname = 'orderforge-reconcile';
    perform cron.schedule('orderforge-reconcile', '*/5 * * * *', 'select public.invoke_reconcile()');
  else
    raise notice 'pg_cron, pg_net or supabase_vault is not available here: reconcile schedule skipped';
  end if;
end;
$$;
