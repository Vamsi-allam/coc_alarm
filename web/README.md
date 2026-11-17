# Builder Desk

HTML, CSS, and JavaScript builder timer with Supabase storage and per-account Discord completion alerts.

Add regular builders and upgrade timers by type: Home Village supports Builder, Lab, and Pet House; Night Village supports Builder and Lab. Each type has its own numbered timers, so (for example) Builder 1 and Lab 1 can both be tracked for the same account and village. Existing local records and CSV files without a **Builder Type** column remain regular builders.

When adding timers, select an existing account or choose **New account** and enter its name. The account list comes from existing timers and is updated when timers are added, imported, or removed.

The **Account timers** summary shows each account's Home and Night Village timers as **in progress / total** (for example, Home: 4/8 and Night: 2/4). It includes all accounts regardless of builder-list filters and updates as timers finish. Click an account card to show that account's timers from both villages; the account dropdown stays in sync and **Show all** clears the filter.

Use the arrows on account cards to change their order. The order also applies to the builder list and account dropdowns. With Supabase configured, the shared order is saved there; reload the app on another device to see changes. In local mode, it is saved only in that browser.

For a running **Home Village Lab** timer, select **Assign assistant** on its row when the account's assistant is available. In the pop-up, choose its level and optionally **Keep assigned until upgrade is complete**, then confirm after assigning it in the game. Each account has one assistant; while an assignment is tracked, another Lab timer on that account cannot use it. The time saved appears above the remaining time on the assigned timer. The countdown applies the assistant's bonus gradually as it works; the estimated finish includes its expected future work. The assistant works for up to one hour at its level's bonus rate, and the shared helper workday lasts 23 hours. If another helper already started the workday, enter its remaining time in the pop-up; leave it blank to start a new workday. Future work is forecast in advance, so the estimated finish time and Discord alert still work with the browser closed.

The app does not interact with Clash of Clans; if the in-game assignment or workday changes, update the tracker to match. **Stop tracking assignment** retains time already saved and removes future projected work; if the assistant continues working in the game, the estimate will no longer match. Stop tracking before editing, deleting, or importing a changed active Lab timer. With Supabase, reload another device to see changes. Local-mode assistant data stays in that browser; existing local assistant assignments are not migrated to Supabase automatically. Stop any active local assignment before switching to Supabase with an empty timer table.

In-progress builder rows have a steady amber background without blinking. Ready builders keep their green Home Village or blue Night Village backgrounds.

## Configure Supabase

1. Create a Supabase project.
2. Open the Supabase SQL Editor and run (or rerun) `supabase_setup.sql`. It adds builder types and alert state to `builder_timers`, creates the shared `account_order` and `lab_assistants` tables, and creates the private `discord_webhooks` and `lab_assistant_alerts` tables.
3. Copy `.env.example` to `.env.local` and set the project URL and publishable/anon key.
4. Run `npm install`, then `npm run dev` from this directory.

The app has no sign-in. Its anon key is intentionally used in the browser, and the SQL policies allow public read/write access to timer rows and the shared account order, as well as reading and assigning Lab Assistants through database functions. Anyone with the deployed site can view, add, change, or delete timers, change the account order, assign or stop Lab Assistants, and could trigger alerts by changing timers. Store only non-sensitive data; consider access control before publishing. The `discord_webhooks` table has no anon policies or grants; only the Edge Function's server-side secret can read it. Never put a Supabase secret/service-role key or a Discord webhook URL in browser code or a `VITE_` variable.

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

Tracked Home Village Lab Assistants also send alerts to that same account's Discord channel when a work session ends (including early upgrade completion), when the cooldown ends without a future assignment, and when the tracked Lab upgrade finishes and needs a new assignment. Repeated assignments notify after each work session; availability is notified only after the final session's cooldown. These are additional to the normal upgrade-complete alert. Events are recorded as sent rather than reminded every minute; failed deliveries are retried. A delivery whose Discord response or database acknowledgement is lost may be repeated on retry.

To enable these alerts on an existing installation, rerun `supabase_setup.sql` and redeploy `discord-builder-alerts`. The existing minute schedule and account webhooks are reused; no browser needs to remain open. Existing tracked assignments are included, so already-due events may arrive after enabling the feature. Stopping tracking cancels pending assistant work/upgrade alerts but retains the cooldown-ready alert. Local-only assignments cannot send Discord alerts.

## Data migration

If the Supabase timer table is empty when the app launches, existing browser-local timers are copied there. You can also use **Import CSV**. CSV files are read in the browser and are not uploaded as files.

## Deploy to Vercel

Set the Vercel project root to `web`, the build command to `npm run build`, and the output directory to `dist`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel's environment variables, then redeploy. Discord alerts run from Supabase, so they continue when the browser is closed. The old Python desktop app and CSV stay outside the deployed site.