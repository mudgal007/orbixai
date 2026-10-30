import type { PrismaClient } from "@orbix/db";

export type ConnectorMode = "sandbox" | "live";

export interface InvokeContext {
  organizationId: string;
  connectionId: string;
  mode: ConnectorMode;
  /** Stable per (run, task, payload hash). Writes must carry it so retries can be reconciled. */
  idempotencyKey: string;
  timeoutMs: number;
  prisma: PrismaClient;
  /** Supplied by the credential broker; only called inside the connector, never exposed to models. */
  getAccessToken: () => Promise<string>;
}

export interface InvokeResult {
  output: Record<string, unknown>;
  /** Provider identifier of the created/affected object, recorded for acknowledgement. */
  externalId?: string;
  /** Number of provider API calls made (for usage accounting). */
  apiCalls: number;
}

export interface ReconcileResult {
  /** True when the provider shows the earlier attempt landed. */
  found: boolean;
  output?: Record<string, unknown>;
  externalId?: string;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** True when the check could not run (e.g. missing optional scope) and was not enforced. */
  skipped?: boolean;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  /** Provider facts discovered by the checks (e.g. resolved channel id), shown as approval evidence. */
  resolved?: Record<string, unknown>;
}

export interface Connector {
  provider: string;
  mode: ConnectorMode;
  invoke(capabilityId: string, input: Record<string, unknown>, ctx: InvokeContext): Promise<InvokeResult>;
  reconcile?(capabilityId: string, input: Record<string, unknown>, ctx: InvokeContext): Promise<ReconcileResult>;
  /**
   * Read-only checks run before an external write is offered for approval. Throws an ExecutionError
   * for problems that would make the write fail (so nobody approves something that cannot succeed).
   */
  preflight?(capabilityId: string, input: Record<string, unknown>, ctx: InvokeContext): Promise<PreflightResult | null>;
}

export interface GithubIssue {
  number: number;
  title: string;
  url: string;
  repo: string;
  body: string;
  state: string;
  labels: string[];
  updatedAt: string;
  daysStale: number;
}
