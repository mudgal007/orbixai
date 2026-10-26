import { z } from "zod";
import { ExecutionError, type AgentDescriptor } from "@orbix/core";
import { HEURISTIC_MODEL, type ModelClient } from "./model";
import { fenceUntrusted, scanValue, stripHidden, type InjectionFinding } from "./injection";

export interface AiResult {
  output: Record<string, unknown>;
  usage: { model: string; tokensIn: number; tokensOut: number; costUsd: number };
  findings: InjectionFinding[];
}

type Item = Record<string, unknown>;

const SummarySchema = z.object({
  summaries: z.array(
    z.object({ ref: z.string(), title: z.string(), summary: z.string().min(1).max(1200), source: z.string() }),
  ),
});
const PlanSchema = z.object({
  plan: z.array(z.object({ ref: z.string(), action: z.string().min(1), priority: z.enum(["high", "medium", "low"]) })),
  text: z.string(),
});
const DraftSchema = z.object({ text: z.string().min(1).max(3500), citations: z.array(z.string()) });

function asItems(v: unknown): Item[] {
  if (!Array.isArray(v)) throw new ExecutionError("permanent", "Input `items` must be an array");
  return v.filter((x): x is Item => !!x && typeof x === "object");
}

export function itemRef(i: Item): string {
  if (typeof i.ref === "string") return i.ref;
  if (i.repo && i.number !== undefined) return `${i.repo}#${i.number}`;
  return String(i.title ?? i.id ?? "item");
}

function itemSource(i: Item): string {
  return String(i.url ?? i.source ?? i.sourceUrl ?? "");
}

function firstSentences(text: string, n: number): string {
  const clean = stripHidden(text).replace(/`/g, "").replace(/\s+/g, " ").trim();
  const sentences = clean.match(/[^.!?]+[.!?]+/g) ?? (clean ? [clean] : []);
  return sentences.slice(0, n).join(" ").trim();
}

function priorityOf(i: Item): "high" | "medium" | "low" {
  const labels = (Array.isArray(i.labels) ? i.labels : []).map(String);
  const stale = Number(i.daysStale ?? 0);
  if (labels.some((l) => /^(p0|p1|security|critical)$/.test(l))) return "high";
  if (labels.includes("bug") || stale >= 14) return "medium";
  return "low";
}

function actionFor(i: Item): string {
  const labels = (Array.isArray(i.labels) ? i.labels : []).map(String);
  if (labels.includes("security")) return "Schedule the fix within 48h and confirm an owner today";
  if (labels.includes("bug")) return "Confirm it still reproduces, post a status update, and agree on a fix owner";
  if (labels.includes("docs")) return "Assign a doc owner and set a due date for an updated draft";
  return "Decide whether to schedule, delegate, or close; post the decision on the issue";
}

// ───────────────────────── deterministic implementations ─────────────────────────

function heuristicSummarize(items: Item[]) {
  return {
    summaries: items.map((i) => {
      const body = firstSentences(String(i.body ?? i.summary ?? i.content ?? ""), 2);
      const age = i.daysStale !== undefined ? ` No update for ${i.daysStale} days.` : "";
      const labels = Array.isArray(i.labels) && i.labels.length ? ` Labels: ${i.labels.join(", ")}.` : "";
      return {
        ref: itemRef(i),
        title: String(i.title ?? itemRef(i)),
        summary: `${body || "No description provided."}${age}${labels}`.trim(),
        source: itemSource(i),
      };
    }),
  };
}

function heuristicPlan(items: Item[], goal: string, sourceById: Map<string, Item>) {
  const plan = items.map((s) => {
    const original = sourceById.get(itemRef(s)) ?? s;
    return { ref: itemRef(s), action: actionFor(original), priority: priorityOf(original) };
  });
  const order = { high: 0, medium: 1, low: 2 } as const;
  plan.sort((a, b) => order[a.priority] - order[b.priority]);
  const text = plan.length
    ? `Goal: ${goal}\n` + plan.map((p, n) => `${n + 1}. [${p.priority}] ${p.ref}: ${p.action}`).join("\n")
    : `Goal: ${goal}\nNothing requires follow-up.`;
  return { plan, text };
}

function heuristicDraft(context: unknown, format: string) {
  const ctx = (context && typeof context === "object" ? context : {}) as { summaries?: Item[]; plan?: Item[] };
  const summaries = Array.isArray(ctx.summaries) ? ctx.summaries : [];
  const plan = Array.isArray(ctx.plan) ? ctx.plan : [];
  const byRef = new Map(summaries.map((s) => [itemRef(s), s]));
  const rows = (plan.length ? plan : summaries).map((p) => {
    const s = byRef.get(itemRef(p)) ?? p;
    const src = itemSource(s);
    const title = String(s.title ?? itemRef(p));
    const link = format === "slack" && src ? `<${src}|${itemRef(p)}>` : itemRef(p);
    const prio = p.priority ? ` _(${p.priority})_` : "";
    const action = p.action ? ` — ${p.action}` : "";
    return `• ${link} ${title}${prio}${action}`;
  });
  const header = rows.length
    ? `*Stale issue follow-up* — ${rows.length} assigned issue${rows.length === 1 ? "" : "s"} without updates:`
    : "*Stale issue follow-up* — no stale assigned issues this time. :tada:";
  return {
    text: [header, ...rows].join("\n"),
    citations: summaries.map(itemSource).filter(Boolean),
  };
}

// ───────────────────────── executor ─────────────────────────

export async function executeAiCapability(
  capabilityId: string,
  input: Record<string, unknown>,
  ctx: { model: ModelClient; agent: AgentDescriptor; timeoutMs: number; upstream: Record<string, unknown> },
): Promise<AiResult> {
  const findings = scanValue(input, "input");
  const zero = { model: HEURISTIC_MODEL, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  const { model } = ctx;

  switch (capabilityId) {
    case "ai.summarize": {
      const items = asItems(input.items);
      if (model.heuristic || items.length === 0) return { output: heuristicSummarize(items), usage: zero, findings };
      const res = await model.completeJson({
        system: ctx.agent.systemPrompt,
        user:
          `Summarize each item in 2-3 sentences for a busy engineering lead. Use only facts in the items. ` +
          `For each, return ref, title, summary and source (the item's url).` +
          (input.instructions ? `\nExtra guidance: ${String(input.instructions)}` : "") +
          `\n\n${fenceUntrusted("items", items.map((i) => ({ ref: itemRef(i), title: i.title, url: itemSource(i), labels: i.labels, daysStale: i.daysStale, body: stripHidden(String(i.body ?? "")) })))}`,
        schema: SummarySchema,
        timeoutMs: ctx.timeoutMs,
      });
      // Grounding check (deterministic): every summary must map to an input item and its real URL.
      const refs = new Map(items.map((i) => [itemRef(i), itemSource(i)]));
      const summaries = res.data.summaries
        .filter((s) => refs.has(s.ref))
        .map((s) => ({ ...s, source: refs.get(s.ref) ?? "" }));
      if (summaries.length !== items.length) {
        throw new ExecutionError("permanent", `Grounding check failed: ${summaries.length}/${items.length} summaries matched source items`);
      }
      return { output: { summaries }, usage: res, findings };
    }
    case "ai.plan": {
      const items = asItems(input.items);
      const goal = String(input.goal ?? "Follow up");
      const sources = new Map<string, Item>();
      for (const v of Object.values(ctx.upstream)) {
        const issues = (v as { issues?: Item[] })?.issues;
        if (Array.isArray(issues)) issues.forEach((i) => sources.set(itemRef(i), i));
      }
      if (model.heuristic || items.length === 0) return { output: heuristicPlan(items, goal, sources), usage: zero, findings };
      const res = await model.completeJson({
        system: ctx.agent.systemPrompt,
        user: `Create one concrete next action per item toward the goal "${goal}". Priority: high|medium|low.\n\n${fenceUntrusted("items", items)}`,
        schema: PlanSchema,
        timeoutMs: ctx.timeoutMs,
      });
      const known = new Set(items.map(itemRef));
      return { output: { ...res.data, plan: res.data.plan.filter((p) => known.has(p.ref)) }, usage: res, findings };
    }
    case "ai.draft_message": {
      const format = String(input.format ?? "slack");
      if (model.heuristic) return { output: heuristicDraft(input.context, format), usage: zero, findings };
      const res = await model.completeJson({
        system: ctx.agent.systemPrompt,
        user:
          `Draft a ${format} message for ${String(input.audience ?? "the team")}. Under 1500 characters. ` +
          `Reference each item by its source link. Do not invent facts.\n\n${fenceUntrusted("context", input.context)}`,
        schema: DraftSchema,
        timeoutMs: ctx.timeoutMs,
      });
      return { output: res.data, usage: res, findings };
    }
    default:
      throw new ExecutionError("permanent", `Unknown AI capability ${capabilityId}`);
  }
}
