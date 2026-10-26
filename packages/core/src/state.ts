export const RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "PAUSED",
  "NEEDS_ATTENTION",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TASK_STATUSES = [
  "PENDING",
  "READY",
  "RUNNING",
  "RETRY_SCHEDULED",
  "WAITING_APPROVAL",
  "NEEDS_RECONCILIATION",
  "SUCCEEDED",
  "FAILED",
  "DEAD_LETTER",
  "SKIPPED",
  "CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  QUEUED: ["RUNNING", "PAUSED", "CANCELLED"],
  RUNNING: ["WAITING_APPROVAL", "PAUSED", "NEEDS_ATTENTION", "SUCCEEDED", "FAILED", "CANCELLED"],
  WAITING_APPROVAL: ["RUNNING", "PAUSED", "FAILED", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED"],
  NEEDS_ATTENTION: ["RUNNING", "FAILED", "CANCELLED"],
  FAILED: ["RUNNING"],
  SUCCEEDED: [],
  CANCELLED: [],
};

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ["READY", "SKIPPED", "CANCELLED"],
  READY: ["RUNNING", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "RETRY_SCHEDULED", "WAITING_APPROVAL", "DEAD_LETTER", "NEEDS_RECONCILIATION", "READY", "CANCELLED"],
  RETRY_SCHEDULED: ["RUNNING", "READY", "CANCELLED"],
  WAITING_APPROVAL: ["READY", "FAILED", "CANCELLED"],
  NEEDS_RECONCILIATION: ["SUCCEEDED", "READY", "FAILED", "CANCELLED"],
  FAILED: ["READY"],
  DEAD_LETTER: ["READY"],
  SUCCEEDED: [],
  SKIPPED: [],
  CANCELLED: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(kind: "run" | "task", from: string, to: string) {
    super(`Illegal ${kind} transition ${from} → ${to}`);
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) throw new IllegalTransitionError("run", from, to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new IllegalTransitionError("task", from, to);
}

export const TERMINAL_TASK: readonly TaskStatus[] = ["SUCCEEDED", "FAILED", "DEAD_LETTER", "SKIPPED", "CANCELLED"];
export const TERMINAL_RUN: readonly RunStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED"];

export type OutcomeStatus = "pending" | "completed" | "acknowledged" | "verified" | "unverified" | "failed";
