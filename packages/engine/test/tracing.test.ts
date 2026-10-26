import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { CredentialBroker, injectFault, seedGithubSandbox } from "@orbix/connectors";
import { bootstrapOrganization, getPrisma, type Prisma } from "@orbix/db";
import { hashPayload } from "@orbix/core/node";
import { ExecutionEngine, HeuristicModel, planWorkflow } from "../src";
import { createRequire } from "node:module";
import { quiesceQueue } from "./helpers";

// Load the compiled CommonJS module exactly as the apps do (Vitest would otherwise pick OTel ESM builds).
const { shouldIgnoreIncoming, startTelemetry } = createRequire(__filename)("../dist/telemetry.js") as typeof import("../src/telemetry");

process.env.ORBIX_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const prisma = getPrisma();
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => provider.register());
beforeEach(() => quiesceQueue(prisma));
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  await prisma.$disconnect();
});

describe("telemetry bootstrap", () => {
  it("is a no-op without an OTLP endpoint and skips secret-bearing routes", async () => {
    const t = startTelemetry("test", {});
    expect(t.enabled).toBe(false);
    await t.shutdown();
    expect(shouldIgnoreIncoming("/v1/oauth/github/callback?code=abc&state=xyz")).toBe(true);
    expect(shouldIgnoreIncoming("/v1/health")).toBe(true);
    expect(shouldIgnoreIncoming("/v1/orgs/o/runs")).toBe(false);
  });
});

describe("engine spans", () => {
  it("emits nested task/tool spans with identifiers only, and marks failures", async () => {
    const user = await prisma.user.create({ data: { email: `trace-${Date.now()}@test.dev`, name: "t", passwordHash: "x" } });
    const org = await bootstrapOrganization(prisma, { name: "tracing", ownerUserId: user.id });
    for (const provider of ["github", "slack"]) {
      await prisma.connection.create({ data: { organizationId: org.id, provider, label: provider, mode: "SANDBOX", scopes: [] } });
    }
    await seedGithubSandbox(prisma, org.id);
    const model = new HeuristicModel();
    const plan = await planWorkflow("Find GitHub issues assigned to me stale for 7 days, summarize them and draft a Slack update", model);
    const wf = await prisma.workflow.create({ data: { organizationId: org.id, name: "t", draft: plan.definition as unknown as Prisma.InputJsonValue } });
    const v = await prisma.workflowVersion.create({
      data: { organizationId: org.id, workflowId: wf.id, version: 1, definition: plan.definition as unknown as Prisma.InputJsonValue, definitionHash: hashPayload(plan.definition) },
    });
    await prisma.workflow.update({ where: { id: wf.id }, data: { latestVersionId: v.id } });

    const engine = new ExecutionEngine({ prisma, model, broker: new CredentialBroker(prisma), workerId: "trace", leaseMs: 30_000 });
    injectFault("github.issues.list_stale_assigned", "permission", 1);
    const failing = await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "system" } });
    exporter.reset();
    for (let i = 0; i < 20 && (await engine.tick(8)) > 0; i++);
    const ok = await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "system" } });
    for (let i = 0; i < 50 && (await engine.tick(8)) > 0; i++);

    const spans = exporter.getFinishedSpans();
    const tasks = spans.filter((s) => s.name === "orbix.task.execute");
    const tools = spans.filter((s) => s.name === "orbix.tool.invoke");
    expect(tasks.length).toBeGreaterThan(3);
    expect(tools.length).toBeGreaterThan(3);

    // Tool spans are children of their task span.
    const tool = tools.find((s) => s.attributes["orbix.run_id"] === ok.id && s.attributes["orbix.capability"] === "ai.summarize")!;
    const parentId = (tool as unknown as { parentSpanContext?: { spanId: string }; parentSpanId?: string }).parentSpanContext?.spanId ?? (tool as unknown as { parentSpanId?: string }).parentSpanId;
    const parent = tasks.find((s) => s.spanContext().spanId === parentId);
    expect(parent?.attributes["orbix.node"]).toBe("summarize_issues");
    expect(tool.attributes).toMatchObject({ "orbix.org_id": org.id, "orbix.provider": "ai", "orbix.risk": "compute" });

    // The injected permission failure is visible on both spans.
    const failedTool = tools.find((s) => s.attributes["orbix.run_id"] === failing.id)!;
    expect(failedTool.status.code).toBe(2); // ERROR
    expect(failedTool.attributes["orbix.failure_class"]).toBe("permission");
    const failedTask = tasks.find((s) => s.attributes["orbix.run_id"] === failing.id)!;
    expect(failedTask.attributes["orbix.task.status"]).toBe("FAILED");

    // Spans carry identifiers and metadata only: no issue text, drafts or tokens.
    const serialized = JSON.stringify(spans.map((s) => ({ a: s.attributes, e: s.events })));
    expect(serialized).not.toMatch(/Motor controller|Stale issue follow-up|ghp_|xox[bp]-/);
  });
});
