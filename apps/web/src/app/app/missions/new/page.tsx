"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, CornerDownLeft, FlaskConical, Info, PencilRuler, Sparkles, User } from "lucide-react";
import { toast } from "sonner";
import type { ValidationIssue, WorkflowDefinition } from "@orbix/core";
import { MissionGraph } from "@/components/mission-graph";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useOrg } from "@/lib/hooks";

const EXAMPLES = [
  "Find GitHub issues assigned to me that have not been updated for seven days, summarize each issue, create a follow-up plan, and draft a Slack update for approval.",
  "Every morning, find GitHub issues assigned to me that are stale for 3 days and post a prioritized plan to #eng-updates in Slack.",
  "Summarize what our knowledge base says about gripper calibration and draft a Slack note for the field team.",
];

interface PlanResponse {
  mission: { id: string; objective: string };
  workflow: { id: string; name: string; draft: WorkflowDefinition };
  planner: string;
  notes: string[];
  issues: ValidationIssue[];
}

export default function NewMissionPage() {
  return (
    <Suspense>
      <NewMission />
    </Suspense>
  );
}

function NewMission() {
  const { orgId } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const [objective, setObjective] = useState(params.get("q") ?? "");
  const [result, setResult] = useState<PlanResponse | null>(null);

  const missions = useQuery({
    queryKey: ["missions", orgId],
    queryFn: () => api<{ missions: Array<{ id: string; objective: string; createdAt: string; workflow: { id: string; name: string } }> }>(`/orgs/${orgId}/missions`),
  });

  const plan = useMutation({
    mutationFn: (text: string) => api<PlanResponse>(`/orgs/${orgId}/missions/plan`, { body: { objective: text } }),
    onSuccess: (r) => {
      setResult(r);
      missions.refetch();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Planning failed"),
  });

  const submit = () => objective.trim().length >= 10 && plan.mutate(objective.trim());
  const errors = result?.issues.filter((i) => i.severity === "error") ?? [];

  return (
    <div>
      <PageHeader title="New mission" description="Describe the outcome you want. ORBIX compiles it into an editable execution graph — nothing runs until you simulate and approve." />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex gap-3">
              <div className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-ink-2">
                <User className="size-4" />
              </div>
              <div className="flex-1">
                <label htmlFor="objective" className="sr-only">Objective</label>
                <Textarea
                  id="objective"
                  rows={4}
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
                  }}
                  placeholder="e.g. Find GitHub issues assigned to me with no update in 7 days, summarize them, and draft a Slack update for my approval."
                  className="resize-none border-0 bg-transparent px-0 text-[15px] focus:ring-0"
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-ink-3">
                    <CornerDownLeft className="mr-1 inline size-3" /> Ctrl+Enter to plan
                  </span>
                  <Button variant="primary" icon={<Sparkles className="size-4" />} loading={plan.isPending} disabled={objective.trim().length < 10} onClick={submit}>
                    Generate plan
                  </Button>
                </div>
              </div>
            </div>
          </Card>

          {!result && !plan.isPending && (
            <div className="grid gap-2 md:grid-cols-3">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => setObjective(ex)} className="glass rounded-xl p-3 text-left text-xs leading-5 text-ink-2 transition hover:border-indigo/40 hover:text-ink">
                  {ex}
                </button>
              ))}
            </div>
          )}

          {plan.isPending && (
            <Card className="flex items-center gap-3 p-4 text-sm text-ink-2">
              <Bot className="size-4 animate-pulse text-indigo" /> Discovering capabilities, selecting agents, and validating the graph…
            </Card>
          )}

          {result && (
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
                <div className="grid size-8 place-items-center rounded-full bg-indigo/15 text-indigo">
                  <Bot className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{result.workflow.name}</div>
                  <div className="text-xs text-ink-3">
                    {result.workflow.draft.nodes.length} steps · planner <span className="font-mono">{result.planner}</span>
                  </div>
                </div>
                {errors.length ? <Badge tone="critical">{errors.length} validation errors</Badge> : <Badge tone="good">Valid graph</Badge>}
              </div>
              {result.planner === "orbix-heuristic" && (
                <p className="flex items-start gap-2 border-b border-line bg-indigo/5 px-4 py-2.5 text-xs text-ink-2">
                  <Info className="mt-0.5 size-3.5 shrink-0 text-indigo" /> No LLM is configured, so the deterministic template planner was used. Set <code className="font-mono">ORBIX_LLM_API_KEY</code> to enable model planning.
                </p>
              )}
              {result.notes.length > 0 && (
                <ul className="space-y-1 border-b border-line px-4 py-3 text-xs text-ink-2">
                  {result.notes.map((n) => (
                    <li key={n} className="flex gap-2">
                      <Info className="mt-0.5 size-3.5 shrink-0 text-warn" /> {n}
                    </li>
                  ))}
                </ul>
              )}
              <div className="h-[420px]">
                <MissionGraph definition={result.workflow.draft} />
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-line p-4">
                <Button icon={<FlaskConical className="size-4" />} onClick={() => router.push(`/app/workflows/${result.workflow.id}/simulate`)}>
                  Simulate
                </Button>
                <Button variant="primary" icon={<PencilRuler className="size-4" />} onClick={() => router.push(`/app/workflows/${result.workflow.id}`)}>
                  Review &amp; edit
                </Button>
              </div>
            </Card>
          )}
        </div>

        <Card className="h-fit">
          <div className="px-4 pt-4 text-sm font-semibold">Recent missions</div>
          <ul className="mt-2 divide-y divide-line">
            {(missions.data?.missions ?? []).slice(0, 8).map((m) => (
              <li key={m.id}>
                <Link href={`/app/workflows/${m.workflow.id}`} className="group block px-4 py-3 hover:bg-surface-3/50">
                  <div className="line-clamp-2 text-xs leading-5 text-ink-2 group-hover:text-ink">{m.objective}</div>
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-3">
                    {timeAgo(m.createdAt)} <ArrowRight className="ml-auto size-3 opacity-0 transition group-hover:opacity-100" />
                  </div>
                </Link>
              </li>
            ))}
            {missions.data?.missions.length === 0 && <li className="px-4 py-6 text-center text-xs text-ink-3">No missions yet.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
