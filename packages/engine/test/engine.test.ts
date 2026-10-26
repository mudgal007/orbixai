import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CredentialBroker, clearFaults, injectFault, seedGithubSandbox } from "@orbix/connectors";
import { bootstrapOrganization, getPrisma, verifyAuditChain, type Prisma } from "@orbix/db";
import { hashPayload } from "@orbix/core/node";
import { EngineError, ExecutionEngine, HeuristicModel, ingestDocument, planWorkflow, searchKnowledge } from "../src";

process.env.ORBIX_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const prisma = getPrisma();
const model = new HeuristicModel();
const engine = new ExecutionEngine({ prisma, model, broker: new CredentialBroker(prisma), workerId: "test-worker", leaseMs: 30_000 });
const OBJECTIVE =
  "Find GitHub issues assigned to me that have not been updated for seven days, summarize each issue, create a follow-up plan, and draft a Slack update for approval.";

async function makeOrg(name: string) {
  const user = await prisma.user.create({ data: { email: `${name}-${Date.now()}-${Math.random()}@test.dev`, name, passwordHash: "x" } });
  const org = await bootstrapOrganization(prisma, { name, ownerUserId: user.id });
  for (const provider of ["github", "slack"]) {
    await prisma.connection.create({ data: { organizationId: org.id, provider, label: `${provider} sandbox`, mode: "SANDBOX", scopes: [] } });
  }
  await seedGithubSandbox(prisma, org.id);
  const plan = await planWorkflow(OBJECTIVE, model);
  const wf = await prisma.workflow.create({ data: { organizationId: org.id, name: plan.definition.name, draft: plan.definition as unknown as Prisma.InputJsonValue } });
  const v = await prisma.workflowVersion.create({
    data: { organizationId: org.id, workflowId: wf.id, version: 1, definition: plan.definition as unknown as Prisma.InputJsonValue, definitionHash: hashPayload(plan.definition) },
  });
  await prisma.workflow.update({ where: { id: wf.id }, data: { latestVersionId: v.id } });
  return { user, org, wf, plan };
}

async function drain(maxLoops = 200) {
  for (let i = 0; i < maxLoops; i++) {
    const n = await engine.tick(8);
    if (n > 0) continue;
    const scheduled = await prisma.taskRun.count({ where: { status: "RETRY_SCHEDULED" } });
    if (scheduled === 0) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

const slackMessages = (organizationId: string) => prisma.mockProviderRecord.count({ where: { organizationId, provider: "slack", kind: "message" } });
const pendingApproval = (runId: string) => prisma.approvalRequest.findFirstOrThrow({ where: { runId, status: "PENDING" } });
const actor = (id: string) => ({ type: "user" as const, id, roleKey: "owner" });

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(() => clearFaults());

describe("planner", () => {
  it("produces a valid six-step graph for the vertical slice", async () => {
    const plan = await planWorkflow(OBJECTIVE, model);
    expect(plan.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(plan.definition.nodes.map((n) => n.action)).toEqual([
      "github.issues.list_stale_assigned",
      "ai.summarize",
      "ai.plan",
      "ai.draft_message",
      "slack.message.post",
      "slack.message.verify",
    ]);
    const post = plan.definition.nodes.find((n) => n.action === "slack.message.post")!;
    expect(post.approval.required).toBe(true);
    expect(plan.definition.nodes[0]!.inputs.staleDays).toBe(7);
  });

  it("calls out roadmap integrations instead of pretending", async () => {
    const plan = await planWorkflow("When a Shopify order arrives, email the customer and post to #ops in Slack", model);
    expect(plan.notes.join(" ")).toMatch(/Shopify is on the roadmap/);
    expect(plan.definition.nodes.some((n) => n.action.startsWith("shopify"))).toBe(false);
  });
});

describe("vertical slice (dry run, sandbox connectors)", () => {
  it("runs to an approval, binds it to the payload, posts once, and verifies the outcome", async () => {
    const { org, wf, user } = await makeOrg("slice");
    const run = await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "user", id: user.id } });
    await drain();

    const waiting = await prisma.missionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(waiting.status).toBe("WAITING_APPROVAL");

    const found = await prisma.taskRun.findFirstOrThrow({ where: { runId: run.id, nodeKey: "find_issues" } });
    expect((found.output as { count: number }).count).toBe(4); // 12, 21, 9, 15 days; the 2-day issue is excluded

    const approval = await pendingApproval(run.id);
    const payload = approval.payload as { input: { channel: string; text: string } };
    expect(payload.input.channel).toBe("#eng-updates");
    expect(payload.input.text).toContain("Stale issue follow-up");
    expect(payload.input.text).not.toMatch(/token|ignore all previous/i);
    expect((approval.evidence as { sources: string[] }).sources.length).toBe(4);

    // Prompt injection hidden in issue #97 is detected and surfaced as evidence.
    expect((approval.evidence as { injectionWarnings: unknown[] }).injectionWarnings.length).toBeGreaterThan(0);

    // Approving a payload hash other than the one displayed is refused.
    await expect(
      engine.decideApproval({ organizationId: org.id, approvalId: approval.id, actor: actor(user.id), decision: "approve", payloadHash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await slackMessages(org.id)).toBe(0);

    await engine.decideApproval({ organizationId: org.id, approvalId: approval.id, actor: actor(user.id), decision: "approve", payloadHash: approval.payloadHash });
    await drain();

    const done = await prisma.missionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe("SUCCEEDED");
    expect(done.outcome).toBe("verified");
    expect(done.estimatedMinutesSaved).toBeGreaterThan(0);
    expect(await slackMessages(org.id)).toBe(1);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("CONSUMED");
    expect(await prisma.executionCheckpoint.count({ where: { runId: run.id } })).toBe(6);

    const chain = await verifyAuditChain(prisma, org.id);
    expect(chain.valid).toBe(true);
    expect(chain.checked).toBeGreaterThan(3);
  });

  it("invalidates an approval when the payload is edited and posts the edited text", async () => {
    const { org, wf, user } = await makeOrg("changes");
    const run = await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "user", id: user.id } });
    await drain();
    const first = await pendingApproval(run.id);

    const second = await engine.requestChanges({ organizationId: org.id, approvalId: first.id, actor: { type: "user", id: user.id }, payload: { text: "Edited by a human." } });
    expect(second.payloadHash).not.toBe(first.payloadHash);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("INVALIDATED");
    await expect(
      engine.decideApproval({ organizationId: org.id, approvalId: first.id, actor: actor(user.id), decision: "approve", payloadHash: first.payloadHash }),
    ).rejects.toBeInstanceOf(EngineError);

    await engine.decideApproval({ organizationId: org.id, approvalId: second.id, actor: actor(user.id), decision: "approve", payloadHash: second.payloadHash });
    await drain();
    const msg = await prisma.mockProviderRecord.findFirstOrThrow({ where: { organizationId: org.id, provider: "slack", kind: "message" } });
    expect((msg.data as { text: string }).text).toBe("Edited by a human.");
    expect((await prisma.missionRun.findUniqueOrThrow({ where: { id: run.id } })).outcome).toBe("verified");
  });

  it("reconciles an ambiguous write instead of sending a duplicate", async () => {
    const { org, wf, user } = await makeOrg("ambiguous");
    const run = await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "user", id: user.id } });
    await drain();
    const approval = await pendingApproval(run.id);
    injectFault("slack.message.post", "ambiguous_after_write", 1);
    await engine.decideApproval({ organizationId: org.id, approvalId: approval.id, actor: actor(user.id), decision: "approve", payloadHash: approval.payloadHash });
    await drain();

    expect(await slackMessages(org.id)).toBe(1);
    const execs = await prisma.toolExecution.findMany({ where: { runId: run.id, capability: "slack.message.post" } });
    expect(execs.map((e) => e.status).sort()).toEqual(["RECONCILED"]);
    const done = await prisma.missionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe("SUCCEEDED");
    expect(done.outcome).toBe("verified");
  });

  it("retries transient read failures with backoff", async () => {
    const { org, wf, user } = await makeOrg("transient");
    injectFault("github.issues.list_stale_assigned", "transient", 2);
    const run = await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "user", id: user.id } });
    await drain();
    const task = await prisma.taskRun.findFirstOrThrow({ where: { runId: run.id, nodeKey: "find_issues" } });
    expect(task.status).toBe("SUCCEEDED");
    expect(task.attempt).toBe(3);
  });

  it("rejection fails the step and skips everything downstream", async () => {
    const { org, wf, user } = await makeOrg("reject");
    const run = await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "user", id: user.id } });
    await drain();
    const approval = await pendingApproval(run.id);
    await engine.decideApproval({ organizationId: org.id, approvalId: approval.id, actor: actor(user.id), decision: "reject", payloadHash: approval.payloadHash, comment: "Not today" });
    await drain();
    const done = await prisma.missionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe("FAILED");
    expect((await prisma.taskRun.findFirstOrThrow({ where: { runId: run.id, nodeKey: "verify_post" } })).status).toBe("SKIPPED");
    expect(await slackMessages(org.id)).toBe(0);
  });

  it("expired approvals fail the step during maintenance", async () => {
    const { org, wf, user } = await makeOrg("expiry");
    const run = await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "user", id: user.id } });
    await drain();
    const approval = await pendingApproval(run.id);
    await prisma.approvalRequest.update({ where: { id: approval.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await engine.maintenance();
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("EXPIRED");
    expect((await prisma.missionRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("FAILED");
  });

  it("pause stops claiming; resume continues", async () => {
    const { org, wf, user } = await makeOrg("pause");
    const run = await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "user", id: user.id } });
    await engine.pause(org.id, run.id, { type: "user", id: user.id });
    expect(await engine.tick(8)).toBe(0);
    await engine.resume(org.id, run.id, { type: "user", id: user.id });
    await drain();
    expect((await prisma.missionRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("WAITING_APPROVAL");
  });
});

describe("tenancy and security", () => {
  it("one org cannot decide another org's approval or read its credentials", async () => {
    const a = await makeOrg("tenant-a");
    const b = await makeOrg("tenant-b");
    const run = await engine.createRun({ organizationId: a.org.id, workflowId: a.wf.id, mode: "dry_run", actor: { type: "user", id: a.user.id } });
    await drain();
    const approval = await pendingApproval(run.id);
    await expect(
      engine.decideApproval({ organizationId: b.org.id, approvalId: approval.id, actor: actor(b.user.id), decision: "approve", payloadHash: approval.payloadHash }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(engine.createRun({ organizationId: b.org.id, workflowId: a.wf.id, mode: "dry_run", actor: { type: "user", id: b.user.id } })).rejects.toMatchObject({
      code: "not_found",
    });

    const conn = await prisma.connection.create({ data: { organizationId: a.org.id, provider: "github", label: "live", mode: "LIVE", scopes: ["repo"] } });
    const broker = new CredentialBroker(prisma);
    await broker.store({ organizationId: a.org.id, connectionId: conn.id, kind: "token", accessToken: "ghp_secretsecretsecretsecret" });
    await expect(broker.getAccessToken(b.org.id, conn.id)).rejects.toThrow(/not found/);
    expect(await broker.getAccessToken(a.org.id, conn.id)).toBe("ghp_secretsecretsecretsecret");
    const stored = await prisma.credentialReference.findUniqueOrThrow({ where: { connectionId: conn.id } });
    expect(stored.encrypted).not.toContain("ghp_");
  });

  it("live runs are refused when a required connection is missing", async () => {
    const { org, wf, user } = await makeOrg("live-missing");
    await prisma.connection.updateMany({ where: { organizationId: org.id, provider: "slack" }, data: { status: "REVOKED" } });
    await expect(engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "live", actor: { type: "user", id: user.id } })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("audit log rejects UPDATE at the database level", async () => {
    const { org } = await makeOrg("audit");
    const { appendAudit } = await import("@orbix/db");
    await appendAudit(prisma, { organizationId: org.id, actorType: "system", action: "test.event" });
    await expect(prisma.auditEvent.updateMany({ where: { organizationId: org.id }, data: { action: "tampered" } })).rejects.toThrow(/append-only/);
  });
});

describe("knowledge", () => {
  it("ingests, versions, and searches within the org only", async () => {
    const a = await makeOrg("kb-a");
    const b = await makeOrg("kb-b");
    await ingestDocument(prisma, model, { organizationId: a.org.id, title: "Gripper calibration", collection: "runbooks", content: "Calibrate the v3 gripper with the torque jig at 4.2 Nm.\n\nRecord results in the fleet log." });
    const v2 = await ingestDocument(prisma, model, { organizationId: a.org.id, title: "Gripper calibration", collection: "runbooks", content: "Calibrate the v3 gripper with the new torque jig at 4.5 Nm." });
    expect(v2.document.version).toBe(2);
    const hits = await searchKnowledge(prisma, model, { organizationId: a.org.id, query: "gripper torque calibration" });
    expect(hits[0]?.content).toContain("4.5 Nm");
    expect(hits.every((h) => h.version === 2)).toBe(true);
    expect(await searchKnowledge(prisma, model, { organizationId: b.org.id, query: "gripper torque calibration" })).toEqual([]);
  });
});
