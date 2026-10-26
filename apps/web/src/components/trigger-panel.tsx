"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Hand, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { CRON_PRESETS, checkCron, nextRuns, type WorkflowDefinition } from "@orbix/core";
import { api, ApiError } from "@/lib/api";
import { timeAgo, timeUntil } from "@/lib/format";
import { Badge, Button, Input, Label, Select } from "./ui";

interface Schedule {
  enabled: boolean;
  mode: "DRY_RUN" | "LIVE";
  cron: string;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastError: string | null;
  upcoming: string[];
}

const COMMON_TZ = ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];

function fmt(d: Date | string, tz: string) {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(d));
}

/** Trigger editor (draft) + schedule activation (published). */
export function TriggerPanel({ orgId, workflowId, draft, editable, canRun, published, onChange }: { orgId: string; workflowId: string; draft: WorkflowDefinition; editable: boolean; canRun: boolean; published: boolean; onChange: (def: WorkflowDefinition) => void }) {
  const qc = useQueryClient();
  const trigger = draft.trigger;
  const q = useQuery({ queryKey: ["schedule", orgId, workflowId], queryFn: () => api<{ schedule: Schedule | null }>(`/orgs/${orgId}/workflows/${workflowId}/schedule`) });
  const schedule = q.data?.schedule ?? null;

  const preview = useMemo(() => {
    if (trigger.type !== "schedule") return null;
    const check = checkCron(trigger.cron, trigger.timezone);
    if (!check.ok) return { error: check.reason, runs: [] as Date[] };
    return { error: null, runs: nextRuns(trigger.cron, trigger.timezone, 3) };
  }, [trigger]);

  const update = useMutation({
    mutationFn: (body: { enabled?: boolean; mode?: "dry_run" | "live" }) => api<{ schedule: Schedule }>(`/orgs/${orgId}/workflows/${workflowId}/schedule`, { method: "PUT", body }),
    onSuccess: (r) => {
      qc.setQueryData(["schedule", orgId, workflowId], r);
      qc.invalidateQueries({ queryKey: ["workflows"] });
      toast.success(r.schedule.enabled ? `Schedule active (${r.schedule.mode === "LIVE" ? "live" : "dry run"})` : "Schedule paused");
    },
    onError: (e) => {
      const details = e instanceof ApiError && Array.isArray(e.details) ? ` — ${(e.details as string[]).join("; ")}` : "";
      toast.error((e instanceof ApiError ? e.message : "Update failed") + details);
    },
  });

  const setTrigger = (t: WorkflowDefinition["trigger"]) => onChange({ ...draft, trigger: t });
  const pendingPublish = schedule && trigger.type === "schedule" && (schedule.cron !== trigger.cron || schedule.timezone !== trigger.timezone);

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold text-ink-2"><CalendarClock className="size-3.5" /> Trigger</h3>
      <Select
        id="trigger-type"
        value={trigger.type === "schedule" ? "schedule" : "manual"}
        disabled={!editable}
        onChange={(v) => setTrigger(v === "schedule" ? { type: "schedule", cron: "0 9 * * 1-5", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } : { type: "manual" })}
        options={[{ value: "manual", label: "Manual — run on demand" }, { value: "schedule", label: "Schedule — run on a cron" }]}
      />

      {trigger.type === "schedule" && (
        <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
          <div>
            <Label htmlFor="cron-preset">Preset</Label>
            <Select
              id="cron-preset"
              disabled={!editable}
              value={CRON_PRESETS.find((p) => p.cron === trigger.cron)?.cron ?? ""}
              onChange={(v) => v && setTrigger({ ...trigger, cron: v })}
              options={[{ value: "", label: "Custom" }, ...CRON_PRESETS.map((p) => ({ value: p.cron, label: p.label }))]}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="cron">Cron</Label>
              <Input id="cron" value={trigger.cron} disabled={!editable} onChange={(e) => setTrigger({ ...trigger, cron: e.target.value })} className="font-mono text-xs" />
            </div>
            <div>
              <Label htmlFor="tz">Timezone</Label>
              <Input id="tz" list="tz-list" value={trigger.timezone} disabled={!editable} onChange={(e) => setTrigger({ ...trigger, timezone: e.target.value })} className="text-xs" />
              <datalist id="tz-list">{COMMON_TZ.map((z) => <option key={z} value={z} />)}</datalist>
            </div>
          </div>
          {preview?.error ? (
            <p role="alert" className="flex gap-1.5 text-[11px] text-critical"><AlertTriangle className="mt-0.5 size-3 shrink-0" />{preview.error}</p>
          ) : (
            <div className="text-[11px] text-ink-3">
              Next runs:
              <ul className="mt-1 space-y-0.5 text-ink-2">{preview?.runs.map((d) => <li key={d.toISOString()}>{fmt(d, trigger.timezone)}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {trigger.type !== "schedule" && !schedule && <p className="flex items-center gap-1.5 text-[11px] text-ink-3"><Hand className="size-3" /> Runs start only when someone clicks Run or calls the API.</p>}

      {trigger.type === "schedule" && !schedule && <p className="text-[11px] text-ink-3">{published ? "Publish again to create the schedule." : "Publish to create the schedule. It starts paused until you activate it."}</p>}
      {pendingPublish && <p className="text-[11px] text-warn">Publish to apply the new cron/timezone to the active schedule.</p>}
      {schedule && trigger.type !== "schedule" && <p className="text-[11px] text-warn">Publishing will remove the existing schedule.</p>}

      {schedule && (
        <div className="space-y-2.5 rounded-lg border border-line bg-surface-2 p-3">
          <div className="flex items-center gap-2">
            {schedule.enabled ? <Badge tone="good">Active</Badge> : <Badge>Paused</Badge>}
            {schedule.mode === "LIVE" ? <Badge tone="critical">Live</Badge> : <Badge tone="cyan">Dry run</Badge>}
            <span className="ml-auto font-mono text-[10px] text-ink-3">{schedule.cron} · {schedule.timezone}</span>
          </div>
          {schedule.enabled && schedule.nextRunAt && <div className="text-xs text-ink-2">Next run {timeUntil(schedule.nextRunAt)} · {fmt(schedule.nextRunAt, schedule.timezone)}</div>}
          {schedule.lastRunAt && (
            <div className="text-[11px] text-ink-3">
              Last fired {timeAgo(schedule.lastRunAt)}
              {schedule.lastRunId && <> · <Link href={`/app/runs/${schedule.lastRunId}`} className="text-indigo hover:underline">view run</Link></>}
            </div>
          )}
          {schedule.lastError && <p className="text-[11px] text-warn">{schedule.lastError}</p>}
          {canRun && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Select
                id="schedule-mode"
                className="h-8 w-28 text-xs"
                value={schedule.mode === "LIVE" ? "live" : "dry_run"}
                onChange={(v) => update.mutate({ mode: v as "dry_run" | "live" })}
                options={[{ value: "dry_run", label: "Dry run" }, { value: "live", label: "Live" }]}
              />
              {schedule.enabled ? (
                <Button size="sm" icon={<Pause className="size-3.5" />} loading={update.isPending} onClick={() => update.mutate({ enabled: false })}>Pause</Button>
              ) : (
                <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={update.isPending} onClick={() => update.mutate({ enabled: true })}>Activate</Button>
              )}
            </div>
          )}
          <p className="text-[10px] leading-4 text-ink-3">Scheduled runs still pause for approval before any external write. A slot is skipped while the previous scheduled run is still active; missed slots are not replayed.</p>
        </div>
      )}
    </div>
  );
}
