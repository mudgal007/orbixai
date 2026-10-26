import type { PrismaClient } from "@orbix/db";

/**
 * `tick()` claims runnable tasks across every org, so leftovers from earlier tests (some leave tasks
 * runnable on purpose) would be picked up by later ones. Cancel anything still claimable so each test
 * starts from a quiet queue. Waiting-for-approval runs are left alone; they are never claimable.
 */
export async function quiesceQueue(prisma: PrismaClient): Promise<void> {
  await prisma.taskRun.updateMany({ where: { status: { in: ["PENDING", "READY", "RUNNING", "RETRY_SCHEDULED"] } }, data: { status: "CANCELLED", leaseOwner: null, leaseExpiresAt: null } });
  await prisma.missionRun.updateMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED" } });
  await prisma.workflowSchedule.updateMany({ where: { enabled: true }, data: { enabled: false, nextRunAt: null } });
}
