import { Prisma, PrismaClient } from "@prisma/client";
import { AGENTS, CAPABILITIES, SYSTEM_ROLES, redact } from "@orbix/core";
import { sha256, canonicalJson } from "@orbix/core/node";

export * from "@prisma/client";

let client: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  client ??= new PrismaClient({ log: process.env.ORBIX_LOG_SQL === "true" ? ["query"] : ["warn", "error"] });
  return client;
}

type Tx = Prisma.TransactionClient | PrismaClient;

export interface AuditInput {
  organizationId: string;
  actorType: "user" | "api_key" | "system" | "agent";
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  data?: unknown;
}

export const GENESIS_HASH = "0".repeat(64);

export function auditHash(prevHash: string, e: { seq: number; actorType: string; actorId: string | null; action: string; targetType: string | null; targetId: string | null; data: unknown; createdAt: string }): string {
  return sha256(prevHash + canonicalJson(e));
}

/**
 * Appends an audit event to the organization's hash chain. An advisory transaction lock serialises
 * writers per org so `seq` and `prevHash` are always consistent. Data is redacted before hashing.
 */
export async function appendAudit(prisma: PrismaClient, input: AuditInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"audit:" + input.organizationId}))`;
    const last = await tx.auditEvent.findFirst({
      where: { organizationId: input.organizationId },
      orderBy: { seq: "desc" },
      select: { seq: true, hash: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const createdAt = new Date();
    const data = redact(input.data ?? {}) as Prisma.InputJsonValue;
    const hash = auditHash(prevHash, {
      seq,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      data,
      createdAt: createdAt.toISOString(),
    });
    await tx.auditEvent.create({
      data: {
        organizationId: input.organizationId,
        seq,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        data,
        prevHash,
        hash,
        createdAt,
      },
    });
  });
}

export async function verifyAuditChain(prisma: PrismaClient, organizationId: string): Promise<{ valid: boolean; checked: number; brokenAtSeq?: number }> {
  const events = await prisma.auditEvent.findMany({ where: { organizationId }, orderBy: { seq: "asc" } });
  let prev = GENESIS_HASH;
  for (const e of events) {
    const expected = auditHash(prev, {
      seq: e.seq,
      actorType: e.actorType,
      actorId: e.actorId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      data: e.data,
      createdAt: e.createdAt.toISOString(),
    });
    if (e.prevHash !== prev || e.hash !== expected) return { valid: false, checked: events.length, brokenAtSeq: e.seq };
    prev = e.hash;
  }
  return { valid: true, checked: events.length };
}

export async function emitRunEvent(db: Tx, organizationId: string, runId: string, type: string, data: unknown = {}): Promise<void> {
  await db.runEvent.create({ data: { organizationId, runId, type, data: redact(data) as Prisma.InputJsonValue } });
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "org";
}

/** Creates an org with system roles, the agent registry, a subscription row, and an owner membership. */
export async function bootstrapOrganization(prisma: PrismaClient, input: { name: string; ownerUserId: string }) {
  const slugBase = slugify(input.name);
  const suffix = Math.random().toString(36).slice(2, 7);
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name: input.name, slug: `${slugBase}-${suffix}` } });
    const roles: Record<string, string> = {};
    for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
      const r = await tx.role.create({
        data: { organizationId: org.id, key, name: role.name, permissions: [...role.permissions], system: true },
      });
      roles[key] = r.id;
    }
    await tx.membership.create({ data: { organizationId: org.id, userId: input.ownerUserId, roleId: roles.owner! } });
    for (const agent of AGENTS) {
      const a = await tx.agent.create({
        data: { organizationId: org.id, key: agent.key, name: agent.name, description: agent.description },
      });
      await tx.agentVersion.create({
        data: {
          organizationId: org.id,
          agentId: a.id,
          version: 1,
          allowedCapabilities: agent.allowedCapabilities,
          systemPrompt: agent.systemPrompt,
        },
      });
    }
    await tx.billingSubscription.create({
      data: { organizationId: org.id, runBudgetUsd: Number(process.env.ORBIX_RUN_BUDGET_USD ?? 1) },
    });
    return org;
  });
}

const PROVIDER_META: Record<string, { name: string; authType: string }> = {
  github: { name: "GitHub", authType: "oauth2_pkce" },
  slack: { name: "Slack", authType: "oauth2" },
  gmail: { name: "Gmail", authType: "oauth2_pkce" },
  google_calendar: { name: "Google Calendar", authType: "oauth2_pkce" },
  hubspot: { name: "HubSpot", authType: "oauth2" },
  shopify: { name: "Shopify", authType: "oauth2" },
  stripe: { name: "Stripe", authType: "api_key" },
  notion: { name: "Notion", authType: "oauth2" },
  linear: { name: "Linear", authType: "oauth2" },
};

/** Global integration catalog derived from the capability registry (idempotent). */
export async function syncIntegrationCatalog(prisma: PrismaClient): Promise<void> {
  for (const [provider, meta] of Object.entries(PROVIDER_META)) {
    const caps = CAPABILITIES.filter((c) => c.provider === provider);
    const status = caps.some((c) => c.availability === "available") ? "available" : "roadmap";
    await prisma.integration.upsert({
      where: { provider },
      create: { provider, name: meta.name, authType: meta.authType, status, capabilities: caps.map((c) => c.id) },
      update: { name: meta.name, authType: meta.authType, status, capabilities: caps.map((c) => c.id) },
    });
  }
}
