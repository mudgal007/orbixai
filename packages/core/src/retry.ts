import type { RetryPolicy } from "./workflow";

export type FailureClass = "transient" | "rate_limited" | "permission" | "permanent" | "ambiguous";

/** Errors thrown by connectors and agents carry a deterministic classification. */
export class ExecutionError extends Error {
  constructor(
    public readonly failureClass: FailureClass,
    message: string,
    public readonly details: { retryAfterMs?: number; providerCode?: string; status?: number } = {},
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

export function classifyHttpStatus(status: number): FailureClass {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "permission";
  if (status === 408 || status >= 500) return "transient";
  return "permanent";
}

/** Exponential backoff with full jitter (AWS architecture blog), capped by policy. */
export function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxBackoffMs, policy.backoffMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * exp);
}

export type RetryDecision =
  | { action: "retry"; delayMs: number }
  | { action: "fail" }
  | { action: "dead_letter" }
  | { action: "reconcile" };

export function decideRetry(input: {
  failureClass: FailureClass;
  attempt: number;
  policy: RetryPolicy;
  retryAfterMs?: number;
  random?: () => number;
}): RetryDecision {
  const { failureClass, attempt, policy } = input;
  if (failureClass === "ambiguous") return { action: "reconcile" };
  if (failureClass === "permission" || failureClass === "permanent") return { action: "fail" };
  if (attempt >= policy.maxAttempts) return { action: "dead_letter" };
  const base = backoffDelay(policy, attempt, input.random);
  const delayMs = failureClass === "rate_limited" ? Math.max(base, input.retryAfterMs ?? 0) : base;
  return { action: "retry", delayMs };
}
