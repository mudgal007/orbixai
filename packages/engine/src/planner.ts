import { z } from "zod";
import {
  AGENTS,
  CAPABILITIES,
  DEFAULT_RETRY,
  getCapability,
  normalizeDefinition,
  topologicalLevels,
  validateWorkflow,
  type Trigger,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@orbix/core";
import type { ModelClient } from "./model";

export interface PlanResult {
  definition: WorkflowDefinition;
  planner: string;
  notes: string[];
  issues: ValidationIssue[];
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Deterministic schedule detection from phrasing like "every morning", "every weekday at 8:30am",
 * "hourly" or "every Monday". Times default to 09:00 in UTC; the editor lets the user change both.
 */
export function detectSchedule(objective: string): { trigger: Trigger; note: string } | null {
  const t = objective.toLowerCase();
  const at = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  let hour = 9;
  let minute = 0;
  if (at) {
    hour = Number(at[1]) % 24;
    minute = Number(at[2] ?? 0) % 60;
    if (at[3] === "pm" && hour < 12) hour += 12;
    if (at[3] === "am" && hour === 12) hour = 0;
  }
  const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const day = DAYS.findIndex((d) => new RegExp(`\\bevery ${d}\\b|\\b${d}s\\b`).test(t));

  let cron: string;
  let label: string;
  if (/\bevery hour\b|\bhourly\b/.test(t)) {
    cron = "0 * * * *";
    label = "every hour";
  } else if (/\b(every|each) weekday\b|\bweekdays\b/.test(t)) {
    cron = `${minute} ${hour} * * 1-5`;
    label = `every weekday at ${hhmm}`;
  } else if (day >= 0) {
    cron = `${minute} ${hour} * * ${day}`;
    label = `every ${DAYS[day]} at ${hhmm}`;
  } else if (/\b(every|each) week\b|\bweekly\b/.test(t)) {
    cron = `${minute} ${hour} * * 1`;
    label = `every Monday at ${hhmm}`;
  } else if (/\b(every|each) (morning|day)\b|\bdaily\b/.test(t)) {
    cron = `${minute} ${hour} * * *`;
    label = `every day at ${hhmm}`;
  } else {
    return null;
  }
  return {
    trigger: { type: "schedule", cron, timezone: "UTC" },
    note: `Scheduled ${label} (UTC, cron "${cron}"). Adjust the timezone in the trigger settings, then publish and enable the schedule.`,
  };
}

const ROADMAP_HINTS: Array<[RegExp, string]> = [
  [/\b(gmail|e-?mail)\b/i, "Gmail"],
  [/\bcalendar\b/i, "Google Calendar"],
  [/\b(shopify|order)\b/i, "Shopify"],
  [/\b(hubspot|salesforce|crm)\b/i, "CRM (HubSpot/Salesforce)"],
  [/\b(stripe|refund)\b/i, "Stripe"],
  [/\bnotion\b/i, "Notion"],
  [/\blinear\b/i, "Linear"],
];

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30 };

function node(partial: Omit<WorkflowNode, "retry" | "timeoutMs" | "approval" | "risk"> & Partial<WorkflowNode>): WorkflowNode {
  const cap = getCapability(partial.action);
  const risk = partial.risk ?? cap?.risk ?? "read";
  const write = risk !== "read" && risk !== "compute";
  return {
    timeoutMs: cap?.provider === "ai" ? 120_000 : 30_000,
    retry: write ? { maxAttempts: 2, backoffMs: 2_000, maxBackoffMs: 10_000 } : { ...DEFAULT_RETRY },
    approval: { required: write, expiresInMinutes: 24 * 60 },
    risk,
    ...partial,
  };
}

export function layoutNodes(def: WorkflowDefinition): WorkflowDefinition {
  const levels = topologicalLevels(def);
  const pos = new Map<string, { x: number; y: number }>();
  levels.forEach((level, x) => level.forEach((id, y) => pos.set(id, { x: x * 300, y: y * 160 - ((level.length - 1) * 160) / 2 })));
  return { ...def, nodes: def.nodes.map((n) => ({ ...n, position: n.position ?? pos.get(n.id) ?? { x: 0, y: 0 } })) };
}

/**
 * Deterministic guard for model plans: when the objective names a Slack destination and the plan drafts a
 * message but never sends it (models often read "draft … for approval" as "stop at the draft"), add the
 * post step and its verification. The post is an external write, so policy makes it wait for approval.
 */
export function ensureSlackDelivery(def: WorkflowDefinition, objective: string): { definition: WorkflowDefinition; note?: string } {
  const text = objective.toLowerCase();
  const wantsSlack = /\bslack\b|#[a-z0-9][\w-]*/.test(text);
  const forbidsSending = /\b(do not|don't|dont|never|without)\s+(post|send|sending|posting)\b/.test(text);
  if (!wantsSlack || forbidsSending || def.nodes.some((n) => n.action === "slack.message.post")) return { definition: def };
  const draft = [...def.nodes].reverse().find((n) => n.action === "ai.draft_message");
  if (!draft) return { definition: def };

  const channel = objective.match(/#([a-z0-9][\w-]*)/i)?.[0] ?? "#eng-updates";
  const ids = new Set(def.nodes.map((n) => n.id));
  const postId = ids.has("post_update") ? "post_update_slack" : "post_update";
  const verifyId = ids.has("verify_post") ? "verify_post_slack" : "verify_post";
  const added: WorkflowNode[] = [
    node({
      id: postId,
      title: `Post to ${channel}`,
      agent: "communication",
      action: "slack.message.post",
      inputs: { channel, text: `{{nodes.${draft.id}.output.text}}` },
      dependsOn: [draft.id],
    }),
    node({
      id: verifyId,
      title: "Verify message in Slack",
      agent: "verification",
      action: "slack.message.verify",
      inputs: { channel: `{{nodes.${postId}.output.channel}}`, ts: `{{nodes.${postId}.output.ts}}`, expectedText: `{{nodes.${postId}.output.text}}` },
      dependsOn: [postId],
      retry: { maxAttempts: 3, backoffMs: 2_000, maxBackoffMs: 10_000 },
      successCondition: { path: "verified", op: "equals", value: true },
    }),
  ];
  return {
    definition: { ...def, nodes: [...def.nodes.map((n) => ({ ...n, position: undefined })), ...added] },
    note: `Added "Post to ${channel}" (pauses for your approval of the exact message) and a verification step after "${draft.title}".`,
  };
}

/** Deterministic template planner used when no LLM is configured (and as a fallback). */
export function heuristicPlan(objective: string): { definition: WorkflowDefinition; notes: string[] } {
  const text = objective.toLowerCase();
  const notes: string[] = [];
  const nodes: WorkflowNode[] = [];

  for (const [re, label] of ROADMAP_HINTS) {
    if (re.test(objective)) notes.push(`${label} is on the roadmap and not connected yet; that part of the objective was left out.`);
  }

  const daysMatch = text.match(/(\d+|one|two|three|four|five|six|seven|ten|fourteen|thirty)\s*(?:\+\s*)?days?/);
  const staleDays = daysMatch ? Number(daysMatch[1]) || WORD_NUMBERS[daysMatch[1]!] || 7 : 7;
  const channel = objective.match(/#([a-z0-9][\w-]*)/i)?.[0] ?? "#eng-updates";
  const wantsGithub = /github|issue|pull request|\bpr\b|repo/.test(text);
  const wantsSlack = /slack|channel|#[a-z]/.test(text);
  const wantsPlan = /plan|follow[- ]?up|next step|action/.test(text);

  if (wantsGithub) {
    nodes.push(
      node({
        id: "find_issues",
        title: `Find issues stale for ${staleDays}+ days`,
        agent: "developer",
        action: "github.issues.list_stale_assigned",
        inputs: { staleDays, limit: 20 },
        dependsOn: [],
        successCondition: { path: "issues", op: "exists" },
      }),
    );
    nodes.push(
      node({
        id: "summarize_issues",
        title: "Summarize each issue",
        agent: "research",
        action: "ai.summarize",
        inputs: { items: "{{nodes.find_issues.output.issues}}", instructions: "Focus on current status and what is blocking progress." },
        dependsOn: ["find_issues"],
      }),
    );
  } else {
    nodes.push(
      node({
        id: "research",
        title: "Search organization knowledge",
        agent: "research",
        action: "knowledge.search",
        inputs: { query: objective.slice(0, 500), limit: 5 },
        dependsOn: [],
      }),
    );
    nodes.push(
      node({
        id: "summarize_findings",
        title: "Summarize findings",
        agent: "research",
        action: "ai.summarize",
        inputs: { items: "{{nodes.research.output.results}}" },
        dependsOn: ["research"],
      }),
    );
    notes.push("No connected integration matched the objective; the plan researches the knowledge base instead.");
  }
  const summaryNode = nodes[nodes.length - 1]!.id;

  let planNode: string | undefined;
  if (wantsPlan || wantsGithub) {
    planNode = "plan_followups";
    nodes.push(
      node({
        id: planNode,
        title: "Create follow-up plan",
        agent: "supervisor",
        action: "ai.plan",
        inputs: { items: `{{nodes.${summaryNode}.output.summaries}}`, goal: "Unblock or close every stale item this week" },
        dependsOn: [summaryNode],
      }),
    );
  }

  const draftDeps = planNode ? [summaryNode, planNode] : [summaryNode];
  nodes.push(
    node({
      id: "draft_update",
      title: wantsSlack ? "Draft Slack update" : "Draft update",
      agent: "communication",
      action: "ai.draft_message",
      inputs: {
        context: { summaries: `{{nodes.${summaryNode}.output.summaries}}`, ...(planNode ? { plan: `{{nodes.${planNode}.output.plan}}` } : {}) },
        audience: "the engineering team",
        format: "slack",
      },
      dependsOn: draftDeps,
    }),
  );

  if (wantsSlack) {
    nodes.push(
      node({
        id: "post_update",
        title: `Post to ${channel}`,
        agent: "communication",
        action: "slack.message.post",
        inputs: { channel, text: "{{nodes.draft_update.output.text}}" },
        dependsOn: ["draft_update"],
        compensation: { action: "slack.message.delete", note: "Delete the message manually in Slack if it must be retracted." },
      }),
      node({
        id: "verify_post",
        title: "Verify message in Slack",
        agent: "verification",
        action: "slack.message.verify",
        inputs: {
          channel: "{{nodes.post_update.output.channel}}",
          ts: "{{nodes.post_update.output.ts}}",
          expectedText: "{{nodes.post_update.output.text}}",
        },
        dependsOn: ["post_update"],
        retry: { maxAttempts: 3, backoffMs: 2_000, maxBackoffMs: 10_000 },
        successCondition: { path: "verified", op: "equals", value: true },
      }),
    );
  }

  const name = wantsGithub ? "Stale issue follow-up" : "Research digest";
  const schedule = detectSchedule(objective);
  if (schedule) notes.push(schedule.note);
  const definition: WorkflowDefinition = { schemaVersion: 1, name, objective, trigger: schedule?.trigger ?? { type: "manual" }, nodes };
  return { definition: layoutNodes(definition), notes };
}

const LlmPlanSchema = z.object({
  name: z.string().min(1).max(120),
  nodes: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        agent: z.string(),
        action: z.string(),
        inputs: z.record(z.string(), z.unknown()),
        dependsOn: z.array(z.string()),
      }),
    )
    .min(1)
    .max(20),
  unsupported: z.array(z.string()).default([]),
});

function catalogPrompt(): string {
  const caps = CAPABILITIES.map((c) => ({
    id: c.id,
    availability: c.availability,
    risk: c.risk,
    inputs: Object.fromEntries(Object.entries(c.inputs).map(([k, v]) => [k, `${v.type}${v.required ? " (required)" : ""}`])),
    outputs: Object.keys(c.outputs),
  }));
  const agents = AGENTS.map((a) => ({ key: a.key, allowed: a.allowedCapabilities }));
  return JSON.stringify({ capabilities: caps, agents });
}

/** LLM planner with deterministic validation; falls back to the template planner on failure. */
export async function planWorkflow(objective: string, model: ModelClient): Promise<PlanResult> {
  const finish = (def: WorkflowDefinition, planner: string, notes: string[]): PlanResult => {
    const { definition, notes: policyNotes } = normalizeDefinition(def);
    const v = validateWorkflow(definition);
    return { definition: layoutNodes(definition), planner, notes: [...notes, ...policyNotes], issues: v.issues };
  };

  if (model.heuristic) {
    const h = heuristicPlan(objective);
    return finish(h.definition, "orbix-heuristic", h.notes);
  }

  const system =
    "You are the ORBIX planner. Convert the user's objective into a DAG of steps using ONLY capabilities " +
    "marked available. Use roadmap capabilities never; list them in `unsupported`. Each node uses an agent " +
    "whose `allowed` list contains the action. Wire outputs with \"{{nodes.<id>.output.<field>}}\" and list " +
    "that node in dependsOn. Node ids are snake_case. After any externally visible write, add a verification step " +
    "when a verify capability exists.\n\n" +
    "Approval is enforced by the platform, not by you: every externally visible write automatically pauses for a " +
    "human to approve the exact payload before it is sent. So when the objective says to draft, prepare or submit " +
    "something \"for approval\" / \"for my review\" in a destination (a Slack channel, an issue, an inbox), include the " +
    "step that actually sends it there, fed by the draft step's output — do not stop at the draft. Only omit the send " +
    "step if the objective explicitly says not to send or post anything.";
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await model.completeJson({
        system,
        user: `Catalog: ${catalogPrompt()}\n\nObjective: ${objective}${feedback}`,
        schema: LlmPlanSchema,
        timeoutMs: 60_000,
      });
      const def: WorkflowDefinition = {
        schemaVersion: 1,
        name: res.data.name,
        objective,
        trigger: detectSchedule(objective)?.trigger ?? { type: "manual" },
        nodes: res.data.nodes.map((n) => node({ ...n, agent: n.agent as WorkflowNode["agent"] })),
      };
      const delivery = ensureSlackDelivery(def, objective);
      const notes = res.data.unsupported.map((u) => `${u} is not available yet; left out.`);
      if (delivery.note) notes.push(delivery.note);
      const result = finish(delivery.definition, `llm:${model.name}`, notes);
      if (!result.issues.some((i) => i.severity === "error")) return result;
      feedback = `\n\nYour previous plan had these errors; fix them:\n${result.issues.map((i) => `- ${i.nodeId ?? ""} ${i.message}`).join("\n")}`;
    } catch (e) {
      feedback = `\n\nPrevious attempt failed: ${(e as Error).message}`;
    }
  }
  const h = heuristicPlan(objective);
  return finish(h.definition, "orbix-heuristic", ["The model's plan failed validation twice; used the template planner.", ...h.notes]);
}

