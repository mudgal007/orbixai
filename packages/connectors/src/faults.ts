import { ExecutionError, type FailureClass } from "@orbix/core";

/**
 * Sandbox fault injection for recovery testing. Configure with
 * ORBIX_SANDBOX_FAULTS="slack.message.post:ambiguous_after_write:1,github.issues.list_stale_assigned:transient:2"
 * or programmatically via `injectFault`. Never consulted by live connectors.
 */
type FaultKind = FailureClass | "ambiguous_after_write";
const faults = new Map<string, { kind: FaultKind; remaining: number }>();

function loadFromEnv(): void {
  for (const entry of (process.env.ORBIX_SANDBOX_FAULTS ?? "").split(",").filter(Boolean)) {
    const [cap, kind, n] = entry.split(":");
    if (cap && kind) faults.set(cap, { kind: kind as FaultKind, remaining: Number(n ?? 1) });
  }
}
loadFromEnv();

export function injectFault(capabilityId: string, kind: FaultKind, times = 1): void {
  faults.set(capabilityId, { kind, remaining: times });
}

export function clearFaults(): void {
  faults.clear();
}

/** Throws a pre-write fault if one is configured. Returns true if an after-write fault is pending. */
export function consumeFault(capabilityId: string): boolean {
  const f = faults.get(capabilityId);
  if (!f || f.remaining <= 0) return false;
  if (f.kind === "ambiguous_after_write") return true;
  f.remaining -= 1;
  throw new ExecutionError(f.kind, `Injected ${f.kind} fault`, f.kind === "rate_limited" ? { retryAfterMs: 200 } : {});
}

export function consumeAfterWriteFault(capabilityId: string): void {
  const f = faults.get(capabilityId);
  if (!f || f.kind !== "ambiguous_after_write" || f.remaining <= 0) return;
  f.remaining -= 1;
  throw new ExecutionError("ambiguous", "Injected timeout after the write was sent");
}
