"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDollarSign, Clock, Info, Lock, Play, Plug, ShieldAlert, XCircle, Zap } from "lucide-react";
import type { SimulationReport } from "@orbix/core";
import { MissionGraph } from "@/components/mission-graph";
import { PageHeader } from "@/components/page-header";
import { RunDialog } from "@/components/run-dialog";
import { RiskBadge } from "@/components/status";
import { Badge, Button, Card, ErrorState, Skeleton, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { duration, num, usd } from "@/lib/format";
import { useOrg } from "@/lib/hooks";
import type { Workflow } from "@/lib/types";

export default function SimulatePage() {
  const { id } = useParams<{ id: string }>();
  const { orgId, can } = useOrg();
  const [running, setRunning] = useState<"dry_run" | "live" | null>(null);
  const wf = useQuery({ queryKey: ["workflow", orgId, id], queryFn: () => api<{ workflow: Workflow; versions: Array<{ id: string; version: number }>; draftMatchesLatest: boolean }>(`/orgs/${orgId}/workflows/${id}`) });
  const sim = useQuery({
    queryKey: ["simulate", orgId, id],
    queryFn: () => api<{ report: SimulationReport; model: { name: string; heuristic: boolean } }>(`/orgs/${orgId}/workflows/${id}/simulate`, { method: "POST" }),
  });

  if (sim.error) return <ErrorState error={sim.error} onRetry={() => sim.refetch()} />;
  if (!sim.data || !wf.data) return <Skeleton className="h-[70vh]" />;
  const { report, model } = sim.data;
  const latest = wf.data.versions[0];
  const runnable = !!latest && wf.data.draftMatchesLatest;

  return (
    <div>
      <PageHeader
        eyebrow={<Link href={`/app/workflows/${id}`} className="hover:text-ink-2">← {wf.data.workflow.name}</Link>}
        title="Simulation"
        description="Plan Preview: validation, execution path, permissions, cost and side effects — computed without any external calls."
        actions={
          can("run:execute") && (
            <>
              {!runnable && <span className="text-xs text-warn">Publish the current draft to run it</span>}
              <Button icon={<Play className="size-4" />} disabled={!runnable || !report.readiness.dryRun} onClick={() => setRunning("dry_run")}>
                Dry run
              </Button>
              <Button variant="danger" icon={<Zap className="size-4" />} disabled={!runnable || !report.readiness.live} onClick={() => setRunning("live")}>
                Run live
              </Button>
            </>
          )
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Card className="flex items-center gap-3 p-4 xl:col-span-1">
          {report.readiness.live ? <CheckCircle2 className="size-8 text-good" /> : report.readiness.dryRun ? <AlertTriangle className="size-8 text-warn" /> : <XCircle className="size-8 text-critical" />}
          <div>
            <div className="text-sm font-semibold">{report.readiness.live ? "Ready for live" : report.readiness.dryRun ? "Dry run only" : "Not runnable"}</div>
            <div className="text-[11px] text-ink-3">{report.valid ? "Graph is valid" : "Fix validation errors"}</div>
          </div>
        </Card>
        <Stat label="Estimated model cost" value={usd(report.totals.costUsd)} hint={model.heuristic ? "heuristic model: $0 actual" : `model ${model.name}, upper bound`} icon={<CircleDollarSign className="size-4" />} />
        <Stat label="Provider API calls" value={num(report.totals.apiCalls)} hint="upper bound incl. retries" icon={<Plug className="size-4" />} />
        <Stat label="External writes" value={report.totals.externalWrites} hint={`${report.totals.approvals} approval checkpoint(s)`} icon={<Lock className="size-4" />} tone="warn" />
        <Stat label="Worst-case duration" value={duration(report.totals.worstCaseDurationMs)} hint="timeouts × attempts on the critical path" icon={<Clock className="size-4" />} />
      </div>

      {(report.readiness.blockers.length > 0 || report.warnings.length > 0) && (
        <div className="mb-4 grid gap-3 lg:grid-cols-2">
          {report.readiness.blockers.length > 0 && (
            <Card className="border-critical/30 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-critical"><ShieldAlert className="size-4" /> Blockers for live execution</h3>
              <ul className="mt-2 space-y-1 text-xs text-ink-2">{report.readiness.blockers.map((b) => <li key={b}>• {b}</li>)}</ul>
              <Link href="/app/integrations" className="mt-3 inline-flex items-center gap-1 text-xs text-indigo hover:underline">Manage integrations <ArrowRight className="size-3" /></Link>
            </Card>
          )}
          {report.warnings.length > 0 && (
            <Card className="border-warn/30 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-warn"><AlertTriangle className="size-4" /> Side effects &amp; warnings</h3>
              <ul className="mt-2 space-y-1 text-xs text-ink-2">{report.warnings.map((w) => <li key={w}>• {w}</li>)}</ul>
            </Card>
          )}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card className="h-[460px] overflow-hidden">
          <MissionGraph definition={wf.data.workflow.draft} />
        </Card>
        <Card className="overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h3 className="text-sm font-semibold">Expected execution path</h3>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
              {report.executionPath.map((level, i) => (
                <span key={i} className="inline-flex items-center gap-1.5">
                  {i > 0 && <ArrowRight className="size-3 text-ink-3" />}
                  <span className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-ink-2">{level.join(" ∥ ")}</span>
                </span>
              ))}
            </div>
          </div>
          <ul className="max-h-[400px] divide-y divide-line overflow-y-auto">
            {report.steps.map((s) => (
              <li key={s.nodeId} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{s.title}</span>
                  <RiskBadge risk={s.risk} />
                  {s.approvalRequired && <Badge tone="warn" icon={<Lock className="size-3" />}>Approval</Badge>}
                  <ConnectionBadge c={s.connection} />
                  <span className="ml-auto text-[11px] text-ink-3">{s.estimatedApiCalls} calls · {usd(s.estimatedCostUsd)}</span>
                </div>
                {s.sideEffect && <p className="mt-1.5 text-xs text-warn">{s.sideEffect}</p>}
                <ul className="mt-1.5 space-y-0.5 text-[11px] text-ink-3">{s.failureScenarios.map((f) => <li key={f}>↳ {f}</li>)}</ul>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {report.issues.length > 0 && (
        <Card className="mt-4 p-4">
          <h3 className="text-sm font-semibold">Validation</h3>
          <ul className="mt-2 space-y-1 text-xs">{report.issues.map((i, k) => <li key={k} className={i.severity === "error" ? "text-critical" : "text-warn"}>{i.nodeId && <span className="font-mono">{i.nodeId}: </span>}{i.message}</li>)}</ul>
        </Card>
      )}
      <p className="mt-4 flex items-start gap-2 text-[11px] leading-5 text-ink-3"><Info className="mt-0.5 size-3.5 shrink-0" /> {report.disclaimer}</p>
      {running && latest && <RunDialog orgId={orgId!} workflowId={id} versionLabel={`v${latest.version}`} defaultMode={running} onClose={() => setRunning(null)} />}
    </div>
  );
}

function ConnectionBadge({ c }: { c: SimulationReport["steps"][number]["connection"] }) {
  if (c.status === "internal") return <Badge>internal</Badge>;
  if (c.status === "ok") return <Badge tone={c.mode === "live" ? "good" : "cyan"}>{c.mode} connection</Badge>;
  if (c.status === "missing_scopes") return <Badge tone="critical">missing {c.missingScopes?.join(", ")}</Badge>;
  return <Badge tone="critical">{c.status === "missing" ? "not connected" : "connection unhealthy"}</Badge>;
}
