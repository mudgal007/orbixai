import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req, UnauthorizedException } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreateApiKeySchema, CreateKnowledgeDocSchema, CreateWebhookSchema } from "@orbix/core";
import { randomToken, sha256 } from "@orbix/core/node";
import { SsrfError, assertSafeOutboundUrl, encryptSecret, verifyGithubSignature, verifySlackSignature } from "@orbix/connectors";
import { appendAudit, type PrismaClient } from "@orbix/db";
import { ingestDocument, searchKnowledge, type ModelClient } from "@orbix/engine";
import { Auth, Public, RequirePermission, type AuthContext, type OrbixRequest } from "../common/context";
import { MODEL, PRISMA } from "../common/tokens";
import { ZodPipe } from "../common/zod.pipe";

@ApiTags("developer")
@Controller()
export class DeveloperController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(MODEL) private readonly model: ModelClient,
  ) {}

  private actor(auth: AuthContext) {
    return { actorType: auth.kind, actorId: auth.userId ?? auth.apiKeyId } as const;
  }

  // ───────────── API keys ─────────────

  @Get("orgs/:orgId/api-keys")
  @RequirePermission("apikey:manage")
  async keys(@Param("orgId") orgId: string) {
    const keys = await this.prisma.apiKey.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" }, include: { role: { select: { key: true } } } });
    return { keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, role: k.role.key, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, createdAt: k.createdAt })) };
  }

  /** The plaintext key is returned exactly once; only its SHA-256 is stored. */
  @Post("orgs/:orgId/api-keys")
  @RequirePermission("apikey:manage")
  async createKey(@Param("orgId") orgId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(CreateApiKeySchema)) body: { name: string; role: string }) {
    const role = await this.prisma.role.findUniqueOrThrow({ where: { organizationId_key: { organizationId: orgId, key: body.role } } });
    const key = `orbx_${randomToken(24)}`;
    const row = await this.prisma.apiKey.create({
      data: { organizationId: orgId, name: body.name, prefix: key.slice(0, 12), keyHash: sha256(key), roleId: role.id, createdById: auth.userId ?? auth.apiKeyId ?? "unknown" },
    });
    await appendAudit(this.prisma, { organizationId: orgId, ...this.actor(auth), action: "apikey.created", targetType: "api_key", targetId: row.id, data: { role: body.role } });
    return { key, apiKey: { id: row.id, name: row.name, prefix: row.prefix, role: body.role } };
  }

  @Delete("orgs/:orgId/api-keys/:id")
  @HttpCode(204)
  @RequirePermission("apikey:manage")
  async revokeKey(@Param("orgId") orgId: string, @Param("id") id: string, @Auth() auth: AuthContext) {
    const n = await this.prisma.apiKey.updateMany({ where: { id, organizationId: orgId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!n.count) throw new NotFoundException();
    await appendAudit(this.prisma, { organizationId: orgId, ...this.actor(auth), action: "apikey.revoked", targetType: "api_key", targetId: id });
  }

  // ───────────── Outbound webhooks ─────────────

  @Get("orgs/:orgId/webhooks")
  @RequirePermission("apikey:manage")
  async webhooks(@Param("orgId") orgId: string) {
    const hooks = await this.prisma.webhookSubscription.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" } });
    return { webhooks: hooks.map(({ secretEncrypted: _s, ...h }) => h) };
  }

  @Post("orgs/:orgId/webhooks")
  @RequirePermission("apikey:manage")
  async createWebhook(@Param("orgId") orgId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(CreateWebhookSchema)) body: { url: string; events: string[] }) {
    try {
      await assertSafeOutboundUrl(body.url, { allowPrivate: process.env.ORBIX_ALLOW_PRIVATE_WEBHOOKS === "true" });
    } catch (e) {
      if (e instanceof SsrfError) throw new BadRequestException({ code: "unsafe_url", message: e.message });
      throw new BadRequestException({ code: "unresolvable_url", message: "Webhook host could not be resolved" });
    }
    const secret = `whsec_${randomToken(24)}`;
    const hook = await this.prisma.webhookSubscription.create({ data: { organizationId: orgId, url: body.url, events: body.events, secretEncrypted: encryptSecret(secret).encrypted } });
    await appendAudit(this.prisma, { organizationId: orgId, ...this.actor(auth), action: "webhook.created", targetType: "webhook", targetId: hook.id, data: { url: body.url, events: body.events } });
    return { secret, webhook: { id: hook.id, url: hook.url, events: hook.events } };
  }

  @Delete("orgs/:orgId/webhooks/:id")
  @HttpCode(204)
  @RequirePermission("apikey:manage")
  async deleteWebhook(@Param("orgId") orgId: string, @Param("id") id: string, @Auth() auth: AuthContext) {
    const n = await this.prisma.webhookSubscription.deleteMany({ where: { id, organizationId: orgId } });
    if (!n.count) throw new NotFoundException();
    await appendAudit(this.prisma, { organizationId: orgId, ...this.actor(auth), action: "webhook.deleted", targetType: "webhook", targetId: id });
  }

  // ───────────── Knowledge ─────────────

  @Get("orgs/:orgId/knowledge/documents")
  @RequirePermission("workflow:read")
  async documents(@Param("orgId") orgId: string) {
    const docs = await this.prisma.knowledgeDocument.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { _count: { select: { chunks: true } } },
    });
    return { documents: docs, embeddingModel: this.model.embeddingModel };
  }

  @Post("orgs/:orgId/knowledge/documents")
  @RequirePermission("knowledge:write")
  async ingest(@Param("orgId") orgId: string, @Auth() auth: AuthContext, @Body(new ZodPipe(CreateKnowledgeDocSchema)) body: { title: string; content: string; collection: string; sourceUrl?: string }) {
    const result = await ingestDocument(this.prisma, this.model, { organizationId: orgId, createdById: auth.userId, ...body });
    await appendAudit(this.prisma, { organizationId: orgId, ...this.actor(auth), action: "knowledge.ingested", targetType: "knowledge_document", targetId: result.document.id, data: { version: result.document.version, chunks: result.chunks } });
    return result;
  }

  @Get("orgs/:orgId/knowledge/search")
  @RequirePermission("workflow:read")
  async search(@Param("orgId") orgId: string, @Query("q") q: string, @Query("collection") collection?: string) {
    if (!q || q.length > 500) throw new BadRequestException("q is required (max 500 chars)");
    return { results: await searchKnowledge(this.prisma, this.model, { organizationId: orgId, query: q, collection }), embeddingModel: this.model.embeddingModel };
  }

  // ───────────── Inbound provider webhooks (signature-verified) ─────────────

  @Public()
  @Post("webhooks/github/:orgId")
  @HttpCode(202)
  async githubWebhook(@Param("orgId") orgId: string, @Req() req: OrbixRequest & { rawBody?: Buffer }) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret || !req.rawBody || !verifyGithubSignature(secret, req.rawBody, req.headers["x-hub-signature-256"] as string | undefined)) {
      throw new UnauthorizedException("Invalid signature");
    }
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException();
    await appendAudit(this.prisma, { organizationId: orgId, actorType: "system", action: `webhook.github.${String(req.headers["x-github-event"] ?? "unknown")}`, data: { delivery: req.headers["x-github-delivery"] } });
    return { accepted: true };
  }

  @Public()
  @Post("webhooks/slack/:orgId")
  @HttpCode(200)
  async slackWebhook(@Param("orgId") orgId: string, @Req() req: OrbixRequest & { rawBody?: Buffer }) {
    const secret = process.env.SLACK_SIGNING_SECRET;
    const raw = req.rawBody?.toString("utf8") ?? "";
    if (!secret || !verifySlackSignature(secret, raw, req.headers["x-slack-request-timestamp"] as string, req.headers["x-slack-signature"] as string)) {
      throw new UnauthorizedException("Invalid signature");
    }
    const body = req.body as { type?: string; challenge?: string };
    if (body.type === "url_verification") return { challenge: body.challenge };
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException();
    await appendAudit(this.prisma, { organizationId: orgId, actorType: "system", action: `webhook.slack.${body.type ?? "event"}` });
    return { ok: true };
  }

  @Public()
  @Get("health")
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ok", model: this.model.name, heuristicModel: this.model.heuristic };
  }
}
