-- CreateEnum
CREATE TYPE "RunMode" AS ENUM ('DRY_RUN', 'LIVE');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'NEEDS_ATTENTION', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'READY', 'RUNNING', 'RETRY_SCHEDULED', 'WAITING_APPROVAL', 'NEEDS_RECONCILIATION', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ConnectionMode" AS ENUM ('SANDBOX', 'LIVE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],
    "system" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'developer',
    "status" TEXT NOT NULL DEFAULT 'active',
    "runBudgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "monthlyBudgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "currentPeriodEnd" TIMESTAMP(3),

    CONSTRAINT "BillingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "system" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "allowedCapabilities" TEXT[],
    "systemPrompt" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "draft" JSONB NOT NULL,
    "draftUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latestVersionId" TEXT,
    "createdById" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowNode" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "approvalRequired" BOOLEAN NOT NULL,
    "config" JSONB NOT NULL,

    CONSTRAINT "WorkflowNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowEdge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "fromKey" TEXT NOT NULL,
    "toKey" TEXT NOT NULL,

    CONSTRAINT "WorkflowEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "planner" TEXT NOT NULL,
    "plannerNotes" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "missionId" TEXT,
    "workflowId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "mode" "RunMode" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "outcomeEvidence" JSONB,
    "triggeredById" TEXT,
    "apiKeyId" TEXT,
    "error" TEXT,
    "budgetUsd" DOUBLE PRECISION NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "estimatedMinutesSaved" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MissionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "dependsOn" TEXT[],
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "error" JSONB,
    "failureClass" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "approvalId" TEXT,
    "idempotencyKey" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionCheckpoint" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolExecution" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "connectionId" TEXT,
    "mode" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestRedacted" JSONB NOT NULL,
    "responseRedacted" JSONB,
    "externalId" TEXT,
    "model" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "action" TEXT NOT NULL,
    "targetAccount" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "consequences" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "approverRole" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" BIGSERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "capabilities" TEXT[],

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mode" "ConnectionMode" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "scopes" TEXT[],
    "externalAccount" JSONB,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialReference" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encrypted" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifierEncrypted" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockProviderRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockProviderRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "data" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT,
    "taskRunId" TEXT,
    "kind" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secretEncrypted" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastStatus" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT NOT NULL,
    "supersedesId" TEXT,
    "createdById" TEXT,
    "retentionUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "embedding" DOUBLE PRECISION[],

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Role_organizationId_key_key" ON "Role"("organizationId", "key");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_organizationId_userId_key" ON "Membership"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_organizationId_idx" ON "ApiKey"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_organizationId_key" ON "BillingSubscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_organizationId_key_key" ON "Agent"("organizationId", "key");

-- CreateIndex
CREATE INDEX "AgentVersion_organizationId_idx" ON "AgentVersion"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentVersion_agentId_version_key" ON "AgentVersion"("agentId", "version");

-- CreateIndex
CREATE INDEX "Workflow_organizationId_createdAt_idx" ON "Workflow"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowVersion_organizationId_idx" ON "WorkflowVersion"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_version_key" ON "WorkflowVersion"("workflowId", "version");

-- CreateIndex
CREATE INDEX "WorkflowNode_organizationId_idx" ON "WorkflowNode"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowNode_workflowVersionId_nodeKey_key" ON "WorkflowNode"("workflowVersionId", "nodeKey");

-- CreateIndex
CREATE INDEX "WorkflowEdge_organizationId_idx" ON "WorkflowEdge"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowEdge_workflowVersionId_fromKey_toKey_key" ON "WorkflowEdge"("workflowVersionId", "fromKey", "toKey");

-- CreateIndex
CREATE INDEX "Mission_organizationId_createdAt_idx" ON "Mission"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MissionRun_organizationId_createdAt_idx" ON "MissionRun"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MissionRun_organizationId_status_idx" ON "MissionRun"("organizationId", "status");

-- CreateIndex
CREATE INDEX "TaskRun_status_nextAttemptAt_idx" ON "TaskRun"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "TaskRun_status_leaseExpiresAt_idx" ON "TaskRun"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "TaskRun_organizationId_idx" ON "TaskRun"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_runId_nodeKey_key" ON "TaskRun"("runId", "nodeKey");

-- CreateIndex
CREATE INDEX "ExecutionCheckpoint_organizationId_idx" ON "ExecutionCheckpoint"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionCheckpoint_runId_sequence_key" ON "ExecutionCheckpoint"("runId", "sequence");

-- CreateIndex
CREATE INDEX "ToolExecution_organizationId_createdAt_idx" ON "ToolExecution"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolExecution_idempotencyKey_idx" ON "ToolExecution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ToolExecution_runId_idx" ON "ToolExecution"("runId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_organizationId_status_idx" ON "ApprovalRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_taskRunId_idx" ON "ApprovalRequest"("taskRunId");

-- CreateIndex
CREATE INDEX "RunEvent_runId_id_idx" ON "RunEvent"("runId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_provider_key" ON "Integration"("provider");

-- CreateIndex
CREATE INDEX "Connection_organizationId_provider_idx" ON "Connection"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "CredentialReference_connectionId_key" ON "CredentialReference"("connectionId");

-- CreateIndex
CREATE INDEX "CredentialReference_organizationId_idx" ON "CredentialReference"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_stateHash_key" ON "OAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "MockProviderRecord_organizationId_provider_kind_idx" ON "MockProviderRecord"("organizationId", "provider", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "MockProviderRecord_organizationId_provider_kind_externalId_key" ON "MockProviderRecord"("organizationId", "provider", "kind", "externalId");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_createdAt_idx" ON "AuditEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_organizationId_seq_key" ON "AuditEvent"("organizationId", "seq");

-- CreateIndex
CREATE INDEX "UsageRecord_organizationId_createdAt_idx" ON "UsageRecord"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookSubscription_organizationId_idx" ON "WebhookSubscription"("organizationId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_organizationId_collection_idx" ON "KnowledgeDocument"("organizationId", "collection");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_organizationId_idx" ON "KnowledgeChunk"("organizationId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_documentId_idx" ON "KnowledgeChunk"("documentId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentVersion" ADD CONSTRAINT "AgentVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowNode" ADD CONSTRAINT "WorkflowNode_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowEdge" ADD CONSTRAINT "WorkflowEdge_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionRun" ADD CONSTRAINT "MissionRun_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionRun" ADD CONSTRAINT "MissionRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionRun" ADD CONSTRAINT "MissionRun_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MissionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionCheckpoint" ADD CONSTRAINT "ExecutionCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MissionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MissionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MissionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialReference" ADD CONSTRAINT "CredentialReference_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
