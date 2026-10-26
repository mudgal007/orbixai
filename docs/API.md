# ORBIX API contracts (v1)

Base URL: `http://localhost:4000/v1` (browser: `/api/v1` via Next rewrite). Live OpenAPI: `GET /docs`.
Auth: session cookie `orbix_session` **or** `Authorization: Bearer orbx_…` (org-bound API key).
Cookie-authenticated mutations must send `X-Orbix-Request: 1`.
All request bodies are validated with Zod schemas from `@orbix/core`; errors use:

```json
{ "error": { "code": "validation_failed", "message": "…", "details": [ … ] } }
```

## Auth & identity
| Method | Path | Body / notes |
|---|---|---|
| POST | `/auth/signup` | `{ email, password, name }` → sets session |
| POST | `/auth/login` | `{ email, password }` |
| POST | `/auth/logout` | revokes session |
| GET | `/me` | user + memberships |
| POST | `/orgs` | `{ name }` → creates org, caller becomes `owner` |

## Org-scoped (`/orgs/:orgId/...`, permission in brackets)
| Method | Path | Notes |
|---|---|---|
| GET | `/members` [member:read] · POST `/members` [member:manage] `{ email, role }` | |
| GET | `/agents` [workflow:read] | agent registry with tool allowlists |
| GET | `/integrations` [workflow:read] | catalog: status `available` / `roadmap` + org connections |
| POST | `/connections/sandbox` [connection:manage] | `{ provider }` sandbox connection |
| POST | `/connections/token` [connection:manage] | `{ provider, token, label }` developer token, encrypted |
| GET | `/connections/oauth/:provider/start` [connection:manage] | returns `{ url }` (state + PKCE) |
| GET | `/oauth/:provider/callback` (global) | validates state/PKCE, stores encrypted token |
| DELETE | `/connections/:id` [connection:manage] | revokes at provider when supported, deletes credential |
| POST | `/missions/plan` [workflow:write] | `{ objective }` → `{ mission, workflow, version, planner }` |
| GET | `/workflows` · GET `/workflows/:id` | latest draft + versions |
| PUT | `/workflows/:id/draft` [workflow:write] | `{ definition }` WorkflowDefinition |
| POST | `/workflows/:id/validate` | → `{ valid, issues[] }` |
| POST | `/workflows/:id/publish` [workflow:write] | creates immutable `WorkflowVersion` |
| GET | `/workflows/:id/export` · POST `/workflows/import` | JSON validated by `/schemas/workflow.json` |
| POST | `/workflows/:id/simulate` | Plan Preview → SimulationReport (no I/O) |
| POST | `/workflows/:id/runs` [run:execute] | `{ mode: "dry_run" \| "live", versionId? }` |
| GET | `/runs` · GET `/runs/:id` | run + task runs + tool executions |
| GET | `/runs/:id/events` | **SSE** stream of RunEvent |
| POST | `/runs/:id/{pause,resume,cancel,retry}` [run:execute] | |
| POST | `/runs/:id/tasks/:taskRunId/reconcile` [run:execute] | manual reconciliation |
| GET | `/approvals?status=pending` | |
| POST | `/approvals/:id/decision` [approval:decide] | `{ decision: approve\|reject, payloadHash, comment? }` — `payloadHash` must equal stored hash |
| POST | `/approvals/:id/request-changes` [approval:decide] | `{ payload }` → invalidates, re-issues with new hash |
| GET | `/audit` [audit:read] · GET `/audit/verify` | hash-chain verification |
| GET | `/analytics/summary` | all numbers computed from rows |
| POST/GET | `/knowledge/documents` · GET `/knowledge/search?q=` | |
| GET/POST/DELETE | `/api-keys` [apikey:manage] | key shown once |
| GET/POST/DELETE | `/webhooks` [apikey:manage] | outbound subscriptions (`run.completed`, `approval.requested`) |

## Inbound webhooks
`POST /v1/webhooks/github` (verifies `X-Hub-Signature-256`), `POST /v1/webhooks/slack` (verifies
`X-Slack-Signature` + timestamp window).

## Core types (abridged — source of truth: `packages/core/src/workflow.ts`)

```ts
type RiskLevel = "read" | "compute" | "internal_write" | "external_write" | "destructive" | "financial";

interface WorkflowNode {
  id: string; title: string; agent: AgentKey; action: CapabilityId;
  inputs: Record<string, unknown>;          // literals or "{{nodes.<id>.output.<path>}}"
  dependsOn: string[];
  timeoutMs: number;
  retry: { maxAttempts: number; backoffMs: number; maxBackoffMs: number };
  risk: RiskLevel;                          // derived from capability, cannot be lowered
  approval: { required: boolean; approverRole?: string; expiresInMinutes: number };
  successCondition?: { path: string; op: "exists" | "nonEmpty" | "equals" | "gte"; value?: unknown };
  compensation?: { action: CapabilityId; note: string };
  position?: { x: number; y: number };
}
interface WorkflowDefinition { schemaVersion: 1; name: string; objective: string; trigger: Trigger; nodes: WorkflowNode[]; }
```
