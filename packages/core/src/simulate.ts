import { getCapability, isExternalProvider } from "./capabilities";
import { modelCostUsd } from "./cost";
import { approvalRequiredFor, isNeverAutoRetry, isWrite, type RiskLevel } from "./risk";
import { topologicalLevels, validateWorkflow, type ValidationIssue } from "./validate";
import type { WorkflowDefinition } from "./workflow";

export interface ConnectionSummary {
  provider: string;
  mode: "sandbox" | "live";
  scopes: string[];
  status: "active" | "error" | "revoked";
}

export interface SimulatedStep {
  nodeId: string;
  title: string;
  agent: string;
  action: string;
  risk: RiskLevel;
  approvalRequired: boolean;
  provider: string;
  connection: { status: "internal" | "ok" | "missing" | "missing_scopes" | "unhealthy"; mode?: string; missingScopes?: string[] };
  estimatedApiCalls: number;
  estimatedTokensIn: number;
  estimatedTokensOut: number;
  estimatedCostUsd: number;
  maxDurationMs: number;
  sideEffect?: string;
  failureScenarios: string[];
}

export interface SimulationReport {
  mode: "plan_preview";
  valid: boolean;
  issues: ValidationIssue[];
  executionPath: string[][];
  steps: SimulatedStep[];
  totals: {
    apiCalls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    externalWrites: number;
    approvals: number;
    worstCaseDurationMs: number;
  };
  warnings: string[];
  readiness: { dryRun: boolean; live: boolean; blockers: string[] };
  disclaimer: string;
}

export function simulatePlan(
  def: WorkflowDefinition,
  connections: ConnectionSummary[],
  model: string,
): SimulationReport {
  const validation = validateWorkflow(def);
  const levels = topologicalLevels(def);
  const warnings: string[] = [];
  const blockers: string[] = [];

  const steps: SimulatedStep[] = def.nodes.map((node) => {
    const cap = getCapability(node.action);
    const provider = cap?.provider ?? "unknown";
    const tokensIn = cap?.estimate.tokensIn ?? 0;
    const tokensOut = cap?.estimate.tokensOut ?? 0;
    const attempts = node.retry.maxAttempts;

    let connection: SimulatedStep["connection"] = { status: "internal" };
    if (cap && isExternalProvider(cap.provider)) {
      const conn = connections.find((c) => c.provider === cap.provider && c.status === "active");
      const unhealthy = connections.find((c) => c.provider === cap.provider && c.status !== "active");
      if (!conn) {
        connection = { status: unhealthy ? "unhealthy" : "missing" };
        blockers.push(`${node.title}: no active ${cap.provider} connection`);
      } else {
        const missing = conn.mode === "live" ? cap.scopes.filter((s) => !conn.scopes.includes(s)) : [];
        connection = missing.length
          ? { status: "missing_scopes", mode: conn.mode, missingScopes: missing }
          : { status: "ok", mode: conn.mode };
        if (missing.length) blockers.push(`${node.title}: ${cap.provider} connection lacks ${missing.join(", ")}`);
      }
    }

    const failureScenarios: string[] = [];
    if (cap) {
      if (cap.provider !== "ai") failureScenarios.push(`Provider error or timeout after ${node.timeoutMs / 1000}s`);
      if (cap.provider === "ai") failureScenarios.push("Model output fails schema validation → task fails, nothing is sent");
      if (attempts > 1) failureScenarios.push(`Transient failures retried up to ${attempts}× with jittered backoff`);
      else failureScenarios.push("Not retried automatically; failure stops dependent steps");
      if (!cap.idempotent && cap.reconcilable) {
        failureScenarios.push("If the outcome is ambiguous, provider state is reconciled before any retry");
      }
      if (isWrite(cap.risk)) failureScenarios.push("If the approved payload changes, the approval is invalidated");
      if (isNeverAutoRetry(cap.risk)) warnings.push(`${node.title}: ${cap.risk} action — never retried automatically`);
      if (cap.risk === "destructive") warnings.push(`${node.title}: destructive action, irreversible`);
    }

    return {
      nodeId: node.id,
      title: node.title,
      agent: node.agent,
      action: node.action,
      risk: node.risk,
      approvalRequired: node.approval.required || approvalRequiredFor(node.risk),
      provider,
      connection,
      estimatedApiCalls: (cap?.estimate.apiCalls ?? 0) * attempts,
      estimatedTokensIn: tokensIn,
      estimatedTokensOut: tokensOut,
      estimatedCostUsd: modelCostUsd(model, tokensIn, tokensOut),
      maxDurationMs: node.timeoutMs * attempts + node.retry.maxBackoffMs * (attempts - 1),
      sideEffect: cap?.sideEffect,
      failureScenarios,
    };
  });

  const byId = new Map(steps.map((s) => [s.nodeId, s]));
  const worstCaseDurationMs = levels.reduce(
    (sum, level) => sum + Math.max(0, ...level.map((id) => byId.get(id)?.maxDurationMs ?? 0)),
    0,
  );
  const externalWrites = steps.filter((s) => isWrite(s.risk) && s.provider !== "ai").length;
  if (externalWrites > 0) {
    warnings.push(`${externalWrites} externally visible write(s); each pauses for approval before sending.`);
  }
  if (!validation.valid) blockers.unshift("Workflow has validation errors");

  return {
    mode: "plan_preview",
    valid: validation.valid,
    issues: validation.issues,
    executionPath: levels,
    steps,
    totals: {
      apiCalls: sum(steps, "estimatedApiCalls"),
      tokensIn: sum(steps, "estimatedTokensIn"),
      tokensOut: sum(steps, "estimatedTokensOut"),
      costUsd: sum(steps, "estimatedCostUsd"),
      externalWrites,
      approvals: steps.filter((s) => s.approvalRequired).length,
      worstCaseDurationMs,
    },
    warnings,
    readiness: {
      dryRun: validation.valid,
      live: validation.valid && blockers.length === 0,
      blockers,
    },
    disclaimer:
      "Plan preview performs no external calls. Estimates are upper bounds from capability metadata; " +
      "a dry run uses sandbox connectors and cannot fully predict live third-party behaviour.",
  };
}

function sum<K extends keyof SimulatedStep>(rows: SimulatedStep[], key: K): number {
  return rows.reduce((acc, r) => acc + (r[key] as number), 0);
}
