import { ExecutionError } from "@orbix/core";
import { httpJson } from "../http";
import type { Connector, GithubIssue, InvokeContext } from "../types";

const API = "https://api.github.com";

interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  state: string;
  updated_at: string;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
  repository?: { full_name: string };
  repository_url: string;
}

async function gh<T>(ctx: InvokeContext, path: string, init: { method?: string; body?: unknown; write?: boolean } = {}) {
  const token = await ctx.getAccessToken();
  return httpJson<T>(`${API}${path}`, {
    ...init,
    timeoutMs: ctx.timeoutMs,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "orbix-ai",
    },
  });
}

export function toIssue(i: GhIssue, now = Date.now()): GithubIssue {
  const repo = i.repository?.full_name ?? i.repository_url.replace(`${API}/repos/`, "");
  return {
    number: i.number,
    title: i.title,
    url: i.html_url,
    repo,
    body: (i.body ?? "").slice(0, 4000),
    state: i.state,
    labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
    updatedAt: i.updated_at,
    daysStale: Math.floor((now - Date.parse(i.updated_at)) / 86_400_000),
  };
}

const marker = (key: string) => `<!-- orbix:idem:${key} -->`;

export const githubLive: Connector = {
  provider: "github",
  mode: "live",
  async invoke(capabilityId, input, ctx) {
    switch (capabilityId) {
      case "github.issues.list_stale_assigned": {
        const staleDays = Number(input.staleDays ?? 7);
        const limit = Number(input.limit ?? 20);
        const cutoff = Date.now() - staleDays * 86_400_000;
        const res = await gh<GhIssue[]>(ctx, "/issues?filter=assigned&state=open&sort=updated&direction=asc&per_page=100");
        const issues = res.data
          .filter((i) => !i.pull_request && Date.parse(i.updated_at) < cutoff)
          .map((i) => toIssue(i))
          .filter((i) => !input.repo || i.repo === input.repo)
          .slice(0, limit);
        return { output: { issues, count: issues.length }, apiCalls: 1 };
      }
      case "github.issue.comment": {
        const body = `${String(input.body)}\n\n${marker(ctx.idempotencyKey)}`;
        const res = await gh<{ id: number; html_url: string }>(ctx, `/repos/${input.repo}/issues/${input.number}/comments`, {
          method: "POST",
          body: { body },
          write: true,
        });
        return { output: { id: res.data.id, url: res.data.html_url }, externalId: String(res.data.id), apiCalls: 1 };
      }
      default:
        throw new ExecutionError("permanent", `GitHub connector does not implement ${capabilityId}`);
    }
  },
  async reconcile(capabilityId, input, ctx) {
    if (capabilityId !== "github.issue.comment") return { found: false };
    const res = await gh<Array<{ id: number; html_url: string; body: string }>>(
      ctx,
      `/repos/${input.repo}/issues/${input.number}/comments?per_page=100`,
    );
    const hit = res.data.find((c) => c.body.includes(marker(ctx.idempotencyKey)));
    return hit ? { found: true, output: { id: hit.id, url: hit.html_url }, externalId: String(hit.id) } : { found: false };
  },
};
