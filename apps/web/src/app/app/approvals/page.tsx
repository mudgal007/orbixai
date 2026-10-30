"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, Check, CircleSlash, ExternalLink, Fingerprint, Inbox, MessageSquare, PencilLine, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ModeBadge, StatusBadge } from "@/components/status";
import { Badge, Button, Card, EmptyState, JsonView, Skeleton, Tabs, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { useOrg } from "@/lib/hooks";
import type { Approval } from "@/lib/types";

export default function ApprovalsPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const { orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const q = useQuery({
    queryKey: ["approvals", orgId, filter],
    queryFn: () => api<{ approvals: Approval[] }>(`/orgs/${orgId}/approvals${filter === "pending" ? "?status=pending" : ""}`),
    refetchInterval: 5000,
  });
  const list = q.data?.approvals ?? [];
  const selectedId = params.get("id") ?? list[0]?.id ?? null;
  const selected = list.find((a) => a.id === selectedId);

  return (
    <div>
      <PageHeader title="Approval inbox" description="Every externally visible or irreversible action waits here. Approvals are bound to the exact payload hash and expire." actions={<Tabs value={filter} onChange={setFilter} tabs={[{ value: "pending", label: "Pending" }, { value: "all", label: "All" }]} />} />
      {q.isLoading ? (
        <Skeleton className="h-96" />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState icon={<Inbox className="size-5" />} title={filter === "pending" ? "Nothing waiting for you" : "No approvals yet"} description="When a run reaches an approval checkpoint, the exact action and payload appear here." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <Card className="h-fit overflow-hidden">
            <ul className="divide-y divide-line">
              {list.map((a) => (
                <li key={a.id}>
                  <button onClick={() => router.replace(`/app/approvals?id=${a.id}`)} className={cn("w-full px-4 py-3 text-left transition hover:bg-surface-3/50", a.id === selectedId && "bg-indigo/8 shadow-[inset_2px_0_0_var(--color-indigo)]")}>
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{a.action}</span>
                      <span className="ml-auto"><StatusBadge status={a.status} /></span>
                    </div>
                    <div className="mt-1 truncate text-xs text-ink-3">{a.run?.workflow.name} · {a.targetAccount}</div>
                    <div className="mt-1 text-[11px] text-ink-3">{timeAgo(a.requestedAt)}</div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {selected ? <ApprovalDetail key={selected.id} approval={selected} /> : <Skeleton className="h-96" />}
        </div>
      )}
    </div>
  );
}

function useCountdown(to: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(to).getTime() - now;
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return h ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function ApprovalDetail({ approval }: { approval: Approval }) {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(approval.payload.input.text ?? ""));
  const [comment, setComment] = useState("");
  const remaining = useCountdown(approval.expiresAt);
  const pending = approval.status === "PENDING";
  const canDecide = can("approval:decide") && pending;
  const isMessage = typeof approval.payload.input.text === "string";

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["approvals"] });
    qc.invalidateQueries({ queryKey: ["run"] });
  };
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") => api(`/orgs/${orgId}/approvals/${approval.id}/decision`, { body: { decision, payloadHash: approval.payloadHash, comment: comment || undefined } }),
    onSuccess: (_, decision) => {
      toast.success(decision === "approve" ? "Approved — the action will execute with this exact payload." : "Rejected — downstream steps were skipped.");
      refresh();
      router.push(`/app/runs/${approval.runId}`);
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Decision failed");
      refresh();
    },
  });
  const change = useMutation({
    mutationFn: () => api<{ approval: Approval }>(`/orgs/${orgId}/approvals/${approval.id}/request-changes`, { body: { payload: { text }, comment: comment || undefined } }),
    onSuccess: (r) => {
      toast.info("Payload updated. The previous approval was invalidated and a new one issued for the edited payload.");
      setEditing(false);
      refresh();
      router.replace(`/app/approvals?id=${r.approval.id}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  const warnings = approval.evidence.injectionWarnings ?? [];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{approval.action}</h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Target: <span className="text-ink-2">{approval.targetAccount}</span> · <Link href={`/app/runs/${approval.runId}`} className="text-indigo hover:underline">view run</Link>
          </p>
        </div>
        {approval.run && <ModeBadge mode={approval.run.mode} />}
        <StatusBadge status={approval.status} />
        {pending && <Badge tone={remaining === "expired" ? "critical" : "warn"}>expires in {remaining}</Badge>}
      </div>

      <div className="grid gap-5 p-5 xl:grid-cols-2">
        <section className="space-y-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Why this is needed</h3>
            <p className="mt-1.5 text-sm leading-6 text-ink-2">{approval.reason}</p>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Consequences</h3>
            <p className="mt-1.5 flex gap-2 text-sm text-warn"><AlertOctagon className="mt-0.5 size-4 shrink-0" />{approval.consequences}</p>
          </div>
          {warnings.length > 0 && (
            <div className="rounded-lg border border-serious/30 bg-serious/8 p-3">
              <h3 className="flex items-center gap-2 text-xs font-semibold text-serious"><ShieldAlert className="size-4" /> Suspicious content in source data</h3>
              <p className="mt-1 text-[11px] text-ink-2">These patterns were found in upstream inputs and treated strictly as data. Check the payload does not act on them.</p>
              <ul className="mt-2 space-y-1">
                {warnings.slice(0, 5).map((w, i) => (
                  <li key={i} className="font-mono text-[10px] text-ink-3">{w.kind}: “{w.excerpt}”</li>
                ))}
              </ul>
            </div>
          )}
          {approval.evidence.preflight && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Pre-flight checks</h3>
              <ul className="mt-1.5 space-y-1">
                {approval.evidence.preflight.checks.map((c) => (
                  <li key={c.name} className={`flex items-start gap-2 text-xs ${c.skipped ? "text-ink-3" : "text-good"}`}>
                    {c.skipped ? <CircleSlash className="mt-0.5 size-3.5 shrink-0" /> : <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />}
                    <span>{c.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Supporting evidence</h3>
            {(approval.evidence.sources ?? []).length === 0 ? (
              <p className="mt-1.5 text-xs text-ink-3">No source links were collected.</p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {approval.evidence.sources!.map((s) => (
                  <li key={s}>
                    <a href={s} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-xs text-indigo hover:underline">{s}<ExternalLink className="size-3 shrink-0" /></a>
                  </li>
                ))}
              </ul>
            )}
            {approval.evidence.upstream && <p className="mt-2 text-[11px] text-ink-3">Upstream steps: {approval.evidence.upstream.map((u) => u.title).join(" → ")}</p>}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Exact payload</h3>
          {isMessage && !editing && (
            <div className="rounded-xl border border-line-strong bg-surface p-4">
              <div className="mb-2 flex items-center gap-2 text-[11px] text-ink-3"><MessageSquare className="size-3.5" /> {String(approval.payload.input.channel ?? "")}</div>
              <p className="whitespace-pre-wrap text-sm leading-6 text-ink">{String(approval.payload.input.text)}</p>
            </div>
          )}
          {editing && <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" aria-label="Edit message text" />}
          <JsonView value={approval.payload} />
          <p className="flex items-center gap-1.5 font-mono text-[10px] text-ink-3" title="Approval is bound to this SHA-256 of the canonical payload"><Fingerprint className="size-3" /> sha256 {approval.payloadHash.slice(0, 16)}…{approval.payloadHash.slice(-8)}</p>
        </section>
      </div>

      {canDecide && (
        <div className="space-y-3 border-t border-line p-5">
          <Textarea rows={2} placeholder="Comment (optional, recorded in the audit log)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
          <div className="flex flex-wrap justify-end gap-2">
            {isMessage &&
              (editing ? (
                <>
                  <Button variant="ghost" onClick={() => setEditing(false)}>Cancel edit</Button>
                  <Button icon={<PencilLine className="size-4" />} loading={change.isPending} disabled={text === approval.payload.input.text || !text.trim()} onClick={() => change.mutate()}>Save changes &amp; re-issue</Button>
                </>
              ) : (
                <Button icon={<PencilLine className="size-4" />} onClick={() => setEditing(true)}>Request changes</Button>
              ))}
            <Button variant="danger" icon={<X className="size-4" />} loading={decide.isPending && decide.variables === "reject"} disabled={editing} onClick={() => decide.mutate("reject")}>Reject</Button>
            <Button variant="success" icon={<Check className="size-4" />} loading={decide.isPending && decide.variables === "approve"} disabled={editing || remaining === "expired"} onClick={() => decide.mutate("approve")}>Approve exact payload</Button>
          </div>
        </div>
      )}
      {!pending && approval.comment && <p className="border-t border-line px-5 py-3 text-xs text-ink-3">Comment: {approval.comment}</p>}
    </Card>
  );
}
