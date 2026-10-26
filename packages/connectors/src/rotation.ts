import { appendAudit, type PrismaClient } from "@orbix/db";
import { decryptSecret, encryptSecret, envelopeVersion, loadKeyRing, type KeyRing } from "./crypto";

export interface RotationReport {
  currentVersion: number;
  /** Envelopes per key version before rotation, across all secret-bearing columns. */
  versionsBefore: Record<string, number>;
  reencrypted: { credentials: number; webhooks: number; oauthStates: number };
  oauthStatesDeleted: number;
  dryRun: boolean;
}

const BATCH = 200;

/**
 * Re-encrypts every stored secret that is not on the current key version. Idempotent and
 * resumable (rows already on the current version are skipped). Expired or consumed OAuth states are
 * deleted instead of re-encrypted. Once a run reports nothing left on an old version, that key can
 * be removed from ORBIX_ENCRYPTION_KEYS.
 */
export async function rotateSecrets(prisma: PrismaClient, opts: { dryRun?: boolean; ring?: KeyRing } = {}): Promise<RotationReport> {
  const ring = opts.ring ?? loadKeyRing();
  const dryRun = !!opts.dryRun;
  const versionsBefore: Record<string, number> = {};
  const count = (env: string) => {
    const v = `v${envelopeVersion(env)}`;
    versionsBefore[v] = (versionsBefore[v] ?? 0) + 1;
  };
  const reencrypted = { credentials: 0, webhooks: 0, oauthStates: 0 };
  const perOrg = new Map<string, number>();
  const bump = (orgId: string) => perOrg.set(orgId, (perOrg.get(orgId) ?? 0) + 1);
  const stale = (env: string) => envelopeVersion(env) !== ring.current;

  for (let cursor: string | undefined; ; ) {
    const rows = await prisma.credentialReference.findMany({ take: BATCH, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: "asc" } });
    if (!rows.length) break;
    for (const r of rows) {
      count(r.encrypted);
      if (!stale(r.encrypted)) continue;
      reencrypted.credentials++;
      bump(r.organizationId);
      if (dryRun) continue;
      const { encrypted, keyVersion } = encryptSecret(decryptSecret(r.encrypted, ring), ring);
      // Compare-and-swap on the old ciphertext so a concurrent token refresh is never overwritten.
      await prisma.credentialReference.updateMany({ where: { id: r.id, encrypted: r.encrypted }, data: { encrypted, keyVersion, rotatedAt: new Date() } });
    }
    cursor = rows[rows.length - 1]!.id;
  }

  for (let cursor: string | undefined; ; ) {
    const rows = await prisma.webhookSubscription.findMany({ take: BATCH, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: "asc" } });
    if (!rows.length) break;
    for (const r of rows) {
      count(r.secretEncrypted);
      if (!stale(r.secretEncrypted)) continue;
      reencrypted.webhooks++;
      bump(r.organizationId);
      if (dryRun) continue;
      const { encrypted } = encryptSecret(decryptSecret(r.secretEncrypted, ring), ring);
      await prisma.webhookSubscription.updateMany({ where: { id: r.id, secretEncrypted: r.secretEncrypted }, data: { secretEncrypted: encrypted } });
    }
    cursor = rows[rows.length - 1]!.id;
  }

  const deadStates = { OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: new Date() } }] };
  const oauthStatesDeleted = dryRun ? await prisma.oAuthState.count({ where: deadStates }) : (await prisma.oAuthState.deleteMany({ where: deadStates })).count;
  for (const r of await prisma.oAuthState.findMany({ where: dryRun ? { NOT: deadStates } : {} })) {
    count(r.codeVerifierEncrypted);
    if (!stale(r.codeVerifierEncrypted)) continue;
    reencrypted.oauthStates++;
    if (dryRun) continue;
    const { encrypted } = encryptSecret(decryptSecret(r.codeVerifierEncrypted, ring), ring);
    await prisma.oAuthState.updateMany({ where: { id: r.id, codeVerifierEncrypted: r.codeVerifierEncrypted }, data: { codeVerifierEncrypted: encrypted } });
  }

  if (!dryRun) {
    for (const [organizationId, secrets] of perOrg) {
      await appendAudit(prisma, { organizationId, actorType: "system", action: "security.secrets_rotated", data: { toKeyVersion: ring.current, itemsReencrypted: secrets } });
    }
  }
  return { currentVersion: ring.current, versionsBefore, reencrypted, oauthStatesDeleted, dryRun };
}
