import { AlertTriangle, CheckCircle2, Circle, CircleDashed, Clock, Hourglass, Loader2, PauseCircle, RotateCw, ShieldAlert, ShieldCheck, SkipForward, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type Tone } from "./ui";

const MAP: Record<string, { tone: Tone; label: string; icon: ReactNode }> = {
  QUEUED: { tone: "neutral", label: "Queued", icon: <Clock className="size-3" /> },
  PENDING: { tone: "neutral", label: "Pending", icon: <Circle className="size-3" /> },
  READY: { tone: "indigo", label: "Ready", icon: <CircleDashed className="size-3" /> },
  RUNNING: { tone: "cyan", label: "Running", icon: <Loader2 className="size-3 animate-spin" /> },
  RETRY_SCHEDULED: { tone: "warn", label: "Retrying", icon: <RotateCw className="size-3" /> },
  WAITING_APPROVAL: { tone: "warn", label: "Awaiting approval", icon: <Hourglass className="size-3" /> },
  NEEDS_RECONCILIATION: { tone: "serious", label: "Reconciling", icon: <ShieldAlert className="size-3" /> },
  NEEDS_ATTENTION: { tone: "serious", label: "Needs attention", icon: <AlertTriangle className="size-3" /> },
  PAUSED: { tone: "neutral", label: "Paused", icon: <PauseCircle className="size-3" /> },
  SUCCEEDED: { tone: "good", label: "Succeeded", icon: <CheckCircle2 className="size-3" /> },
  FAILED: { tone: "critical", label: "Failed", icon: <XCircle className="size-3" /> },
  DEAD_LETTER: { tone: "critical", label: "Dead letter", icon: <XCircle className="size-3" /> },
  SKIPPED: { tone: "neutral", label: "Skipped", icon: <SkipForward className="size-3" /> },
  CANCELLED: { tone: "neutral", label: "Cancelled", icon: <XCircle className="size-3" /> },
  APPROVED: { tone: "good", label: "Approved", icon: <CheckCircle2 className="size-3" /> },
  CONSUMED: { tone: "good", label: "Executed", icon: <CheckCircle2 className="size-3" /> },
  REJECTED: { tone: "critical", label: "Rejected", icon: <XCircle className="size-3" /> },
  EXPIRED: { tone: "neutral", label: "Expired", icon: <Clock className="size-3" /> },
  INVALIDATED: { tone: "neutral", label: "Superseded", icon: <RotateCw className="size-3" /> },
};

export function StatusBadge({ status }: { status: string }) {
  const s = MAP[status] ?? { tone: "neutral" as Tone, label: status, icon: null };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

const OUTCOME: Record<string, { tone: Tone; label: string; icon: ReactNode; help: string }> = {
  pending: { tone: "neutral", label: "Pending", icon: <Clock className="size-3" />, help: "Run has not finished" },
  completed: { tone: "indigo", label: "Completed", icon: <CheckCircle2 className="size-3" />, help: "All tasks finished; no external writes to verify" },
  acknowledged: { tone: "cyan", label: "Acknowledged", icon: <CheckCircle2 className="size-3" />, help: "Provider returned IDs for every write; not independently verified" },
  verified: { tone: "good", label: "Verified", icon: <ShieldCheck className="size-3" />, help: "Provider state was re-read and matched the approved payload" },
  unverified: { tone: "warn", label: "Unverified", icon: <AlertTriangle className="size-3" />, help: "Evidence was insufficient to confirm the outcome" },
  failed: { tone: "critical", label: "Failed", icon: <XCircle className="size-3" />, help: "Run did not complete" },
};

export function OutcomeBadge({ outcome }: { outcome: string }) {
  const o = OUTCOME[outcome] ?? OUTCOME.pending!;
  return (
    <span title={o.help}>
      <Badge tone={o.tone} icon={o.icon}>
        {o.label}
      </Badge>
    </span>
  );
}

export function outcomeHelp(outcome: string): string {
  return (OUTCOME[outcome] ?? OUTCOME.pending!).help;
}

export function RiskBadge({ risk }: { risk: string }) {
  const tone: Tone = risk === "read" ? "neutral" : risk === "compute" ? "indigo" : risk === "internal_write" ? "cyan" : risk === "external_write" ? "warn" : "critical";
  return <Badge tone={tone}>{risk.replace("_", " ")}</Badge>;
}

export function ModeBadge({ mode }: { mode: string }) {
  return mode === "LIVE" || mode === "live" ? <Badge tone="critical">Live</Badge> : <Badge tone="cyan">Dry run</Badge>;
}
