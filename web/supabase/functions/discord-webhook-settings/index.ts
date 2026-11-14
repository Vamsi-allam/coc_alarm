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
  let difference = 0;
  for (let index = 0; index < suppliedBytes.length; index += 1) {
    difference |= suppliedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
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

function normalize(value: string) {
  return value.trim().toLocaleLowerCase();
}

export default {
  fetch: withSupabase({ auth: "publishable" }, async (request, ctx) => {
    if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed." });

    const expectedPassword = Deno.env.get("WEBHOOK_ADMIN_PASSWORD");
    let payload: Record<string, unknown>;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(400, { error: "Invalid request body." });
    }

    const suppliedPassword = typeof payload.adminPassword === "string" ? payload.adminPassword : "";
    if (!expectedPassword || !await secretsMatch(suppliedPassword, expectedPassword)) {
      return jsonResponse(401, { error: "Incorrect settings passcode." });
    }

    const supabase = ctx.supabaseAdmin;
    const action = payload.action;

    if (action === "list") {
      const [{ data: builderRows, error: builderError }, { data: webhookRows, error: webhookError }] = await Promise.all([
        supabase.from("builder_timers").select("account"),
        supabase.from("discord_webhooks").select("account"),
      ]);
      if (builderError || webhookError) {
        console.error("Could not load webhook account settings.", builderError?.message ?? webhookError?.message);
        return jsonResponse(500, { error: "Could not load builder accounts." });
      }

      const configuredAccounts = new Set((webhookRows ?? []).map((row) => normalize(row.account)));
      const uniqueAccounts = new Map<string, string>();
      for (const row of builderRows ?? []) {
        uniqueAccounts.set(normalize(row.account), row.account);
      }
      const accounts = [...uniqueAccounts.values()]
        .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))
        .map((account) => ({ account, webhookConfigured: configuredAccounts.has(normalize(account)) }));

      return jsonResponse(200, { accounts });
    }

    const account = typeof payload.account === "string" ? payload.account.trim() : "";
    if (!account || account.length > 100) {
      return jsonResponse(400, { error: "Select a builder account first." });
    }

    const { data: webhookRows, error: webhookError } = await supabase
      .from("discord_webhooks")
      .select("account");
    if (webhookError) {
      console.error("Could not load Discord destination accounts.", webhookError.message);
      return jsonResponse(500, { error: "Could not access Discord destinations." });
    }

    if (action === "save") {
      const { data: builderRows, error: builderError } = await supabase
        .from("builder_timers")
        .select("account");
      if (builderError) {
        console.error("Could not verify builder account.", builderError.message);
        return jsonResponse(500, { error: "Could not verify that builder account." });
      }
      const canonicalAccount = builderRows.find((row) => normalize(row.account) === normalize(account))?.account;
      if (!canonicalAccount) {
        return jsonResponse(400, { error: "That account has no builders yet. Add its builders first." });
      }

      const webhookUrl = typeof payload.webhookUrl === "string" ? payload.webhookUrl.trim() : "";
      if (!isDiscordWebhook(webhookUrl)) {
        return jsonResponse(400, { error: "Enter a valid Discord webhook URL." });
      }
      const { error } = await supabase
        .from("discord_webhooks")
        .upsert({ account: canonicalAccount, webhook_url: webhookUrl }, { onConflict: "account" });
      if (error) {
        console.error("Could not save Discord destination.", error.message);
        return jsonResponse(500, { error: "Could not save Discord destination." });
      }
      return jsonResponse(200, { account: canonicalAccount });
    }

    if (action === "delete") {
      const existingAccount = webhookRows.find((row) => normalize(row.account) === normalize(account))?.account;
      if (!existingAccount) return jsonResponse(404, { error: "No Discord destination exists for that account." });
      const { error } = await supabase
        .from("discord_webhooks")
        .delete()
        .eq("account", existingAccount);
      if (error) {
        console.error("Could not remove Discord destination.", error.message);
        return jsonResponse(500, { error: "Could not remove Discord destination." });
      }
      return jsonResponse(200, { account: existingAccount });
    }

    return jsonResponse(400, { error: "Unknown action." });
  }),
};