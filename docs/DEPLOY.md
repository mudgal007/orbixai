# Deploying ORBIX to Railway

Target layout: four Railway services in one project. Only **web** is public; the browser reaches the API
through web's `/api` proxy, so the session cookie stays first-party and the API is never exposed directly.

```
Internet ──HTTPS──▶ web (Next.js, public domain)
                      │  /api/* rewrite (private network)
                      ▼
                    api (NestJS) ─────┐
                    worker ───────────┼──▶ Postgres (Railway managed)
                                      │
                    GitHub / Slack / OpenAI APIs (outbound)
```

Expected cost: Railway Hobby plan (about $5/month including some usage) plus metered usage for four small
services. Check Railway's pricing page for current numbers. pgvector is optional: without it, Knowledge
search falls back to SQL cosine similarity.

## 0. Before you start

- A Railway account (sign up with GitHub) and the `mudgal007/orbixai` repository on GitHub.
- A **new** production encryption key — never reuse your local one:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
  Store it in a password manager. Losing it makes stored GitHub/Slack credentials unreadable.
- Your OpenAI API key (enter it only in Railway's variables UI).

## 1. Create the project and database

1. Railway → **New Project** → **Deploy PostgreSQL**. Rename the service to `Postgres`.
2. In the same project → **New** → **GitHub Repo** → `mudgal007/orbixai`. Rename this service to **`api`**
   (the name matters: web reaches it at `api.railway.internal`).
3. Repeat **New → GitHub Repo** twice more and name the services **`worker`** and **`web`**.

## 2. Point each service at its config file

For each service: **Settings → Config-as-code → Railway config file**:

| Service | Config file | Root directory |
|---|---|---|
| api | `apps/api/railway.json` | *(leave empty — builds from repo root)* |
| worker | `apps/worker/railway.json` | *(empty)* |
| web | `apps/web/railway.json` | *(empty)* |

These set the Dockerfile, health check and restart policy. If your Railway UI lacks config-as-code, set the
same values by hand: **Builder: Dockerfile**, **Dockerfile path** as in the file, health check path
`/v1/health` (api) or `/login` (web).

## 3. Variables

Use **Project Settings → Shared Variables** for the values api and worker share, then reference them from
each service (Variables → *Add a shared variable*).

**Shared (api + worker):**

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `ORBIX_ENCRYPTION_KEY` | the new key from step 0 |
| `ORBIX_LLM_API_KEY` | your OpenAI key |
| `ORBIX_LLM_BASE_URL` | `https://api.openai.com/v1` |
| `ORBIX_LLM_MODEL` | `gpt-4.1-mini` |
| `ORBIX_EMBEDDING_MODEL` | `text-embedding-3-small` |
| `ORBIX_WEB_URL` | `https://<your-web-domain>` (fill in after step 4) |
| `ORBIX_API_PUBLIC_URL` | `https://<your-web-domain>/api` — OAuth callbacks go through the web proxy |
| `ORBIX_ALLOW_PRIVATE_WEBHOOKS` | `false` |
| `ORBIX_RUN_BUDGET_USD` | `1.00` |

**api only:** `ORBIX_API_PORT` = `4000`.

**web only:**

| Variable | Value |
|---|---|
| `ORBIX_API_INTERNAL_URL` | `http://api.railway.internal:4000` — read at **build** time by the `/api` rewrite |
| `PORT` | `3000` |

## 4. Public domain (web only)

**web → Settings → Networking → Generate Domain** (target port `3000`). Copy the domain into
`ORBIX_WEB_URL` and `ORBIX_API_PUBLIC_URL` above. Do **not** generate a domain for api or worker.

## 5. Deploy and check

Changing variables triggers deploys; otherwise **Deploy** each service. Then:

- **api** logs: Prisma applies all migrations, then `"msg":"api.started"`.
- **worker** logs: `"msg":"worker.started"` with `"model":"gpt-4.1-mini","heuristic":false`.
- Open `https://<your-web-domain>` → **Get started** → sign up. Your account and organization are new; the
  local demo data is not copied.
- **Integrations** → connect GitHub and Slack with tokens (as you did locally) → plan a mission → simulate
  → run live.

Every push to `main` redeploys the services whose watched paths changed.

## Production notes

- **Secrets** live only in Railway variables. Rotate any key that has been pasted into chats or files.
- **Rate limiting** sees real client IPs: Railway's edge adds `X-Forwarded-For`, web forwards it, and the API
  trusts one proxy hop (`ORBIX_TRUST_PROXY_HOPS`, default `1`).
- **Migrations** run when the api starts. Keep api at **one replica** (workers can scale; they coordinate
  through Postgres row locks).
- **Backups**: enable Postgres backups in Railway before real users depend on it.
- **Custom domain**: add it under web → Networking, then update `ORBIX_WEB_URL` / `ORBIX_API_PUBLIC_URL`.
- **OAuth apps** (optional): set the callback to `https://<domain>/api/v1/oauth/github/callback`
  (or `/slack/callback`) and add `GITHUB_CLIENT_ID/SECRET`, `SLACK_CLIENT_ID/SECRET` to api.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Web loads, but sign-in fails with 502/504 | `ORBIX_API_INTERNAL_URL` wrong, or api not named `api`; redeploy **web** after fixing (build-time value) |
| Sign-in "works" but you are logged out immediately | `ORBIX_WEB_URL` not https, or accessing a different domain than configured |
| api crashes: `ORBIX_LLM_API_KEY is required in production` | set the key on the api **and** worker services |
| api crashes on startup with Prisma errors | `DATABASE_URL` missing or not referencing the Postgres service |
| Runs stay "Queued" | worker not running or missing `DATABASE_URL` |

## Alternative: one VPS with Docker Compose

On any Linux server with Docker: clone the repo, create `.env` (same variables as above, with
`DATABASE_URL` provided by compose), run `docker compose --profile app up -d --build`, and put a reverse proxy
with automatic HTTPS (e.g. Caddy: `your-domain { reverse_proxy localhost:3000 }`) in front of port 3000.
Cheaper, but you own OS updates, backups and monitoring.
