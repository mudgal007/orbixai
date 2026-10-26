"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FlaskConical, Radio } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button, Dialog } from "./ui";

export function RunDialog({ orgId, workflowId, versionLabel, onClose, defaultMode = "dry_run" }: { orgId: string; workflowId: string; versionLabel: string; onClose: () => void; defaultMode?: "dry_run" | "live" }) {
  const router = useRouter();
  const [mode, setMode] = useState<"dry_run" | "live">(defaultMode);
  const [blockers, setBlockers] = useState<string[]>([]);
  const run = useMutation({
    mutationFn: () => api<{ run: { id: string } }>(`/orgs/${orgId}/workflows/${workflowId}/runs`, { body: { mode } }),
    onSuccess: (r) => router.push(`/app/runs/${r.run.id}`),
    onError: (e) => {
      if (e instanceof ApiError && Array.isArray(e.details) && typeof e.details[0] === "string") setBlockers(e.details as string[]);
      toast.error(e instanceof ApiError ? e.message : "Could not start run");
    },
  });

  const options = [
    { value: "dry_run" as const, icon: FlaskConical, title: "Dry run", body: "Executes every step against sandbox connectors with real agents and approvals. No external side effects." },
    { value: "live" as const, icon: Radio, title: "Live execution", body: "Uses your connections. Externally visible actions still pause for approval of the exact payload." },
  ];

  return (
    <Dialog open onClose={onClose} title={`Run ${versionLabel}`}>
      <div className="space-y-2">
        {options.map((o) => (
          <button key={o.value} onClick={() => setMode(o.value)} className={cn("flex w-full gap-3 rounded-xl border p-3 text-left transition", mode === o.value ? "border-indigo bg-indigo/8" : "border-line hover:border-line-strong")} aria-pressed={mode === o.value}>
            <o.icon className={cn("mt-0.5 size-4 shrink-0", o.value === "live" ? "text-critical" : "text-cyan")} />
            <span>
              <span className="block text-sm font-medium">{o.title}</span>
              <span className="mt-0.5 block text-xs leading-5 text-ink-3">{o.body}</span>
            </span>
          </button>
        ))}
      </div>
      {blockers.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg border border-critical/30 bg-critical/8 p-3 text-xs text-critical">
          {blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
      <p className="mt-3 text-[11px] leading-5 text-ink-3">A dry run cannot fully predict how live third-party systems will behave.</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={mode === "live" ? "danger" : "primary"} loading={run.isPending} onClick={() => run.mutate()}>
          {mode === "live" ? "Start live run" : "Start dry run"}
        </Button>
      </div>
    </Dialog>
  );
}
