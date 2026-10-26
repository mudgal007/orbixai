# Implementation plan & acceptance criteria

Status legend: ✅ done in this repo · 🟡 partial · ⏭ roadmap. See README "Status" for test results.

## Phase 1 — Specification & architecture
- PRD, architecture, diagrams, tenancy model, Prisma schema, API contracts, state machines.
- **Accept:** docs in `/docs`, schema migrates cleanly on a fresh Postgres+pgvector.

## Phase 2 — Platform foundation
- Turborepo + pnpm workspaces, strict TS, shared `@orbix/core`.
- Auth (scrypt hashes, opaque hashed sessions), orgs, memberships, roles, API keys.
- Dashboard shell, command palette, keyboard shortcuts.
- **Accept:** sign up → create org → see empty dashboard; a user of org A gets 404 on org B resources.

## Phase 3 — Orchestration
- WorkflowDefinition schema, validator (DAG, refs, allowlists, risk policy), planner (LLM + deterministic).
- Postgres durable engine: claim/lease, checkpoints, dependency promotion, parallel branches.
- Agent registry seeded as `Agent`/`AgentVersion`.
- **Accept:** validator unit tests; engine integration test runs the slice in dry-run to completion.

## Phase 4 — Integrations
- Connector interface; GitHub + Slack real (REST) and sandbox; credential broker (AES-256-GCM);
  OAuth with state + PKCE; developer-token connections; webhook signature verification.
- **Accept:** sandbox flow end-to-end; real connectors exercised when tokens are configured.

## Phase 5 — Mission control
- React Flow editor, simulation view, live run monitor via SSE, approval inbox, audit trail, analytics.
- **Accept:** Playwright test drives the whole vertical slice in the browser.

## Phase 6 — Hardening
- Failure taxonomy, backoff with jitter, reconciliation of ambiguous writes, dead-letter, manual retry.
- Unit + integration + E2E tests, CI workflow, Dockerfiles, docs.
- **Accept:** tests for duplicate-send prevention, approval-hash mismatch, expired approval, tenancy.

## Technical risks
| Risk | Mitigation |
|---|---|
| LLM emits invalid graphs | Zod-validated structured output, capability allowlist, repair loop (1 retry), deterministic fallback |
| Duplicate external writes on crash | Idempotency key per (run, task, payload hash); ambiguous state → reconcile first |
| Prompt injection via issues/docs | Untrusted-content fencing; permissions only from published version; policy in code |
| Token leakage | Encrypted at rest, decrypted only inside connector call, redacted from traces/logs |
| Approval replay | Approval bound to payload hash + expiry + single use |
