"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Plus, Upload, Workflow as WorkflowIcon } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { timeAgo, timeUntil } from "@/lib/format";
import { useOrg } from "@/lib/hooks";

interface Row {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  draft: { nodes: unknown[] };
  versions: Array<{ version: number; createdAt: string }>;
  schedule: { enabled: boolean; cron: string; timezone: string; mode: "DRY_RUN" | "LIVE"; nextRunAt: string | null } | null;
  _count: { runs: number };
}

export default function WorkflowsPage() {
  const { orgId, can } = useOrg();
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const q = useQuery({ queryKey: ["workflows", orgId, "list"], queryFn: () => api<{ workflows: Row[] }>(`/orgs/${orgId}/workflows`) });

  async function importFile(f: File) {
    try {
      const parsed = JSON.parse(await f.text());
      const res = await api<{ workflow: { id: string } }>(`/orgs/${orgId}/workflows/import`, { body: { definition: parsed.definition ?? parsed } });
      toast.success("Workflow imported");
      router.push(`/app/workflows/${res.workflow.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Not a valid ORBIX workflow file");
    }
  }

  return (
    <div>
      <PageHeader
        title="Workflows"
        description="Versioned execution graphs. Drafts are editable; published versions are immutable."
        actions={
          can("workflow:write") && (
            <>
              <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
              <Button icon={<Upload className="size-4" />} onClick={() => file.current?.click()}>Import JSON</Button>
              <Link href="/app/missions/new"><Button variant="primary" icon={<Plus className="size-4" />}>New mission</Button></Link>
            </>
          )
        }
      />
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-64" />
      ) : q.data.workflows.length === 0 ? (
        <Card><EmptyState icon={<WorkflowIcon className="size-5" />} title="No workflows yet" description="Describe a mission and ORBIX will generate a workflow you can edit and publish." action={<Link href="/app/missions/new"><Button variant="primary" size="sm">Create a mission</Button></Link>} /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {q.data.workflows.map((w) => (
            <Link key={w.id} href={`/app/workflows/${w.id}`} className="glass group rounded-xl p-4 transition hover:border-indigo/40">
              <div className="flex items-center gap-2">
                <WorkflowIcon className="size-4 text-indigo" />
                <span className="truncate font-medium group-hover:text-indigo">{w.name}</span>
                {w.versions[0] ? <Badge tone="indigo" className="ml-auto">v{w.versions[0].version}</Badge> : <Badge className="ml-auto">Draft</Badge>}
              </div>
              {w.description && <p className="mt-2 line-clamp-2 text-xs leading-5 text-ink-3">{w.description}</p>}
              <div className="mt-3 flex gap-3 text-[11px] text-ink-3">
                <span>{w.draft.nodes.length} steps</span>
                <span>{w._count.runs} runs</span>
                {w.schedule && (
                  <span className={`inline-flex items-center gap-1 ${w.schedule.enabled ? "text-cyan" : ""}`} title={`${w.schedule.cron} (${w.schedule.timezone})`}>
                    <CalendarClock className="size-3" />
                    {w.schedule.enabled && w.schedule.nextRunAt ? `next ${timeUntil(w.schedule.nextRunAt)}` : "schedule paused"}
                  </span>
                )}
                <span className="ml-auto">{timeAgo(w.createdAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
