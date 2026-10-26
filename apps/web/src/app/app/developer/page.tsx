"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, KeyRound, Plus, Trash2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, CardHeader, Dialog, Input, Label, Select, Skeleton } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useOrg } from "@/lib/hooks";

interface Key { id: string; name: string; prefix: string; role: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
interface Hook { id: string; url: string; events: string[]; active: boolean; lastDeliveryAt: string | null; lastStatus: number | null }

export default function DeveloperPage() {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyRole, setKeyRole] = useState("operator");
  const [hookUrl, setHookUrl] = useState("");
  const allowed = can("apikey:manage");
  const keys = useQuery({ queryKey: ["keys", orgId], queryFn: () => api<{ keys: Key[] }>(`/orgs/${orgId}/api-keys`), enabled: allowed });
  const hooks = useQuery({ queryKey: ["hooks", orgId], queryFn: () => api<{ webhooks: Hook[] }>(`/orgs/${orgId}/webhooks`), enabled: allowed });
  const err = (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Request failed");

  const createKey = useMutation({
    mutationFn: () => api<{ key: string }>(`/orgs/${orgId}/api-keys`, { body: { name: keyName, role: keyRole } }),
    onSuccess: (r) => { setSecret({ title: "API key created", value: r.key }); setKeyName(""); qc.invalidateQueries({ queryKey: ["keys", orgId] }); },
    onError: err,
  });
  const revokeKey = useMutation({ mutationFn: (id: string) => api(`/orgs/${orgId}/api-keys/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["keys", orgId] }), onError: err });
  const createHook = useMutation({
    mutationFn: () => api<{ secret: string }>(`/orgs/${orgId}/webhooks`, { body: { url: hookUrl, events: ["run.completed", "run.failed", "approval.requested"] } }),
    onSuccess: (r) => { setSecret({ title: "Webhook signing secret", value: r.secret }); setHookUrl(""); qc.invalidateQueries({ queryKey: ["hooks", orgId] }); },
    onError: err,
  });
  const deleteHook = useMutation({ mutationFn: (id: string) => api(`/orgs/${orgId}/webhooks/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["hooks", orgId] }), onError: err });

  const curl = `curl -X POST http://localhost:4000/v1/orgs/${orgId}/missions/plan \\\n  -H "Authorization: Bearer $ORBIX_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"objective":"Find stale GitHub issues and draft a Slack update"}'`;

  return (
    <div className="space-y-6">
      <PageHeader title="Developer platform" description="Create and monitor missions programmatically. Every endpoint is documented in OpenAPI and validated with the same Zod contracts the console uses." actions={<a href="http://localhost:4000/docs" target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface-3 px-4 text-sm hover:border-indigo/50">OpenAPI docs <ExternalLink className="size-3.5" /></a>} />
      <Card className="p-5">
        <h3 className="text-sm font-semibold">Quick start</h3>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-bg/70 p-3 font-mono text-[11px] leading-5 text-ink-2">{curl}</pre>
        <p className="mt-2 text-xs text-ink-3">Workflow JSON Schema: <a className="font-mono text-indigo hover:underline" href="/api/v1/schemas/workflow.json" target="_blank">/v1/schemas/workflow.json</a> · Run events stream as SSE at <code className="font-mono">/v1/orgs/:org/runs/:id/events</code> · TypeScript SDK in <code className="font-mono">packages/sdk</code>.</p>
      </Card>

      {!allowed ? <Card className="p-5 text-sm text-ink-3">Your role cannot manage API keys or webhooks.</Card> : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="API keys" description="Org-bound bearer tokens. Shown once; stored as SHA-256." />
            <div className="flex flex-wrap items-end gap-2 p-5 pb-3">
              <div className="min-w-[160px] flex-1"><Label htmlFor="kn">Name</Label><Input id="kn" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="CI pipeline" /></div>
              <div className="w-32"><Label htmlFor="kr">Role</Label><Select id="kr" value={keyRole} onChange={setKeyRole} options={[{ value: "viewer", label: "Viewer" }, { value: "operator", label: "Operator" }, { value: "admin", label: "Admin" }]} /></div>
              <Button variant="primary" icon={<Plus className="size-4" />} disabled={!keyName} loading={createKey.isPending} onClick={() => createKey.mutate()}>Create</Button>
            </div>
            {!keys.data ? <Skeleton className="m-5 h-20" /> : (
              <ul className="divide-y divide-line px-2 pb-2">
                {keys.data.keys.map((k) => (
                  <li key={k.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <KeyRound className="size-4 text-ink-3" />
                    <div className="min-w-0 flex-1"><div className="truncate">{k.name} <span className="font-mono text-xs text-ink-3">{k.prefix}…</span></div><div className="text-[11px] text-ink-3">{k.role} · last used {timeAgo(k.lastUsedAt)}</div></div>
                    {k.revokedAt ? <Badge>revoked</Badge> : <Button size="sm" variant="ghost" aria-label={`Revoke ${k.name}`} icon={<Trash2 className="size-3.5" />} onClick={() => confirm(`Revoke ${k.name}?`) && revokeKey.mutate(k.id)} />}
                  </li>
                ))}
                {keys.data.keys.length === 0 && <li className="px-3 py-4 text-xs text-ink-3">No keys yet.</li>}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Webhooks" description="Signed with HMAC-SHA256 (X-Orbix-Signature: t=…,v1=…). Private network targets are blocked." />
            <div className="flex items-end gap-2 p-5 pb-3">
              <div className="flex-1"><Label htmlFor="wu">Endpoint URL</Label><Input id="wu" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://example.com/orbix" /></div>
              <Button variant="primary" icon={<Webhook className="size-4" />} disabled={!hookUrl} loading={createHook.isPending} onClick={() => createHook.mutate()}>Add</Button>
            </div>
            {!hooks.data ? <Skeleton className="m-5 h-20" /> : (
              <ul className="divide-y divide-line px-2 pb-2">
                {hooks.data.webhooks.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1"><div className="truncate font-mono text-xs">{h.url}</div><div className="text-[11px] text-ink-3">{h.events.join(", ")} · last {h.lastStatus ?? "never"} {h.lastDeliveryAt ? timeAgo(h.lastDeliveryAt) : ""}</div></div>
                    <Button size="sm" variant="ghost" aria-label="Delete webhook" icon={<Trash2 className="size-3.5" />} onClick={() => deleteHook.mutate(h.id)} />
                  </li>
                ))}
                {hooks.data.webhooks.length === 0 && <li className="px-3 py-4 text-xs text-ink-3">No webhooks.</li>}
              </ul>
            )}
          </Card>
        </div>
      )}
      <Dialog open={!!secret} onClose={() => setSecret(null)} title={secret?.title ?? ""}>
        <p className="text-xs text-ink-3">Copy it now — it will not be shown again.</p>
        <div className="mt-3 flex gap-2">
          <Input readOnly value={secret?.value ?? ""} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label="Secret value" />
          <Button icon={<Copy className="size-4" />} onClick={() => { navigator.clipboard.writeText(secret?.value ?? ""); toast.success("Copied"); }}>Copy</Button>
        </div>
      </Dialog>
    </div>
  );
}
