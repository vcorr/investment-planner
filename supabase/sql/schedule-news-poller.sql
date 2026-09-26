-- Schedules the news-poller Edge Function every 5 minutes with pg_cron and pg_net.
--
-- How to apply (once, after deploying the function):
-- 1. Store two Vault secrets in the SQL editor. Never commit their values:
--      select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/news-poller', 'news_poller_url');
--      select vault.create_secret('<the default secret key, sb_secret_...>', 'news_poller_key');
--    To change one later: select vault.update_secret(id, '<new value>') with the id from vault.secrets.
-- 2. Run this file in the SQL editor, or with psql against the project database.
--
-- Re-running is safe: cron.schedule replaces a job with the same name.
-- Check runs:  select * from cron.job_run_details order by start_time desc limit 20;
-- Responses:   select * from net._http_response order by created desc limit 20;  (kept for about 6 hours)
-- Stop:        select cron.unschedule('news-poller');
--
-- Never schedule more often than every 30 seconds (docs/verification.md V12).

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'news-poller',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'news_poller_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'news_poller_key')
    ),
    body := '{}'::jsonb,
    -- Catch-up after downtime fetches up to 5 pages with pauses between them; allow a minute.
    timeout_milliseconds := 60000
  );
  $$
);
