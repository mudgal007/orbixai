# ORBIX AI — The Control Plane for Autonomous Work

ORBIX turns a business goal into a **typed, validated execution graph**, simulates it, asks a human to
approve the **exact payload** of every externally visible action, runs it on a **durable engine**, and
reports an outcome that is **independently verified** against the provider — not just "the step returned 200".

- Product requirements: [docs/PRD.md](docs/PRD.md)
- Architecture, diagrams, state machines, failure taxonomy: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- API contracts: [docs/API.md](docs/API.md) · live OpenAPI at `http://localhost:4000/docs`
- Phased plan & acceptance criteria: [docs/PLAN.md](docs/PLAN.md)

## Status (honest)

| Area | Status | Notes |
|---|---|---|
| Auth, orgs, RBAC, API keys | ✅ | scrypt passwords, hashed opaque sessions, CSRF header, org-bound keys, 5 system roles |
| NL mission → workflow graph | ✅ | LLM planner (OpenAI-compatible) with Zod validation + repair; deterministic template planner when no key is set (labelled `orbix-heuristic`) |
| Visual editor (React Flow) | ✅ | edit nodes/edges, inspector, validation, immutable versioned publish, JSON import/export |
| Simulation | ✅ | Plan Preview (no I/O) + Dry Run (sandbox connectors) + Live |
| Scheduled triggers | ✅ | Cron + IANA timezone per workflow (DST-aware); planner detects "every weekday at 8:30am"-style phrasing; schedules start paused and are activated explicitly (dry run or live); double-fire prevented by row locks + a unique (schedule, slot) constraint; overlapping slots skipped; missed slots not replayed; ≥5-minute interval policy |
| Durable execution | ✅ | Postgres-backed: `FOR UPDATE SKIP LOCKED` claims, leases, checkpoints, retries w/ jitter, dead-letter, pause/resume/cancel/retry |
| Approvals | ✅ | bound to SHA-256 of the canonical payload, expiring, invalidated on edit, single decision |
| Recovery | ✅ | failure taxonomy; ambiguous writes reconciled against provider before any retry (tested: no duplicate send) |
| GitHub, Slack | ✅ sandbox · 🟡 live | Real REST connectors, OAuth (state + PKCE where supported) and developer-token connections are implemented. **Live calls have not been exercised against real accounts in this environment** (no credentials configured). |
| Gmail, Calendar, HubSpot, Shopify, Stripe, Notion, Linear, MCP | ⏭ roadmap | Visible in the catalog and to the planner as *unavailable*; never executable |
| Audit | ✅ | per-org hash chain, append-only enforced by a DB trigger, redaction, verify endpoint |
| Knowledge (pgvector) | ✅ / 🟡 | Ingest, versioning, retention, org-scoped search with citations. Uses pgvector + HNSW when the extension exists (docker image); falls back to SQL cosine over `float8[]` otherwise. Local dev embeddings are lexical (feature hashing) unless an embedding API is configured. |
| Developer platform | ✅ | REST + OpenAPI, workflow JSON Schema, signed outbound webhooks (SSRF-guarded), inbound GitHub/Slack signature verification, TS SDK (`packages/sdk`) |
| Temporal | ⏭ | The engine sits behind `ExecutionEngine`; Postgres-backed durability is used instead (see Architecture → decisions) |
| Billing, SSO, email invites, OpenTelemetry export | ⏭ | Structured JSON logs are emitted; OTel exporter not wired |

**Not production-ready yet**: live connector paths need verification with real credentials, there is no
load testing, and OTel/alerting are not wired. Security, recovery and tenancy behaviour *is* covered by tests (below).

## Quick start (no Docker required)

Requirements: Node ≥ 20.9, pnpm 10. On Windows, keep the checkout path short (e.g. `C:\Users\you\oai`) — deep paths exceed MAX_PATH.

```bash
pnpm install
cp .env.example .env    # then set ORBIX_ENCRYPTION_KEY (command in the file)
pnpm db:up              # private PostgreSQL 17 on :5433 (embedded-postgres); leave running
pnpm db:migrate
pnpm build
pnpm db:seed            # demo@orbix.dev / orbix-demo-password (local demo credentials)
pnpm dev                # api :4000 · worker · web :3000
```

Open http://localhost:3000, sign in, then **New mission** → use the first example objective → **Review & edit** →
**Publish** → **Simulate** → **Dry run** → approve in the **Approval inbox** → watch the run reach **Verified**.

With Docker instead: `docker compose up -d postgres` (pgvector image on :5433), then the same steps from `pnpm db:migrate`.
Full containers: `docker compose --profile app up --build` (Dockerfiles are provided but were **not built in this environment** — Docker Desktop failed to start here).

### Real integrations
- **Model**: set `ORBIX_LLM_API_KEY` (and optionally `ORBIX_LLM_BASE_URL`, `ORBIX_LLM_MODEL`) for any OpenAI-compatible endpoint. `NODE_ENV=production` refuses to start without one.
- **GitHub**: OAuth app with callback `http://localhost:4000/v1/oauth/github/callback` → `GITHUB_CLIENT_ID/SECRET`; or connect a PAT from Integrations → Token.
- **Slack**: app with scopes `chat:write channels:read channels:history`, callback `http://localhost:4000/v1/oauth/slack/callback` → `SLACK_CLIENT_ID/SECRET`; or connect a bot token. The bot must be in the target channel.

## Tests

| Suite | Command | Result (this environment) |
|---|---|---|
| Core unit (validator, policy, state machines, retry, hashing, redaction, simulation, cron/timezone/DST) | `pnpm --filter @orbix/core test` | 21 passed |
| Connectors unit (AES-GCM, PKCE, webhook signatures, SSRF, mapping) | `pnpm --filter @orbix/connectors test` | 7 passed |
| Engine integration (vertical slice, approval binding, edit invalidation, ambiguous-write reconciliation, retries, rejection, expiry, pause/resume, tenancy, audit immutability, knowledge, scheduler concurrency/overlap/missed slots, non-UTC database timezone) | `pnpm --filter @orbix/engine test` | 24 passed |
| API e2e over HTTP (auth/CSRF, slice incl. SSE, publish validation, tenancy 404s, RBAC, API keys, SSRF, credential non-disclosure, schedule lifecycle + RBAC) | `pnpm --filter @orbix/api test` | 10 passed |
| Playwright (full UI vertical slice; signed-out redirect; schedule detect → publish → activate) | `pnpm test:e2e` (stack running) | 3 passed |

`pnpm test` runs all Vitest suites (serially — DB-backed suites share a `<db>_test` database that is migrated automatically and forced to a non-UTC session timezone to catch timestamp bugs).
Windows note: stop running API/worker processes before `pnpm build`/`pnpm test`, because they lock Prisma's engine DLL.

## Layout

```
apps/api       NestJS REST API (guards, controllers, SSE)
apps/worker    durable execution worker
apps/web       Next.js console + marketing site
packages/core  Zod contracts, validator, policy, state machines, simulation
packages/db    Prisma schema, migrations, audit chain, org bootstrap
packages/connectors  connector interface, GitHub/Slack real + sandbox, broker, OAuth, SSRF, signatures
packages/engine      orchestrator, agents, model abstraction, planner, knowledge, webhooks
packages/sdk   typed TypeScript client
e2e/           Playwright tests
```

## Key assumptions
- Postgres-backed durable execution instead of Temporal for the MVP (allowed by spec as an equivalent).
- Redis is optional (not used); SSE reads an append-only `RunEvent` table so any API instance can stream any worker's events.
- Dry runs still require approvals, so the human checkpoint is rehearsed exactly as in live mode.
- "Estimated time saved" comes from a per-capability table in `packages/engine/src/engine.ts` and is always labelled as an estimate.
