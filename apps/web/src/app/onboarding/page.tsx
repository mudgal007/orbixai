"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, GitBranch, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/logo";
import { Button, Card, Input, Label } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useUi } from "@/lib/store";

export default function Onboarding() {
  const router = useRouter();
  const qc = useQueryClient();
  const setOrgId = useUi((s) => s.setOrgId);
  const [orgId, setLocalOrg] = useState<string | null>(null);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function createOrg(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy("org");
    try {
      const res = await api<{ organization: { id: string } }>("/orgs", { body: { name: new FormData(e.currentTarget).get("name") } });
      setLocalOrg(res.organization.id);
      setOrgId(res.organization.id);
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create organization");
    } finally {
      setBusy(null);
    }
  }

  async function connect(provider: "github" | "slack") {
    if (!orgId) return;
    setBusy(provider);
    try {
      await api(`/orgs/${orgId}/connections/sandbox`, { body: { provider } });
      setConnected((c) => ({ ...c, [provider]: true }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not connect");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-8">
          <Logo />
        </div>
        <ol className="space-y-4">
          <li>
            <Card className="p-6">
              <StepTitle n={1} done={!!orgId} title="Create your organization" />
              {!orgId && (
                <form onSubmit={createOrg} className="mt-4 flex gap-2">
                  <div className="flex-1">
                    <Label htmlFor="org">Organization name</Label>
                    <Input id="org" name="name" required minLength={2} placeholder="Acme Robotics" />
                  </div>
                  <Button type="submit" variant="primary" className="self-end" loading={busy === "org"}>
                    Create
                  </Button>
                </form>
              )}
            </Card>
          </li>
          <li>
            <Card className={`p-6 ${orgId ? "" : "opacity-50"}`}>
              <StepTitle n={2} done={!!connected.github && !!connected.slack} title="Connect your tools" />
              <p className="mt-2 text-xs leading-5 text-ink-3">
                Sandbox connectors behave like GitHub and Slack using seeded data and never touch real accounts. Connect real accounts later from Integrations.
              </p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {(["github", "slack"] as const).map((p) => (
                  <Button key={p} disabled={!orgId || connected[p]} loading={busy === p} onClick={() => connect(p)} icon={connected[p] ? <Check className="size-4 text-good" /> : p === "github" ? <GitBranch className="size-4" /> : <MessageSquare className="size-4" />}>
                    {connected[p] ? `${p === "github" ? "GitHub" : "Slack"} sandbox connected` : `Connect ${p === "github" ? "GitHub" : "Slack"} sandbox`}
                  </Button>
                ))}
              </div>
            </Card>
          </li>
          <li>
            <Card className={`p-6 ${orgId ? "" : "opacity-50"}`}>
              <StepTitle n={3} done={false} title="Describe your first mission" />
              <Button variant="primary" className="mt-4" disabled={!orgId} onClick={() => router.push("/app/missions/new")}>
                Open mission composer
              </Button>
            </Card>
          </li>
        </ol>
      </div>
    </div>
  );
}

function StepTitle({ n, done, title }: { n: number; done: boolean; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`grid size-6 place-items-center rounded-full text-xs font-semibold ${done ? "bg-good/20 text-good" : "bg-indigo/15 text-indigo"}`}>{done ? <Check className="size-3.5" /> : n}</span>
      <h2 className="text-sm font-semibold">{title}</h2>
    </div>
  );
}
