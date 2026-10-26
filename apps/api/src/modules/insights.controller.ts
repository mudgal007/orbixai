import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { verifyAuditChain, type PrismaClient } from "@orbix/db";
import { RequirePermission } from "../common/context";
import { PRISMA } from "../common/tokens";
import { ZodPipe } from "../common/zod.pipe";

const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional(), action: z.string().max(80).optional() });

@ApiTags("insights")
@Controller("orgs/:orgId")
export class InsightsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get("audit")
  @RequirePermission("audit:read")
  async audit(@Param("orgId") orgId: string, @Query(new ZodPipe(AuditQuery)) q: { limit: number; before?: number; action?: string }) {
    const events = await this.prisma.auditEvent.findMany({
      where: { organizationId: orgId, ...(q.before ? { seq: { lt: q.before } } : {}), ...(q.action ? { action: { startsWith: q.action } } : {}) },
      orderBy: { seq: "desc" },
      take: q.limit,
    });
    const userIds = [...new Set(events.filter((e) => e.actorType === "user" && e.actorId).map((e) => e.actorId!))];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } });
    return { events, actors: Object.fromEntries(users.map((u) => [u.id, u])) };
  }

  @Get("audit/verify")
  @RequirePermission("audit:read")
  verify(@Param("orgId") orgId: string) {
    return verifyAuditChain(this.prisma, orgId);
  }

  /** Every figure here is an aggregate over stored rows; nothing is sampled or synthesised. */
  @Get("analytics/summary")
  @RequirePermission("workflow:read")
  async summary(@Param("orgId") orgId: string, @Query("days") daysRaw?: string) {
    const days = Math.min(Math.max(Number(daysRaw) || 14, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000);
    const where = { organizationId: orgId, createdAt: { gte: since } };

    const [byStatus, byOutcome, totals, pendingApprovals, connections, runs, recentFailures, toolCalls, usageByModel] = await Promise.all([
      this.prisma.missionRun.groupBy({ by: ["status"], where, _count: true }),
      this.prisma.missionRun.groupBy({ by: ["outcome"], where, _count: true }),
      this.prisma.missionRun.aggregate({ where, _sum: { costUsd: true, tokensIn: true, tokensOut: true, estimatedMinutesSaved: true } }),
      this.prisma.approvalRequest.count({ where: { organizationId: orgId, status: "PENDING" } }),
      this.prisma.connection.findMany({ where: { organizationId: orgId, status: "ACTIVE" }, select: { provider: true, mode: true, label: true } }),
      this.prisma.missionRun.findMany({ where, select: { createdAt: true, status: true, startedAt: true, finishedAt: true, outcome: true } }),
      this.prisma.missionRun.findMany({ where: { organizationId: orgId, status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, error: true, createdAt: true, workflow: { select: { name: true } } } }),
      this.prisma.toolExecution.groupBy({ by: ["capability", "status"], where, _count: true, _avg: { latencyMs: true } }),
      this.prisma.usageRecord.groupBy({ by: ["model"], where: { ...where, kind: "model" }, _sum: { tokensIn: true, tokensOut: true, costUsd: true }, _count: true }),
    ]);

    const count = (rows: Array<{ _count: number }>) => rows.reduce((n, r) => n + r._count, 0);
    const finished = byStatus.filter((s) => s.status === "SUCCEEDED" || s.status === "FAILED");
    const succeeded = byStatus.find((s) => s.status === "SUCCEEDED")?._count ?? 0;
    const durations = runs.filter((r) => r.startedAt && r.finishedAt).map((r) => r.finishedAt!.getTime() - r.startedAt!.getTime());

    const series: Array<{ date: string; succeeded: number; failed: number; other: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const dayRuns = runs.filter((r) => r.createdAt.toISOString().slice(0, 10) === d);
      series.push({
        date: d,
        succeeded: dayRuns.filter((r) => r.status === "SUCCEEDED").length,
        failed: dayRuns.filter((r) => r.status === "FAILED").length,
        other: dayRuns.filter((r) => r.status !== "SUCCEEDED" && r.status !== "FAILED").length,
      });
    }

    return {
      windowDays: days,
      runs: {
        total: count(byStatus),
        byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
        successRate: count(finished) ? succeeded / count(finished) : null,
        avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      },
      outcomes: Object.fromEntries(byOutcome.map((o) => [o.outcome, o._count])),
      cost: { usd: totals._sum.costUsd ?? 0, tokensIn: totals._sum.tokensIn ?? 0, tokensOut: totals._sum.tokensOut ?? 0, byModel: usageByModel },
      estimatedMinutesSaved: totals._sum.estimatedMinutesSaved ?? 0,
      pendingApprovals,
      connections,
      series,
      recentFailures,
      tools: toolCalls.map((t) => ({ capability: t.capability, status: t.status, count: t._count, avgLatencyMs: Math.round(t._avg.latencyMs ?? 0) })),
    };
  }
}
