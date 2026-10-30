import { ExecutionError, type FailureClass } from "@orbix/core";
import { httpJson } from "../http";
import type { Connector, InvokeContext, PreflightResult } from "../types";

const API = "https://slack.com/api";

const ERROR_CLASS: Record<string, FailureClass> = {
  ratelimited: "rate_limited",
  invalid_auth: "permission",
  not_authed: "permission",
  token_revoked: "permission",
  token_expired: "permission",
  account_inactive: "permission",
  missing_scope: "permission",
  no_permission: "permission",
  channel_not_found: "permanent",
  not_in_channel: "permanent",
  is_archived: "permanent",
  msg_too_long: "permanent",
  invalid_arguments: "permanent",
  internal_error: "transient",
  fatal_error: "transient",
  service_unavailable: "transient",
};

interface SlackResponse {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

interface SlackChannel {
  id: string;
  name: string;
  is_member?: boolean;
  is_archived?: boolean;
  is_private?: boolean;
}

/**
 * Slack returns HTTP 200 with `ok:false`; normalise into ExecutionError. Writes go as JSON (needed for
 * message metadata); reads go form-encoded, which Slack accepts on every Web API method.
 */
export async function slackCall<T extends SlackResponse>(
  ctx: Pick<InvokeContext, "getAccessToken" | "timeoutMs">,
  method: string,
  body: Record<string, unknown>,
  write = false,
): Promise<T> {
  const token = await ctx.getAccessToken();
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) if (v !== undefined) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  const res = await httpJson<T>(`${API}/${method}`, {
    method: "POST",
    body: write ? body : form.toString(),
    write,
    timeoutMs: ctx.timeoutMs,
    headers: { Authorization: `Bearer ${token}`, ...(write ? {} : { "Content-Type": "application/x-www-form-urlencoded" }) },
  });
  if (!res.data.ok) {
    const code = res.data.error ?? "unknown_error";
    const cls = ERROR_CLASS[code] ?? (write ? "ambiguous" : "permanent");
    throw new ExecutionError(cls, `Slack ${method}: ${code}`, { providerCode: code });
  }
  return res.data;
}

const METADATA_TYPE = "orbix_action";
const CHANNEL_ID_RE = /^[CG][A-Z0-9]{6,}$/;

const isMissingScope = (e: unknown) => e instanceof ExecutionError && e.details.providerCode === "missing_scope";

/** Finds a channel by id or #name as the bot sees it. Private channels are searched when groups:read allows. */
export async function findSlackChannel(ctx: Pick<InvokeContext, "getAccessToken" | "timeoutMs">, raw: string): Promise<SlackChannel | null> {
  const value = raw.trim();
  if (CHANNEL_ID_RE.test(value)) {
    try {
      const res = await slackCall<SlackResponse & { channel: SlackChannel }>(ctx, "conversations.info", { channel: value });
      return res.channel;
    } catch (e) {
      if (e instanceof ExecutionError && e.details.providerCode === "channel_not_found") return null;
      throw e;
    }
  }
  const name = value.replace(/^#/, "").toLowerCase();
  const list = async (types: string) => {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await slackCall<SlackResponse & { channels: SlackChannel[]; response_metadata?: { next_cursor?: string } }>(ctx, "conversations.list", {
        types,
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      const hit = res.channels.find((c) => c.name.toLowerCase() === name);
      if (hit) return hit;
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return null;
  };
  try {
    return await list("public_channel,private_channel");
  } catch (e) {
    if (!isMissingScope(e)) throw e;
    return list("public_channel"); // no groups:read: public channels only
  }
}

async function permalinkFor(ctx: InvokeContext, channel: string, ts: string): Promise<{ permalink?: string; permalinkError?: string }> {
  try {
    const p = await slackCall<SlackResponse & { permalink: string }>(ctx, "chat.getPermalink", { channel, message_ts: ts });
    return { permalink: p.permalink };
  } catch (e) {
    const code = e instanceof ExecutionError ? String(e.details.providerCode ?? e.message) : (e as Error).message;
    // Fall back to the workspace URL, which auth.test returns with no extra scope.
    try {
      const auth = await slackCall<SlackResponse & { url?: string }>(ctx, "auth.test", {});
      if (auth.url) return { permalink: `${auth.url.replace(/\/?$/, "/")}archives/${channel}/p${ts.replace(".", "")}`, permalinkError: code };
    } catch {
      /* fall through */
    }
    return { permalinkError: code };
  }
}

export const slackLive: Connector = {
  provider: "slack",
  mode: "live",
  async invoke(capabilityId, input, ctx) {
    switch (capabilityId) {
      case "slack.channels.list": {
        const res = await slackCall<SlackResponse & { channels: SlackChannel[] }>(ctx, "conversations.list", {
          exclude_archived: true,
          limit: 200,
        });
        return { output: { channels: res.channels.map((c) => ({ id: c.id, name: c.name })) }, apiCalls: 1 };
      }
      case "slack.message.post": {
        // The idempotency key travels in message metadata so reconciliation can find this message.
        const res = await slackCall<SlackResponse & { ts: string; channel: string }>(
          ctx,
          "chat.postMessage",
          {
            channel: String(input.channel),
            text: String(input.text),
            unfurl_links: false,
            metadata: { event_type: METADATA_TYPE, event_payload: { idempotency_key: ctx.idempotencyKey } },
          },
          true,
        );
        const link = await permalinkFor(ctx, res.channel, res.ts);
        return { output: { ts: res.ts, channel: res.channel, text: String(input.text), ...link }, externalId: `${res.channel}:${res.ts}`, apiCalls: 2 };
      }
      case "slack.message.verify": {
        const res = await slackCall<SlackResponse & { messages: Array<{ ts: string; text: string }> }>(ctx, "conversations.history", {
          channel: String(input.channel),
          latest: String(input.ts),
          oldest: String(input.ts),
          inclusive: true,
          limit: 1,
        });
        const msg = res.messages[0];
        const verified = !!msg && msg.ts === input.ts && msg.text === input.expectedText;
        return {
          output: { verified, evidence: { source: "slack.conversations.history", found: !!msg, ts: msg?.ts, textMatches: msg?.text === input.expectedText } },
          apiCalls: 1,
        };
      }
      default:
        throw new ExecutionError("permanent", `Slack connector does not implement ${capabilityId}`);
    }
  },
  async preflight(capabilityId, input, ctx): Promise<PreflightResult | null> {
    if (capabilityId !== "slack.message.post") return null;
    const raw = String(input.channel ?? "");
    let channel: SlackChannel | null;
    try {
      channel = await findSlackChannel(ctx, raw);
    } catch (e) {
      if (isMissingScope(e)) {
        return { checks: [{ name: "channel", ok: true, skipped: true, detail: "Not checked: the Slack connection lacks channels:read" }] };
      }
      throw e;
    }
    if (!channel) {
      throw new ExecutionError(
        "permanent",
        `Slack channel "${raw}" was not found, or the bot cannot see it. Check the spelling, or paste the channel ID (channel name → About → Channel ID). Private channels also need the bot invited.`,
        { providerCode: "channel_not_found" },
      );
    }
    if (channel.is_archived) throw new ExecutionError("permanent", `Slack channel #${channel.name} is archived`, { providerCode: "is_archived" });
    if (channel.is_member === false) {
      let bot = "your app";
      try {
        const auth = await slackCall<SlackResponse & { user?: string }>(ctx, "auth.test", {});
        if (auth.user) bot = `@${auth.user}`;
      } catch {
        /* name is cosmetic */
      }
      throw new ExecutionError("permanent", `The bot is not a member of #${channel.name}. In Slack, open #${channel.name} and type /invite ${bot}.`, {
        providerCode: "not_in_channel",
      });
    }
    return {
      checks: [{ name: "channel", ok: true, detail: `#${channel.name} (${channel.id}) found; the bot is a member` }],
      resolved: { channelId: channel.id, channelName: channel.name, private: !!channel.is_private },
    };
  },
  async reconcile(capabilityId, input, ctx) {
    if (capabilityId !== "slack.message.post") return { found: false };
    // conversations.history needs a channel id, not a #name.
    const raw = String(input.channel);
    const channelId = CHANNEL_ID_RE.test(raw.trim()) ? raw.trim() : (await findSlackChannel(ctx, raw))?.id;
    if (!channelId) return { found: false };
    const res = await slackCall<
      SlackResponse & { messages: Array<{ ts: string; metadata?: { event_type: string; event_payload?: { idempotency_key?: string } } }> }
    >(ctx, "conversations.history", { channel: channelId, limit: 100, include_all_metadata: true });
    const hit = res.messages.find(
      (m) => m.metadata?.event_type === METADATA_TYPE && m.metadata.event_payload?.idempotency_key === ctx.idempotencyKey,
    );
    return hit
      ? { found: true, output: { ts: hit.ts, channel: channelId, text: String(input.text) }, externalId: `${channelId}:${hit.ts}` }
      : { found: false };
  },
};
