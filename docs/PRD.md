# ORBIX AI — Product Requirements (MVP)

**Positioning:** ORBIX is the control plane for autonomous work. Users state a goal; ORBIX turns it into a
typed, validated, simulated, approval-gated execution graph, runs it durably, and reports a *verified*
outcome — not just "the step returned 200".

## How ORBIX differs from Zapier / n8n / agent builders

| Concern | Trigger→action tools | Agent builders | ORBIX |
|---|---|---|---|
| Authoring | Hand-wired steps | Prompt + tools | Goal → typed DAG the user can edit |
| Safety | Per-step config | LLM decides | Deterministic policy engine; risk class forces approval |
| Pre-flight | None | None | Plan preview, dry run against sandbox connectors, cost estimate |
| Approvals | Optional, coarse | Rare | Bound to an exact payload hash, expiring, invalidated on change |
| Failure | Retry N times | Re-prompt | Failure taxonomy; ambiguous writes reconciled before any retry |
| Outcome | "Step succeeded" | "Agent said done" | Three states: completed → acknowledged → independently verified |

## Personas
- **Operator** (non-technical owner/manager): describes goals, reviews plans, approves actions.
- **Builder** (developer/ops engineer): edits graphs, configures connections, uses the API.
- **Admin**: manages members, roles, budgets, audit.

## MVP scope (this repository)
In scope:
1. Email/password auth, organizations, memberships, org-scoped RBAC, API keys.
2. Natural-language mission → workflow graph (LLM planner when configured; deterministic template
   planner otherwise, clearly labelled).
3. Visual editor (React Flow): edit nodes, connect edges, validate, publish immutable versions.
4. Simulation: Plan Preview (no I/O), Dry Run (sandbox connectors), Live.
5. Durable execution engine on PostgreSQL (leases, checkpoints, retries, dead-letter, reconciliation).
6. Approval inbox with payload-hash binding and expiry.
7. Connectors: GitHub and Slack (real via OAuth or developer token; sandbox mocks behind the same
   interface). Gmail/Calendar are defined in the registry but marked **roadmap** — not claimed.
8. Hash-chained audit log, run trace, usage/cost records, outcome metrics on the dashboard.
9. Knowledge: org-scoped documents, chunking, pgvector search with citations.
10. Developer platform: REST API, OpenAPI at `/docs`, workflow JSON Schema import/export, outbound
    webhooks with HMAC signatures, a typed TypeScript SDK.

Out of scope for MVP (documented as roadmap): Temporal adapter, billing provider, SSO/SAML,
MCP server connections, Gmail/Calendar/Notion/HubSpot/etc., multi-region.

## First vertical slice (acceptance)
> "Find GitHub issues assigned to me that have not been updated for seven days, summarize each issue,
> create a follow-up plan, and draft a Slack update for approval."

1. User signs up, creates an org. 2. Connects GitHub and Slack (sandbox or real). 3. Types the
mission. 4. Planner produces a valid 6-node graph. 5. User edits/publishes. 6. Simulation shows
path, cost, side effects (1 external write, approval required). 7. Run finds stale issues.
8. Summaries cite issue URLs. 9. Slack draft is generated. 10. Approval shows exact payload.
11. On approve, message is posted with an idempotency key. 12. Verification agent re-reads the
channel and marks the outcome **verified**. 13. Dashboard reflects run, cost and verified outcome.

## Non-goals / principles
- The LLM never enforces security. Policies are deterministic backend code.
- Credentials never enter prompts; connectors receive them from a broker at call time.
- No fabricated metrics: every dashboard number is a query over stored rows.
- Do not claim an integration until auth and operations work end-to-end.
