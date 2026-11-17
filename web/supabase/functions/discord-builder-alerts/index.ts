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
    const { data: assistantAlerts, error: assistantClaimError } = await supabase
      .rpc("claim_due_lab_assistant_alerts", { batch_size: 50 });
    if (assistantClaimError) {
      console.error("Could not claim helper alerts.", assistantClaimError.message);
      return jsonResponse(500, { error: "Could not claim helper alerts. Run the updated database setup." });
    }

    const helperNames: Record<string, string> = { Lab: "Lab Assistant", Builder: "Builder's Apprentice" };
    function helperMessage(helperType: string, eventType: string) {
      const name = helperNames[helperType];
      if (!name) return undefined;
      const messages: Record<string, { title: string; description: string }> = {
        work_finished: {
          title: `${name} Work Finished`,
          description: `Your ${name} has finished this work session.`,
        },
        available: {
          title: `${name} Available`,
          description: `Your ${name}'s cooldown has ended. It is ready and not assigned to a future work session.`,
        },
        upgrade_finished: {
          title: `${helperType} Upgrade Complete - ${name} Needs Assignment`,
          description: `The ${helperType} upgrade has finished. Assign your ${name} to a new upgrade when its cooldown allows.`,
        },
      };
      return messages[eventType];
    }
    const deliveries = [
      ...(timers ?? []).map((timer) => ({
        table: "builder_timers" as const,
        id: timer.id,
        account: timer.account,
        claimedAt: timer.discord_alert_claimed_at,
        title: "Builder Upgrade Complete",
        description: "Your upgrade is ready.",
        village: timer.village,
        upgrade: `${timer.builder_type} #${timer.builder_number}`,
        timestamp: new Date().toISOString(),
      })),
      ...(assistantAlerts ?? []).map((alert) => ({
        table: "lab_assistant_alerts" as const,
        id: alert.id,
        account: alert.account,
        claimedAt: alert.claimed_at,
        title: helperMessage(alert.helper_type, alert.event_type)?.title,
        description: helperMessage(alert.helper_type, alert.event_type)?.description,
        village: "Home Village",
        upgrade: alert.builder_number ? `${alert.helper_type} #${alert.builder_number}` : helperNames[alert.helper_type],
        timestamp: alert.due_at,
      })),
    ];

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const delivery of deliveries) {
      const claimColumn = delivery.table === "builder_timers" ? "discord_alert_claimed_at" : "claimed_at";
      const releaseClaim = async () => {
        const { error } = await supabase.from(delivery.table)
          .update({ [claimColumn]: null })
          .eq("id", delivery.id)
          .eq(claimColumn, delivery.claimedAt);
        if (error) console.error("Could not release a Discord alert claim.", error.message);
      };
      if (!delivery.title || !delivery.description) {
        failed += 1;
        console.error("Unrecognized helper alert event.");
        await releaseClaim();
        continue;
      }
      const accountKey = delivery.account.trim().toLocaleLowerCase();
      const webhookUrl = webhooks.get(accountKey);
      if (!webhookUrl || !isDiscordWebhook(webhookUrl)) {
        skipped += 1;
        await releaseClaim();
        continue;
      }

      try {
        const isNightVillage = delivery.village === "Night Village";
        const discordResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "@everyone",
            embeds: [{
              title: delivery.title,
              description: [
                delivery.description,
                "",
                `**Account:** ${delivery.account}`,
                `**Village:** ${delivery.village}`,
                `**Upgrade:** ${delivery.upgrade}`,
              ].join("\n"),
              color: isNightVillage ? 0x66ccff : 0x33cc66,
              timestamp: delivery.timestamp,
              footer: { text: "Builder Desk" },
            }],
            allowed_mentions: { parse: ["everyone"] },
          }),
        });
        if (!discordResponse.ok) {
          failed += 1;
          console.error(`Discord returned HTTP ${discordResponse.status} for an account webhook.`);
          await releaseClaim();
          continue;
        }

        const { error: updateError } = await supabase
          .from(delivery.table)
          .update(delivery.table === "builder_timers" ? {
            discord_alert_enabled: false,
            discord_alert_sent_at: new Date().toISOString(),
            discord_alert_claimed_at: null,
          } : {
            sent_at: new Date().toISOString(),
            claimed_at: null,
          })
          .eq("id", delivery.id)
          .eq(claimColumn, delivery.claimedAt);
        if (updateError) {
          failed += 1;
          console.error("Alert sent, but its database row could not be marked as notified.", updateError.message);
        } else {
          sent += 1;
        }
      } catch (error) {
        failed += 1;
        console.error("Could not deliver a Discord alert.", error instanceof Error ? error.name : "Unknown error");
        await releaseClaim();
      }
    }

    return jsonResponse(200, { claimed: deliveries.length, sent, failed, skipped });
  }),
};