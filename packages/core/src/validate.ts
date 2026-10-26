import { getAgent } from "./agents";
import { getCapability } from "./capabilities";
import { approvalRequiredFor, isNeverAutoRetry, riskRank } from "./risk";
import { findRefs } from "./templates";
import { NO_RETRY, WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowNode } from "./workflow";

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  field?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  definition?: WorkflowDefinition;
}

/**
 * Deterministic policy normalisation. Applied on every save and publish, so neither the LLM planner
 * nor a user edit can lower a node's risk, disable a mandatory approval, or enable blind retries.
 */
export function normalizeDefinition(def: WorkflowDefinition): { definition: WorkflowDefinition; notes: string[] } {
  const notes: string[] = [];
  const nodes = def.nodes.map((node): WorkflowNode => {
    const cap = getCapability(node.action);
    if (!cap) return node;
    let next: WorkflowNode = { ...node, inputs: { ...node.inputs } };

    if (riskRank(next.risk) < riskRank(cap.risk)) {
      notes.push(`${node.id}: risk raised from ${next.risk} to ${cap.risk} (capability policy)`);
      next.risk = cap.risk;
    }
    if (approvalRequiredFor(next.risk) && !next.approval.required) {
      notes.push(`${node.id}: approval enforced for ${next.risk} action`);
      next.approval = { ...next.approval, required: true };
    }
    const unsafeRetry = isNeverAutoRetry(next.risk) || (!cap.idempotent && !cap.reconcilable);
    if (unsafeRetry && next.retry.maxAttempts > 1) {
      notes.push(`${node.id}: automatic retries disabled (non-idempotent, not reconcilable)`);
      next.retry = { ...NO_RETRY };
    }
    for (const [key, spec] of Object.entries(cap.inputs)) {
      if (next.inputs[key] === undefined && spec.default !== undefined) next.inputs[key] = spec.default;
    }
    return next;
  });
  return { definition: { ...def, nodes }, notes };
}

export function validateWorkflow(input: unknown): ValidationResult {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((i) => ({
        severity: "error" as const,
        code: "schema",
        message: i.message,
        field: i.path.join("."),
        nodeId: nodeIdFromPath(input, i.path),
      })),
    };
  }
  const def = parsed.data;
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();

  for (const node of def.nodes) {
    if (ids.has(node.id)) issues.push(err("duplicate_id", `Duplicate node id "${node.id}"`, node.id));
    ids.add(node.id);
  }

  for (const node of def.nodes) {
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) issues.push(err("unknown_dependency", `Depends on unknown node "${dep}"`, node.id));
      if (dep === node.id) issues.push(err("self_dependency", "A node cannot depend on itself", node.id));
    }

    const cap = getCapability(node.action);
    if (!cap) {
      issues.push(err("unknown_capability", `Unknown action "${node.action}"`, node.id));
      continue;
    }
    if (cap.availability !== "available") {
      issues.push(err("capability_unavailable", `"${cap.title}" is on the roadmap and cannot run yet`, node.id));
    }
    const agent = getAgent(node.agent);
    if (agent && !agent.allowedCapabilities.includes(node.action)) {
      issues.push(err("agent_not_permitted", `${agent.name} is not permitted to use ${node.action}`, node.id));
    }
    if (riskRank(node.risk) < riskRank(cap.risk)) {
      issues.push(err("risk_too_low", `Risk must be at least ${cap.risk}`, node.id, "risk"));
    }
    if (approvalRequiredFor(cap.risk) && !node.approval.required) {
      issues.push(err("approval_required", `${cap.risk} actions require human approval`, node.id, "approval"));
    }
    if ((isNeverAutoRetry(cap.risk) || (!cap.idempotent && !cap.reconcilable)) && node.retry.maxAttempts > 1) {
      issues.push(err("unsafe_retry", "This action cannot be retried automatically", node.id, "retry"));
    }
    if (node.retry.backoffMs > node.retry.maxBackoffMs) {
      issues.push(err("retry_backoff", "backoffMs must be ≤ maxBackoffMs", node.id, "retry"));
    }
    for (const [key, spec] of Object.entries(cap.inputs)) {
      const v = node.inputs[key];
      if (spec.required && (v === undefined || v === null || v === "")) {
        issues.push(err("missing_input", `Missing required input "${key}"`, node.id, `inputs.${key}`));
      }
    }
    for (const key of Object.keys(node.inputs)) {
      if (!(key in cap.inputs)) issues.push(warn("unknown_input", `Input "${key}" is not used by ${node.action}`, node.id));
    }
  }

  const cycle = findCycle(def);
  if (cycle) issues.push(err("cycle", `Cycle detected: ${cycle.join(" → ")}`, cycle[0]));

  if (!cycle) {
    const ancestors = ancestorMap(def);
    const byId = new Map(def.nodes.map((n) => [n.id, n]));
    for (const node of def.nodes) {
      for (const ref of findRefs(node.inputs)) {
        const src = byId.get(ref.nodeId);
        if (!src) {
          issues.push(err("unknown_reference", `References unknown node "${ref.nodeId}"`, node.id));
          continue;
        }
        if (!ancestors.get(node.id)?.has(ref.nodeId)) {
          issues.push(err("reference_not_upstream", `Uses output of "${ref.nodeId}" without depending on it`, node.id));
        }
        const cap = getCapability(src.action);
        const head = ref.path[0];
        if (cap && head && !(head in cap.outputs)) {
          issues.push(warn("unknown_output", `"${src.id}" has no output "${head}"`, node.id));
        }
      }
    }
  }

  const valid = !issues.some((i) => i.severity === "error");
  return { valid, issues, definition: def };
}

/** Groups of node ids that can run in parallel, in execution order. */
export function topologicalLevels(def: Pick<WorkflowDefinition, "nodes">): string[][] {
  const remaining = new Map(def.nodes.map((n) => [n.id, new Set(n.dependsOn)]));
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) break; // cycle; reported by validator
    levels.push(ready.sort());
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) ready.forEach((r) => deps.delete(r));
  }
  return levels;
}

function findCycle(def: WorkflowDefinition): string[] | null {
  const deps = new Map(def.nodes.map((n) => [n.id, n.dependsOn]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of deps.keys()) {
    const c = visit(id);
    if (c) return c.reverse();
  }
  return null;
}

function ancestorMap(def: WorkflowDefinition): Map<string, Set<string>> {
  const deps = new Map(def.nodes.map((n) => [n.id, n.dependsOn]));
  const memo = new Map<string, Set<string>>();
  const get = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const set = new Set<string>();
    memo.set(id, set);
    for (const d of deps.get(id) ?? []) {
      set.add(d);
      get(d).forEach((a) => set.add(a));
    }
    return set;
  };
  def.nodes.forEach((n) => get(n.id));
  return memo;
}

function nodeIdFromPath(input: unknown, path: PropertyKey[]): string | undefined {
  if (path[0] !== "nodes" || typeof path[1] !== "number") return undefined;
  const nodes = (input as { nodes?: Array<{ id?: unknown }> })?.nodes;
  const id = nodes?.[path[1]]?.id;
  return typeof id === "string" ? id : undefined;
}

const err = (code: string, message: string, nodeId?: string, field?: string): ValidationIssue => ({
  severity: "error",
  code,
  message,
  nodeId,
  field,
});
const warn = (code: string, message: string, nodeId?: string): ValidationIssue => ({
  severity: "warning",
  code,
  message,
  nodeId,
});
