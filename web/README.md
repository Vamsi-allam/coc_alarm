# Builder Desk

HTML, CSS, and JavaScript builder timer with Supabase storage and per-account Discord completion alerts.

The **Account builders** summary shows each account's Home and Night Village builders as **in progress / total** (for example, Home: 4/8 and Night: 2/4). It includes all accounts regardless of builder-list filters and updates as timers finish.

In-progress builder rows have a steady amber background without blinking. Ready builders keep their green Home Village or blue Night Village backgrounds.

## Configure Supabase

1. Create a Supabase project.
2. Open the Supabase SQL Editor and run (or rerun) `supabase_setup.sql`. It adds alert state to `builder_timers` and creates a private `discord_webhooks` table.
3. Copy `.env.example` to `.env.local` and set the project URL and publishable/anon key.
4. Run `npm install`, then `npm run dev` from this directory.

The app has no sign-in. Its anon key is intentionally used in the browser, and the SQL policies allow public read/write access to timer rows. Anyone with the deployed site can view, add, change, or delete timers, and could trigger alerts by changing timers. Store only non-sensitive data; consider access control before publishing. The `discord_webhooks` table has no anon policies or grants; only the Edge Function's server-side secret can read it. Never put a Supabase secret/service-role key or a Discord webhook URL in browser code or a `VITE_` variable.

## Configure Discord alerts

1. In Discord, create a webhook for each channel that should receive alerts.
2. Add the account's builders in Builder Desk first. Open **Webhooks**, enter `WEBHOOK_ADMIN_PASSWORD`, choose that builder account, and enter its Discord webhook URL. The account picker comes from `builder_timers`; it marks whether a webhook is saved, and the URL is never sent back to the browser. You can still manage rows directly in **Table Editor → `discord_webhooks`** if needed.
3. Generate two different random values locally with `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. In **Edge Functions → Secrets**, add them as `CRON_SECRET` and `WEBHOOK_ADMIN_PASSWORD`. Keep both values private; the passcode is only for webhook settings, not a sign-in account.
4. Install and log in to the Supabase CLI, then link it to this project from this directory: `supabase login` and `supabase link --project-ref YOUR_PROJECT_REF`.
5. Deploy both functions: `supabase functions deploy discord-builder-alerts --no-verify-jwt` and `supabase functions deploy discord-webhook-settings --no-verify-jwt`. In the Dashboard editor, deploy the corresponding `.ts` file and turn **Verify JWT** off for each. The alert function checks the Secret API key and `CRON_SECRET`; the settings function checks the publishable key and `WEBHOOK_ADMIN_PASSWORD`.
6. In Supabase **Database → Vault**, create `discord_builder_alert_function_url` with value `https://YOUR_PROJECT_REF.supabase.co/functions/v1/discord-builder-alerts`, `discord_builder_alert_cron_secret` with the same value as `CRON_SECRET`, and `discord_builder_alert_project_secret_key` with the project's **Secret API key**. The schedule sends that key only from Vault to the alert function; never put it in the frontend or a `VITE_` variable.
7. Run `discord_alert_schedule.sql` in the Supabase SQL Editor. It checks every minute; alerts may arrive up to about one minute after a timer finishes.
8. Use **Webhooks** in the app, enter `WEBHOOK_ADMIN_PASSWORD`, select an account that already has builders, and paste its Discord URL. The URL is sent directly to Supabase and never returned to the browser. The passcode is cleared when the dialog closes.

Only timers set with a positive duration are eligible. New unassigned builders and manually completed timers do not send alerts. A missing account webhook is skipped and can be added later in the table editor.

## Data migration

If the Supabase timer table is empty when the app launches, existing browser-local timers are copied there. You can also use **Import CSV**. CSV files are read in the browser and are not uploaded as files.

## Deploy to Vercel

Set the Vercel project root to `web`, the build command to `npm run build`, and the output directory to `dist`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel's environment variables, then redeploy. Discord alerts run from Supabase, so they continue when the browser is closed. The old Python desktop app and CSV stay outside the deployed site.