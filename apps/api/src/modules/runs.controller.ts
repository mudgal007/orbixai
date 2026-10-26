import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ApprovalDecisionSchema, CreateRunSchema, RequestChangesSchema, TERMINAL_RUN, type RunStatus } from "@orbix/core";
import type { PrismaClient } from "@orbix/db";
import type { ExecutionEngine } from "@orbix/engine";
import type { Response } from "express";
import { Auth, RequirePermission, actorOf, type AuthContext, type OrbixRequest } from "../common/context";
import { ENGINE, PRISMA } from "../common/tokens";
import { ZodPipe } from "../common/zod.pipe";

const ReconcileSchema = z.object({ resolution: z.enum(["auto", "mark_not_sent"]).default("auto") });
const ListRunsSchema = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

@ApiTags("runs")
@Controller("orgs/:orgId")
export class RunsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENGINE) private readonly engine: ExecutionEngine,
  ) {}

  @Post("workflows/:id/runs")
  @RequirePermission("run:execute")
  async create(@Param("orgId") orgId: string, @Param("id") id: string, @Auth() auth: AuthContext, @Body(new ZodPipe(CreateRunSchema)) body: { mode: "dry_run" | "live"; versionId?: string }) {
    const run = await this.engine.createRun({ organizationId: orgId, workflowId: id, versionId: body.versionId, mode: body.mode, actor: actorOf(auth) });
    return { run };
  }

  @Get("runs")
  @RequirePermission("workflow:read")
  async list(@Param("orgId") orgId: string, @Query(new ZodPipe(ListRunsSchema)) q: { status?: string; limit: number }) {
    const runs = await this.prisma.missionRun.findMany({
      where: { organizationId: orgId, ...(q.status ? { status: q.status as RunStatus } : {}) },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: { workflow: { select: { id: true, name: true } }, version: { select: { version: true } }, _count: { select: { tasks: true } } },
    });
    return { runs };
  }

  @Get("runs/:runId")
  @RequirePermission("workflow:read")
  async get(@Param("orgId") orgId: string, @Param("runId") runId: string) {
    const run = await this.prisma.missionRun.findFirst({
      where: { id: runId, organizationId: orgId },
      include: {
        workflow: { select: { id: true, name: true } },
        version: { select: { version: true, definition: true } },
        mission: { select: { objective: true, planner: true } },
        tasks: { orderBy: { createdAt: "asc" } },
        toolExecutions: { orderBy: { createdAt: "asc" } },
        approvals: { orderBy: { requestedAt: "desc" } },
      },
    });
    if (!run) throw new NotFoundException("Run not found");
    return { run };
  }

  /**
   * Server-Sent Events stream of RunEvent rows. Supports Last-Event-ID for resumption.
   * Events are read from Postgres, so updates from any worker process reach any API instance.
   */
  @Get("runs/:runId/events")
  @RequirePermission("workflow:read")
  async events(@Param("orgId") orgId: string, @Param("runId") runId: string, @Req() req: OrbixRequest, @Res() res: Response) {
    const run = await this.prisma.missionRun.findFirst({ where: { id: runId, organizationId: orgId }, select: { id: true } });
    if (!run) throw new NotFoundException("Run not found");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    let lastId = BigInt(String(req.headers["last-event-id"] ?? (req.query as Record<string, string>).after ?? "0").replace(/\D/g, "") || "0");
    let closed = false;
    let lastBeat = Date.now();
    req.on("close", () => {
      closed = true;
    });
    while (!closed) {
      const rows = await this.prisma.runEvent.findMany({ where: { runId, organizationId: orgId, id: { gt: lastId } }, orderBy: { id: "asc" }, take: 200 });
      for (const e of rows) {
        res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ type: e.type, data: e.data, at: e.createdAt })}\n\n`);
        lastId = e.id;
      }
      if (Date.now() - lastBeat > 15_000) {
        res.write(": keepalive\n\n");
        lastBeat = Date.now();
      }
      if (rows.some((r) => r.type === "run.finalized")) {
        const current = await this.prisma.missionRun.findUnique({ where: { id: runId }, select: { status: true } });
        if (current && TERMINAL_RUN.includes(current.status)) break;
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    res.end();
  }

  @Post("runs/:runId/pause")
  @HttpCode(200)
  @RequirePermission("run:execute")
  pause(@Param("orgId") orgId: string, @Param("runId") runId: string, @Auth() auth: AuthContext) {
    return this.engine.pause(orgId, runId, actorOf(auth));
  }

  @Post("runs/:runId/resume")
  @HttpCode(200)
  @RequirePermission("run:execute")
  resume(@Param("orgId") orgId: string, @Param("runId") runId: string, @Auth() auth: AuthContext) {
    return this.engine.resume(orgId, runId, actorOf(auth));
  }

  @Post("runs/:runId/cancel")
  @HttpCode(200)
  @RequirePermission("run:execute")
  cancel(@Param("orgId") orgId: string, @Param("runId") runId: string, @Auth() auth: AuthContext) {
    return this.engine.cancel(orgId, runId, actorOf(auth));
  }

  @Post("runs/:runId/retry")
  @HttpCode(200)
  @RequirePermission("run:execute")
  retry(@Param("orgId") orgId: string, @Param("runId") runId: string, @Auth() auth: AuthContext) {
    return this.engine.retry(orgId, runId, actorOf(auth));
  }

  @Post("runs/:runId/tasks/:taskRunId/reconcile")
  @HttpCode(200)
  @RequirePermission("run:execute")
  reconcile(@Param("orgId") orgId: string, @Param("runId") runId: string, @Param("taskRunId") taskRunId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(ReconcileSchema)) body: { resolution: "auto" | "mark_not_sent" }) {
    return this.engine.reconcileTask(orgId, runId, taskRunId, actorOf(auth), body.resolution);
  }

  // ───────────── Approval inbox ─────────────

  @Get("approvals")
  @RequirePermission("workflow:read")
  async approvals(@Param("orgId") orgId: string, @Query("status") status?: string) {
    const approvals = await this.prisma.approvalRequest.findMany({
      where: { organizationId: orgId, ...(status ? { status: status.toUpperCase() } : {}) },
      orderBy: { requestedAt: "desc" },
      take: 100,
      include: { run: { select: { id: true, mode: true, status: true, workflow: { select: { id: true, name: true } } } } },
    });
    return { approvals };
  }

  @Get("approvals/:approvalId")
  @RequirePermission("workflow:read")
  async approval(@Param("orgId") orgId: string, @Param("approvalId") approvalId: string) {
    const approval = await this.prisma.approvalRequest.findFirst({
      where: { id: approvalId, organizationId: orgId },
      include: { run: { select: { id: true, mode: true, status: true, workflow: { select: { id: true, name: true } } } } },
    });
    if (!approval) throw new NotFoundException("Approval not found");
    return { approval };
  }

  @Post("approvals/:approvalId/decision")
  @HttpCode(200)
  @RequirePermission("approval:decide")
  async decide(@Param("orgId") orgId: string, @Param("approvalId") approvalId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(ApprovalDecisionSchema)) body: { decision: "approve" | "reject"; payloadHash: string; comment?: string }) {
    await this.engine.decideApproval({ organizationId: orgId, approvalId, actor: actorOf(auth), ...body });
    return { ok: true };
  }

  @Post("approvals/:approvalId/request-changes")
  @HttpCode(200)
  @RequirePermission("approval:decide")
  async requestChanges(@Param("orgId") orgId: string, @Param("approvalId") approvalId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(RequestChangesSchema)) body: { payload: Record<string, unknown>; comment?: string }) {
    const approval = await this.engine.requestChanges({ organizationId: orgId, approvalId, actor: actorOf(auth), ...body });
    return { approval };
  }
}
