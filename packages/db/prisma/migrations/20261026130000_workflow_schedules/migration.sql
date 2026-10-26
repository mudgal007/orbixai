-- AlterTable
ALTER TABLE "MissionRun" ADD COLUMN     "scheduleId" TEXT,
ADD COLUMN     "scheduledFor" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WorkflowSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "mode" "RunMode" NOT NULL DEFAULT 'DRY_RUN',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastRunId" TEXT,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowSchedule_workflowId_key" ON "WorkflowSchedule"("workflowId");

-- CreateIndex
CREATE INDEX "WorkflowSchedule_enabled_nextRunAt_idx" ON "WorkflowSchedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "WorkflowSchedule_organizationId_idx" ON "WorkflowSchedule"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MissionRun_scheduleId_scheduledFor_key" ON "MissionRun"("scheduleId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "WorkflowSchedule" ADD CONSTRAINT "WorkflowSchedule_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

