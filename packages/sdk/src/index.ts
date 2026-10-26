import type { SimulationReport, ValidationIssue, WorkflowDefinition } from "@orbix/core";

export interface OrbixClientOptions {
  /** API base, e.g. http://localhost:4000 */
  baseUrl: string;
  /** Org-bound API key (orbx_…). */
  apiKey: string;
  organizationId: string;
  fetch?: typeof fetch;
}

export class OrbixApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface RunSummary {
  id: string;
  status: string;
  mode: "DRY_RUN" | "LIVE";
  outcome: string;
  costUsd: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/** Minimal typed client for creating and monitoring missions programmatically. */
export class OrbixClient {
  private readonly f: typeof fetch;

  constructor(private readonly opts: OrbixClientOptions) {
    this.f = opts.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/orgs/${this.opts.organizationId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new OrbixApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? res.statusText, data?.error?.details);
    return data as T;
  }

  planMission(objective: string) {
    return this.req<{ mission: { id: string }; workflow: { id: string; draft: WorkflowDefinition }; planner: string; notes: string[]; issues: ValidationIssue[] }>("POST", "/missions/plan", { objective });
  }

  saveDraft(workflowId: string, definition: WorkflowDefinition) {
    return this.req<{ validation: { valid: boolean; issues: ValidationIssue[] }; policyNotes: string[] }>("PUT", `/workflows/${workflowId}/draft`, { definition });
  }

  publish(workflowId: string) {
    return this.req<{ version: { id: string; version: number }; unchanged: boolean }>("POST", `/workflows/${workflowId}/publish`);
  }

  simulate(workflowId: string) {
    return this.req<{ report: SimulationReport }>("POST", `/workflows/${workflowId}/simulate`);
  }

  startRun(workflowId: string, mode: "dry_run" | "live", versionId?: string) {
    return this.req<{ run: RunSummary }>("POST", `/workflows/${workflowId}/runs`, { mode, versionId });
  }

  getRun(runId: string) {
    return this.req<{ run: RunSummary & Record<string, unknown> }>("GET", `/runs/${runId}`);
  }

  listPendingApprovals() {
    return this.req<{ approvals: Array<{ id: string; runId: string; action: string; payload: unknown; payloadHash: string; expiresAt: string }> }>("GET", "/approvals?status=pending");
  }

  /** The hash must be the one you reviewed; the API rejects decisions on a changed payload. */
  decide(approvalId: string, decision: "approve" | "reject", payloadHash: string, comment?: string) {
    return this.req<{ ok: true }>("POST", `/approvals/${approvalId}/decision`, { decision, payloadHash, comment });
  }

  /** Polls until the run reaches a terminal state or a pending approval (returned so callers can act). */
  async waitForRun(runId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<RunSummary> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const { run } = await this.getRun(runId);
      if (TERMINAL.has(run.status) || run.status === "WAITING_APPROVAL" || run.status === "NEEDS_ATTENTION") return run;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for run ${runId}`);
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1000));
    }
  }

  /** Streams run events over SSE (Node 18+ / browsers with fetch streaming). */
  async *events(runId: string, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    const res = await this.f(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/orgs/${this.opts.organizationId}/runs/${runId}/events`, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new OrbixApiError(res.status, "stream_failed", "Could not open event stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const id = /^id: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (id && data) yield { id, ...(JSON.parse(data) as Omit<RunEvent, "id">) };
      }
    }
  }
}
