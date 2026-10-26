import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  canTransitionRun,
  canTransitionTask,
  decideRetry,
  normalizeDefinition,
  redact,
  resolveTemplates,
  simulatePlan,
  topologicalLevels,
  validateWorkflow,
  workflowJsonSchema,
  type WorkflowDefinition,
  type WorkflowNode,
} from "../src";
import { hashPayload } from "../src/node";

const base = (over: Partial<WorkflowNode> & Pick<WorkflowNode, "id" | "agent" | "action">): WorkflowNode => ({
  title: over.id,
  inputs: {},
  dependsOn: [],
  timeoutMs: 30_000,
  retry: { maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 10_000 },
  risk: "read",
  approval: { required: false, expiresInMinutes: 60 },
  ...over,
});

const slice = (): WorkflowDefinition => ({
  schemaVersion: 1,
  name: "Stale issue digest",
  objective: "test",
  trigger: { type: "manual" },
  nodes: [
    base({ id: "find", agent: "developer", action: "github.issues.list_stale_assigned", inputs: { staleDays: 7 } }),
    base({
      id: "summarize",
      agent: "research",
      action: "ai.summarize",
      risk: "compute",
      dependsOn: ["find"],
      inputs: { items: "{{nodes.find.output.issues}}" },
    }),
    base({
      id: "post",
      agent: "communication",
      action: "slack.message.post",
      risk: "external_write",
      dependsOn: ["summarize"],
      retry: { maxAttempts: 2, backoffMs: 1000, maxBackoffMs: 5000 },
      approval: { required: true, expiresInMinutes: 60 },
      inputs: { channel: "#eng", text: "{{nodes.summarize.output.summaries}}" },
    }),
  ],
});

describe("validator", () => {
  it("accepts the reference slice", () => {
    const r = validateWorkflow(slice());
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("detects cycles", () => {
    const def = slice();
    def.nodes[0]!.dependsOn = ["post"];
    const r = validateWorkflow(def);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === "cycle")).toBe(true);
  });

  it("rejects disabling approval on external writes", () => {
    const def = slice();
    def.nodes[2]!.approval.required = false;
    expect(validateWorkflow(def).issues.map((i) => i.code)).toContain("approval_required");
  });

  it("rejects tools outside the agent allowlist", () => {
    const def = slice();
    def.nodes[2]!.agent = "research";
    expect(validateWorkflow(def).issues.map((i) => i.code)).toContain("agent_not_permitted");
  });

  it("rejects references to nodes that are not upstream", () => {
    const def = slice();
    def.nodes[1]!.dependsOn = [];
    expect(validateWorkflow(def).issues.map((i) => i.code)).toContain("reference_not_upstream");
  });

  it("rejects roadmap capabilities and missing inputs", () => {
    const def = slice();
    def.nodes.push(base({ id: "mail", agent: "communication", action: "gmail.message.send", risk: "external_write", approval: { required: true, expiresInMinutes: 5 } }));
    def.nodes[2]!.inputs = { channel: "#eng" };
    const codes = validateWorkflow(def).issues.map((i) => i.code);
    expect(codes).toContain("capability_unavailable");
    expect(codes).toContain("missing_input");
  });

  it("normalisation raises risk and forces approval", () => {
    const def = slice();
    def.nodes[2]!.risk = "read";
    def.nodes[2]!.approval.required = false;
    const { definition, notes } = normalizeDefinition(def);
    expect(definition.nodes[2]!.risk).toBe("external_write");
    expect(definition.nodes[2]!.approval.required).toBe(true);
    expect(notes.length).toBeGreaterThan(0);
    expect(validateWorkflow(definition).valid).toBe(true);
  });

  it("computes parallel levels", () => {
    const def = slice();
    def.nodes.push(base({ id: "alt", agent: "supervisor", action: "ai.plan", risk: "compute", dependsOn: ["find"], inputs: { items: [], goal: "x" } }));
    expect(topologicalLevels(def)).toEqual([["find"], ["alt", "summarize"], ["post"]]);
  });

  it("exports a JSON schema", () => {
    const schema = workflowJsonSchema() as { type: string };
    expect(schema.type).toBe("object");
  });
});

describe("templates", () => {
  it("resolves whole-value refs with types and interpolates strings", () => {
    const outputs = { find: { issues: [{ n: 1 }], count: 1 } };
    expect(resolveTemplates("{{nodes.find.output.issues}}", outputs)).toEqual([{ n: 1 }]);
    expect(resolveTemplates("Found {{nodes.find.output.count}} issue", outputs)).toBe("Found 1 issue");
  });
});

describe("state machines", () => {
  it("allows legal and blocks illegal transitions", () => {
    expect(canTransitionRun("RUNNING", "WAITING_APPROVAL")).toBe(true);
    expect(canTransitionRun("SUCCEEDED", "RUNNING")).toBe(false);
    expect(canTransitionTask("NEEDS_RECONCILIATION", "SUCCEEDED")).toBe(true);
    expect(canTransitionTask("SUCCEEDED", "READY")).toBe(false);
  });
});

describe("retry policy", () => {
  const policy = { maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 5000 };
  it("caps exponential backoff and applies jitter", () => {
    expect(backoffDelay(policy, 1, () => 1)).toBe(1000);
    expect(backoffDelay(policy, 10, () => 1)).toBe(5000);
    expect(backoffDelay(policy, 3, () => 0.5)).toBe(2000);
  });
  it("never retries permission/permanent failures and reconciles ambiguous ones", () => {
    expect(decideRetry({ failureClass: "permission", attempt: 1, policy }).action).toBe("fail");
    expect(decideRetry({ failureClass: "ambiguous", attempt: 1, policy }).action).toBe("reconcile");
    expect(decideRetry({ failureClass: "transient", attempt: 3, policy }).action).toBe("dead_letter");
    const rl = decideRetry({ failureClass: "rate_limited", attempt: 1, policy, retryAfterMs: 9000, random: () => 0 });
    expect(rl).toEqual({ action: "retry", delayMs: 9000 });
  });
});

describe("hashing and redaction", () => {
  it("hashes payloads independent of key order", () => {
    expect(hashPayload({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashPayload({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(hashPayload({ text: "hi" })).not.toBe(hashPayload({ text: "hi!" }));
  });
  it("redacts secrets by key and by shape", () => {
    const r = redact({ token: "abc", nested: { note: "use xoxb-1234567890-abcdefghij please" } });
    expect(r.token).toBe("[REDACTED]");
    expect(r.nested.note).not.toContain("xoxb-");
  });
});

describe("plan preview", () => {
  it("reports blockers for missing connections and counts approvals", () => {
    const report = simulatePlan(slice(), [{ provider: "github", mode: "sandbox", scopes: [], status: "active" }], "gpt-4.1-mini");
    expect(report.totals.approvals).toBe(1);
    expect(report.totals.externalWrites).toBe(1);
    expect(report.readiness.dryRun).toBe(true);
    expect(report.readiness.live).toBe(false);
    expect(report.readiness.blockers.join()).toContain("slack");
  });
});
