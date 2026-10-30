import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CredentialBroker } from "@orbix/connectors";
import { getPrisma } from "@orbix/db";
import { ExecutionEngine, HeuristicModel } from "@orbix/engine";

process.env.ORBIX_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

import { createApp } from "../src/bootstrap";

const OBJECTIVE =
  "Find GitHub issues assigned to me that have not been updated for seven days, summarize each issue, create a follow-up plan, and draft a Slack update for approval.";

let app: INestApplication;
const prisma = getPrisma();
const worker = new ExecutionEngine({ prisma, model: new HeuristicModel(), broker: new CredentialBroker(prisma), workerId: "e2e-worker", leaseMs: 30_000 });

async function drain() {
  for (let i = 0; i < 100; i++) {
    if ((await worker.tick(8)) > 0) continue;
    if ((await prisma.taskRun.count({ where: { status: "RETRY_SCHEDULED" } })) === 0) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A cookie-authenticated client that sends the CSRF header on mutations. */
async function signup(name: string) {
  const agent = request.agent(app.getHttpServer());
  const email = `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.dev`;
  await agent.post("/v1/auth/signup").send({ email, password: "correct-horse-battery", name }).expect(201);
  const org = await agent.post("/v1/orgs").set("x-orbix-request", "1").send({ name: `${name} Org` }).expect(201);
  return { agent, email, orgId: org.body.organization.id as string };
}

const mut = (agent: ReturnType<typeof request.agent>) => ({
  post: (url: string) => agent.post(url).set("x-orbix-request", "1"),
  put: (url: string) => agent.put(url).set("x-orbix-request", "1"),
  del: (url: string) => agent.delete(url).set("x-orbix-request", "1"),
});

// drain() claims tasks across all orgs; start every test from a quiet queue (see engine/test/helpers.ts).
beforeEach(async () => {
  await prisma.taskRun.updateMany({ where: { status: { in: ["PENDING", "READY", "RUNNING", "RETRY_SCHEDULED"] } }, data: { status: "CANCELLED", leaseOwner: null, leaseExpiresAt: null } });
  await prisma.missionRun.updateMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED" } });
});

beforeAll(async () => {
  app = await createApp({ logger: false });
  await app.init();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("auth", () => {
  it("rejects unauthenticated access, wrong passwords and cookie mutations without CSRF header", async () => {
    await request(app.getHttpServer()).get("/v1/me").expect(401);
    const { agent, email } = await signup("auth");
    await request(app.getHttpServer()).post("/v1/auth/login").send({ email, password: "wrong-password!!" }).expect(401);
    await agent.post("/v1/orgs").send({ name: "No CSRF" }).expect(403);
    const me = await agent.get("/v1/me").expect(200);
    expect(me.body.memberships[0].role).toBe("owner");
  });

  it("validates input with shared Zod contracts", async () => {
    const res = await request(app.getHttpServer()).post("/v1/auth/signup").send({ email: "bad", password: "short", name: "" }).expect(400);
    expect(res.body.error.code).toBe("validation_failed");
  });
});

describe("vertical slice over HTTP", () => {
  it("plan → edit → publish → simulate → dry run → approve → verified outcome", async () => {
    const { agent, orgId } = await signup("slice");
    const m = mut(agent);
    await m.post(`/v1/orgs/${orgId}/connections/sandbox`).send({ provider: "github" }).expect(201);
    await m.post(`/v1/orgs/${orgId}/connections/sandbox`).send({ provider: "slack" }).expect(201);

    const plan = await m.post(`/v1/orgs/${orgId}/missions/plan`).send({ objective: OBJECTIVE }).expect(201);
    const wfId = plan.body.workflow.id as string;
    expect(plan.body.issues.filter((i: { severity: string }) => i.severity === "error")).toEqual([]);

    // Edit: the user changes the channel, and tries (and fails) to disable the approval gate.
    const def = plan.body.workflow.draft;
    const post = def.nodes.find((n: { id: string }) => n.id === "post_update");
    post.inputs.channel = "#general";
    post.approval.required = false;
    post.risk = "read";
    const saved = await m.put(`/v1/orgs/${orgId}/workflows/${wfId}/draft`).send({ definition: def }).expect(200);
    expect(saved.body.policyNotes.join(" ")).toMatch(/approval enforced/);
    const savedPost = saved.body.workflow.draft.nodes.find((n: { id: string }) => n.id === "post_update");
    expect(savedPost.approval.required).toBe(true);
    expect(savedPost.risk).toBe("external_write");

    const pub = await m.post(`/v1/orgs/${orgId}/workflows/${wfId}/publish`).expect(201);
    expect(pub.body.version.version).toBe(1);

    const sim = await m.post(`/v1/orgs/${orgId}/workflows/${wfId}/simulate`).expect(201);
    expect(sim.body.report.valid).toBe(true);
    expect(sim.body.report.totals.approvals).toBe(1);
    expect(sim.body.report.readiness.live).toBe(true);

    const run = await m.post(`/v1/orgs/${orgId}/workflows/${wfId}/runs`).send({ mode: "dry_run" }).expect(201);
    const runId = run.body.run.id as string;
    await drain();

    const inbox = await agent.get(`/v1/orgs/${orgId}/approvals?status=pending`).expect(200);
    expect(inbox.body.approvals).toHaveLength(1);
    const approval = inbox.body.approvals[0];
    expect(approval.payload.input.channel).toBe("#general");

    await m.post(`/v1/orgs/${orgId}/approvals/${approval.id}/decision`).send({ decision: "approve", payloadHash: "f".repeat(64) }).expect(409);
    await m.post(`/v1/orgs/${orgId}/approvals/${approval.id}/decision`).send({ decision: "approve", payloadHash: approval.payloadHash }).expect(200);
    await drain();

    const done = await agent.get(`/v1/orgs/${orgId}/runs/${runId}`).expect(200);
    expect(done.body.run.status).toBe("SUCCEEDED");
    expect(done.body.run.outcome).toBe("verified");
    expect(done.body.run.toolExecutions.some((t: { capability: string; externalId: string }) => t.capability === "slack.message.post" && t.externalId)).toBe(true);

    // SSE stream replays the run's events and closes once the run is final.
    const sse = await agent.get(`/v1/orgs/${orgId}/runs/${runId}/events`).buffer(true).parse((res, cb) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString()));
      res.on("end", () => cb(null, data));
    });
    expect(sse.headers["content-type"]).toContain("text/event-stream");
    expect(String(sse.body)).toContain("event: approval.requested");
    expect(String(sse.body)).toContain("event: run.finalized");

    const analytics = await agent.get(`/v1/orgs/${orgId}/analytics/summary`).expect(200);
    expect(analytics.body.runs.total).toBe(1);
    expect(analytics.body.outcomes.verified).toBe(1);
    expect(analytics.body.estimatedMinutesSaved).toBeGreaterThan(0);

    const verify = await agent.get(`/v1/orgs/${orgId}/audit/verify`).expect(200);
    expect(verify.body.valid).toBe(true);
  });

  it("refuses to publish invalid workflows", async () => {
    const { agent, orgId } = await signup("invalid");
    const m = mut(agent);
    const plan = await m.post(`/v1/orgs/${orgId}/missions/plan`).send({ objective: OBJECTIVE }).expect(201);
    const def = plan.body.workflow.draft;
    def.nodes[0].dependsOn = ["verify_post"]; // cycle
    await m.put(`/v1/orgs/${orgId}/workflows/${plan.body.workflow.id}/draft`).send({ definition: def }).expect(200);
    const res = await m.post(`/v1/orgs/${orgId}/workflows/${plan.body.workflow.id}/publish`).expect(422);
    expect(res.body.error.details.some((i: { code: string }) => i.code === "cycle")).toBe(true);
  });
});

describe("tenancy, RBAC and API keys", () => {
  it("isolates organizations and enforces role permissions", async () => {
    const a = await signup("tenant-a");
    const b = await signup("tenant-b");
    const plan = await mut(a.agent).post(`/v1/orgs/${a.orgId}/missions/plan`).send({ objective: OBJECTIVE }).expect(201);

    // B cannot see A's org or its workflow, even by guessing IDs (404, not 403).
    await b.agent.get(`/v1/orgs/${a.orgId}/workflows`).expect(404);
    await b.agent.get(`/v1/orgs/${b.orgId}/workflows/${plan.body.workflow.id}`).expect(404);

    // Add B to A as a viewer: can read, cannot publish or approve.
    await mut(a.agent).post(`/v1/orgs/${a.orgId}/members`).send({ email: b.email, role: "viewer" }).expect(201);
    await b.agent.get(`/v1/orgs/${a.orgId}/workflows`).expect(200);
    await mut(b.agent).post(`/v1/orgs/${a.orgId}/workflows/${plan.body.workflow.id}/publish`).expect(403);
  });

  it("API keys are org-bound, shown once, and revocable", async () => {
    const { agent, orgId } = await signup("keys");
    const other = await signup("keys-other");
    const created = await mut(agent).post(`/v1/orgs/${orgId}/api-keys`).send({ name: "CI", role: "operator" }).expect(201);
    const key = created.body.key as string;
    expect(key.startsWith("orbx_")).toBe(true);

    const server = app.getHttpServer();
    await request(server).get(`/v1/orgs/${orgId}/workflows`).set("authorization", `Bearer ${key}`).expect(200);
    await request(server).post(`/v1/orgs/${orgId}/missions/plan`).set("authorization", `Bearer ${key}`).send({ objective: OBJECTIVE }).expect(201);
    await request(server).get(`/v1/orgs/${other.orgId}/workflows`).set("authorization", `Bearer ${key}`).expect(404);

    const list = await agent.get(`/v1/orgs/${orgId}/api-keys`).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(key);
    await mut(agent).del(`/v1/orgs/${orgId}/api-keys/${created.body.apiKey.id}`).expect(204);
    await request(server).get(`/v1/orgs/${orgId}/workflows`).set("authorization", `Bearer ${key}`).expect(401);
  });

  it("blocks webhook URLs that target private networks", async () => {
    const prev = process.env.ORBIX_ALLOW_PRIVATE_WEBHOOKS;
    process.env.ORBIX_ALLOW_PRIVATE_WEBHOOKS = "false";
    const { agent, orgId } = await signup("ssrf");
    const res = await mut(agent).post(`/v1/orgs/${orgId}/webhooks`).send({ url: "https://169.254.169.254/latest/meta-data", events: ["run.completed"] }).expect(400);
    expect(res.body.error.code).toBe("unsafe_url");
    process.env.ORBIX_ALLOW_PRIVATE_WEBHOOKS = prev;
  });

  it("never returns credentials from the integrations API", async () => {
    const { agent, orgId } = await signup("creds");
    const conn = await prisma.connection.create({ data: { organizationId: orgId, provider: "slack", label: "live", mode: "LIVE", scopes: ["chat:write"] } });
    await new CredentialBroker(prisma).store({ organizationId: orgId, connectionId: conn.id, kind: "token", accessToken: "xoxb-should-never-leak-1234567890" });
    const res = await agent.get(`/v1/orgs/${orgId}/integrations`).expect(200);
    expect(JSON.stringify(res.body)).not.toContain("xoxb-should-never-leak");
    expect(res.body.integrations.find((i: { provider: string }) => i.provider === "gmail")?.status).toBe("roadmap");
  });
});

describe("scheduled triggers over HTTP", () => {
  const SCHEDULED =
    "Every weekday morning, find GitHub issues assigned to me that have not been updated for seven days, summarize each issue, create a follow-up plan, and draft a Slack update for approval.";

  it("publish creates a paused schedule; operators activate it; viewers cannot", async () => {
    const { agent, orgId } = await signup("sched");
    const viewer = await signup("sched-viewer");
    const m = mut(agent);
    await m.post(`/v1/orgs/${orgId}/connections/sandbox`).send({ provider: "github" }).expect(201);
    await m.post(`/v1/orgs/${orgId}/connections/sandbox`).send({ provider: "slack" }).expect(201);

    const plan = await m.post(`/v1/orgs/${orgId}/missions/plan`).send({ objective: SCHEDULED }).expect(201);
    const wfId = plan.body.workflow.id as string;
    expect(plan.body.workflow.draft.trigger).toEqual({ type: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" });

    // No schedule exists until the workflow is published.
    expect((await agent.get(`/v1/orgs/${orgId}/workflows/${wfId}/schedule`).expect(200)).body.schedule).toBeNull();
    await m.put(`/v1/orgs/${orgId}/workflows/${wfId}/schedule`).send({ enabled: true }).expect(404);

    const pub = await m.post(`/v1/orgs/${orgId}/workflows/${wfId}/publish`).expect(201);
    expect(pub.body.schedule).toMatchObject({ enabled: false, cron: "0 9 * * 1-5", mode: "DRY_RUN" });

    const on = await m.put(`/v1/orgs/${orgId}/workflows/${wfId}/schedule`).send({ enabled: true, mode: "live" }).expect(200);
    expect(on.body.schedule).toMatchObject({ enabled: true, mode: "LIVE" });
    expect(on.body.schedule.upcoming).toHaveLength(3);
    expect(new Date(on.body.schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    const list = await agent.get(`/v1/orgs/${orgId}/schedules`).expect(200);
    expect(list.body.schedules[0].workflow.id).toBe(wfId);
    const wfList = await agent.get(`/v1/orgs/${orgId}/workflows`).expect(200);
    expect(wfList.body.workflows[0].schedule.enabled).toBe(true);

    await mut(agent).post(`/v1/orgs/${orgId}/members`).send({ email: viewer.email, role: "viewer" }).expect(201);
    await viewer.agent.get(`/v1/orgs/${orgId}/workflows/${wfId}/schedule`).expect(200);
    await mut(viewer.agent).put(`/v1/orgs/${orgId}/workflows/${wfId}/schedule`).send({ enabled: false }).expect(403);
    await m.put(`/v1/orgs/${orgId}/workflows/${wfId}/schedule`).send({}).expect(400);
  });

  it("refuses to publish a schedule that fires more often than every 5 minutes", async () => {
    const { agent, orgId } = await signup("sched-invalid");
    const m = mut(agent);
    const plan = await m.post(`/v1/orgs/${orgId}/missions/plan`).send({ objective: SCHEDULED }).expect(201);
    const def = { ...plan.body.workflow.draft, trigger: { type: "schedule", cron: "* * * * *", timezone: "UTC" } };
    const saved = await m.put(`/v1/orgs/${orgId}/workflows/${plan.body.workflow.id}/draft`).send({ definition: def }).expect(200);
    expect(saved.body.validation.issues.some((i: { code: string }) => i.code === "invalid_schedule")).toBe(true);
    const res = await m.post(`/v1/orgs/${orgId}/workflows/${plan.body.workflow.id}/publish`).expect(422);
    expect(res.body.error.details.some((i: { code: string }) => i.code === "invalid_schedule")).toBe(true);
  });
});

describe("connection refresh", () => {
  it("only live connections can be refreshed, within the org, by connection managers", async () => {
    const a = await signup("refresh-a");
    const b = await signup("refresh-b");
    const sandbox = await mut(a.agent).post(`/v1/orgs/${a.orgId}/connections/sandbox`).send({ provider: "slack" }).expect(201);
    const res = await mut(a.agent).post(`/v1/orgs/${a.orgId}/connections/${sandbox.body.connection.id}/refresh`).expect(400);
    expect(res.body.error.code).toBe("not_refreshable");

    // A live connection with no stored credential cannot be re-checked.
    const live = await prisma.connection.create({ data: { organizationId: a.orgId, provider: "slack", label: "live", mode: "LIVE", scopes: ["chat:write"] } });
    expect((await mut(a.agent).post(`/v1/orgs/${a.orgId}/connections/${live.id}/refresh`).expect(400)).body.error.code).toBe("no_credential");

    // Other orgs and viewers are refused.
    await mut(b.agent).post(`/v1/orgs/${b.orgId}/connections/${live.id}/refresh`).expect(404);
    await mut(a.agent).post(`/v1/orgs/${a.orgId}/members`).send({ email: b.email, role: "viewer" }).expect(201);
    await mut(b.agent).post(`/v1/orgs/${a.orgId}/connections/${live.id}/refresh`).expect(403);
  });
});
