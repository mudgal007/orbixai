"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, CardHeader, Input, Label, Select, Skeleton } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useOrg } from "@/lib/hooks";

interface Members {
  members: Array<{ id: string; user: { id: string; name: string; email: string }; role: string; joinedAt: string }>;
  roles: Array<{ key: string; name: string; permissions: string[] }>;
}

const PERMS = ["workflow:read", "workflow:write", "run:execute", "approval:decide", "connection:manage", "knowledge:write", "member:read", "member:manage", "apikey:manage", "audit:read", "org:manage"];

export default function SettingsPage() {
  const { orgId, org, role, can, me } = useOrg();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState("operator");
  const q = useQuery({ queryKey: ["members", orgId], queryFn: () => api<Members>(`/orgs/${orgId}/members`) });
  const orgQ = useQuery({ queryKey: ["org", orgId], queryFn: () => api<{ organization: { slug: string; createdAt: string; subscription: { plan: string; runBudgetUsd: number; monthlyBudgetUsd: number } | null } }>(`/orgs/${orgId}`) });
  const add = useMutation({
    mutationFn: () => api(`/orgs/${orgId}/members`, { body: { email, role: newRole } }),
    onSuccess: () => { toast.success("Member added"); setEmail(""); qc.invalidateQueries({ queryKey: ["members", orgId] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not add member"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/orgs/${orgId}/members/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", orgId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not remove member"),
  });
  const sub = orgQ.data?.organization.subscription;

  return (
    <div className="space-y-6">
      <PageHeader title={org?.name ?? "Organization"} description={`Your role: ${role}. All data in this organization is isolated from every other tenant.`} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5"><div className="text-xs text-ink-3">Slug</div><div className="mt-1 font-mono text-sm">{orgQ.data?.organization.slug ?? "…"}</div></Card>
        <Card className="p-5"><div className="text-xs text-ink-3">Plan</div><div className="mt-1 text-sm capitalize">{sub?.plan ?? "…"}</div><div className="mt-1 text-[11px] text-ink-3">Billing provider integration is on the roadmap.</div></Card>
        <Card className="p-5"><div className="text-xs text-ink-3">Budgets</div><div className="mt-1 text-sm">${sub?.runBudgetUsd.toFixed(2) ?? "…"} per run · ${sub?.monthlyBudgetUsd.toFixed(2) ?? "…"} / month</div><div className="mt-1 text-[11px] text-ink-3">Per-run model budget is enforced before every model call.</div></Card>
      </div>
      <Card>
        <CardHeader title="Members" description="Existing ORBIX users can be added by email. Email invitations are on the roadmap." />
        {can("member:manage") && (
          <div className="flex flex-wrap items-end gap-2 p-5 pb-2">
            <div className="min-w-[220px] flex-1"><Label htmlFor="me">Email</Label><Input id="me" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="w-36"><Label htmlFor="mr">Role</Label><Select id="mr" value={newRole} onChange={setNewRole} options={["admin", "operator", "approver", "viewer"].map((r) => ({ value: r, label: r }))} /></div>
            <Button variant="primary" icon={<UserPlus className="size-4" />} disabled={!email} loading={add.isPending} onClick={() => add.mutate()}>Add</Button>
          </div>
        )}
        {!q.data ? <Skeleton className="m-5 h-24" /> : (
          <ul className="divide-y divide-line px-2 pb-2">
            {q.data.members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-3 py-3 text-sm">
                <div className="grid size-8 place-items-center rounded-full bg-surface-3 text-xs font-semibold">{m.user.name[0]?.toUpperCase()}</div>
                <div className="min-w-0 flex-1"><div className="truncate">{m.user.name} {m.user.id === me.data?.user.id && <span className="text-xs text-ink-3">(you)</span>}</div><div className="truncate text-xs text-ink-3">{m.user.email} · joined {timeAgo(m.joinedAt)}</div></div>
                <Badge tone={m.role === "owner" ? "indigo" : "neutral"}>{m.role}</Badge>
                {can("member:manage") && m.user.id !== me.data?.user.id && <Button size="sm" variant="ghost" aria-label={`Remove ${m.user.name}`} icon={<X className="size-3.5" />} onClick={() => confirm(`Remove ${m.user.name}?`) && remove.mutate(m.id)} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {q.data && (
        <Card className="overflow-x-auto">
          <CardHeader title="Role permissions" description="Enforced by the API guard on every request; the UI only mirrors them." />
          <table className="mt-3 w-full min-w-[720px] text-left text-xs">
            <thead className="text-ink-3"><tr><th className="px-5 py-2 font-medium">Permission</th>{q.data.roles.map((r) => <th key={r.key} className="px-3 py-2 text-center font-medium">{r.name}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {PERMS.map((p) => (
                <tr key={p}><td className="px-5 py-2 font-mono text-ink-2">{p}</td>{q.data.roles.map((r) => <td key={r.key} className="px-3 py-2 text-center">{r.permissions.includes(p) ? <Check className="mx-auto size-3.5 text-good" aria-label="granted" /> : <span className="text-ink-3" aria-label="not granted">·</span>}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
