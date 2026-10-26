import { createHash, randomBytes } from "node:crypto";
import { ExecutionError } from "@orbix/core";
import { httpJson } from "./http";

export interface OAuthProviderConfig {
  provider: "github" | "slack";
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  scopeSeparator: string;
  pkce: boolean;
  clientId?: string;
  clientSecret?: string;
}

export function oauthConfig(provider: string): OAuthProviderConfig {
  switch (provider) {
    case "github":
      return {
        provider,
        authorizeUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        scopes: ["repo"],
        scopeSeparator: " ",
        pkce: true,
        clientId: process.env.GITHUB_CLIENT_ID || undefined,
        clientSecret: process.env.GITHUB_CLIENT_SECRET || undefined,
      };
    case "slack":
      return {
        provider,
        authorizeUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        scopes: ["chat:write", "channels:read", "channels:history"],
        scopeSeparator: ",",
        pkce: false,
        clientId: process.env.SLACK_CLIENT_ID || undefined,
        clientSecret: process.env.SLACK_CLIENT_SECRET || undefined,
      };
    default:
      throw new Error(`OAuth is not supported for ${provider}`);
  }
}

export function isOAuthConfigured(provider: string): boolean {
  try {
    const c = oauthConfig(provider);
    return !!c.clientId && !!c.clientSecret;
  } catch {
    return false;
  }
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(cfg: OAuthProviderConfig, input: { state: string; redirectUri: string; codeChallenge: string }): string {
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId ?? "");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", cfg.scopes.join(cfg.scopeSeparator));
  url.searchParams.set("state", input.state);
  if (cfg.pkce) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  account: Record<string, unknown>;
}

function expiry(d: Record<string, unknown>): Date | undefined {
  return d.expires_in ? new Date(Date.now() + Number(d.expires_in) * 1000) : undefined;
}

export async function exchangeCode(provider: string, input: { code: string; redirectUri: string; codeVerifier: string }): Promise<TokenResult> {
  const cfg = oauthConfig(provider);
  const params = new URLSearchParams({
    client_id: cfg.clientId ?? "",
    client_secret: cfg.clientSecret ?? "",
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  if (cfg.pkce) params.set("code_verifier", input.codeVerifier);
  const res = await httpJson<Record<string, unknown>>(cfg.tokenUrl, {
    method: "POST",
    body: params.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeoutMs: 15_000,
  });
  const d = res.data;
  if (d.error || d.ok === false) throw new ExecutionError("permission", `OAuth exchange failed: ${String(d.error ?? "unknown")}`);
  const team = d.team as { id: string; name: string } | undefined;
  return {
    accessToken: String(d.access_token),
    refreshToken: d.refresh_token ? String(d.refresh_token) : undefined,
    expiresAt: expiry(d),
    scopes: String(d.scope ?? "").split(/[ ,]/).filter(Boolean),
    account: provider === "slack" ? { team: team?.name, teamId: team?.id, botUserId: d.bot_user_id } : {},
  };
}

export async function refreshAccessToken(provider: string, refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: Date }> {
  const cfg = oauthConfig(provider);
  const params = new URLSearchParams({
    client_id: cfg.clientId ?? "",
    client_secret: cfg.clientSecret ?? "",
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await httpJson<Record<string, unknown>>(cfg.tokenUrl, {
    method: "POST",
    body: params.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeoutMs: 15_000,
  });
  const d = res.data;
  if (d.error || d.ok === false || !d.access_token) throw new ExecutionError("permission", "Token refresh failed; reconnect required");
  return { accessToken: String(d.access_token), refreshToken: d.refresh_token ? String(d.refresh_token) : undefined, expiresAt: expiry(d) };
}

/** Best-effort revocation at the provider. Local credential deletion happens regardless. */
export async function revokeAtProvider(provider: string, accessToken: string): Promise<boolean> {
  try {
    if (provider === "slack") {
      await httpJson("https://slack.com/api/auth.revoke", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: 10_000 });
      return true;
    }
    if (provider === "github") {
      const cfg = oauthConfig("github");
      if (!cfg.clientId || !cfg.clientSecret) return false;
      await httpJson(`https://api.github.com/applications/${cfg.clientId}/grant`, {
        method: "DELETE",
        body: { access_token: accessToken },
        headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`, "User-Agent": "orbix-ai" },
        timeoutMs: 10_000,
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Validates a developer token and discovers the account and granted scopes. */
export async function inspectToken(provider: "github" | "slack", token: string): Promise<{ scopes: string[]; account: Record<string, unknown> }> {
  if (provider === "github") {
    const res = await httpJson<{ login: string; id: number }>("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "orbix-ai", Accept: "application/vnd.github+json" },
      timeoutMs: 10_000,
    });
    const header = res.headers.get("x-oauth-scopes");
    // Fine-grained PATs report no scopes header; GitHub enforces their permissions per request.
    const scopes = header ? header.split(",").map((s) => s.trim()).filter(Boolean) : ["repo"];
    return { scopes, account: { login: res.data.login, id: res.data.id } };
  }
  const res = await httpJson<{ ok: boolean; error?: string; team: string; user: string; team_id: string }>("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 10_000,
  });
  if (!res.data.ok) throw new ExecutionError("permission", `Slack token rejected: ${res.data.error}`);
  const scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { scopes, account: { team: res.data.team, teamId: res.data.team_id, user: res.data.user } };
}
