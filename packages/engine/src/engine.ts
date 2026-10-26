import {
  ExecutionError,
  TERMINAL_TASK,
  approvalRequiredFor,
  canTransitionRun,
  decideRetry,
  getAgent,
  getCapability,
  getPath,
  isExternalProvider,
  isWrite,
  redact,
  resolveTemplates,
  simulatePlan,
  validateWorkflow,
  type RunStatus,
  type SuccessCondition,
  type TaskStatus,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@orbix/core";
import { hashPayload, sha256 } from "@orbix/core/node";
import type { CredentialBroker, InvokeResult } from "@orbix/connectors";
import { Prisma, appendAudit, emitRunEvent, type MissionRun, type PrismaClient, type TaskRun } from "@orbix/db";
import { executeAiCapability } from "./ai";
import { searchKnowledge } from "./knowledge";
import type { ModelClient } from "./model";
import { authorizeToolCall, type PolicyDecision } from "./policy";
import { deliverWebhooks } from "./webhooks";

export interface Actor {
  type: "user" | "api_key" | "system";
  id?: string;
}

export interface EngineDeps {
  prisma: PrismaClient;
  model: ModelClient;
  broker: CredentialBroker;
  workerId: string;
  leaseMs: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class EngineError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "invalid" | "forbidden" | "gone",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Estimated manual minutes replaced per step (configurable heuristic shown as "estimated" in the UI). */
const MINUTES_SAVED: Record<string, number> = {
  "github.issues.list_stale_assigned": 5,
  "github.issue.comment": 3,
  "ai.summarize": 10,
  "ai.plan": 10,
  "ai.draft_message": 10,
  "slack.message.post": 2,
  "slack.message.verify": 2,
  "knowledge.search": 5,
};

const ACTIVE: TaskStatus[] = ["READY", "RUNNING", "RETRY_SCHEDULED"];
const json = (v: unknown) => v as Prisma.InputJsonValue;

export class ExecutionEngine {
  constructor(private readonly d: EngineDeps) {}

  private get db() {
    return this.d.prisma;
  }

  // ═════════════════════════════ Run lifecycle (API-facing) ═════════════════════════════

  async createRun(input: {
    organizationId: string;
    workflowId: string;
    versionId?: string;
    mode: "dry_run" | "live";
    actor: Actor;
    missionId?: string;
  }): Promise<MissionRun> {
    const { organizationId } = input;
    const workflow = await this.db.workflow.findFirst({ where: { id: input.workflowId, organizationId } });
    if (!workflow) throw new EngineError("not_found", "Workflow not found");
    const versionId = input.versionId ?? workflow.latestVersionId;
    if (!versionId) throw new EngineError("invalid", "Publish the workflow before running it");
    const version = await this.db.workflowVersion.findFirst({ where: { id: versionId, organizationId, workflowId: workflow.id } });
    if (!version) throw new EngineError("not_found", "Workflow version not found");

    const def = version.definition as unknown as WorkflowDefinition;
    const validation = validateWorkflow(def);
    if (!validation.valid) throw new EngineError("invalid", "Workflow version is invalid", validation.issues);

    if (input.mode === "live") {
      const connections = await this.db.connection.findMany({ where: { organizationId } });
      const report = simulatePlan(
        def,
        connections.map((c) => ({ provider: c.provider, mode: c.mode === "LIVE" ? "live" : "sandbox", scopes: c.scopes, status: c.status.toLowerCase() as "active" })),
        this.d.model.name,
      );
      if (!report.readiness.live) throw new EngineError("invalid", "Workflow is not ready for live execution", report.readiness.blockers);
    }

    const sub = await this.db.billingSubscription.findUnique({ where: { organizationId } });
    const mission = input.missionId ?? (await this.db.mission.findFirst({ where: { organizationId, workflowId: workflow.id }, orderBy: { createdAt: "desc" } }))?.id;

    const run = await this.db.$transaction(async (tx) => {
      const run = await tx.missionRun.create({
        data: {
          organizationId,
          workflowId: workflow.id,
          workflowVersionId: version.id,
          missionId: mission,
          mode: input.mode === "live" ? "LIVE" : "DRY_RUN",
          triggeredById: input.actor.type === "user" ? input.actor.id : null,
          apiKeyId: input.actor.type === "api_key" ? input.actor.id : null,
          budgetUsd: sub?.runBudgetUsd ?? Number(process.env.ORBIX_RUN_BUDGET_USD ?? 1),
        },
      });
      await tx.taskRun.createMany({
        data: def.nodes.map((n) => ({
          organizationId,
          runId: run.id,
          nodeKey: n.id,
          title: n.title,
          agentKey: n.agent,
          action: n.action,
          risk: n.risk,
          dependsOn: n.dependsOn,
          status: n.dependsOn.length === 0 ? ("READY" as const) : ("PENDING" as const),
          maxAttempts: n.retry.maxAttempts,
        })),
      });
      await emitRunEvent(tx, organizationId, run.id, "run.created", { mode: run.mode, version: version.version });
      return run;
    });
    await appendAudit(this.db, {
      organizationId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: "run.created",
      targetType: "run",
      targetId: run.id,
      data: { workflowId: workflow.id, version: version.version, mode: run.mode },
    });
    return run;
  }

  async pause(organizationId: string, runId: string, actor: Actor) {
    return this.transitionRun(organizationId, runId, actor, "PAUSED", ["QUEUED", "RUNNING", "WAITING_APPROVAL", "NEEDS_ATTENTION"]);
  }

  async resume(organizationId: string, runId: string, actor: Actor) {
    const run = await this.transitionRun(organizationId, runId, actor, "RUNNING", ["PAUSED"]);
    await this.withRunLock(runId, (tx) => this.refreshRun(tx, runId));
    return run;
  }

  async cancel(organizationId: string, runId: string, actor: Actor) {
    const run = await this.getRun(organizationId, runId);
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.status)) throw new EngineError("conflict", `Run is already ${run.status}`);
    await this.withRunLock(runId, async (tx) => {
      await tx.taskRun.updateMany({
        where: { runId, status: { notIn: TERMINAL_TASK as TaskStatus[] } },
        data: { status: "CANCELLED", leaseOwner: null, leaseExpiresAt: null, finishedAt: new Date() },
      });
      await tx.approvalRequest.updateMany({ where: { runId, status: "PENDING" }, data: { status: "INVALIDATED", comment: "Run cancelled" } });
      await tx.missionRun.update({ where: { id: runId }, data: { status: "CANCELLED", finishedAt: new Date(), outcome: "failed" } });
      await emitRunEvent(tx, organizationId, runId, "run.status", { status: "CANCELLED" });
    });
    await this.audit(organizationId, actor, "run.cancelled", runId);
    return this.getRun(organizationId, runId);
  }

  /** Manual retry: failed/dead-lettered tasks go back to READY; skipped descendants to PENDING. */
  async retry(organizationId: string, runId: string, actor: Actor) {
    const run = await this.getRun(organizationId, runId);
    if (run.status !== "FAILED" && run.status !== "NEEDS_ATTENTION") throw new EngineError("conflict", "Only failed runs can be retried");
    await this.withRunLock(runId, async (tx) => {
      await tx.taskRun.updateMany({
        where: { runId, status: { in: ["FAILED", "DEAD_LETTER"] } },
        data: { status: "READY", attempt: 0, error: Prisma.DbNull, failureClass: null, nextAttemptAt: null, approvalId: null, input: Prisma.DbNull, finishedAt: null },
      });
      await tx.taskRun.updateMany({ where: { runId, status: "SKIPPED" }, data: { status: "PENDING" } });
      await tx.missionRun.update({ where: { id: runId }, data: { status: "RUNNING", finishedAt: null, outcome: "pending", error: null } });
      await this.promote(tx, runId);
      await emitRunEvent(tx, organizationId, runId, "run.status", { status: "RUNNING", reason: "manual_retry" });
    });
    await this.audit(organizationId, actor, "run.retried", runId);
    return this.getRun(organizationId, runId);
  }

  /** Manual reconciliation for ambiguous writes. `mark_not_sent` is an operator assertion and is audited. */
  async reconcileTask(organizationId: string, runId: string, taskRunId: string, actor: Actor, resolution: "auto" | "mark_not_sent") {
    const task = await this.db.taskRun.findFirst({ where: { id: taskRunId, runId, organizationId } });
    if (!task) throw new EngineError("not_found", "Task not found");
    if (task.status !== "NEEDS_RECONCILIATION") throw new EngineError("conflict", "Task does not need reconciliation");
    if (resolution === "mark_not_sent") {
      await this.withRunLock(runId, async (tx) => {
        await tx.taskRun.update({ where: { id: task.id }, data: { status: "READY", attempt: Math.max(0, task.attempt - 1) } });
        await this.refreshRun(tx, runId);
      });
      await this.audit(organizationId, actor, "task.reconciled.mark_not_sent", runId, { taskRunId });
      return { found: false };
    }
    const found = await this.autoReconcile(task);
    await this.audit(organizationId, actor, "task.reconciled.auto", runId, { taskRunId, found });
    return { found };
  }

  // ═════════════════════════════ Approvals ═════════════════════════════

  async decideApproval(input: {
    organizationId: string;
    approvalId: string;
    actor: Actor & { roleKey?: string };
    decision: "approve" | "reject";
    payloadHash: string;
    comment?: string;
  }) {
    const a = await this.db.approvalRequest.findFirst({ where: { id: input.approvalId, organizationId: input.organizationId } });
    if (!a) throw new EngineError("not_found", "Approval not found");
    if (a.status !== "PENDING") throw new EngineError("conflict", `Approval is ${a.status.toLowerCase()}`);
    if (a.expiresAt.getTime() <= Date.now()) {
      await this.expireApproval(a.id);
      throw new EngineError("gone", "Approval expired; the step has been failed and can be retried");
    }
    if (input.payloadHash !== a.payloadHash) {
      throw new EngineError("conflict", "The payload you reviewed is not the current payload. Reload and review again.");
    }
    if (a.approverRole && !["owner", "admin", a.approverRole].includes(input.actor.roleKey ?? "")) {
      throw new EngineError("forbidden", `Requires the ${a.approverRole} role`);
    }

    await this.withRunLock(a.runId, async (tx) => {
      const claimed = await tx.approvalRequest.updateMany({
        where: { id: a.id, status: "PENDING" },
        data: { status: input.decision === "approve" ? "APPROVED" : "REJECTED", decidedById: input.actor.id, decidedAt: new Date(), comment: input.comment },
      });
      if (claimed.count !== 1) throw new EngineError("conflict", "Approval was decided concurrently");
      if (input.decision === "approve") {
        await tx.taskRun.update({ where: { id: a.taskRunId }, data: { status: "READY" } });
      } else {
        await tx.taskRun.update({
          where: { id: a.taskRunId },
          data: { status: "FAILED", failureClass: "permanent", error: json({ message: "Rejected by approver", comment: input.comment ?? null }), finishedAt: new Date() },
        });
        await this.skipDescendants(tx, a.runId);
      }
      await emitRunEvent(tx, a.organizationId, a.runId, "approval.decided", { approvalId: a.id, decision: input.decision });
      await this.refreshRun(tx, a.runId);
    });
    await this.audit(input.organizationId, input.actor, `approval.${input.decision === "approve" ? "approved" : "rejected"}`, a.runId, {
      approvalId: a.id,
      payloadHash: a.payloadHash,
      comment: input.comment,
    });
    await this.afterRunChange(a.runId);
  }

  /** Editing the payload invalidates the current approval and issues a new one bound to the new hash. */
  async requestChanges(input: { organizationId: string; approvalId: string; actor: Actor; payload: Record<string, unknown>; comment?: string }) {
    const a = await this.db.approvalRequest.findFirst({ where: { id: input.approvalId, organizationId: input.organizationId } });
    if (!a) throw new EngineError("not_found", "Approval not found");
    if (a.status !== "PENDING") throw new EngineError("conflict", `Approval is ${a.status.toLowerCase()}`);
    const task = await this.db.taskRun.findUniqueOrThrow({ where: { id: a.taskRunId } });
    const cap = getCapability(task.action)!;
    for (const key of Object.keys(input.payload)) {
      if (!(key in cap.inputs)) throw new EngineError("invalid", `"${key}" is not an input of ${cap.id}`);
    }
    const oldPayload = a.payload as { action: string; target: unknown; input: Record<string, unknown> };
    const newInput = { ...oldPayload.input, ...input.payload };
    for (const [key, spec] of Object.entries(cap.inputs)) {
      if (spec.required && (newInput[key] === undefined || newInput[key] === "")) throw new EngineError("invalid", `"${key}" is required`);
    }
    const newPayload = { ...oldPayload, input: newInput };
    const newHash = hashPayload(newPayload);

    const created = await this.db.$transaction(async (tx) => {
      await tx.approvalRequest.update({ where: { id: a.id }, data: { status: "INVALIDATED", comment: input.comment ?? "Payload changed", decidedAt: new Date(), decidedById: input.actor.id } });
      const next = await tx.approvalRequest.create({
        data: {
          organizationId: a.organizationId,
          runId: a.runId,
          taskRunId: a.taskRunId,
          action: a.action,
          targetAccount: a.targetAccount,
          payload: json(newPayload),
          payloadHash: newHash,
          reason: a.reason,
          consequences: a.consequences,
          evidence: json({ ...(a.evidence as object), revisedFrom: a.id }),
          approverRole: a.approverRole,
          expiresAt: a.expiresAt,
        },
      });
      await tx.taskRun.update({ where: { id: task.id }, data: { input: json(newInput), approvalId: next.id } });
      await emitRunEvent(tx, a.organizationId, a.runId, "approval.requested", { approvalId: next.id, revisedFrom: a.id });
      return next;
    });
    await this.audit(input.organizationId, input.actor, "approval.changes_requested", a.runId, { from: a.id, to: created.id, oldHash: a.payloadHash, newHash });
    return created;
  }

  // ═════════════════════════════ Worker ═════════════════════════════

  /** Claims up to `limit` runnable tasks with SKIP LOCKED and executes them concurrently. */
  async tick(limit = 4): Promise<number> {
    const ids = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE "TaskRun" SET status = 'RUNNING'::"TaskStatus",
             "leaseOwner" = ${this.d.workerId},
             "leaseExpiresAt" = now() + make_interval(secs => ${this.d.leaseMs / 1000}),
             attempt = attempt + 1,
             "startedAt" = COALESCE("startedAt", now()),
             "updatedAt" = now()
       WHERE id IN (
         SELECT t.id FROM "TaskRun" t JOIN "MissionRun" r ON r.id = t."runId"
          WHERE (t.status = 'READY' OR (t.status = 'RETRY_SCHEDULED' AND t."nextAttemptAt" <= now()))
            AND r.status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL')
          ORDER BY t."createdAt"
          LIMIT ${limit}
          FOR UPDATE OF t SKIP LOCKED)
      RETURNING id`;
    if (ids.length === 0) return 0;
    const tasks = await this.db.taskRun.findMany({ where: { id: { in: ids.map((r) => r.id) } } });
    await Promise.all(tasks.map((t) => this.execute(t)));
    return tasks.length;
  }

  /** Periodic maintenance: lost leases, expired approvals, pending reconciliations. */
  async maintenance(): Promise<{ recovered: number; expired: number; reconciled: number }> {
    let recovered = 0;
    const lost = await this.db.taskRun.findMany({ where: { status: "RUNNING", leaseExpiresAt: { lt: new Date() } }, take: 50 });
    for (const t of lost) {
      const open = await this.db.toolExecution.findFirst({ where: { taskRunId: t.id, status: "STARTED" }, orderBy: { createdAt: "desc" } });
      const cap = getCapability(t.action);
      const run = await this.db.missionRun.findUniqueOrThrow({ where: { id: t.runId }, include: { version: true } });
      const node = (run.version.definition as unknown as WorkflowDefinition).nodes.find((n) => n.id === t.nodeKey)!;
      if (open) await this.db.toolExecution.update({ where: { id: open.id }, data: { status: open && cap && !cap.idempotent ? "AMBIGUOUS" : "FAILED", error: "Worker lease lost" } });
      const cls = open && cap && !cap.idempotent ? "ambiguous" : "transient";
      await this.handleFailure(t, run, node, new ExecutionError(cls, "Worker lease expired during execution"));
      recovered++;
    }

    let expired = 0;
    const stale = await this.db.approvalRequest.findMany({ where: { status: "PENDING", expiresAt: { lt: new Date() } }, take: 50 });
    for (const a of stale) {
      await this.expireApproval(a.id);
      expired++;
    }

    let reconciled = 0;
    const pending = await this.db.taskRun.findMany({ where: { status: "NEEDS_RECONCILIATION", updatedAt: { lt: new Date(Date.now() - 30_000) } }, take: 20 });
    for (const t of pending) if (await this.autoReconcile(t)) reconciled++;
    return { recovered, expired, reconciled };
  }

  // ═════════════════════════════ Task execution ═════════════════════════════

  private async execute(task: TaskRun): Promise<void> {
    const run = await this.db.missionRun.findUnique({ where: { id: task.runId }, include: { version: true } });
    if (!run) return;
    if (run.status === "CANCELLED") {
      await this.db.taskRun.update({ where: { id: task.id }, data: { status: "CANCELLED", leaseOwner: null } });
      return;
    }
    if (run.status === "PAUSED") {
      await this.db.taskRun.update({ where: { id: task.id }, data: { status: "READY", attempt: task.attempt - 1, leaseOwner: null, leaseExpiresAt: null } });
      return;
    }
    if (run.status === "QUEUED") {
      await this.db.missionRun.updateMany({ where: { id: run.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date() } });
      await emitRunEvent(this.db, run.organizationId, run.id, "run.status", { status: "RUNNING" });
    }
    const def = run.version.definition as unknown as WorkflowDefinition;
    const node = def.nodes.find((n) => n.id === task.nodeKey);
    if (!node) {
      await this.handleFailure(task, run, def.nodes[0]!, new ExecutionError("permanent", "Node missing from workflow version"));
      return;
    }
    await emitRunEvent(this.db, run.organizationId, run.id, "task.status", { taskRunId: task.id, nodeKey: node.id, status: "RUNNING", attempt: task.attempt });

    try {
      const outputs = await this.collectOutputs(run.id);
      // After an approval (or requested changes) the bound input is authoritative; otherwise resolve templates.
      const input = (task.approvalId && task.input ? task.input : resolveTemplates(node.inputs, outputs)) as Record<string, unknown>;
      const decision = await authorizeToolCall(this.db, { organizationId: run.organizationId, runMode: run.mode, node });

      if (node.approval.required || approvalRequiredFor(node.risk)) {
        const payload = { action: node.action, target: { provider: decision.capability.provider, connectionId: decision.connectionId ?? null, label: decision.targetLabel }, input };
        const ok = await this.approvalGate(task, run, def, node, decision, payload, input);
        if (!ok) return;
      }

      const payloadHash = hashPayload({ action: node.action, input });
      const idempotencyKey = sha256(`${run.id}:${node.id}:${payloadHash}`);
      if (task.idempotencyKey !== idempotencyKey) {
        await this.db.taskRun.update({ where: { id: task.id }, data: { idempotencyKey } });
      }

      // An earlier attempt with this key may have landed: reconcile before sending again.
      const prior = await this.db.toolExecution.findFirst({ where: { idempotencyKey, status: { in: ["STARTED", "AMBIGUOUS"] } } });
      if (prior && decision.connector?.reconcile) {
        const r = await decision.connector.reconcile(node.action, input, this.connectorCtx(run, decision, idempotencyKey, node.timeoutMs));
        if (r.found) {
          await this.db.toolExecution.update({ where: { id: prior.id }, data: { status: "RECONCILED", externalId: r.externalId, responseRedacted: json(redact(r.output ?? {})) } });
          await this.completeTask(task, run, node, r.output ?? {}, { reconciled: true });
          return;
        }
      }

      const result = await this.invoke(task, run, node, decision, input, idempotencyKey, outputs);
      if (node.successCondition && !checkCondition(result.output, node.successCondition)) {
        throw new ExecutionError(node.agent === "verification" ? "transient" : "permanent", `Success condition not met: ${node.successCondition.path} ${node.successCondition.op}`);
      }
      await this.completeTask(task, run, node, result.output, {});
    } catch (e) {
      await this.handleFailure(task, run, node, e);
    }
  }

  private connectorCtx(run: MissionRun, decision: PolicyDecision, idempotencyKey: string, timeoutMs: number) {
    const { broker } = this.d;
    return {
      organizationId: run.organizationId,
      connectionId: decision.connectionId ?? "",
      mode: decision.connectionMode ?? "sandbox",
      idempotencyKey,
      timeoutMs,
      prisma: this.db,
      getAccessToken: () => broker.getAccessToken(run.organizationId, decision.connectionId ?? ""),
    } as const;
  }

  private async invoke(
    task: TaskRun,
    run: MissionRun,
    node: WorkflowNode,
    decision: PolicyDecision,
    input: Record<string, unknown>,
    idempotencyKey: string,
    outputs: Record<string, unknown>,
  ): Promise<{ output: Record<string, unknown> }> {
    const cap = decision.capability;
    const started = Date.now();
    const te = await this.db.toolExecution.create({
      data: {
        organizationId: run.organizationId,
        runId: run.id,
        taskRunId: task.id,
        capability: cap.id,
        provider: cap.provider,
        connectionId: decision.connectionId,
        mode: decision.connectionMode ?? (cap.provider === "ai" ? "model" : "internal"),
        attempt: task.attempt,
        idempotencyKey,
        status: "STARTED",
        requestRedacted: json(redact(input)),
      },
    });
    try {
      let output: Record<string, unknown>;
      let usage = { model: null as string | null, tokensIn: 0, tokensOut: 0, costUsd: 0 };
      let externalId: string | undefined;
      let apiCalls = 0;

      if (cap.provider === "ai") {
        const fresh = await this.db.missionRun.findUniqueOrThrow({ where: { id: run.id }, select: { costUsd: true, budgetUsd: true } });
        if (fresh.costUsd >= fresh.budgetUsd) throw new ExecutionError("permanent", `Run budget of $${fresh.budgetUsd.toFixed(2)} exhausted`);
        const res = await withTimeout(
          executeAiCapability(cap.id, input, { model: this.d.model, agent: getAgent(node.agent)!, timeoutMs: node.timeoutMs, upstream: outputs }),
          node.timeoutMs,
          false,
        );
        output = res.output;
        usage = { ...res.usage, model: res.usage.model };
        if (res.findings.length) {
          await emitRunEvent(this.db, run.organizationId, run.id, "security.injection_detected", { nodeKey: node.id, findings: res.findings });
          await appendAudit(this.db, { organizationId: run.organizationId, actorType: "agent", actorId: node.agent, action: "security.injection_detected", targetType: "run", targetId: run.id, data: { nodeKey: node.id, findings: res.findings } });
        }
      } else if (cap.provider === "knowledge") {
        const results = await searchKnowledge(this.db, this.d.model, { organizationId: run.organizationId, query: String(input.query), limit: Number(input.limit ?? 5) });
        output = { results: results.map((r) => ({ ...r, ref: `${r.title} v${r.version}`, url: r.sourceUrl ?? `orbix://knowledge/${r.documentId}`, body: r.content })) };
      } else {
        const res: InvokeResult = await withTimeout(
          decision.connector!.invoke(cap.id, input, this.connectorCtx(run, decision, idempotencyKey, node.timeoutMs)),
          node.timeoutMs + 2_000,
          !cap.idempotent,
        );
        output = res.output;
        externalId = res.externalId;
        apiCalls = res.apiCalls;
      }

      await this.db.toolExecution.update({
        where: { id: te.id },
        data: {
          status: "SUCCEEDED",
          responseRedacted: json(redact(output)),
          externalId,
          model: usage.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          costUsd: usage.costUsd,
          latencyMs: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      await this.db.usageRecord.create({
        data: {
          organizationId: run.organizationId,
          runId: run.id,
          taskRunId: task.id,
          kind: cap.provider === "ai" ? "model" : "tool",
          model: usage.model,
          provider: cap.provider,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          costUsd: usage.costUsd,
        },
      });
      if (usage.costUsd || usage.tokensIn || usage.tokensOut) {
        await this.db.missionRun.update({
          where: { id: run.id },
          data: { costUsd: { increment: usage.costUsd }, tokensIn: { increment: usage.tokensIn }, tokensOut: { increment: usage.tokensOut } },
        });
      }
      await emitRunEvent(this.db, run.organizationId, run.id, "tool.called", {
        nodeKey: node.id,
        capability: cap.id,
        mode: decision.connectionMode ?? cap.provider,
        latencyMs: Date.now() - started,
        externalId,
        apiCalls,
        model: usage.model,
      });
      return { output };
    } catch (e) {
      const cls = e instanceof ExecutionError ? e.failureClass : "permanent";
      await this.db.toolExecution.update({
        where: { id: te.id },
        data: { status: cls === "ambiguous" ? "AMBIGUOUS" : "FAILED", error: (e as Error).message.slice(0, 1000), latencyMs: Date.now() - started, finishedAt: new Date() },
      });
      throw e;
    }
  }

  /**
   * Approval binding: an approval authorises exactly one payload hash. If the payload or target
   * changed since approval, or the approval expired, a fresh approval is requested.
   */
  private async approvalGate(
    task: TaskRun,
    run: MissionRun,
    def: WorkflowDefinition,
    node: WorkflowNode,
    decision: PolicyDecision,
    payload: Record<string, unknown>,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    const hash = hashPayload(payload);
    if (task.approvalId) {
      const a = await this.db.approvalRequest.findUnique({ where: { id: task.approvalId } });
      if (a && (a.status === "APPROVED" || a.status === "CONSUMED")) {
        const valid = a.payloadHash === hash && a.expiresAt.getTime() > Date.now();
        if (valid) {
          if (a.status === "APPROVED") {
            await this.db.approvalRequest.update({ where: { id: a.id }, data: { status: "CONSUMED", consumedAt: new Date() } });
          }
          return true;
        }
        const reason = a.payloadHash !== hash ? "payload_changed" : "expired";
        await this.db.approvalRequest.update({ where: { id: a.id }, data: { status: reason === "expired" ? "EXPIRED" : "INVALIDATED" } });
        await appendAudit(this.db, { organizationId: run.organizationId, actorType: "system", action: `approval.${reason}`, targetType: "run", targetId: run.id, data: { approvalId: a.id, approvedHash: a.payloadHash, currentHash: hash } });
      }
    }

    const evidence = await this.collectEvidence(run.id, run.mode);
    const cap = decision.capability;
    const approval = await this.withRunLock(run.id, async (tx) => {
      const created = await tx.approvalRequest.create({
        data: {
          organizationId: run.organizationId,
          runId: run.id,
          taskRunId: task.id,
          action: cap.title,
          targetAccount: decision.targetLabel,
          payload: json(payload),
          payloadHash: hash,
          reason: node.description ?? `Step "${node.title}" in "${def.name}" — objective: ${def.objective.slice(0, 300)}`,
          consequences: cap.sideEffect ?? `Performs ${cap.risk.replace("_", " ")} action ${cap.id}`,
          evidence: json(evidence),
          approverRole: node.approval.approverRole ?? null,
          expiresAt: new Date(Date.now() + node.approval.expiresInMinutes * 60_000),
        },
      });
      await tx.taskRun.update({
        where: { id: task.id },
        data: { status: "WAITING_APPROVAL", approvalId: created.id, input: json(input), attempt: Math.max(0, task.attempt - 1), leaseOwner: null, leaseExpiresAt: null },
      });
      await emitRunEvent(tx, run.organizationId, run.id, "approval.requested", { approvalId: created.id, nodeKey: node.id });
      await emitRunEvent(tx, run.organizationId, run.id, "task.status", { taskRunId: task.id, nodeKey: node.id, status: "WAITING_APPROVAL" });
      await this.refreshRun(tx, run.id);
      return created;
    });
    await appendAudit(this.db, { organizationId: run.organizationId, actorType: "system", action: "approval.requested", targetType: "run", targetId: run.id, data: { approvalId: approval.id, payloadHash: hash, nodeKey: node.id } });
    void deliverWebhooks(this.db, run.organizationId, "approval.requested", { approvalId: approval.id, runId: run.id, action: cap.id }, this.d.log);
    return false;
  }

  private async collectEvidence(runId: string, mode: string) {
    const tasks = await this.db.taskRun.findMany({ where: { runId, status: "SUCCEEDED" }, orderBy: { finishedAt: "asc" } });
    const sources = new Set<string>();
    for (const t of tasks) {
      const out = (t.output ?? {}) as Record<string, unknown>;
      for (const c of (out.citations as string[] | undefined) ?? []) sources.add(c);
      for (const s of (out.summaries as Array<{ source?: string }> | undefined) ?? []) if (s.source) sources.add(s.source);
    }
    const injections = await this.db.runEvent.findMany({ where: { runId, type: "security.injection_detected" } });
    return {
      mode,
      sources: [...sources],
      upstream: tasks.map((t) => ({ nodeKey: t.nodeKey, title: t.title, action: t.action })),
      injectionWarnings: injections.flatMap((e) => ((e.data as { findings?: unknown[] }).findings ?? []) as unknown[]),
    };
  }

  private async collectOutputs(runId: string): Promise<Record<string, unknown>> {
    const done = await this.db.taskRun.findMany({ where: { runId, status: "SUCCEEDED" }, select: { nodeKey: true, output: true } });
    return Object.fromEntries(done.map((t) => [t.nodeKey, t.output]));
  }

  private async completeTask(task: TaskRun, run: MissionRun, node: WorkflowNode, output: Record<string, unknown>, meta: { reconciled?: boolean }) {
    await this.withRunLock(run.id, async (tx) => {
      await tx.taskRun.update({
        where: { id: task.id },
        data: { status: "SUCCEEDED", output: json(output), error: Prisma.DbNull, failureClass: null, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
      });
      const seq = (await tx.executionCheckpoint.count({ where: { runId: run.id } })) + 1;
      const done = await tx.taskRun.findMany({ where: { runId: run.id, status: "SUCCEEDED" }, select: { nodeKey: true, output: true } });
      await tx.executionCheckpoint.create({
        data: { organizationId: run.organizationId, runId: run.id, taskRunId: task.id, sequence: seq, state: json({ completed: Object.fromEntries(done.map((t) => [t.nodeKey, t.output])) }) },
      });
      await emitRunEvent(tx, run.organizationId, run.id, "task.status", { taskRunId: task.id, nodeKey: node.id, status: "SUCCEEDED", ...meta });
      await this.promote(tx, run.id);
      await this.refreshRun(tx, run.id);
    });
    await this.afterRunChange(run.id);
  }

  private async handleFailure(task: TaskRun, run: MissionRun, node: WorkflowNode, e: unknown) {
    const err = e instanceof ExecutionError ? e : new ExecutionError("permanent", (e as Error)?.message ?? "Unknown error");
    const decision = decideRetry({ failureClass: err.failureClass, attempt: task.attempt, policy: node.retry, retryAfterMs: err.details.retryAfterMs });
    this.d.log?.("task.failed", { runId: run.id, node: node.id, attempt: task.attempt, class: err.failureClass, decision: decision.action, message: err.message });
    const error = json({ message: err.message, class: err.failureClass, attempt: task.attempt, ...err.details });

    let status: TaskStatus;
    await this.withRunLock(run.id, async (tx) => {
      const base = { failureClass: err.failureClass, error, leaseOwner: null, leaseExpiresAt: null };
      switch (decision.action) {
        case "retry":
          status = "RETRY_SCHEDULED";
          await tx.taskRun.update({ where: { id: task.id }, data: { ...base, status, nextAttemptAt: new Date(Date.now() + decision.delayMs) } });
          break;
        case "reconcile":
          status = "NEEDS_RECONCILIATION";
          await tx.taskRun.update({ where: { id: task.id }, data: { ...base, status } });
          break;
        case "dead_letter":
          status = "DEAD_LETTER";
          await tx.taskRun.update({ where: { id: task.id }, data: { ...base, status, finishedAt: new Date() } });
          await this.skipDescendants(tx, run.id);
          break;
        default:
          status = "FAILED";
          await tx.taskRun.update({ where: { id: task.id }, data: { ...base, status, finishedAt: new Date() } });
          await this.skipDescendants(tx, run.id);
      }
      await emitRunEvent(tx, run.organizationId, run.id, "task.status", { taskRunId: task.id, nodeKey: node.id, status, error: err.message, failureClass: err.failureClass });
      await this.refreshRun(tx, run.id);
    });
    if (decision.action === "reconcile") {
      const fresh = await this.db.taskRun.findUniqueOrThrow({ where: { id: task.id } });
      await this.autoReconcile(fresh);
    }
    await this.afterRunChange(run.id);
  }

  /** Asks the provider whether an ambiguous write landed. Returns true if resolved as delivered. */
  private async autoReconcile(task: TaskRun): Promise<boolean> {
    const run = await this.db.missionRun.findUniqueOrThrow({ where: { id: task.runId }, include: { version: true } });
    const node = (run.version.definition as unknown as WorkflowDefinition).nodes.find((n) => n.id === task.nodeKey)!;
    let decision: PolicyDecision;
    try {
      decision = await authorizeToolCall(this.db, { organizationId: run.organizationId, runMode: run.mode, node });
    } catch {
      return false;
    }
    if (!decision.connector?.reconcile || !task.idempotencyKey) return false;
    const input = (task.input ?? resolveTemplates(node.inputs, await this.collectOutputs(run.id))) as Record<string, unknown>;
    let result;
    try {
      result = await decision.connector.reconcile(node.action, input, this.connectorCtx(run, decision, task.idempotencyKey, node.timeoutMs));
    } catch (e) {
      this.d.log?.("reconcile.error", { taskRunId: task.id, message: (e as Error).message });
      return false;
    }
    await emitRunEvent(this.db, run.organizationId, run.id, "task.reconciled", { nodeKey: node.id, found: result.found });
    if (result.found) {
      await this.db.toolExecution.updateMany({ where: { idempotencyKey: task.idempotencyKey, status: { in: ["AMBIGUOUS", "STARTED"] } }, data: { status: "RECONCILED", externalId: result.externalId } });
      await this.completeTask(task, run, node, result.output ?? {}, { reconciled: true });
      return true;
    }
    // Confirmed not delivered: safe to retry with the same idempotency key if attempts remain.
    await this.withRunLock(run.id, async (tx) => {
      const next: TaskStatus = task.attempt < node.retry.maxAttempts ? "READY" : "DEAD_LETTER";
      await tx.taskRun.update({ where: { id: task.id }, data: { status: next, ...(next === "DEAD_LETTER" ? { finishedAt: new Date() } : {}) } });
      if (next === "DEAD_LETTER") await this.skipDescendants(tx, run.id);
      await this.refreshRun(tx, run.id);
    });
    await this.afterRunChange(run.id);
    return false;
  }

  private async expireApproval(approvalId: string) {
    const a = await this.db.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    await this.withRunLock(a.runId, async (tx) => {
      const n = await tx.approvalRequest.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: "EXPIRED" } });
      if (n.count === 0) return;
      await tx.taskRun.updateMany({
        where: { id: a.taskRunId, status: "WAITING_APPROVAL" },
        data: { status: "FAILED", failureClass: "permanent", error: json({ message: "Approval expired" }), finishedAt: new Date() },
      });
      await this.skipDescendants(tx, a.runId);
      await emitRunEvent(tx, a.organizationId, a.runId, "approval.expired", { approvalId: a.id });
      await this.refreshRun(tx, a.runId);
    });
    await appendAudit(this.db, { organizationId: a.organizationId, actorType: "system", action: "approval.expired", targetType: "run", targetId: a.runId, data: { approvalId: a.id } });
    await this.afterRunChange(a.runId);
  }

  // ═════════════════════════════ Graph & status helpers ═════════════════════════════

  /** Serialises state changes per run so dependency promotion never races between workers. */
  private async withRunLock<T>(runId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"run:" + runId}))`;
      return fn(tx);
    });
  }

  private async promote(tx: Prisma.TransactionClient, runId: string) {
    const tasks = await tx.taskRun.findMany({ where: { runId }, select: { id: true, nodeKey: true, status: true, dependsOn: true } });
    const done = new Set(tasks.filter((t) => t.status === "SUCCEEDED").map((t) => t.nodeKey));
    const ready = tasks.filter((t) => t.status === "PENDING" && t.dependsOn.every((d) => done.has(d)));
    if (ready.length) await tx.taskRun.updateMany({ where: { id: { in: ready.map((t) => t.id) } }, data: { status: "READY" } });
  }

  private async skipDescendants(tx: Prisma.TransactionClient, runId: string) {
    const tasks = await tx.taskRun.findMany({ where: { runId }, select: { id: true, nodeKey: true, status: true, dependsOn: true } });
    const blocked = new Set(tasks.filter((t) => ["FAILED", "DEAD_LETTER", "CANCELLED", "SKIPPED"].includes(t.status)).map((t) => t.nodeKey));
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of tasks) {
        if (t.status === "PENDING" && !blocked.has(t.nodeKey) && t.dependsOn.some((d) => blocked.has(d))) {
          blocked.add(t.nodeKey);
          t.status = "SKIPPED";
          changed = true;
        }
      }
    }
    const skip = tasks.filter((t) => t.status === "SKIPPED").map((t) => t.id);
    if (skip.length) await tx.taskRun.updateMany({ where: { id: { in: skip }, status: "PENDING" }, data: { status: "SKIPPED" } });
  }

  /** Derives run status from task states and finalises outcome on completion. */
  private async refreshRun(tx: Prisma.TransactionClient, runId: string) {
    const run = await tx.missionRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status === "PAUSED" || run.status === "CANCELLED" || run.status === "SUCCEEDED") return;
    const tasks = await tx.taskRun.findMany({ where: { runId } });
    const has = (s: TaskStatus) => tasks.some((t) => t.status === s);
    const active = tasks.some((t) => ACTIVE.includes(t.status));
    const allTerminal = tasks.every((t) => TERMINAL_TASK.includes(t.status));

    let next: RunStatus;
    if (allTerminal) next = tasks.every((t) => t.status === "SUCCEEDED") ? "SUCCEEDED" : "FAILED";
    else if (active) next = "RUNNING";
    else if (has("WAITING_APPROVAL")) next = "WAITING_APPROVAL";
    else if (has("NEEDS_RECONCILIATION")) next = "NEEDS_ATTENTION";
    else next = "FAILED";

    if (next === run.status) return;
    if (!canTransitionRun(run.status, next) && !(run.status === "QUEUED" && next !== "RUNNING")) {
      this.d.log?.("run.transition_blocked", { runId, from: run.status, to: next });
      return;
    }

    const data: Prisma.MissionRunUpdateInput = { status: next };
    if (next === "SUCCEEDED" || next === "FAILED") {
      data.finishedAt = new Date();
      Object.assign(data, await this.computeOutcome(tx, runId, next));
      if (next === "FAILED") {
        const failed = tasks.find((t) => t.status === "FAILED" || t.status === "DEAD_LETTER");
        data.error = failed ? `${failed.title}: ${(failed.error as { message?: string } | null)?.message ?? failed.status}` : "Run failed";
      }
    }
    await tx.missionRun.update({ where: { id: runId }, data });
    await emitRunEvent(tx, run.organizationId, runId, "run.status", { status: next });
  }

  private async computeOutcome(tx: Prisma.TransactionClient, runId: string, status: RunStatus) {
    const tasks = await tx.taskRun.findMany({ where: { runId } });
    const minutes = tasks.filter((t) => t.status === "SUCCEEDED").reduce((m, t) => m + (MINUTES_SAVED[t.action] ?? 0), 0);
    if (status !== "SUCCEEDED") return { outcome: "failed", estimatedMinutesSaved: 0 };

    const writes = tasks.filter((t) => {
      const cap = getCapability(t.action);
      return cap && isExternalProvider(cap.provider) && isWrite(cap.risk);
    });
    const execs = await tx.toolExecution.findMany({ where: { runId, status: { in: ["SUCCEEDED", "RECONCILED"] } } });
    const ack = writes.map((w) => {
      const e = execs.find((x) => x.taskRunId === w.id && x.externalId);
      const out = (w.output ?? {}) as Record<string, unknown>;
      return { nodeKey: w.nodeKey, externalId: e?.externalId ?? null, permalink: out.permalink ?? out.url ?? null };
    });
    const verifications = tasks
      .filter((t) => t.agentKey === "verification")
      .map((t) => ({ nodeKey: t.nodeKey, verified: (t.output as { verified?: boolean } | null)?.verified === true, evidence: (t.output as { evidence?: unknown } | null)?.evidence ?? null }));

    let outcome = "completed";
    if (writes.length) {
      const allAck = ack.every((a) => a.externalId);
      if (!allAck) outcome = "unverified";
      else if (verifications.length && verifications.every((v) => v.verified)) outcome = "verified";
      else if (verifications.some((v) => !v.verified)) outcome = "unverified";
      else outcome = "acknowledged";
    }
    return { outcome, estimatedMinutesSaved: minutes, outcomeEvidence: json({ writes: ack, verifications }) };
  }

  private async afterRunChange(runId: string) {
    const run = await this.db.missionRun.findUnique({ where: { id: runId } });
    if (!run || (run.status !== "SUCCEEDED" && run.status !== "FAILED")) return;
    const already = await this.db.runEvent.findFirst({ where: { runId, type: "run.finalized" } });
    if (already) return;
    await emitRunEvent(this.db, run.organizationId, runId, "run.finalized", { status: run.status, outcome: run.outcome });
    await appendAudit(this.db, {
      organizationId: run.organizationId,
      actorType: "system",
      action: run.status === "SUCCEEDED" ? "run.succeeded" : "run.failed",
      targetType: "run",
      targetId: run.id,
      data: { outcome: run.outcome, costUsd: run.costUsd, error: run.error },
    });
    void deliverWebhooks(this.db, run.organizationId, run.status === "SUCCEEDED" ? "run.completed" : "run.failed", { runId, status: run.status, outcome: run.outcome }, this.d.log);
  }

  private async transitionRun(organizationId: string, runId: string, actor: Actor, to: RunStatus, from: RunStatus[]) {
    const run = await this.getRun(organizationId, runId);
    if (!from.includes(run.status)) throw new EngineError("conflict", `Cannot move a ${run.status} run to ${to}`);
    await this.db.missionRun.update({ where: { id: runId }, data: { status: to } });
    await emitRunEvent(this.db, organizationId, runId, "run.status", { status: to });
    await this.audit(organizationId, actor, `run.${to.toLowerCase()}`, runId);
    return this.getRun(organizationId, runId);
  }

  private async getRun(organizationId: string, runId: string) {
    const run = await this.db.missionRun.findFirst({ where: { id: runId, organizationId } });
    if (!run) throw new EngineError("not_found", "Run not found");
    return run;
  }

  private audit(organizationId: string, actor: Actor, action: string, runId: string, data?: unknown) {
    return appendAudit(this.db, { organizationId, actorType: actor.type, actorId: actor.id, action, targetType: "run", targetId: runId, data });
  }
}

export function checkCondition(output: Record<string, unknown>, cond: SuccessCondition): boolean {
  const v = getPath(output, cond.path.split("."));
  switch (cond.op) {
    case "exists":
      return v !== undefined && v !== null;
    case "nonEmpty":
      return Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.length > 0 : v !== undefined && v !== null;
    case "equals":
      return v === cond.value;
    case "gte":
      return typeof v === "number" && v >= Number(cond.value);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, write: boolean): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExecutionError(write ? "ambiguous" : "transient", `Step timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
