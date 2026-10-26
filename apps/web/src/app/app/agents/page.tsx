"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot, Lock } from "lucide-react";
import { AGENT_META } from "@/components/mission-graph";
import { PageHeader } from "@/components/page-header";
import { RiskBadge } from "@/components/status";
import { Badge, Card, ErrorState, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { useOrg } from "@/lib/hooks";

interface Agent {
  key: string;
  name: string;
  description: string;
  version: number;
  tools: Array<{ id: string; title: string; risk?: string; availability: string }>;
  stats: { tasks: number; succeeded: number };
}

export default function AgentsPage() {
  const { orgId } = useOrg();
  const q = useQuery({ queryKey: ["agents", orgId], queryFn: () => api<{ agents: Agent[] }>(`/orgs/${orgId}/agents`) });
  return (
    <div>
      <PageHeader title="Agent directory" description="Specialised workers routed deterministically by the orchestrator. Each agent can only call the tools on its allowlist — enforced by backend policy, not the model." />
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !q.data ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {q.data.agents.map((a) => {
            const meta = AGENT_META[a.key];
            const Icon = meta?.icon ?? Bot;
            return (
              <Card key={a.key} className="flex flex-col p-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 place-items-center rounded-lg" style={{ background: `${meta?.color ?? "#7c83ff"}1f`, color: meta?.color }}>
                    <Icon className="size-4" />
                  </span>
                  <div>
                    <div className="text-sm font-semibold">{a.name}</div>
                    <div className="text-[11px] text-ink-3">v{a.version} · {a.stats.tasks} tasks · {a.stats.tasks ? Math.round((a.stats.succeeded / a.stats.tasks) * 100) : 0}% ok</div>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-5 text-ink-2">{a.description}</p>
                <div className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-ink-3"><Lock className="size-3" /> Tool allowlist</div>
                <ul className="mt-1.5 space-y-1">
                  {a.tools.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 text-xs">
                      <span className={t.availability === "available" ? "text-ink-2" : "text-ink-3 line-through decoration-ink-3/50"}>{t.title}</span>
                      <span className="ml-auto">{t.availability === "roadmap" ? <Badge>roadmap</Badge> : t.risk && <RiskBadge risk={t.risk} />}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
