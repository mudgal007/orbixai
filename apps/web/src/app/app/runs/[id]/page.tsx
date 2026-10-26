"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, ChevronRight, CircleDollarSign, Clock, ExternalLink, Hourglass, Pause, Play, RotateCcw, ShieldAlert, ShieldCheck, Timer, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { MissionGraph } from "@/components/mission-graph";
import { ModeBadge, OutcomeBadge, StatusBadge, outcomeHelp } from "@/components/status";
import { Badge, Button, Card, ErrorState, JsonView, Skeleton, Tabs } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { duration, num, timeUntil, usd } from "@/lib/format";
import { useOrg } from "@/lib/hooks";
import type { Run, TaskRun } from "@/lib/types";

interface LiveEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED"];

export default function RunMonitor() {
  const { id } = useParams<{ id: string }>();
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["run", orgId, id], queryFn: () => api<{ run: Run }>(`/orgs/${orgId}/runs/${id}`) });
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"timeline" | "trace" | "outcome">("timeline");
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live updates over Server-Sent Events; each event triggers a debounced refetch of the run snapshot.
  useEffect(() => {
    if (!orgId) return;
    const es = new EventSource(`/api/v1/orgs/${orgId}/runs/${id}/events`, { withCredentials: true });
    const onEvent = (e: MessageEvent) => {
      const payload = JSON.parse(e.data) as Omit<LiveEvent, "id">;
      setEvents((prev) => (prev.some((p) => p.id === e.lastEventId) ? prev : [...prev, { id: e.lastEventId, ...payload }]));
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => qc.invalidateQueries({ queryKey: ["run", orgId, id] }), 150);
      if (payload.type.startsWith("approval")) qc.invalidateQueries({ queryKey: ["approvals"] });
    };
    for (const t of ["run.created", "run.status", "task.status", "tool.called", "approval.requested", "approval.decided", "approval.expired", "task.reconciled", "security.injection_detected", "run.finalized"]) {
      es.addEventListener(t, onEvent as EventListener);
    }
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => {
      es.close();
      setLive(false);
    };
  }, [orgId, id, qc]);

  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "cancel" | "retry") => api(`/orgs/${orgId}/runs/${id}/${action}`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["run", orgId, id] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });
  const reconcile = useMutation({
    mutationFn: (v: { taskId: string; resolution: "auto" | "mark_not_sent" }) => api<{ found: boolean }>(`/orgs/${orgId}/runs/${id}/tasks/${v.taskId}/reconcile`, { body: { resolution: v.resolution } }),
    onSuccess: (r) => {
      toast.info(r.found ? "Provider shows the action landed — marked delivered." : "Not found at provider; step will retry with the same idempotency key.");
      qc.invalidateQueries({ queryKey: ["run", orgId, id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reconcile failed"),
  });

  const run = q.data?.run;
  const statuses = useMemo(() => Object.fromEntries((run?.tasks ?? []).map((t) => [t.nodeKey, { status: t.status, attempt: t.attempt }])), [run?.tasks]);
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!run || !run.version.definition) return <Skeleton className="h-[70vh]" />;

  const tasks = run.tasks ?? [];
  const task = tasks.find((t) => t.nodeKey === selected);
  const pendingApproval = run.approvals?.find((a) => a.status === "PENDING");
  const elapsed = run.startedAt ? (run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now()) - new Date(run.startedAt).getTime() : null;
  const done = tasks.filter((t) => t.status === "SUCCEEDED").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="text-xs text-ink-3"><Link href="/app/runs" className="hover:text-ink-2">Runs</Link> / <span className="font-mono">{run.id}</span></div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{run.workflow.name}</h1>
            <Badge tone="indigo">v{run.version.version}</Badge>
            <ModeBadge mode={run.mode} />
            {run.scheduledFor && <Badge tone="cyan">Scheduled · {new Date(run.scheduledFor).toLocaleString()}</Badge>}
            <StatusBadge status={run.status} />
            <OutcomeBadge outcome={run.outcome} />
            <span className={cn("inline-flex items-center gap-1 text-[11px]", live ? "text-good" : "text-ink-3")}>{live ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}{live ? "live" : TERMINAL.includes(run.status) ? "final" : "reconnecting"}</span>
          </div>
          {run.mission && <p className="mt-1 line-clamp-1 text-xs text-ink-3">{run.mission.objective}</p>}
        </div>
        {can("run:execute") && (
          <div className="flex flex-wrap gap-2">
            {["QUEUED", "RUNNING", "WAITING_APPROVAL", "NEEDS_ATTENTION"].includes(run.status) && <Button size="sm" icon={<Pause className="size-3.5" />} onClick={() => control.mutate("pause")}>Pause</Button>}
            {run.status === "PAUSED" && <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => control.mutate("resume")}>Resume</Button>}
            {(run.status === "FAILED" || run.status === "NEEDS_ATTENTION") && <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => control.mutate("retry")}>Retry failed steps</Button>}
            {!TERMINAL.includes(run.status) && <Button size="sm" variant="danger" icon={<Ban className="size-3.5" />} onClick={() => confirm("Cancel this run? Pending approvals will be invalidated.") && control.mutate("cancel")}>Cancel</Button>}
          </div>
        )}
      </div>

      {pendingApproval && (
        <Card className="flex flex-col gap-3 border-warn/40 bg-warn/5 p-4 sm:flex-row sm:items-center">
          <Hourglass className="size-5 shrink-0 text-warn" />
          <div className="flex-1 text-sm">
            <span className="font-medium">{pendingApproval.action}</span> on <span className="text-ink-2">{pendingApproval.targetAccount}</span> is waiting for approval.
            <span className="ml-1 text-xs text-ink-3">Expires {timeUntil(pendingApproval.expiresAt)}</span>
          </div>
          <Link href={`/app/approvals?id=${pendingApproval.id}`} className="inline-flex h-9 items-center gap-1 rounded-lg bg-indigo-strong px-4 text-sm font-medium text-white hover:bg-indigo">
            Review exact payload <ChevronRight className="size-4" />
          </Link>
        </Card>
      )}
      {run.error && <div role="alert" className="rounded-xl border border-critical/30 bg-critical/8 px-4 py-3 text-sm text-critical">{run.error}</div>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MiniStat icon={<Timer className="size-4" />} label="Progress" value={`${done}/${tasks.length} steps`} />
        <MiniStat icon={<Clock className="size-4" />} label="Elapsed" value={duration(elapsed)} />
        <MiniStat icon={<CircleDollarSign className="size-4" />} label="Model cost" value={`${usd(run.costUsd)} / ${usd(run.budgetUsd)}`} hint={`${num(run.tokensIn + run.tokensOut)} tokens`} />
        <MiniStat icon={<ShieldCheck className="size-4" />} label="Outcome" value={run.outcome} hint={outcomeHelp(run.outcome)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card className="h-[520px] overflow-hidden">
          <MissionGraph definition={run.version.definition} statuses={statuses} selectedId={selected} onSelect={setSelected} />
        </Card>
        <Card className="flex h-[520px] flex-col overflow-hidden">
          {task ? (
            <TaskDetail task={task} run={run} onBack={() => setSelected(null)} onReconcile={(resolution) => reconcile.mutate({ taskId: task.id, resolution })} canExecute={can("run:execute")} />
          ) : (
            <>
              <div className="border-b border-line p-3">
                <Tabs value={tab} onChange={setTab} tabs={[{ value: "timeline", label: "Timeline" }, { value: "trace", label: "Tool trace" }, { value: "outcome", label: "Outcome" }]} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {tab === "timeline" && <Timeline events={events} tasks={tasks} onSelect={setSelected} />}
                {tab === "trace" && <Trace run={run} />}
                {tab === "outcome" && <Outcome run={run} />}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card className="flex items-center gap-3 p-3">
      <span className="grid size-8 place-items-center rounded-lg bg-indigo/10 text-indigo">{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] text-ink-3">{label}</div>
        <div className="truncate text-sm font-medium capitalize tabular-nums">{value}</div>
        {hint && <div className="truncate text-[10px] text-ink-3" title={hint}>{hint}</div>}
      </div>
    </Card>
  );
}

function describe(e: LiveEvent, tasks: TaskRun[]): string {
  const title = (key: unknown) => tasks.find((t) => t.nodeKey === key)?.title ?? String(key ?? "");
  switch (e.type) {
    case "run.created": return `Run created (${String(e.data.mode).toLowerCase().replace("_", " ")}, v${e.data.version})`;
    case "run.status": return `Run → ${String(e.data.status).toLowerCase().replace("_", " ")}`;
    case "task.status": return `${title(e.data.nodeKey)} → ${String(e.data.status).toLowerCase().replace(/_/g, " ")}${e.data.attempt ? ` (attempt ${e.data.attempt})` : ""}${e.data.error ? `: ${e.data.error}` : ""}`;
    case "tool.called": return `${String(e.data.capability)} via ${String(e.data.mode)} in ${duration(Number(e.data.latencyMs))}${e.data.externalId ? ` · id ${e.data.externalId}` : ""}`;
    case "approval.requested": return "Approval requested";
    case "approval.decided": return `Approval ${String(e.data.decision)}d`;
    case "approval.expired": return "Approval expired";
    case "task.reconciled": return `Reconciled ${title(e.data.nodeKey)}: ${e.data.found ? "delivered" : "not delivered"}`;
    case "security.injection_detected": return `Prompt-injection pattern detected in input to ${title(e.data.nodeKey)} — treated as data`;
    case "run.finalized": return `Run finalized: ${String(e.data.status).toLowerCase()}, outcome ${String(e.data.outcome)}`;
    default: return e.type;
  }
}

function Timeline({ events, tasks, onSelect }: { events: LiveEvent[]; tasks: TaskRun[]; onSelect: (k: string) => void }) {
  if (!events.length) return <p className="p-6 text-center text-xs text-ink-3">Waiting for events…</p>;
  return (
    <ol className="relative space-y-0 p-4">
      {[...events].reverse().map((e) => {
        const tone = e.type === "security.injection_detected" ? "bg-serious" : e.type.startsWith("approval") ? "bg-warn" : String(e.data.status ?? "").includes("FAIL") ? "bg-critical" : e.data.status === "SUCCEEDED" ? "bg-good" : "bg-indigo";
        return (
          <li key={e.id} className="relative flex gap-3 pb-3 pl-1">
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", tone)} />
            <div className="min-w-0 flex-1">
              <button className="text-left text-xs leading-5 text-ink-2 hover:text-ink" onClick={() => typeof e.data.nodeKey === "string" && onSelect(e.data.nodeKey)}>
                {e.type === "security.injection_detected" && <ShieldAlert className="mr-1 inline size-3 text-serious" />}
                {describe(e, tasks)}
              </button>
              <div className="text-[10px] text-ink-3">{new Date(e.at).toLocaleTimeString()}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Trace({ run }: { run: Run }) {
  const execs = run.toolExecutions ?? [];
  if (!execs.length) return <p className="p-6 text-center text-xs text-ink-3">No tool calls yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="sticky top-0 bg-surface-2 text-[11px] text-ink-3">
          <tr>
            <th className="px-3 py-2 font-medium">Capability</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Model / mode</th>
            <th className="px-3 py-2 text-right font-medium">Latency</th>
            <th className="px-3 py-2 text-right font-medium">Tokens</th>
            <th className="px-3 py-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {execs.map((t) => (
            <tr key={t.id} title={t.error ?? undefined}>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-2">{t.capability}{t.attempt > 1 && <span className="text-warn"> #{t.attempt}</span>}</td>
              <td className="px-3 py-2"><Badge tone={t.status === "SUCCEEDED" || t.status === "RECONCILED" ? "good" : t.status === "STARTED" ? "cyan" : t.status === "AMBIGUOUS" ? "serious" : "critical"}>{t.status.toLowerCase()}</Badge></td>
              <td className="px-3 py-2 text-ink-3">{t.model ?? t.mode}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-2">{duration(t.latencyMs)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-2">{t.tokensIn + t.tokensOut ? num(t.tokensIn + t.tokensOut) : "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-2">{usd(t.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Outcome({ run }: { run: Run }) {
  const ev = run.outcomeEvidence;
  const states = [
    { key: "completed", label: "Task completed", ok: run.status === "SUCCEEDED" },
    { key: "acknowledged", label: "External action acknowledged", ok: !!ev?.writes?.length && ev.writes.every((w) => w.externalId) },
    { key: "verified", label: "Outcome independently verified", ok: run.outcome === "verified" },
  ];
  return (
    <div className="space-y-4 p-4">
      <ol className="space-y-2">
        {states.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm">
            <span className={cn("grid size-5 place-items-center rounded-full text-[10px]", s.ok ? "bg-good/20 text-good" : "bg-surface-3 text-ink-3")}>{s.ok ? "✓" : "·"}</span>
            <span className={s.ok ? "text-ink" : "text-ink-3"}>{s.label}</span>
          </li>
        ))}
      </ol>
      {!ev && <p className="text-xs text-ink-3">Outcome evidence appears when the run finishes. Until then the outcome is pending — never inferred.</p>}
      {ev?.writes?.map((w) => (
        <div key={w.nodeKey} className="rounded-lg border border-line bg-surface p-3 text-xs">
          <div className="font-medium">{w.nodeKey}</div>
          <div className="mt-1 font-mono text-ink-3">provider id: {w.externalId ?? "none"}</div>
          {w.permalink && (
            <a href={w.permalink} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-indigo hover:underline">
              Open in provider <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      ))}
      {ev?.verifications?.map((v) => (
        <div key={v.nodeKey} className="rounded-lg border border-line bg-surface p-3 text-xs">
          <div className="flex items-center gap-2 font-medium">{v.nodeKey} {v.verified ? <Badge tone="good">verified</Badge> : <Badge tone="warn">not verified</Badge>}</div>
          <JsonView value={v.evidence} className="mt-2" />
        </div>
      ))}
      {run.estimatedMinutesSaved > 0 && <p className="text-[11px] text-ink-3">Estimated time saved: {run.estimatedMinutesSaved} min (per-step estimate table, not measured).</p>}
    </div>
  );
}

function TaskDetail({ task, run, onBack, onReconcile, canExecute }: { task: TaskRun; run: Run; onBack: () => void; onReconcile: (r: "auto" | "mark_not_sent") => void; canExecute: boolean }) {
  const execs = (run.toolExecutions ?? []).filter((t) => t.taskRunId === task.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line p-3">
        <button onClick={onBack} className="rounded px-1.5 py-0.5 text-xs text-ink-3 hover:bg-surface-3 hover:text-ink">← Back</button>
        <span className="truncate text-sm font-medium">{task.title}</span>
        <span className="ml-auto"><StatusBadge status={task.status} /></span>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        <div className="grid grid-cols-2 gap-2 text-ink-3">
          <div>Agent: <span className="text-ink-2">{task.agentKey}</span></div>
          <div>Attempts: <span className="text-ink-2">{task.attempt}/{task.maxAttempts}</span></div>
          <div className="col-span-2 font-mono">{task.action}</div>
          {task.nextAttemptAt && task.status === "RETRY_SCHEDULED" && <div className="col-span-2 text-warn">Next attempt {new Date(task.nextAttemptAt).toLocaleTimeString()}</div>}
        </div>
        {task.error && (
          <div className="rounded-lg border border-critical/30 bg-critical/8 p-3 text-critical">
            <div className="font-medium">{task.error.message}</div>
            {task.failureClass && <div className="mt-1 text-[11px] opacity-80">failure class: {task.failureClass}</div>}
          </div>
        )}
        {task.status === "NEEDS_RECONCILIATION" && canExecute && (
          <div className="rounded-lg border border-serious/30 bg-serious/8 p-3">
            <p className="text-serious">The provider may or may not have received this write. ORBIX will not resend until its state is reconciled.</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => onReconcile("auto")}>Check provider</Button>
              <Button size="sm" variant="ghost" onClick={() => confirm("Confirm you verified this action did NOT happen. It will be retried with the same idempotency key.") && onReconcile("mark_not_sent")}>Mark as not sent</Button>
            </div>
          </div>
        )}
        {task.input !== null && task.input !== undefined && (<div><div className="mb-1 font-medium text-ink-2">Bound input</div><JsonView value={task.input} /></div>)}
        {task.output && (<div><div className="mb-1 font-medium text-ink-2">Output</div><JsonView value={task.output} /></div>)}
        {execs.map((t) => (
          <div key={t.id}>
            <div className="mb-1 font-medium text-ink-2">Tool call #{t.attempt} · {t.status.toLowerCase()} · {duration(t.latencyMs)}</div>
            <JsonView value={{ request: t.requestRedacted, response: t.responseRedacted, error: t.error, externalId: t.externalId }} />
          </div>
        ))}
        <p className="text-[10px] text-ink-3">Inputs and outputs in traces are redacted for secrets.</p>
      </div>
    </div>
  );
}
