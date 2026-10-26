import { z } from "zod";
import {
  AGENTS,
  CAPABILITIES,
  DEFAULT_RETRY,
  getCapability,
  normalizeDefinition,
  topologicalLevels,
  validateWorkflow,
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
  const definition: WorkflowDefinition = { schemaVersion: 1, name, objective, trigger: { type: "manual" }, nodes };
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
    "when a verify capability exists.";
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
        trigger: { type: "manual" },
        nodes: res.data.nodes.map((n) => node({ ...n, agent: n.agent as WorkflowNode["agent"] })),
      };
      const result = finish(def, `llm:${model.name}`, res.data.unsupported.map((u) => `${u} is not available yet; left out.`));
      if (!result.issues.some((i) => i.severity === "error")) return result;
      feedback = `\n\nYour previous plan had these errors; fix them:\n${result.issues.map((i) => `- ${i.nodeId ?? ""} ${i.message}`).join("\n")}`;
    } catch (e) {
      feedback = `\n\nPrevious attempt failed: ${(e as Error).message}`;
    }
  }
  const h = heuristicPlan(objective);
  return finish(h.definition, "orbix-heuristic", ["The model's plan failed validation twice; used the template planner.", ...h.notes]);
}

