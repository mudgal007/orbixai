"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, CheckCircle2, CircleDollarSign, Clock, ShieldCheck, Timer } from "lucide-react";
import { HBarChart, RunsChart } from "@/components/charts";
import { PageHeader } from "@/components/page-header";
import { OutcomeBadge } from "@/components/status";
import { Card, CardHeader, EmptyState, ErrorState, Skeleton, Stat, Tabs } from "@/components/ui";
import { api } from "@/lib/api";
import { duration, num, pct, usd } from "@/lib/format";
import { useOrg } from "@/lib/hooks";

interface Summary {
  windowDays: number;
  runs: { total: number; byStatus: Record<string, number>; successRate: number | null; avgDurationMs: number | null };
  outcomes: Record<string, number>;
  cost: { usd: number; tokensIn: number; tokensOut: number; byModel: Array<{ model: string | null; _sum: { costUsd: number | null; tokensIn: number | null; tokensOut: number | null }; _count: number }> };
  estimatedMinutesSaved: number;
  series: Array<{ date: string; succeeded: number; failed: number; other: number }>;
  tools: Array<{ capability: string; status: string; count: number; avgLatencyMs: number }>;
}

export default function AnalyticsPage() {
  const { orgId } = useOrg();
  const [days, setDays] = useState<"7" | "14" | "30">("14");
  const q = useQuery({ queryKey: ["summary", orgId, days], queryFn: () => api<Summary>(`/orgs/${orgId}/analytics/summary?days=${days}`) });

  return (
    <div className="space-y-6">
      <PageHeader title="Analytics & outcomes" description="Aggregates over stored runs, tool executions and usage records. Nothing here is sampled or synthetic." actions={<Tabs value={days} onChange={setDays} tabs={[{ value: "7", label: "7d" }, { value: "14", label: "14d" }, { value: "30", label: "30d" }]} />} />
      {q.error ? <ErrorState error={q.error} /> : !q.data ? <Skeleton className="h-96" /> : q.data.runs.total === 0 ? (
        <Card><EmptyState icon={<BarChart3 className="size-5" />} title="No data in this window" description="Run a mission to start collecting execution, cost and outcome metrics." /></Card>
      ) : (
        <Body s={q.data} />
      )}
    </div>
  );
}

function Body({ s }: { s: Summary }) {
  const toolRows = Object.values(
    s.tools.reduce<Record<string, { capability: string; count: number; failed: number; latency: number }>>((acc, t) => {
      const r = (acc[t.capability] ??= { capability: t.capability, count: 0, failed: 0, latency: 0 });
      r.latency = (r.latency * r.count + t.avgLatencyMs * t.count) / (r.count + t.count);
      r.count += t.count;
      if (t.status !== "SUCCEEDED" && t.status !== "RECONCILED") r.failed += t.count;
      return acc;
    }, {}),
  ).sort((a, b) => b.count - a.count);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Runs" value={num(s.runs.total)} icon={<BarChart3 className="size-4" />} />
        <Stat label="Success rate" value={pct(s.runs.successRate)} icon={<CheckCircle2 className="size-4" />} tone="good" />
        <Stat label="Avg duration" value={duration(s.runs.avgDurationMs)} icon={<Timer className="size-4" />} hint="includes time waiting for approval" />
        <Stat label="Model spend" value={usd(s.cost.usd)} icon={<CircleDollarSign className="size-4" />} hint={`${num(s.cost.tokensIn)} in · ${num(s.cost.tokensOut)} out`} />
        <Stat label="Time saved (est.)" value={`${num(s.estimatedMinutesSaved)}m`} icon={<Clock className="size-4" />} hint="per-step estimate table" />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card><CardHeader title="Runs per day" description="By final status" /><div className="p-5 pt-3"><RunsChart data={s.series} /></div></Card>
        <Card>
          <CardHeader title="Outcome verification" description="Completed ≠ acknowledged ≠ verified" />
          <ul className="space-y-3 p-5">
            {["verified", "acknowledged", "completed", "unverified", "failed", "pending"].map((o) => (
              <li key={o} className="flex items-center justify-between text-sm"><OutcomeBadge outcome={o} /><span className="tabular-nums text-ink">{s.outcomes[o] ?? 0}</span></li>
            ))}
          </ul>
          <p className="flex items-start gap-2 px-5 pb-5 text-[11px] text-ink-3"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" />Verified means a verification agent re-read provider state and matched the approved payload.</p>
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Model cost by model" description="USD in window" />
          <div className="p-5 pt-3">{s.cost.byModel.length ? <HBarChart data={s.cost.byModel.map((m) => ({ label: m.model ?? "unknown", value: m._sum.costUsd ?? 0 }))} format={(n) => usd(n)} /> : <p className="text-xs text-ink-3">No model calls.</p>}</div>
        </Card>
        <Card className="overflow-x-auto">
          <CardHeader title="Tool reliability" description="Calls, failures and average latency per capability" />
          <table className="mt-2 w-full min-w-[420px] text-left text-xs">
            <thead className="text-ink-3"><tr><th className="px-5 py-2 font-medium">Capability</th><th className="px-3 py-2 text-right font-medium">Calls</th><th className="px-3 py-2 text-right font-medium">Failed</th><th className="px-5 py-2 text-right font-medium">Avg latency</th></tr></thead>
            <tbody className="divide-y divide-line">{toolRows.map((t) => <tr key={t.capability}><td className="px-5 py-2 font-mono text-ink-2">{t.capability}</td><td className="px-3 py-2 text-right tabular-nums">{t.count}</td><td className={`px-3 py-2 text-right tabular-nums ${t.failed ? "text-critical" : "text-ink-3"}`}>{t.failed}</td><td className="px-5 py-2 text-right tabular-nums text-ink-2">{duration(Math.round(t.latency))}</td></tr>)}</tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
