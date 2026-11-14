import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const jsonHeaders = { "Content-Type": "application/json" };

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

async function secretsMatch(supplied: string, expected: string) {
  const encoder = new TextEncoder();
  const [suppliedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const suppliedBytes = new Uint8Array(suppliedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  return suppliedBytes.every((value, index) => value === expectedBytes[index]);
}

function isDiscordWebhook(value: string) {
  try {
    const url = new URL(value);
    return (url.hostname === "discord.com" || url.hostname === "discordapp.com")
      && url.protocol === "https:"
      && /^\/api\/webhooks\/\d+\//.test(url.pathname);
  } catch {
    return false;
  }
}

export default {
  fetch: withSupabase({ auth: "secret" }, async (request, ctx) => {
    if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed." });

    const cronSecret = Deno.env.get("CRON_SECRET");
    const suppliedSecret = request.headers.get("x-cron-secret") ?? "";
    if (!cronSecret || !await secretsMatch(suppliedSecret, cronSecret)) {
      return jsonResponse(401, { error: "Unauthorized." });
    }

    const supabase = ctx.supabaseAdmin;
    const { data: webhookRows, error: webhookError } = await supabase
      .from("discord_webhooks")
      .select("account, webhook_url");
    if (webhookError) {
      console.error("Could not load Discord webhook settings.", webhookError.message);
      return jsonResponse(500, { error: "Could not load Discord webhook settings." });
    }

    const webhooks = new Map(
      (webhookRows ?? []).map((row) => [row.account.trim().toLocaleLowerCase(), row.webhook_url]),
    );
    const { data: timers, error: claimError } = await supabase
      .rpc("claim_due_builder_alerts", { batch_size: 50 });
    if (claimError) {
      console.error("Could not claim due builder alerts.", claimError.message);
      return jsonResponse(500, { error: "Could not claim due builder alerts." });
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const timer of timers ?? []) {
      const accountKey = timer.account.trim().toLocaleLowerCase();
      const webhookUrl = webhooks.get(accountKey);
      if (!webhookUrl || !isDiscordWebhook(webhookUrl)) {
        skipped += 1;
        await supabase
          .from("builder_timers")
          .update({ discord_alert_claimed_at: null })
          .eq("id", timer.id);
        continue;
      }

      try {
        const isNightVillage = timer.village === "Night Village";
        const discordResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [{
              title: "Builder Upgrade Complete",
              description: [
                "Your builder is ready for its next upgrade.",
                "",
                `**Account:** ${timer.account}`,
                `**Village:** ${timer.village}`,
                `**Builder:** #${timer.builder_number}`,
              ].join("\n"),
              color: isNightVillage ? 0x66ccff : 0x33cc66,
              timestamp: new Date().toISOString(),
              footer: { text: "Builder Desk" },
            }],
            allowed_mentions: { parse: [] },
          }),
        });
        if (!discordResponse.ok) {
          failed += 1;
          console.error(`Discord returned HTTP ${discordResponse.status} for an account webhook.`);
          await supabase
            .from("builder_timers")
            .update({ discord_alert_claimed_at: null })
            .eq("id", timer.id);
          continue;
        }

        const { error: updateError } = await supabase
          .from("builder_timers")
          .update({
            discord_alert_enabled: false,
            discord_alert_sent_at: new Date().toISOString(),
            discord_alert_claimed_at: null,
          })
          .eq("id", timer.id)
          .eq("discord_alert_enabled", true)
          .is("discord_alert_sent_at", null);
        if (updateError) {
          failed += 1;
          console.error("Alert sent, but its timer row could not be marked as notified.", updateError.message);
        } else {
          sent += 1;
        }
      } catch {
        failed += 1;
        console.error("Could not deliver a Discord builder alert.");
        await supabase
          .from("builder_timers")
          .update({ discord_alert_claimed_at: null })
          .eq("id", timer.id);
      }
    }

    return jsonResponse(200, { claimed: timers?.length ?? 0, sent, failed, skipped });
  }),
};