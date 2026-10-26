"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, ShieldCheck, ShieldX } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, ErrorState, Input, JsonView, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { useOrg } from "@/lib/hooks";

interface Event {
  id: string;
  seq: number;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  data: unknown;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export default function AuditPage() {
  const { orgId } = useOrg();
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["audit", orgId, filter], queryFn: () => api<{ events: Event[]; actors: Record<string, { name: string; email: string }> }>(`/orgs/${orgId}/audit?limit=200${filter ? `&action=${encodeURIComponent(filter)}` : ""}`) });
  const verify = useQuery({ queryKey: ["audit-verify", orgId], queryFn: () => api<{ valid: boolean; checked: number; brokenAtSeq?: number }>(`/orgs/${orgId}/audit/verify`), enabled: false });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit log"
        description="Append-only (enforced by a database trigger) and hash-chained per organization. Sensitive values are redacted before hashing."
        actions={
          <>
            {verify.data && (verify.data.valid ? <Badge tone="good" icon={<ShieldCheck className="size-3" />}>Chain intact · {verify.data.checked} events</Badge> : <Badge tone="critical" icon={<ShieldX className="size-3" />}>Broken at #{verify.data.brokenAtSeq}</Badge>)}
            <Button size="sm" icon={<Link2 className="size-3.5" />} loading={verify.isFetching} onClick={() => verify.refetch()}>Verify chain</Button>
          </>
        }
      />
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by action prefix, e.g. approval. or run." className="max-w-sm" aria-label="Filter audit events" />
      {q.error ? <ErrorState error={q.error} /> : !q.data ? <Skeleton className="h-96" /> : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-line text-xs text-ink-3"><tr><th className="px-4 py-3 font-medium">#</th><th className="px-4 py-3 font-medium">Action</th><th className="px-4 py-3 font-medium">Actor</th><th className="px-4 py-3 font-medium">Target</th><th className="px-4 py-3 font-medium">Hash</th><th className="px-4 py-3 text-right font-medium">Time</th></tr></thead>
            <tbody className="divide-y divide-line">
              {q.data.events.map((e) => (
                <Fragment key={e.id}>
                  <tr className="cursor-pointer hover:bg-surface-3/40" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className="px-4 py-2.5 tabular-nums text-ink-3">{e.seq}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{e.action}</td>
                    <td className="px-4 py-2.5 text-xs text-ink-2">{e.actorType === "user" ? q.data.actors[e.actorId ?? ""]?.name ?? "user" : e.actorType}</td>
                    <td className="px-4 py-2.5 text-xs">{e.targetType === "run" && e.targetId ? <Link href={`/app/runs/${e.targetId}`} className="text-indigo hover:underline" onClick={(ev) => ev.stopPropagation()}>run</Link> : <span className="text-ink-3">{e.targetType ?? "—"}</span>}</td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-ink-3">{e.hash.slice(0, 12)}…</td>
                    <td className="px-4 py-2.5 text-right text-xs text-ink-3">{new Date(e.createdAt).toLocaleString()}</td>
                  </tr>
                  {open === e.id && (
                    <tr><td colSpan={6} className="bg-bg/40 px-4 py-3"><JsonView value={{ data: e.data, prevHash: e.prevHash, hash: e.hash }} /></td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
