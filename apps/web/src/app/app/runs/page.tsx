"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, CalendarClock } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ModeBadge, OutcomeBadge, StatusBadge } from "@/components/status";
import { Card, EmptyState, ErrorState, Select, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { duration, timeAgo, usd } from "@/lib/format";
import { useOrg } from "@/lib/hooks";
import type { Run } from "@/lib/types";

const STATUSES = ["", "RUNNING", "WAITING_APPROVAL", "NEEDS_ATTENTION", "PAUSED", "SUCCEEDED", "FAILED", "CANCELLED"];

export default function RunsPage() {
  const { orgId } = useOrg();
  const [status, setStatus] = useState("");
  const q = useQuery({
    queryKey: ["runs", orgId, status],
    queryFn: () => api<{ runs: Array<Run & { _count: { tasks: number } }> }>(`/orgs/${orgId}/runs?limit=100${status ? `&status=${status}` : ""}`),
    refetchInterval: 5000,
  });

  return (
    <div>
      <PageHeader
        title="Execution history"
        description="Every run, its mode, final state, and verified outcome."
        actions={<Select value={status} onChange={setStatus} className="w-48" options={STATUSES.map((s) => ({ value: s, label: s ? s.replace(/_/g, " ").toLowerCase() : "All statuses" }))} />}
      />
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-96" />
      ) : q.data.runs.length === 0 ? (
        <Card><EmptyState icon={<Activity className="size-5" />} title="No runs" description="Runs appear here after you start a dry run or live execution from a published workflow." /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-line text-xs text-ink-3">
              <tr>
                <th className="px-4 py-3 font-medium">Workflow</th>
                <th className="px-4 py-3 font-medium">Mode</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Outcome</th>
                <th className="px-4 py-3 text-right font-medium">Duration</th>
                <th className="px-4 py-3 text-right font-medium">Cost</th>
                <th className="px-4 py-3 text-right font-medium">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {q.data.runs.map((r) => (
                <tr key={r.id} className="hover:bg-surface-3/40">
                  <td className="px-4 py-3">
                    <Link href={`/app/runs/${r.id}`} className="font-medium hover:text-indigo">{r.workflow.name}</Link>
                    <div className="flex items-center gap-1.5 font-mono text-[10px] text-ink-3">
                      {r.scheduleId && <CalendarClock className="size-3 text-cyan" aria-label="Started by schedule" />}v{r.version.version} · {r.id}
                    </div>
                  </td>
                  <td className="px-4 py-3"><ModeBadge mode={r.mode} /></td>
                  <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-3"><OutcomeBadge outcome={r.outcome} /></td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-2">{r.startedAt ? duration((r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now()) - new Date(r.startedAt).getTime()) : "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-2">{usd(r.costUsd)}</td>
                  <td className="px-4 py-3 text-right text-xs text-ink-3">{timeAgo(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
