import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, beforeEach } from "vitest";
import { CredentialBroker, seedGithubSandbox } from "@orbix/connectors";
import { bootstrapOrganization, getPrisma, type Prisma } from "@orbix/db";
import { hashPayload } from "@orbix/core/node";
import type { Trigger } from "@orbix/core";
import { ExecutionEngine, HeuristicModel, Scheduler, detectSchedule, planWorkflow } from "../src";
import { quiesceQueue } from "./helpers";

process.env.ORBIX_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const prisma = getPrisma();
const model = new HeuristicModel();
const engine = new ExecutionEngine({ prisma, model, broker: new CredentialBroker(prisma), workerId: "sched-test", leaseMs: 30_000 });
const scheduler = new Scheduler(prisma, engine);
const OBJECTIVE =
  "Every weekday morning, find GitHub issues assigned to me that have not been updated for seven days, summarize each issue, create a follow-up plan, and draft a Slack update for approval.";

beforeEach(() => quiesceQueue(prisma));
afterAll(() => prisma.$disconnect());

/** Org with sandbox connections and a published workflow whose trigger is a schedule. */
async function setup(name: string, trigger?: Trigger) {
  const user = await prisma.user.create({ data: { email: `${name}-${Date.now()}-${Math.random()}@test.dev`, name, passwordHash: "x" } });
  const org = await bootstrapOrganization(prisma, { name, ownerUserId: user.id });
  for (const provider of ["github", "slack"]) {
    await prisma.connection.create({ data: { organizationId: org.id, provider, label: `${provider} sandbox`, mode: "SANDBOX", scopes: [] } });
  }
  await seedGithubSandbox(prisma, org.id);
  const plan = await planWorkflow(OBJECTIVE, model);
  const definition = trigger ? { ...plan.definition, trigger } : plan.definition;
  const wf = await prisma.workflow.create({ data: { organizationId: org.id, name: definition.name, draft: definition as unknown as Prisma.InputJsonValue } });
  const v = await prisma.workflowVersion.create({
    data: { organizationId: org.id, workflowId: wf.id, version: 1, definition: definition as unknown as Prisma.InputJsonValue, definitionHash: hashPayload(definition) },
  });
  await prisma.workflow.update({ where: { id: wf.id }, data: { latestVersionId: v.id } });
  const actor = { type: "user" as const, id: user.id };
  const schedule = await scheduler.syncFromVersion({ organizationId: org.id, workflowId: wf.id, workflowVersionId: v.id, trigger: definition.trigger, actor });
  return { org, wf, v, actor, schedule, definition };
}

/** Make the schedule due right now without waiting for the clock. */
const makeDue = (scheduleId: string, at = new Date(Date.now() - 1000)) => prisma.workflowSchedule.update({ where: { id: scheduleId }, data: { nextRunAt: at } });
const runsFor = (scheduleId: string) => prisma.missionRun.findMany({ where: { scheduleId } });

describe("schedule detection in planning", () => {
  it("turns 'every weekday morning' into a valid weekday cron trigger", async () => {
    const plan = await planWorkflow(OBJECTIVE, model);
    expect(plan.definition.trigger).toEqual({ type: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" });
    expect(plan.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(plan.notes.join(" ")).toMatch(/Scheduled every weekday at 09:00/);
    expect(detectSchedule("Summarize stale issues")).toBeNull();
  });
});

describe("scheduler", () => {
  it("creates a paused schedule on publish and computes next run when activated", async () => {
    const { org, wf, actor, schedule } = await setup("sched-activate");
    expect(schedule).toMatchObject({ enabled: false, nextRunAt: null, mode: "DRY_RUN", cron: "0 9 * * 1-5" });

    const on = await scheduler.update({ organizationId: org.id, workflowId: wf.id, enabled: true, actor });
    expect(on.enabled).toBe(true);
    expect(on.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(on.upcoming).toHaveLength(3);
    expect([1, 2, 3, 4, 5]).toContain(on.nextRunAt!.getUTCDay());

    const off = await scheduler.update({ organizationId: org.id, workflowId: wf.id, enabled: false, actor });
    expect(off.nextRunAt).toBeNull();
  });

  it("fires a due slot exactly once even with concurrent workers, then advances to a future slot", async () => {
    const { org, wf, actor, schedule } = await setup("sched-once");
    await scheduler.update({ organizationId: org.id, workflowId: wf.id, enabled: true, actor });
    const slot = new Date(Date.now() - 1000);
    await makeDue(schedule!.id, slot);

    const workers = [1, 2, 3].map((i) => new Scheduler(prisma, new ExecutionEngine({ prisma, model, broker: new CredentialBroker(prisma), workerId: `w${i}`, leaseMs: 30_000 })));
    const results = (await Promise.all(workers.map((w) => w.fireDue()))).flat().filter((r) => r.scheduleId === schedule!.id);

    expect(results.filter((r) => r.runId)).toHaveLength(1);
    const runs = await runsFor(schedule!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.scheduledFor!.getTime()).toBe(slot.getTime());
    expect(runs[0]!.mode).toBe("DRY_RUN");

    const after = await prisma.workflowSchedule.findUniqueOrThrow({ where: { id: schedule!.id } });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after.lastRunId).toBe(runs[0]!.id);
    expect(after.lastError).toBeNull();

    // The scheduled run executes like any other run and pauses for approval before posting.
    for (let i = 0; i < 50 && (await engine.tick(8)) > 0; i++);
    expect((await prisma.missionRun.findUniqueOrThrow({ where: { id: runs[0]!.id } })).status).toBe("WAITING_APPROVAL");
  });

  it("skips a slot while the previous scheduled run is still active", async () => {
    const { org, wf, actor, schedule } = await setup("sched-overlap");
    await scheduler.update({ organizationId: org.id, workflowId: wf.id, enabled: true, actor });
    await makeDue(schedule!.id);
    await scheduler.fireDue();
    expect(await runsFor(schedule!.id)).toHaveLength(1);

    await makeDue(schedule!.id);
    const second = (await scheduler.fireDue()).find((r) => r.scheduleId === schedule!.id);
    expect(second?.skipped).toMatch(/previous scheduled run is still/);
    expect(await runsFor(schedule!.id)).toHaveLength(1);
    expect((await prisma.workflowSchedule.findUniqueOrThrow({ where: { id: schedule!.id } })).lastError).toMatch(/still/);
  });

  it("does not replay missed slots after downtime", async () => {
    const { org, wf, actor, schedule } = await setup("sched-missed", { type: "schedule", cron: "0 * * * *", timezone: "UTC" });
    await scheduler.update({ organizationId: org.id, workflowId: wf.id, enabled: true, actor });
    await makeDue(schedule!.id, new Date(Date.now() - 3 * 86_400_000)); // ~72 hourly slots missed
    await scheduler.fireDue();
    await scheduler.fireDue();
    expect(await runsFor(schedule!.id)).toHaveLength(1);
    const after = await prisma.workflowSchedule.findUniqueOrThrow({ where: { id: schedule!.id } });
    expect(after.nextRunAt!.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("never fires paused schedules", async () => {
    const { schedule } = await setup("sched-paused");
    await makeDue(schedule!.id);
    await scheduler.fireDue();
    expect(await runsFor(schedule!.id)).toHaveLength(0);
  });

  it("refuses to activate live mode when connections are missing, and records failures at fire time", async () => {
    const { org, wf, actor, schedule } = await setup("sched-live");
    await prisma.connection.updateMany({ where: { organizationId: org.id, provider: "slack" }, data: { status: "REVOKED" } });
    await expect(scheduler.update({ organizationId: org.id, workflowId: wf.id, enabled: true, mode: "live", actor })).rejects.toMatchObject({ code: "invalid" });

    // If it became unready after activation, the fire is skipped with the reason recorded.
    await prisma.workflowSchedule.update({ where: { id: schedule!.id }, data: { enabled: true, mode: "LIVE" } });
    await makeDue(schedule!.id);
    const r = (await scheduler.fireDue()).find((x) => x.scheduleId === schedule!.id);
    expect(r?.skipped).toMatch(/not ready for live/);
    expect(await runsFor(schedule!.id)).toHaveLength(0);
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: org.id, action: "schedule.skipped" } });
    expect(audit).not.toBeNull();
  });

  it("the database rejects a second run for the same slot", async () => {
    const { org, wf, schedule } = await setup("sched-unique");
    const slot = new Date("2030-01-01T09:00:00Z");
    await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "system" }, schedule: { id: schedule!.id, scheduledFor: slot } });
    await expect(
      engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "system" }, schedule: { id: schedule!.id, scheduledFor: slot } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("updates cron on republish and removes the schedule when the trigger becomes manual", async () => {
    const { org, wf, v, actor, schedule } = await setup("sched-sync");
    await scheduler.update({ organizationId: org.id, workflowId: wf.id, enabled: true, actor });
    const updated = await scheduler.syncFromVersion({ organizationId: org.id, workflowId: wf.id, workflowVersionId: v.id, trigger: { type: "schedule", cron: "30 7 * * *", timezone: "Asia/Kolkata" }, actor });
    expect(updated).toMatchObject({ id: schedule!.id, cron: "30 7 * * *", timezone: "Asia/Kolkata", enabled: true });
    expect(updated!.nextRunAt).not.toBeNull();

    expect(await scheduler.syncFromVersion({ organizationId: org.id, workflowId: wf.id, workflowVersionId: v.id, trigger: { type: "manual" }, actor })).toBeNull();
    expect(await prisma.workflowSchedule.findUnique({ where: { workflowId: wf.id } })).toBeNull();
  });
});

describe("timezone safety (test DB session TimeZone is Asia/Kolkata, UTC+5:30)", () => {
  it("does not fire a schedule whose UTC fire time is still in the future", async () => {
    const { org, wf, actor, schedule } = await setup("sched-tz");
    await scheduler.update({ organizationId: org.id, workflowId: wf.id, enabled: true, actor });
    await makeDue(schedule!.id, new Date(Date.now() + 2 * 3_600_000)); // 2h ahead: inside the +5:30 skew
    const fired = (await scheduler.fireDue()).filter((r) => r.scheduleId === schedule!.id);
    expect(fired).toEqual([]);
    expect(await runsFor(schedule!.id)).toHaveLength(0);
  });

  it("writes task leases and honours retry backoff in UTC", async () => {
    const { org, wf } = await setup("lease-tz");
    const run = await engine.createRun({ organizationId: org.id, workflowId: wf.id, mode: "dry_run", actor: { type: "system" } });
    const t = await prisma.taskRun.findFirstOrThrow({ where: { runId: run.id, nodeKey: "find_issues" } });
    // A retry due in 2h must not be claimable now.
    await prisma.taskRun.update({ where: { id: t.id }, data: { status: "RETRY_SCHEDULED", nextAttemptAt: new Date(Date.now() + 2 * 3_600_000) } });
    await engine.tick(50);
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("RETRY_SCHEDULED");

    // Once due, it is claimed and its lease expires ~leaseMs (30s) from now in UTC, not hours later.
    await prisma.taskRun.update({ where: { id: t.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const leaseEngine = new ExecutionEngine({ prisma, model, broker: new CredentialBroker(prisma), workerId: "lease", leaseMs: 30_000 });
    // Capture the claimed task instead of executing it, to read the lease the claim query wrote.
    let leaseSeen: Date | null = null;
    (leaseEngine as unknown as { execute: (task: { id: string; leaseExpiresAt: Date | null }) => Promise<void> }).execute = async (task) => {
      if (task.id === t.id) leaseSeen = task.leaseExpiresAt;
    };
    const before = Date.now();
    await leaseEngine.tick(50);
    expect(leaseSeen).not.toBeNull();
    const delta = leaseSeen!.getTime() - before;
    expect(delta).toBeGreaterThan(20_000);
    expect(delta).toBeLessThan(45_000);
  });
});
