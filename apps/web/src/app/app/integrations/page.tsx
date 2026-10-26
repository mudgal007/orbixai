"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, KeyRound, Link2, Plug, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { RiskBadge } from "@/components/status";
import { Badge, Button, Card, Dialog, ErrorState, Input, Label, Skeleton } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useOrg } from "@/lib/hooks";

interface Integration {
  provider: string;
  name: string;
  status: "available" | "roadmap";
  authType: string;
  oauthConfigured: boolean;
  capabilities: Array<{ id: string; title: string; risk: string; availability: string; scopes: string[] }>;
}
interface Connection {
  id: string;
  provider: string;
  label: string;
  mode: "SANDBOX" | "LIVE";
  status: string;
  scopes: string[];
  account: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: string;
}

export default function IntegrationsPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const params = useSearchParams();
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["integrations", orgId], queryFn: () => api<{ integrations: Integration[]; connections: Connection[] }>(`/orgs/${orgId}/integrations`) });
  const manage = can("connection:manage");

  useEffect(() => {
    if (params.get("connected")) toast.success(`${params.get("connected")} connected`);
    if (params.get("error")) toast.error(`Connection failed: ${params.get("error")}`);
  }, [params]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["integrations", orgId] });
  const sandbox = useMutation({ mutationFn: (provider: string) => api(`/orgs/${orgId}/connections/sandbox`, { body: { provider } }), onSuccess: refresh, onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed") });
  const revoke = useMutation({
    mutationFn: (id: string) => api<{ providerRevoked: boolean }>(`/orgs/${orgId}/connections/${id}`, { method: "DELETE" }),
    onSuccess: (r) => {
      toast.success(r.providerRevoked ? "Revoked at provider and deleted locally" : "Credential deleted");
      refresh();
    },
  });
  const oauth = useMutation({
    mutationFn: (provider: string) => api<{ url: string }>(`/orgs/${orgId}/connections/oauth/${provider}/start`),
    onSuccess: (r) => (window.location.href = r.url),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "OAuth unavailable"),
  });

  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const active = q.data.connections.filter((c) => c.status === "ACTIVE");

  return (
    <div className="space-y-6">
      <PageHeader title="Integration hub" description="Credentials are encrypted (AES-256-GCM), brokered per call, and never shown to models. Only integrations with working auth and operations are marked available." />

      <section>
        <h2 className="mb-3 text-sm font-semibold">Active connections</h2>
        {active.length === 0 ? (
          <Card className="p-5 text-sm text-ink-3">No active connections yet.</Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {active.map((c) => (
              <Card key={c.id} className="flex items-start gap-3 p-4">
                <span className="grid size-9 place-items-center rounded-lg bg-indigo/10 text-indigo"><Plug className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{c.label}</span>
                    {c.mode === "LIVE" ? <Badge tone="good">live</Badge> : <Badge tone="cyan">sandbox</Badge>}
                  </div>
                  <div className="mt-1 text-[11px] text-ink-3">{c.mode === "LIVE" ? `Scopes: ${c.scopes.join(", ") || "—"}` : "Seeded mock data · no external calls"} · {timeAgo(c.createdAt)}</div>
                </div>
                {manage && (
                  <Button size="sm" variant="ghost" aria-label={`Revoke ${c.label}`} icon={<Trash2 className="size-3.5" />} onClick={() => confirm(`Revoke ${c.label}?`) && revoke.mutate(c.id)} />
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Marketplace</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {q.data.integrations.map((i) => (
            <Card key={i.provider} className={`flex flex-col p-4 ${i.status === "roadmap" ? "opacity-70" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{i.name}</span>
                {i.status === "available" ? <Badge tone="good" icon={<ShieldCheck className="size-3" />}>Available</Badge> : <Badge>Roadmap</Badge>}
              </div>
              <ul className="mt-3 flex-1 space-y-1.5">
                {i.capabilities.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-xs text-ink-2">
                    <span className="truncate">{c.title}</span>
                    <span className="ml-auto">{c.availability === "available" && <RiskBadge risk={c.risk} />}</span>
                  </li>
                ))}
              </ul>
              {i.status === "available" && manage && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" icon={<FlaskConical className="size-3.5" />} loading={sandbox.isPending && sandbox.variables === i.provider} onClick={() => sandbox.mutate(i.provider)}>Sandbox</Button>
                  <Button size="sm" icon={<Link2 className="size-3.5" />} disabled={!i.oauthConfigured} title={i.oauthConfigured ? undefined : `Set ${i.provider.toUpperCase()}_CLIENT_ID/SECRET to enable OAuth`} onClick={() => oauth.mutate(i.provider)}>OAuth</Button>
                  <Button size="sm" icon={<KeyRound className="size-3.5" />} onClick={() => setTokenFor(i.provider)}>Token</Button>
                </div>
              )}
              {i.status === "available" && !i.oauthConfigured && <p className="mt-2 text-[10px] text-ink-3">OAuth app not configured on this server.</p>}
            </Card>
          ))}
        </div>
      </section>
      {tokenFor && <TokenDialog provider={tokenFor} orgId={orgId!} onClose={() => setTokenFor(null)} onDone={refresh} />}
    </div>
  );
}

function TokenDialog({ provider, orgId, onClose, onDone }: { provider: string; orgId: string; onClose: () => void; onDone: () => void }) {
  const [token, setToken] = useState("");
  const m = useMutation({
    mutationFn: () => api(`/orgs/${orgId}/connections/token`, { body: { provider, token } }),
    onSuccess: () => {
      toast.success("Connected — token verified with the provider");
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Token rejected"),
  });
  return (
    <Dialog open onClose={onClose} title={`Connect ${provider === "github" ? "GitHub" : "Slack"} with a token`}>
      <p className="text-xs leading-5 text-ink-3">
        {provider === "github" ? "Paste a personal access token with the repo scope (or a fine-grained token with Issues read)." : "Paste a bot token (xoxb-…) with chat:write, channels:read and channels:history."} The token is verified with the provider, encrypted at rest, and never displayed again.
      </p>
      <div className="mt-4">
        <Label htmlFor="tok">Token</Label>
        <Input id="tok" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={m.isPending} disabled={token.length < 10} onClick={() => m.mutate()}>Verify &amp; connect</Button>
      </div>
    </Dialog>
  );
}
