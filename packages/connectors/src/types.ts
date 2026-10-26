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

export interface Connector {
  provider: string;
  mode: ConnectorMode;
  invoke(capabilityId: string, input: Record<string, unknown>, ctx: InvokeContext): Promise<InvokeResult>;
  reconcile?(capabilityId: string, input: Record<string, unknown>, ctx: InvokeContext): Promise<ReconcileResult>;
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
