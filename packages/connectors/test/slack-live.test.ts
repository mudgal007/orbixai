import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionError } from "@orbix/core";
import { slackLive } from "../src/slack/real";
import type { InvokeContext } from "../src/types";

type Handler = (body: URLSearchParams | Record<string, unknown>, contentType: string) => Record<string, unknown>;

/** Routes Slack Web API calls to fake handlers and records each call for assertions. */
function mockSlack(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; contentType: string; body: URLSearchParams | Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const method = url.split("/api/")[1]!;
    const contentType = init.headers["Content-Type"] ?? "";
    const body = contentType.includes("x-www-form-urlencoded") ? new URLSearchParams(init.body) : (JSON.parse(init.body || "{}") as Record<string, unknown>);
    calls.push({ method, contentType, body });
    const handler = handlers[method];
    const payload = handler ? handler(body, contentType) : { ok: false, error: "unknown_method" };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const ctx = (): InvokeContext => ({
  organizationId: "org",
  connectionId: "conn",
  mode: "live",
  idempotencyKey: "idem-123",
  timeoutMs: 5_000,
  prisma: {} as InvokeContext["prisma"],
  getAccessToken: async () => "xoxb-test-token",
});

const list = (channels: Array<Record<string, unknown>>) => () => ({ ok: true, channels, response_metadata: { next_cursor: "" } });

afterEach(() => vi.unstubAllGlobals());

describe("Slack pre-flight channel check", () => {
  it("passes and resolves the channel id when the bot is a member", async () => {
    const calls = mockSlack({ "conversations.list": list([{ id: "C0TEST1234", name: "orbix-test", is_member: true }]) });
    const r = await slackLive.preflight!("slack.message.post", { channel: "#orbix-test", text: "hi" }, ctx());
    expect(r?.resolved).toMatchObject({ channelId: "C0TEST1234", channelName: "orbix-test" });
    expect(r?.checks[0]).toMatchObject({ ok: true });
    expect(calls[0]!.contentType).toContain("x-www-form-urlencoded"); // reads are form-encoded
    expect((calls[0]!.body as URLSearchParams).get("types")).toBe("public_channel,private_channel");
  });

  it("blocks before approval when the bot is not in the channel, naming the /invite command", async () => {
    mockSlack({
      "conversations.list": list([{ id: "C0TEST1234", name: "orbix-test", is_member: false }]),
      "auth.test": () => ({ ok: true, user: "orbix", url: "https://orbixdev.slack.com/" }),
    });
    await expect(slackLive.preflight!("slack.message.post", { channel: "#orbix-test" }, ctx())).rejects.toMatchObject({
      failureClass: "permanent",
      message: expect.stringContaining("/invite @orbix"),
    });
  });

  it("blocks when the channel does not exist", async () => {
    mockSlack({ "conversations.list": list([{ id: "C0OTHER123", name: "general", is_member: true }]) });
    const err = await slackLive.preflight!("slack.message.post", { channel: "#nope" }, ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect(err.message).toMatch(/"#nope" was not found/);
  });

  it("falls back to public channels without groups:read, and skips (not blocks) without channels:read", async () => {
    mockSlack({
      "conversations.list": (body) =>
        (body as URLSearchParams).get("types")?.includes("private")
          ? { ok: false, error: "missing_scope" }
          : { ok: true, channels: [{ id: "C0PUB12345", name: "orbix-test", is_member: true }] },
    });
    expect((await slackLive.preflight!("slack.message.post", { channel: "orbix-test" }, ctx()))?.resolved).toMatchObject({ channelId: "C0PUB12345" });

    mockSlack({ "conversations.list": () => ({ ok: false, error: "missing_scope" }) });
    const skipped = await slackLive.preflight!("slack.message.post", { channel: "#orbix-test" }, ctx());
    expect(skipped?.checks[0]).toMatchObject({ skipped: true });
  });

  it("checks channel ids with conversations.info", async () => {
    const calls = mockSlack({ "conversations.info": () => ({ ok: true, channel: { id: "C0TEST1234", name: "orbix-test", is_member: true } }) });
    await slackLive.preflight!("slack.message.post", { channel: "C0TEST1234" }, ctx());
    expect(calls.map((c) => c.method)).toEqual(["conversations.info"]);
  });
});

describe("Slack post permalink", () => {
  it("uses chat.getPermalink when it works", async () => {
    mockSlack({
      "chat.postMessage": () => ({ ok: true, ts: "1700000000.000100", channel: "C0TEST1234" }),
      "chat.getPermalink": () => ({ ok: true, permalink: "https://orbixdev.slack.com/archives/C0TEST1234/p1700000000000100" }),
    });
    const r = await slackLive.invoke("slack.message.post", { channel: "#orbix-test", text: "hi" }, ctx());
    expect(r.output.permalink).toBe("https://orbixdev.slack.com/archives/C0TEST1234/p1700000000000100");
    expect(r.output.permalinkError).toBeUndefined();
  });

  it("builds the link from the workspace URL when chat.getPermalink fails, and records why", async () => {
    const calls = mockSlack({
      "chat.postMessage": (_b, ct) => {
        expect(ct).not.toContain("x-www-form-urlencoded"); // writes stay JSON (metadata)
        return { ok: true, ts: "1700000000.000100", channel: "C0TEST1234" };
      },
      "chat.getPermalink": () => ({ ok: false, error: "invalid_arguments" }),
      "auth.test": () => ({ ok: true, url: "https://orbixdev.slack.com/" }),
    });
    const r = await slackLive.invoke("slack.message.post", { channel: "#orbix-test", text: "hi" }, ctx());
    expect(r.output.permalink).toBe("https://orbixdev.slack.com/archives/C0TEST1234/p1700000000000100");
    expect(r.output.permalinkError).toBe("invalid_arguments");
    expect(calls.map((c) => c.method)).toEqual(["chat.postMessage", "chat.getPermalink", "auth.test"]);
  });
});

describe("Slack reconciliation", () => {
  it("resolves a #name to its channel id before reading history", async () => {
    const calls = mockSlack({
      "conversations.list": list([{ id: "C0TEST1234", name: "orbix-test", is_member: true }]),
      "conversations.history": (body) => {
        expect((body as URLSearchParams).get("channel")).toBe("C0TEST1234");
        return { ok: true, messages: [{ ts: "1.2", metadata: { event_type: "orbix_action", event_payload: { idempotency_key: "idem-123" } } }] };
      },
    });
    const r = await slackLive.reconcile!("slack.message.post", { channel: "#orbix-test", text: "hi" }, ctx());
    expect(r).toMatchObject({ found: true, externalId: "C0TEST1234:1.2" });
    expect(calls.map((c) => c.method)).toEqual(["conversations.list", "conversations.history"]);
  });
});
