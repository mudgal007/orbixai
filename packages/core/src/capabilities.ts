import type { RiskLevel } from "./risk";

export type ProviderKey =
  | "github"
  | "slack"
  | "ai"
  | "knowledge"
  | "gmail"
  | "google_calendar"
  | "notion"
  | "hubspot"
  | "salesforce"
  | "shopify"
  | "stripe"
  | "linear"
  | "google_drive"
  | "postgresql"
  | "custom_api"
  | "mcp";

export type FieldType = "string" | "number" | "boolean" | "array" | "object" | "any";

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  description: string;
  default?: unknown;
}

export interface CapabilityDescriptor {
  id: string;
  provider: ProviderKey;
  title: string;
  description: string;
  risk: RiskLevel;
  /** Provider OAuth scopes the connection must hold. Empty for internal capabilities. */
  scopes: string[];
  inputs: Record<string, FieldSpec>;
  outputs: Record<string, FieldSpec>;
  /** Safe to repeat with the same input without additional side effects. */
  idempotent: boolean;
  /** Provider state can be queried to determine whether a previous attempt landed. */
  reconcilable: boolean;
  /** `roadmap` capabilities are visible to the planner but cannot be published or executed. */
  availability: "available" | "roadmap";
  estimate: { apiCalls: number; tokensIn?: number; tokensOut?: number };
  sideEffect?: string;
}

const C = (d: CapabilityDescriptor) => d;

export const CAPABILITIES: readonly CapabilityDescriptor[] = [
  C({
    id: "github.issues.list_stale_assigned",
    provider: "github",
    title: "List stale issues assigned to me",
    description: "Open issues assigned to the connected user with no update for N days.",
    risk: "read",
    scopes: ["repo"],
    inputs: {
      staleDays: { type: "number", required: true, description: "Minimum days since last update", default: 7 },
      repo: { type: "string", description: "Optional owner/name filter" },
      limit: { type: "number", description: "Maximum issues to return", default: 20 },
    },
    outputs: {
      issues: { type: "array", description: "Issues with number, title, url, repo, body, updatedAt, labels, daysStale" },
      count: { type: "number", description: "Number of issues found" },
    },
    idempotent: true,
    reconcilable: false,
    availability: "available",
    estimate: { apiCalls: 2 },
  }),
  C({
    id: "github.issue.comment",
    provider: "github",
    title: "Comment on an issue",
    description: "Post a comment to a GitHub issue.",
    risk: "external_write",
    scopes: ["repo"],
    inputs: {
      repo: { type: "string", required: true, description: "owner/name" },
      number: { type: "number", required: true, description: "Issue number" },
      body: { type: "string", required: true, description: "Markdown comment body" },
    },
    outputs: {
      id: { type: "number", description: "Comment id" },
      url: { type: "string", description: "Comment URL" },
    },
    idempotent: false,
    reconcilable: true,
    availability: "available",
    estimate: { apiCalls: 1 },
    sideEffect: "Creates a publicly visible comment on a GitHub issue",
  }),
  C({
    id: "slack.channels.list",
    provider: "slack",
    title: "List channels",
    description: "Channels visible to the connected Slack app.",
    risk: "read",
    scopes: ["channels:read"],
    inputs: {},
    outputs: { channels: { type: "array", description: "id, name" } },
    idempotent: true,
    reconcilable: false,
    availability: "available",
    estimate: { apiCalls: 1 },
  }),
  C({
    id: "slack.message.post",
    provider: "slack",
    title: "Post a Slack message",
    description: "Publish a message to a Slack channel.",
    risk: "external_write",
    scopes: ["chat:write"],
    inputs: {
      channel: { type: "string", required: true, description: "Channel id or #name" },
      text: { type: "string", required: true, description: "Message text (mrkdwn)" },
    },
    outputs: {
      ts: { type: "string", description: "Message timestamp id" },
      channel: { type: "string", description: "Channel id" },
      permalink: { type: "string", description: "Link to the message" },
      text: { type: "string", description: "Exact text that was posted" },
    },
    idempotent: false,
    reconcilable: true,
    availability: "available",
    estimate: { apiCalls: 2 },
    sideEffect: "Sends a message visible to every member of the channel",
  }),
  C({
    id: "slack.message.verify",
    provider: "slack",
    title: "Verify a Slack message",
    description: "Re-read the channel and confirm the message exists with the expected content.",
    risk: "read",
    scopes: ["channels:history"],
    inputs: {
      channel: { type: "string", required: true, description: "Channel id" },
      ts: { type: "string", required: true, description: "Message ts" },
      expectedText: { type: "string", required: true, description: "Text that should be present" },
    },
    outputs: {
      verified: { type: "boolean", description: "True when provider state matches" },
      evidence: { type: "object", description: "Provider data used as evidence" },
    },
    idempotent: true,
    reconcilable: false,
    availability: "available",
    estimate: { apiCalls: 1 },
  }),
  C({
    id: "ai.summarize",
    provider: "ai",
    title: "Summarize items",
    description: "Produce a grounded summary per item, citing the item's source URL.",
    risk: "compute",
    scopes: [],
    inputs: {
      items: { type: "array", required: true, description: "Items to summarize" },
      instructions: { type: "string", description: "Extra guidance" },
    },
    outputs: { summaries: { type: "array", description: "ref, title, summary, source" } },
    idempotent: true,
    reconcilable: false,
    availability: "available",
    estimate: { apiCalls: 1, tokensIn: 3000, tokensOut: 800 },
  }),
  C({
    id: "ai.plan",
    provider: "ai",
    title: "Create a follow-up plan",
    description: "Turn summaries into concrete next actions.",
    risk: "compute",
    scopes: [],
    inputs: {
      items: { type: "array", required: true, description: "Summaries or findings" },
      goal: { type: "string", required: true, description: "What the plan should achieve" },
    },
    outputs: {
      plan: { type: "array", description: "ref, action, priority" },
      text: { type: "string", description: "Plan as prose" },
    },
    idempotent: true,
    reconcilable: false,
    availability: "available",
    estimate: { apiCalls: 1, tokensIn: 1500, tokensOut: 600 },
  }),
  C({
    id: "ai.draft_message",
    provider: "ai",
    title: "Draft a message",
    description: "Draft a message for a given audience and channel format.",
    risk: "compute",
    scopes: [],
    inputs: {
      context: { type: "any", required: true, description: "Material the message must be grounded in" },
      audience: { type: "string", description: "Who will read it" },
      format: { type: "string", description: "slack | email", default: "slack" },
    },
    outputs: {
      text: { type: "string", description: "Draft text" },
      citations: { type: "array", description: "Sources referenced" },
    },
    idempotent: true,
    reconcilable: false,
    availability: "available",
    estimate: { apiCalls: 1, tokensIn: 1500, tokensOut: 500 },
  }),
  C({
    id: "knowledge.search",
    provider: "knowledge",
    title: "Search knowledge",
    description: "Retrieve relevant passages from the organization's knowledge base.",
    risk: "read",
    scopes: [],
    inputs: {
      query: { type: "string", required: true, description: "Search query" },
      limit: { type: "number", description: "Max passages", default: 5 },
    },
    outputs: { results: { type: "array", description: "documentId, title, content, score" } },
    idempotent: true,
    reconcilable: false,
    availability: "available",
    estimate: { apiCalls: 0 },
  }),
  // ---- Roadmap: visible to the planner so it can explain gaps, but never executable. ----
  ...(
    [
      ["gmail.messages.search", "gmail", "Search Gmail", "read"],
      ["gmail.message.send", "gmail", "Send an email", "external_write"],
      ["google_calendar.events.list", "google_calendar", "List calendar events", "read"],
      ["hubspot.contacts.search", "hubspot", "Search CRM contacts", "read"],
      ["shopify.order.get", "shopify", "Get a Shopify order", "read"],
      ["stripe.refund.create", "stripe", "Issue a refund", "financial"],
      ["notion.page.create", "notion", "Create a Notion page", "external_write"],
      ["linear.issue.create", "linear", "Create a Linear issue", "external_write"],
    ] as const
  ).map(([id, provider, title, risk]) =>
    C({
      id,
      provider,
      title,
      description: `${title} (roadmap — not yet implemented)`,
      risk,
      scopes: [],
      inputs: {},
      outputs: {},
      idempotent: risk === "read",
      reconcilable: false,
      availability: "roadmap",
      estimate: { apiCalls: 1 },
    }),
  ),
];

const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function getCapability(id: string): CapabilityDescriptor | undefined {
  return byId.get(id);
}

export function capabilitiesFor(provider: ProviderKey): CapabilityDescriptor[] {
  return CAPABILITIES.filter((c) => c.provider === provider);
}

/** Providers that need an org connection (vs. internal providers like ai/knowledge). */
export function isExternalProvider(provider: ProviderKey): boolean {
  return provider !== "ai" && provider !== "knowledge";
}
