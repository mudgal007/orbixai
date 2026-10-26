"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, CheckCircle2, CircleDollarSign, Clock, Inbox, Plug, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import { RunsChart } from "@/components/charts";
import { ModeBadge, OutcomeBadge, StatusBadge } from "@/components/status";
import { Button, Card, CardHeader, EmptyState, ErrorState, Input, Skeleton, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { num, pct, timeAgo, usd } from "@/lib/format";
import { useOrg } from "@/lib/hooks";
import type { Run } from "@/lib/types";

interface Summary {
  windowDays: number;
  runs: { total: number; byStatus: Record<string, number>; successRate: number | null; avgDurationMs: number | null };
  outcomes: Record<string, number>;
  cost: { usd: number; tokensIn: number; tokensOut: number };
  estimatedMinutesSaved: number;
  pendingApprovals: number;
  connections: Array<{ provider: string; mode: string; label: string }>;
  series: Array<{ date: string; succeeded: number; failed: number; other: number }>;
  recentFailures: Array<{ id: string; error: string | null; createdAt: string; workflow: { name: string } }>;
}

interface AuditEvent {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  createdAt: string;
  targetType: string | null;
  targetId: string | null;
}

export default function MissionControl() {
  const { orgId, me } = useOrg();
  const router = useRouter();
  const [objective, setObjective] = useState("");
  const summary = useQuery({ queryKey: ["summary", orgId], queryFn: () => api<Summary>(`/orgs/${orgId}/analytics/summary?days=14`), refetchInterval: 15_000 });
  const runs = useQuery({ queryKey: ["runs", orgId, "recent"], queryFn: () => api<{ runs: Run[] }>(`/orgs/${orgId}/runs?limit=8`), refetchInterval: 5_000 });
  const audit = useQuery({ queryKey: ["audit", orgId, "recent"], queryFn: () => api<{ events: AuditEvent[]; actors: Record<string, { name: string }> }>(`/orgs/${orgId}/audit?limit=8`), retry: false });

  if (summary.error) return <ErrorState error={summary.error} onRetry={() => summary.refetch()} />;
  const s = summary.data;
  const active = (s?.runs.byStatus.RUNNING ?? 0) + (s?.runs.byStatus.QUEUED ?? 0) + (s?.runs.byStatus.WAITING_APPROVAL ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs text-ink-3">Mission control</p>
          <h1 className="text-2xl font-semibold tracking-tight">Good to see you{me.data ? `, ${me.data.user.name.split(" ")[0]}` : ""}.</h1>
        </div>
        <form
          className="flex w-full max-w-xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(`/app/missions/new${objective ? `?q=${encodeURIComponent(objective)}` : ""}`);
          }}
        >
          <Input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Describe a new mission…" aria-label="New mission objective" />
          <Button type="submit" variant="primary" icon={<Sparkles className="size-4" />}>Plan</Button>
        </form>
      </div>

      {!s ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <Stat label="Active runs" value={active} icon={<Activity className="size-4" />} hint={`${s.runs.total} runs in ${s.windowDays}d`} />
          <Link href="/app/approvals"><Stat label="Pending approvals" value={s.pendingApprovals} icon={<Inbox className="size-4" />} tone={s.pendingApprovals ? "warn" : "indigo"} hint={s.pendingApprovals ? "waiting on you" : "inbox clear"} /></Link>
          <Stat label="Success rate" value={pct(s.runs.successRate)} icon={<CheckCircle2 className="size-4" />} tone="good" hint="finished runs" />
          <Stat label="Verified outcomes" value={s.outcomes.verified ?? 0} icon={<ShieldCheck className="size-4" />} tone="good" hint={`${s.outcomes.acknowledged ?? 0} acknowledged · ${s.outcomes.unverified ?? 0} unverified`} />
          <Stat label="Model spend" value={usd(s.cost.usd)} icon={<CircleDollarSign className="size-4" />} hint={`${num(s.cost.tokensIn + s.cost.tokensOut)} tokens`} />
          <Stat label="Time saved (est.)" value={`${num(s.estimatedMinutesSaved)}m`} icon={<Clock className="size-4" />} hint="per-step estimate, not measured" />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Runs per day" description={`Last ${s?.windowDays ?? 14} days, by final status`} />
          <div className="p-5 pt-3">{s ? s.runs.total ? <RunsChart data={s.series} /> : <EmptyState icon={<Activity className="size-5" />} title="No runs yet" description="Plan a mission, simulate it, and run it — results will appear here." action={<Link href="/app/missions/new"><Button variant="primary" size="sm">Create a mission</Button></Link>} /> : <Skeleton className="h-56" />}</div>
        </Card>
        <Card>
          <CardHeader title="Actionable errors" description="Most recent failed runs" />
          <ul className="divide-y divide-line p-2">
            {s?.recentFailures.length === 0 && <li className="flex items-center gap-2 px-3 py-6 text-xs text-ink-3"><CheckCircle2 className="size-4 text-good" /> No failed runs.</li>}
            {s?.recentFailures.map((f) => (
              <li key={f.id}>
                <Link href={`/app/runs/${f.id}`} className="flex gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-3/50">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-critical" />
                  <div className="min-w-0">
                    <div className="truncate text-sm">{f.workflow.name}</div>
                    <div className="line-clamp-2 text-xs text-ink-3">{f.error ?? "Failed"}</div>
                  </div>
                  <span className="ml-auto shrink-0 text-[11px] text-ink-3">{timeAgo(f.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Recent runs" action={<Link href="/app/runs" className="inline-flex items-center gap-1 text-xs text-indigo hover:underline">All runs <ArrowRight className="size-3" /></Link>} />
          <div className="overflow-x-auto p-2">
            {runs.data?.runs.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-ink-3">No runs yet.</p>
            ) : (
              <table className="w-full min-w-[560px] text-left text-sm">
                <tbody className="divide-y divide-line">
                  {(runs.data?.runs ?? []).map((r) => (
                    <tr key={r.id} className="cursor-pointer hover:bg-surface-3/40" onClick={() => router.push(`/app/runs/${r.id}`)}>
                      <td className="px-3 py-2.5"><Link href={`/app/runs/${r.id}`} className="font-medium hover:text-indigo">{r.workflow.name}</Link></td>
                      <td className="px-3 py-2.5"><ModeBadge mode={r.mode} /></td>
                      <td className="px-3 py-2.5"><StatusBadge status={r.status} /></td>
                      <td className="px-3 py-2.5"><OutcomeBadge outcome={r.outcome} /></td>
                      <td className="px-3 py-2.5 text-right text-xs text-ink-3">{timeAgo(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Connected apps" action={<Link href="/app/integrations" className="text-xs text-indigo hover:underline">Manage</Link>} />
            <ul className="space-y-2 p-5 pt-3">
              {s?.connections.length === 0 && <li className="text-xs text-ink-3">No connections. <Link className="text-indigo hover:underline" href="/app/integrations">Connect GitHub or Slack</Link>.</li>}
              {s?.connections.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <Plug className="size-3.5 text-ink-3" /> {c.label}
                  <span className={`ml-auto text-[11px] ${c.mode === "LIVE" ? "text-good" : "text-cyan"}`}>{c.mode.toLowerCase()}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Activity" action={<Link href="/app/audit" className="text-xs text-indigo hover:underline">Audit log</Link>} />
            <ul className="space-y-2.5 p-5 pt-3">
              {audit.error && <li className="text-xs text-ink-3">Your role cannot view the audit log.</li>}
              {audit.data?.events.map((e) => (
                <li key={e.id} className="flex gap-2 text-xs">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-indigo" />
                  <span className="text-ink-2">
                    <span className="text-ink">{e.actorType === "user" ? audit.data.actors[e.actorId ?? ""]?.name ?? "User" : e.actorType}</span> {e.action.replace(/[._]/g, " ")}
                  </span>
                  <span className="ml-auto shrink-0 text-ink-3">{timeAgo(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
