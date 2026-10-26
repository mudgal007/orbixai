import { nextRun, nextRuns, type Trigger, type WorkflowDefinition } from "@orbix/core";
import { Prisma, appendAudit, type PrismaClient, type WorkflowSchedule } from "@orbix/db";
import { EngineError, type Actor, type ExecutionEngine } from "./engine";

const ACTIVE_RUN = ["QUEUED", "RUNNING", "WAITING_APPROVAL", "PAUSED", "NEEDS_ATTENTION"] as const;

export interface FireResult {
  scheduleId: string;
  workflowId: string;
  scheduledFor: Date;
  runId?: string;
  skipped?: string;
}

export interface ScheduleView extends WorkflowSchedule {
  upcoming: Date[];
}

/**
 * Cron triggers. A schedule mirrors the trigger of the workflow's latest published version and is
 * activated explicitly. Firing policy:
 *  - due schedules are claimed with FOR UPDATE SKIP LOCKED and their nextRunAt advanced in the same
 *    transaction, so concurrent workers never both fire a slot;
 *  - runs carry (scheduleId, scheduledFor), unique in the database, as a second guard;
 *  - missed slots (worker down) are not replayed: at most one run per wake-up, then the next future slot;
 *  - a slot is skipped while the previous scheduled run is still active (no pile-up).
 */
export class Scheduler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly engine: ExecutionEngine,
    private readonly log?: (msg: string, data?: Record<string, unknown>) => void,
  ) {}

  /** Called on publish: create/update the schedule from the version's trigger, or remove it. */
  async syncFromVersion(input: { organizationId: string; workflowId: string; workflowVersionId: string; trigger: Trigger; actor: Actor }): Promise<WorkflowSchedule | null> {
    const existing = await this.prisma.workflowSchedule.findUnique({ where: { workflowId: input.workflowId } });
    if (input.trigger.type !== "schedule") {
      if (existing) {
        await this.prisma.workflowSchedule.delete({ where: { id: existing.id } });
        await this.audit(input.organizationId, input.actor, "schedule.removed", input.workflowId, { reason: "trigger is no longer a schedule" });
      }
      return null;
    }
    const { cron, timezone } = input.trigger;
    const schedule = existing
      ? await this.prisma.workflowSchedule.update({
          where: { id: existing.id },
          data: { cron, timezone, workflowVersionId: input.workflowVersionId, nextRunAt: existing.enabled ? nextRun(cron, timezone) : null, lastError: null },
        })
      : await this.prisma.workflowSchedule.create({
          data: {
            organizationId: input.organizationId,
            workflowId: input.workflowId,
            workflowVersionId: input.workflowVersionId,
            cron,
            timezone,
            createdById: input.actor.type === "user" ? input.actor.id : null,
          },
        });
    if (!existing || existing.cron !== cron || existing.timezone !== timezone) {
      await this.audit(input.organizationId, input.actor, existing ? "schedule.updated" : "schedule.created", input.workflowId, { cron, timezone, enabled: schedule.enabled });
    }
    return schedule;
  }

  async get(organizationId: string, workflowId: string): Promise<ScheduleView | null> {
    const s = await this.prisma.workflowSchedule.findFirst({ where: { organizationId, workflowId } });
    return s ? { ...s, upcoming: nextRuns(s.cron, s.timezone, 3) } : null;
  }

  async list(organizationId: string) {
    return this.prisma.workflowSchedule.findMany({
      where: { organizationId },
      orderBy: [{ enabled: "desc" }, { nextRunAt: "asc" }],
      include: { workflow: { select: { id: true, name: true } } },
    });
  }

  /** Enable/disable or switch dry-run/live. Enabling live requires the workflow to be ready for live. */
  async update(input: { organizationId: string; workflowId: string; enabled?: boolean; mode?: "dry_run" | "live"; actor: Actor }): Promise<ScheduleView> {
    const s = await this.prisma.workflowSchedule.findFirst({ where: { organizationId: input.organizationId, workflowId: input.workflowId } });
    if (!s) throw new EngineError("not_found", "This workflow has no schedule. Set a schedule trigger and publish.");
    const enabled = input.enabled ?? s.enabled;
    const mode = input.mode ? (input.mode === "live" ? "LIVE" : "DRY_RUN") : s.mode;
    if (enabled && mode === "LIVE") {
      const version = await this.prisma.workflowVersion.findUniqueOrThrow({ where: { id: s.workflowVersionId } });
      const blockers = await this.engine.liveBlockers(input.organizationId, version.definition as unknown as WorkflowDefinition);
      if (blockers.length) throw new EngineError("invalid", "Workflow is not ready for scheduled live runs", blockers);
    }
    const updated = await this.prisma.workflowSchedule.update({
      where: { id: s.id },
      data: {
        enabled,
        mode,
        nextRunAt: enabled ? (s.enabled && s.nextRunAt ? s.nextRunAt : nextRun(s.cron, s.timezone)) : null,
        lastError: enabled && !s.enabled ? null : s.lastError,
      },
    });
    await this.audit(input.organizationId, input.actor, "schedule.settings_changed", input.workflowId, { enabled, mode });
    return { ...updated, upcoming: nextRuns(updated.cron, updated.timezone, 3) };
  }

  /** Fires every schedule that is due at `now`. Safe to call concurrently from many workers. */
  async fireDue(now: Date = new Date(), limit = 10): Promise<FireResult[]> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string; organizationId: string; workflowId: string; cron: string; timezone: string; mode: "DRY_RUN" | "LIVE"; nextRunAt: Date }>>`
        SELECT id, "organizationId", "workflowId", cron, timezone, mode, "nextRunAt"
          FROM "WorkflowSchedule"
         WHERE enabled AND "nextRunAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
         ORDER BY "nextRunAt"
         LIMIT ${limit}
           FOR UPDATE SKIP LOCKED`;
      for (const s of due) {
        await tx.workflowSchedule.update({ where: { id: s.id }, data: { nextRunAt: nextRun(s.cron, s.timezone, now), lastRunAt: now } });
      }
      return due;
    });

    const results: FireResult[] = [];
    for (const s of claimed) {
      const base = { scheduleId: s.id, workflowId: s.workflowId, scheduledFor: s.nextRunAt };
      const actor: Actor = { type: "system", id: `schedule:${s.id}` };
      try {
        const active = await this.prisma.missionRun.findFirst({ where: { scheduleId: s.id, status: { in: [...ACTIVE_RUN] } }, select: { id: true, status: true } });
        if (active) throw new EngineError("conflict", `Skipped: previous scheduled run is still ${active.status.toLowerCase().replace(/_/g, " ")}`);
        const run = await this.engine.createRun({
          organizationId: s.organizationId,
          workflowId: s.workflowId,
          mode: s.mode === "LIVE" ? "live" : "dry_run",
          actor,
          schedule: { id: s.id, scheduledFor: s.nextRunAt },
        });
        await this.prisma.workflowSchedule.update({ where: { id: s.id }, data: { lastRunId: run.id, lastError: null } });
        results.push({ ...base, runId: run.id });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          results.push({ ...base, skipped: "already fired" });
          continue;
        }
        const reason = e instanceof EngineError ? `${e.message}${Array.isArray(e.details) && typeof e.details[0] === "string" ? `: ${e.details.join("; ")}` : ""}` : (e as Error).message;
        await this.prisma.workflowSchedule.update({ where: { id: s.id }, data: { lastError: reason.slice(0, 500) } }).catch(() => undefined);
        await this.audit(s.organizationId, actor, "schedule.skipped", s.workflowId, { scheduledFor: s.nextRunAt, reason });
        this.log?.("schedule.skipped", { scheduleId: s.id, reason });
        results.push({ ...base, skipped: reason });
      }
    }
    return results;
  }

  private audit(organizationId: string, actor: Actor, action: string, workflowId: string, data: unknown) {
    return appendAudit(this.prisma, { organizationId, actorType: actor.type, actorId: actor.id, action, targetType: "workflow", targetId: workflowId, data });
  }
}
