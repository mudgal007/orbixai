import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CAPABILITIES, SandboxConnectionSchema, TokenConnectionSchema } from "@orbix/core";
import { randomToken, sha256 } from "@orbix/core/node";
import {
  CredentialBroker,
  IMPLEMENTED_PROVIDERS,
  buildAuthorizeUrl,
  createPkcePair,
  decryptSecret,
  encryptSecret,
  exchangeCode,
  inspectToken,
  isOAuthConfigured,
  oauthConfig,
  revokeAtProvider,
  seedGithubSandbox,
} from "@orbix/connectors";
import { appendAudit, type PrismaClient } from "@orbix/db";
import type { Response } from "express";
import { Auth, Public, RequirePermission, type AuthContext } from "../common/context";
import { BROKER, PRISMA } from "../common/tokens";
import { ZodPipe } from "../common/zod.pipe";

const apiBase = () => process.env.ORBIX_API_PUBLIC_URL ?? "http://localhost:4000";
const webBase = () => process.env.ORBIX_WEB_URL ?? "http://localhost:3000";
const redirectUri = (provider: string) => `${apiBase()}/v1/oauth/${provider}/callback`;

function publicConnection(c: { id: string; provider: string; label: string; mode: string; status: string; scopes: string[]; externalAccount: unknown; lastError: string | null; createdAt: Date }) {
  return { id: c.id, provider: c.provider, label: c.label, mode: c.mode, status: c.status, scopes: c.scopes, account: c.externalAccount, lastError: c.lastError, createdAt: c.createdAt };
}

@ApiTags("integrations")
@Controller()
export class IntegrationsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(BROKER) private readonly broker: CredentialBroker,
  ) {}

  @Get("orgs/:orgId/integrations")
  @RequirePermission("workflow:read")
  async catalog(@Param("orgId") orgId: string) {
    const [integrations, connections] = await Promise.all([
      this.prisma.integration.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }] }),
      this.prisma.connection.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" } }),
    ]);
    return {
      integrations: integrations.map((i) => ({
        provider: i.provider,
        name: i.name,
        status: (IMPLEMENTED_PROVIDERS as readonly string[]).includes(i.provider) ? "available" : "roadmap",
        authType: i.authType,
        oauthConfigured: isOAuthConfigured(i.provider),
        capabilities: CAPABILITIES.filter((c) => c.provider === i.provider).map((c) => ({ id: c.id, title: c.title, risk: c.risk, availability: c.availability, scopes: c.scopes })),
      })),
      connections: connections.map(publicConnection),
    };
  }

  @Post("orgs/:orgId/connections/sandbox")
  @RequirePermission("connection:manage")
  async sandbox(@Param("orgId") orgId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(SandboxConnectionSchema)) body: { provider: "github" | "slack" }) {
    const existing = await this.prisma.connection.findFirst({ where: { organizationId: orgId, provider: body.provider, mode: "SANDBOX", status: "ACTIVE" } });
    const conn =
      existing ??
      (await this.prisma.connection.create({
        data: { organizationId: orgId, provider: body.provider, label: `${body.provider === "github" ? "GitHub" : "Slack"} sandbox`, mode: "SANDBOX", scopes: [], createdById: auth.userId },
      }));
    if (body.provider === "github") await seedGithubSandbox(this.prisma, orgId);
    await appendAudit(this.prisma, { organizationId: orgId, actorType: auth.kind, actorId: auth.userId ?? auth.apiKeyId, action: "connection.created", targetType: "connection", targetId: conn.id, data: { provider: body.provider, mode: "SANDBOX" } });
    return { connection: publicConnection(conn) };
  }

  /** Developer token connection (GitHub PAT or Slack bot token). Validated against the provider first. */
  @Post("orgs/:orgId/connections/token")
  @RequirePermission("connection:manage")
  async token(@Param("orgId") orgId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(TokenConnectionSchema)) body: { provider: "github" | "slack"; token: string; label?: string }) {
    const info = await inspectToken(body.provider, body.token);
    const conn = await this.prisma.connection.create({
      data: {
        organizationId: orgId,
        provider: body.provider,
        label: body.label ?? `${body.provider === "github" ? "GitHub" : "Slack"} (${String(info.account.login ?? info.account.team ?? "token")})`,
        mode: "LIVE",
        scopes: info.scopes,
        externalAccount: info.account as object,
        createdById: auth.userId,
      },
    });
    await this.broker.store({ organizationId: orgId, connectionId: conn.id, kind: "token", accessToken: body.token });
    await appendAudit(this.prisma, { organizationId: orgId, actorType: auth.kind, actorId: auth.userId ?? auth.apiKeyId, action: "connection.created", targetType: "connection", targetId: conn.id, data: { provider: body.provider, mode: "LIVE", scopes: info.scopes } });
    return { connection: publicConnection(conn) };
  }

  @Get("orgs/:orgId/connections/oauth/:provider/start")
  @RequirePermission("connection:manage")
  async oauthStart(@Param("orgId") orgId: string, @Param("provider") provider: string, @Auth() auth: AuthContext) {
    if (!(IMPLEMENTED_PROVIDERS as readonly string[]).includes(provider)) throw new NotFoundException("Unknown provider");
    if (auth.kind !== "user") throw new BadRequestException("OAuth requires a signed-in user");
    if (!isOAuthConfigured(provider)) {
      throw new BadRequestException({
        code: "oauth_not_configured",
        message: `Set ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET to enable ${provider} OAuth, or use a sandbox/token connection.`,
      });
    }
    const state = randomToken(32);
    const { verifier, challenge } = createPkcePair();
    await this.prisma.oAuthState.create({
      data: { organizationId: orgId, userId: auth.userId!, provider, stateHash: sha256(state), codeVerifierEncrypted: encryptSecret(verifier).encrypted, expiresAt: new Date(Date.now() + 10 * 60_000) },
    });
    return { url: buildAuthorizeUrl(oauthConfig(provider), { state, redirectUri: redirectUri(provider), codeChallenge: challenge }) };
  }

  /** Provider redirect target. State is single-use, expiring, and bound to the initiating user + org. */
  @Public()
  @Get("oauth/:provider/callback")
  async oauthCallback(@Param("provider") provider: string, @Query("code") code: string, @Query("state") state: string, @Res() res: Response) {
    const fail = (reason: string) => res.redirect(`${webBase()}/app/integrations?error=${encodeURIComponent(reason)}`);
    if (!code || !state) return fail("missing_code");
    const record = await this.prisma.oAuthState.findUnique({ where: { stateHash: sha256(state) } });
    if (!record || record.provider !== provider || record.consumedAt || record.expiresAt < new Date()) return fail("invalid_state");
    const consumed = await this.prisma.oAuthState.updateMany({ where: { id: record.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (consumed.count !== 1) return fail("invalid_state");
    try {
      const token = await exchangeCode(provider, { code, redirectUri: redirectUri(provider), codeVerifier: decryptSecret(record.codeVerifierEncrypted) });
      const account = provider === "github" ? (await inspectToken("github", token.accessToken)).account : token.account;
      const conn = await this.prisma.connection.create({
        data: {
          organizationId: record.organizationId,
          provider,
          label: `${provider === "github" ? "GitHub" : "Slack"} (${String(account.login ?? account.team ?? "connected")})`,
          mode: "LIVE",
          scopes: token.scopes,
          externalAccount: account as object,
          createdById: record.userId,
        },
      });
      await this.broker.store({ organizationId: record.organizationId, connectionId: conn.id, kind: "oauth", accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt });
      await appendAudit(this.prisma, { organizationId: record.organizationId, actorType: "user", actorId: record.userId, action: "connection.created", targetType: "connection", targetId: conn.id, data: { provider, mode: "LIVE", scopes: token.scopes } });
      return res.redirect(`${webBase()}/app/integrations?connected=${provider}`);
    } catch (e) {
      return fail((e as Error).message.slice(0, 120));
    }
  }

  @Delete("orgs/:orgId/connections/:id")
  @HttpCode(200)
  @RequirePermission("connection:manage")
  async revoke(@Param("orgId") orgId: string, @Param("id") id: string, @Auth() auth: AuthContext) {
    const conn = await this.prisma.connection.findFirst({ where: { id, organizationId: orgId } });
    if (!conn) throw new NotFoundException("Connection not found");
    let providerRevoked = false;
    if (conn.mode === "LIVE") {
      const secret = await this.broker.readSecret(orgId, conn.id);
      if (secret) providerRevoked = await revokeAtProvider(conn.provider, secret.accessToken);
    }
    await this.prisma.credentialReference.deleteMany({ where: { connectionId: conn.id, organizationId: orgId } });
    await this.prisma.connection.update({ where: { id: conn.id }, data: { status: "REVOKED" } });
    await appendAudit(this.prisma, { organizationId: orgId, actorType: auth.kind, actorId: auth.userId ?? auth.apiKeyId, action: "connection.revoked", targetType: "connection", targetId: conn.id, data: { providerRevoked } });
    return { revoked: true, providerRevoked };
  }
}
