create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname = 'discord-builder-alerts-every-minute';

select cron.schedule(
  'discord-builder-alerts-every-minute',
  '* * * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'discord_builder_alert_function_url'
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'discord_builder_alert_project_secret_key'
        ),
        'x-cron-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'discord_builder_alert_cron_secret'
        )
      ),
      body := '{}'::jsonb
    );
  $$
);