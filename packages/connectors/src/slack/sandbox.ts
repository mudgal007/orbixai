import { ExecutionError } from "@orbix/core";
import { consumeAfterWriteFault, consumeFault } from "../faults";
import type { Connector, InvokeContext } from "../types";

export const SANDBOX_CHANNELS = [
  { id: "C0SBXENG01", name: "eng-updates" },
  { id: "C0SBXGEN01", name: "general" },
  { id: "C0SBXOPS01", name: "ops" },
];

function resolveChannel(channel: string): { id: string; name: string } {
  const name = channel.replace(/^#/, "");
  const hit = SANDBOX_CHANNELS.find((c) => c.id === channel || c.name === name);
  if (!hit) throw new ExecutionError("permanent", `Slack sandbox: channel_not_found (${channel})`, { providerCode: "channel_not_found" });
  return hit;
}

async function findByKey(ctx: InvokeContext) {
  return ctx.prisma.mockProviderRecord.findFirst({
    where: { organizationId: ctx.organizationId, provider: "slack", kind: "message", idempotencyKey: ctx.idempotencyKey },
  });
}

/** Sandbox Slack: messages persist in MockProviderRecord so verification and reconciliation are real reads. */
export const slackSandbox: Connector = {
  provider: "slack",
  mode: "sandbox",
  async invoke(capabilityId, input, ctx) {
    const afterWriteFault = consumeFault(capabilityId);
    switch (capabilityId) {
      case "slack.channels.list":
        return { output: { channels: SANDBOX_CHANNELS }, apiCalls: 1 };
      case "slack.message.post": {
        const channel = resolveChannel(String(input.channel));
        // Sandbox models a provider WITHOUT native idempotency: every call creates a message.
        // Duplicate prevention must come from the engine's reconciliation, which tests assert.
        const ts = `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1000).padStart(3, "0")}${Math.floor(Math.random() * 1000)
          .toString()
          .padStart(3, "0")}`;
        const data = { ts, channel: channel.id, channelName: channel.name, text: String(input.text) };
        await ctx.prisma.mockProviderRecord.create({
          data: { organizationId: ctx.organizationId, provider: "slack", kind: "message", externalId: `${channel.id}:${ts}`, idempotencyKey: ctx.idempotencyKey, data },
        });
        if (afterWriteFault) consumeAfterWriteFault(capabilityId);
        const permalink = `https://sandbox.slack.local/archives/${channel.id}/p${ts.replace(".", "")}`;
        return { output: { ts, channel: channel.id, permalink, text: data.text }, externalId: `${channel.id}:${ts}`, apiCalls: 2 };
      }
      case "slack.message.verify": {
        const rec = await ctx.prisma.mockProviderRecord.findUnique({
          where: {
            organizationId_provider_kind_externalId: {
              organizationId: ctx.organizationId,
              provider: "slack",
              kind: "message",
              externalId: `${input.channel}:${input.ts}`,
            },
          },
        });
        const text = (rec?.data as { text?: string } | undefined)?.text;
        return {
          output: {
            verified: !!rec && text === input.expectedText,
            evidence: { source: "sandbox.slack.history", found: !!rec, ts: input.ts, textMatches: text === input.expectedText },
          },
          apiCalls: 1,
        };
      }
      default:
        throw new ExecutionError("permanent", `Slack sandbox does not implement ${capabilityId}`);
    }
  },
  async preflight(capabilityId, input) {
    if (capabilityId !== "slack.message.post") return null;
    const raw = String(input.channel ?? "");
    const name = raw.replace(/^#/, "");
    const hit = SANDBOX_CHANNELS.find((c) => c.id === raw || c.name === name);
    if (!hit) {
      throw new ExecutionError(
        "permanent",
        `Sandbox Slack channel "${raw}" does not exist. Sandbox channels: ${SANDBOX_CHANNELS.map((c) => `#${c.name}`).join(", ")}.`,
        { providerCode: "channel_not_found" },
      );
    }
    return {
      checks: [{ name: "channel", ok: true, detail: `#${hit.name} (${hit.id}) found in the sandbox workspace` }],
      resolved: { channelId: hit.id, channelName: hit.name, private: false },
    };
  },
  async reconcile(capabilityId, _input, ctx) {
    if (capabilityId !== "slack.message.post") return { found: false };
    const hit = await findByKey(ctx);
    if (!hit) return { found: false };
    const d = hit.data as { ts: string; channel: string; text: string };
    return {
      found: true,
      output: { ts: d.ts, channel: d.channel, text: d.text, permalink: `https://sandbox.slack.local/archives/${d.channel}/p${d.ts.replace(".", "")}` },
      externalId: hit.externalId,
    };
  },
};
