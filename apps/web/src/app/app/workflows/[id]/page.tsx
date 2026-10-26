"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FlaskConical, Play, Plus, Rocket, Save, ShieldCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { CAPABILITIES, agentForCapability, approvalRequiredFor, type ValidationIssue, type WorkflowDefinition, type WorkflowNode } from "@orbix/core";
import { MissionGraph } from "@/components/mission-graph";
import { NodeInspector } from "@/components/node-inspector";
import { RunDialog } from "@/components/run-dialog";
import { RiskBadge } from "@/components/status";
import { Badge, Button, Card, Dialog, ErrorState, Input, Skeleton } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useOrg } from "@/lib/hooks";
import type { Workflow } from "@/lib/types";

interface WorkflowResponse {
  workflow: Workflow;
  versions: Array<{ id: string; version: number; createdAt: string }>;
  mission: { objective: string; planner: string; plannerNotes: string[] } | null;
  validation: { valid: boolean; issues: ValidationIssue[] };
  draftMatchesLatest: boolean;
}

export default function WorkflowEditor() {
  const { id } = useParams<{ id: string }>();
  const { orgId, can } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["workflow", orgId, id], queryFn: () => api<WorkflowResponse>(`/orgs/${orgId}/workflows/${id}`) });

  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const editable = can("workflow:write");

  useEffect(() => {
    if (q.data && !dirty) {
      setDraft(q.data.workflow.draft);
      setIssues(q.data.validation.issues);
    }
  }, [q.data, dirty]);

  const update = useCallback((def: WorkflowDefinition) => {
    setDraft(def);
    setDirty(true);
  }, []);

  const save = useMutation({
    mutationFn: (def: WorkflowDefinition) =>
      api<{ workflow: Workflow; policyNotes: string[]; validation: { valid: boolean; issues: ValidationIssue[] } }>(`/orgs/${orgId}/workflows/${id}/draft`, { method: "PUT", body: { definition: def } }),
    onSuccess: (r) => {
      setDraft(r.workflow.draft);
      setIssues(r.validation.issues);
      setDirty(false);
      r.policyNotes.forEach((n) => toast.info(n));
      qc.invalidateQueries({ queryKey: ["workflow", orgId, id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const publish = useMutation({
    mutationFn: async () => {
      if (dirty && draft) await save.mutateAsync(draft);
      return api<{ version: { version: number }; unchanged: boolean }>(`/orgs/${orgId}/workflows/${id}/publish`, { method: "POST" });
    },
    onSuccess: (r) => {
      toast.success(r.unchanged ? `Already published as v${r.version.version}` : `Published v${r.version.version}`);
      qc.invalidateQueries({ queryKey: ["workflow", orgId, id] });
    },
    onError: (e) => {
      if (e instanceof ApiError && Array.isArray(e.details)) setIssues(e.details as ValidationIssue[]);
      toast.error(e instanceof ApiError ? e.message : "Publish failed");
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (draft && dirty) save.mutate(draft);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, dirty, save]);

  const issuesByNode = useMemo(() => {
    const m: Record<string, number> = {};
    issues.filter((i) => i.severity === "error" && i.nodeId).forEach((i) => (m[i.nodeId!] = (m[i.nodeId!] ?? 0) + 1));
    return m;
  }, [issues]);

  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data || !draft) return <Skeleton className="h-[70vh]" />;

  const node = draft.nodes.find((n) => n.id === selected);
  const errors = issues.filter((i) => i.severity === "error");
  const latest = q.data.versions[0];
  const published = latest && q.data.draftMatchesLatest && !dirty;

  function addNode(capId: string) {
    const cap = CAPABILITIES.find((c) => c.id === capId)!;
    const base = capId.split(".").slice(1).join("_").replace(/[^a-z0-9_]/g, "_");
    let nid = base;
    for (let i = 2; draft!.nodes.some((n) => n.id === nid); i++) nid = `${base}_${i}`;
    const anchor = draft!.nodes.find((n) => n.id === selected) ?? draft!.nodes[draft!.nodes.length - 1];
    const write = approvalRequiredFor(cap.risk);
    const n: WorkflowNode = {
      id: nid,
      title: cap.title,
      agent: (agentForCapability(capId)?.key ?? "supervisor") as WorkflowNode["agent"],
      action: capId,
      inputs: Object.fromEntries(Object.entries(cap.inputs).filter(([, s]) => s.default !== undefined).map(([k, s]) => [k, s.default])),
      dependsOn: anchor ? [anchor.id] : [],
      timeoutMs: cap.provider === "ai" ? 120_000 : 30_000,
      retry: write ? { maxAttempts: cap.reconcilable ? 2 : 1, backoffMs: 2000, maxBackoffMs: 10000 } : { maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 30000 },
      risk: cap.risk,
      approval: { required: write, expiresInMinutes: 1440 },
      position: anchor?.position ? { x: anchor.position.x + 300, y: anchor.position.y + 40 } : { x: 0, y: 0 },
    };
    update({ ...draft!, nodes: [...draft!.nodes, n] });
    setSelected(nid);
    setAdding(false);
  }

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col gap-4 lg:h-[calc(100vh-3rem)]">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="text-xs text-ink-3">
            <Link href="/app/workflows" className="hover:text-ink-2">Workflows</Link> / editor
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Input aria-label="Workflow name" value={draft.name} disabled={!editable} onChange={(e) => update({ ...draft, name: e.target.value })} className="h-8 w-auto min-w-[240px] border-transparent bg-transparent px-1 text-lg font-semibold hover:border-line-strong" />
            {latest ? <Badge tone="indigo">v{latest.version}</Badge> : <Badge>Unpublished</Badge>}
            {dirty ? <Badge tone="warn">Unsaved changes</Badge> : published ? <Badge tone="good" icon={<CheckCircle2 className="size-3" />}>Published</Badge> : latest ? <Badge tone="warn">Draft differs from v{latest.version}</Badge> : null}
            {errors.length > 0 ? <Badge tone="critical" icon={<TriangleAlert className="size-3" />}>{errors.length} errors</Badge> : <Badge tone="good" icon={<ShieldCheck className="size-3" />}>Valid</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {editable && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>Add step</Button>}
          <a href={`/api/v1/orgs/${orgId}/workflows/${id}/export`} download={`${draft.name}.orbix.json`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface-3 px-3 text-xs text-ink hover:border-indigo/50">
            <Download className="size-3.5" /> Export
          </a>
          {editable && <Button size="sm" icon={<Save className="size-3.5" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>Save</Button>}
          {editable && <Button size="sm" icon={<Rocket className="size-3.5" />} loading={publish.isPending} disabled={published} onClick={() => publish.mutate()}>Publish</Button>}
          <Button size="sm" icon={<FlaskConical className="size-3.5" />} onClick={() => router.push(`/app/workflows/${id}/simulate`)}>Simulate</Button>
          {can("run:execute") && <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} disabled={!published} title={published ? undefined : "Publish your changes first"} onClick={() => setRunning(true)}>Run</Button>}
        </div>
      </div>

      {q.data.mission && <p className="line-clamp-1 text-xs text-ink-3">Objective: <span className="text-ink-2">{q.data.mission.objective}</span></p>}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-h-[420px] overflow-hidden">
          <MissionGraph definition={draft} editable={editable} issuesByNode={issuesByNode} selectedId={selected} onSelect={setSelected} onChange={update} />
        </Card>
        <Card className="min-h-0 overflow-y-auto p-4">
          {node ? (
            <NodeInspector
              node={node}
              readOnly={!editable}
              issues={issues.filter((i) => i.nodeId === node.id)}
              onChange={(n) => update({ ...draft, nodes: draft.nodes.map((x) => (x.id === n.id ? n : x)) })}
              onDelete={() => {
                update({ ...draft, nodes: draft.nodes.filter((x) => x.id !== node.id).map((x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== node.id) })) });
                setSelected(null);
              }}
            />
          ) : (
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-semibold">Graph</h2>
                <p className="mt-1 text-xs leading-5 text-ink-3">Select a step to edit it. Drag between handles to add a dependency; select an edge and press Backspace to remove it. Ctrl+S saves.</p>
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold text-ink-2">Validation</h3>
                {issues.length === 0 ? (
                  <p className="flex items-center gap-2 text-xs text-good"><CheckCircle2 className="size-3.5" /> No issues found.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {issues.map((i, k) => (
                      <li key={k}>
                        <button onClick={() => i.nodeId && setSelected(i.nodeId)} className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${i.severity === "error" ? "border-critical/30 bg-critical/8 text-critical" : "border-warn/30 bg-warn/8 text-warn"}`}>
                          {i.nodeId && <span className="font-mono text-[10px] opacity-80">{i.nodeId} · </span>}
                          {i.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold text-ink-2">Versions</h3>
                <ul className="space-y-1 text-xs text-ink-3">
                  {q.data.versions.map((v) => (
                    <li key={v.id} className="flex justify-between"><span>v{v.version}</span><span>{timeAgo(v.createdAt)}</span></li>
                  ))}
                  {q.data.versions.length === 0 && <li>Not published yet.</li>}
                </ul>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a step" wide>
        <div className="grid gap-2 sm:grid-cols-2">
          {CAPABILITIES.map((c) => (
            <button key={c.id} disabled={c.availability !== "available"} onClick={() => addNode(c.id)} className="rounded-lg border border-line bg-surface p-3 text-left transition hover:border-indigo/40 disabled:cursor-not-allowed disabled:opacity-45">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{c.title}</span>
                {c.availability === "roadmap" ? <Badge>Roadmap</Badge> : <RiskBadge risk={c.risk} />}
              </div>
              <div className="mt-1 font-mono text-[10px] text-ink-3">{c.id}</div>
            </button>
          ))}
        </div>
      </Dialog>
      {running && latest && <RunDialog orgId={orgId!} workflowId={id} versionLabel={`v${latest.version}`} onClose={() => setRunning(false)} />}
    </div>
  );
}
