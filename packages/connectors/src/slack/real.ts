import { ExecutionError, type FailureClass } from "@orbix/core";
import { httpJson } from "../http";
import type { Connector, InvokeContext } from "../types";

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

/** Slack returns HTTP 200 with `ok:false`; normalise into ExecutionError. */
export async function slackCall<T extends SlackResponse>(
  ctx: Pick<InvokeContext, "getAccessToken" | "timeoutMs">,
  method: string,
  body: Record<string, unknown>,
  write = false,
): Promise<T> {
  const token = await ctx.getAccessToken();
  const res = await httpJson<T>(`${API}/${method}`, {
    method: "POST",
    body,
    write,
    timeoutMs: ctx.timeoutMs,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.data.ok) {
    const code = res.data.error ?? "unknown_error";
    const cls = ERROR_CLASS[code] ?? (write ? "ambiguous" : "permanent");
    throw new ExecutionError(cls, `Slack ${method}: ${code}`, { providerCode: code });
  }
  return res.data;
}

const METADATA_TYPE = "orbix_action";

export const slackLive: Connector = {
  provider: "slack",
  mode: "live",
  async invoke(capabilityId, input, ctx) {
    switch (capabilityId) {
      case "slack.channels.list": {
        const res = await slackCall<SlackResponse & { channels: Array<{ id: string; name: string }> }>(ctx, "conversations.list", {
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
        let permalink: string | undefined;
        try {
          const p = await slackCall<SlackResponse & { permalink: string }>(ctx, "chat.getPermalink", { channel: res.channel, message_ts: res.ts });
          permalink = p.permalink;
        } catch {
          /* permalink is best-effort */
        }
        return { output: { ts: res.ts, channel: res.channel, permalink, text: String(input.text) }, externalId: `${res.channel}:${res.ts}`, apiCalls: 2 };
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
  async reconcile(capabilityId, input, ctx) {
    if (capabilityId !== "slack.message.post") return { found: false };
    const res = await slackCall<
      SlackResponse & { messages: Array<{ ts: string; metadata?: { event_type: string; event_payload?: { idempotency_key?: string } } }> }
    >(ctx, "conversations.history", { channel: String(input.channel), limit: 100, include_all_metadata: true });
    const hit = res.messages.find(
      (m) => m.metadata?.event_type === METADATA_TYPE && m.metadata.event_payload?.idempotency_key === ctx.idempotencyKey,
    );
    return hit
      ? { found: true, output: { ts: hit.ts, channel: String(input.channel), text: String(input.text) }, externalId: `${input.channel}:${hit.ts}` }
      : { found: false };
  },
};
