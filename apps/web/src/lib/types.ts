import type { SimulationReport, ValidationIssue, WorkflowDefinition } from "@orbix/core";

export type { SimulationReport, ValidationIssue, WorkflowDefinition };

export interface Me {
  kind: "user";
  user: { id: string; email: string; name: string };
  memberships: Array<{ organization: { id: string; name: string; slug: string }; role: string; permissions: string[] }>;
}

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  draft: WorkflowDefinition;
  latestVersionId: string | null;
  createdAt: string;
  draftUpdatedAt: string;
}

export interface TaskRun {
  id: string;
  nodeKey: string;
  title: string;
  agentKey: string;
  action: string;
  risk: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  input: unknown;
  output: Record<string, unknown> | null;
  error: { message?: string; class?: string } | null;
  failureClass: string | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  dependsOn: string[];
}

export interface ToolExecution {
  id: string;
  taskRunId: string;
  capability: string;
  provider: string;
  mode: string;
  attempt: number;
  status: string;
  requestRedacted: unknown;
  responseRedacted: unknown;
  externalId: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface Approval {
  id: string;
  runId: string;
  taskRunId: string;
  status: string;
  action: string;
  targetAccount: string;
  payload: { action: string; target: { provider: string; label: string; connectionId: string | null }; input: Record<string, unknown> };
  payloadHash: string;
  reason: string;
  consequences: string;
  evidence: {
    mode?: string;
    sources?: string[];
    upstream?: Array<{ nodeKey: string; title: string; action: string }>;
    injectionWarnings?: Array<{ source: string; kind: string; excerpt: string }>;
    revisedFrom?: string;
  };
  approverRole: string | null;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  comment: string | null;
  run?: { id: string; mode: string; status: string; workflow: { id: string; name: string } };
}

export interface Run {
  id: string;
  status: string;
  mode: "DRY_RUN" | "LIVE";
  outcome: string;
  outcomeEvidence: {
    writes?: Array<{ nodeKey: string; externalId: string | null; permalink: string | null }>;
    verifications?: Array<{ nodeKey: string; verified: boolean; evidence: unknown }>;
  } | null;
  error: string | null;
  costUsd: number;
  budgetUsd: number;
  tokensIn: number;
  tokensOut: number;
  estimatedMinutesSaved: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  workflow: { id: string; name: string };
  version: { version: number; definition?: WorkflowDefinition };
  mission?: { objective: string; planner: string } | null;
  tasks?: TaskRun[];
  toolExecutions?: ToolExecution[];
  approvals?: Approval[];
}
