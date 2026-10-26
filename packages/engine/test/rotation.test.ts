import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { CredentialBroker, decryptSecret, encryptSecret, loadKeyRing, rotateSecrets } from "@orbix/connectors";
import { bootstrapOrganization, getPrisma } from "@orbix/db";

const prisma = getPrisma();
afterAll(() => prisma.$disconnect());

describe("secret rotation", () => {
  it("re-encrypts credentials, webhook secrets and live OAuth states to the new key, idempotently", async () => {
    const k1 = randomBytes(32).toString("base64");
    const k2 = randomBytes(32).toString("base64");
    const ringV1 = loadKeyRing({ ORBIX_ENCRYPTION_KEY: k1 });
    const ringV2 = loadKeyRing({ ORBIX_ENCRYPTION_KEYS: `2:${k2},1:${k1}` });
    const ringOnlyV2 = loadKeyRing({ ORBIX_ENCRYPTION_KEYS: `2:${k2}` });

    // Isolate this test's rows from the rest of the suite: everything else in the DB uses other keys.
    await prisma.credentialReference.deleteMany({});
    await prisma.webhookSubscription.deleteMany({});
    await prisma.oAuthState.deleteMany({});

    const user = await prisma.user.create({ data: { email: `rot-${Date.now()}@test.dev`, name: "rot", passwordHash: "x" } });
    const org = await bootstrapOrganization(prisma, { name: "rotation", ownerUserId: user.id });
    const conn = await prisma.connection.create({ data: { organizationId: org.id, provider: "github", label: "live", mode: "LIVE", scopes: ["repo"] } });

    const prev = { ...process.env };
    process.env.ORBIX_ENCRYPTION_KEY = k1;
    delete process.env.ORBIX_ENCRYPTION_KEYS;
    await new CredentialBroker(prisma).store({ organizationId: org.id, connectionId: conn.id, kind: "token", accessToken: "ghp_rotation_token_value_123456" });
    process.env = prev;

    await prisma.webhookSubscription.create({ data: { organizationId: org.id, url: "https://example.com/h", events: ["run.completed"], secretEncrypted: encryptSecret("whsec_abc", ringV1).encrypted } });
    await prisma.oAuthState.create({ data: { organizationId: org.id, userId: user.id, provider: "github", stateHash: `live-${Date.now()}`, codeVerifierEncrypted: encryptSecret("verifier", ringV1).encrypted, expiresAt: new Date(Date.now() + 600_000) } });
    await prisma.oAuthState.create({ data: { organizationId: org.id, userId: user.id, provider: "github", stateHash: `dead-${Date.now()}`, codeVerifierEncrypted: encryptSecret("old", ringV1).encrypted, expiresAt: new Date(Date.now() - 1000) } });

    const dry = await rotateSecrets(prisma, { ring: ringV2, dryRun: true });
    expect(dry.reencrypted).toEqual({ credentials: 1, webhooks: 1, oauthStates: 1 });
    expect(dry.oauthStatesDeleted).toBe(1);
    expect((await prisma.credentialReference.findUniqueOrThrow({ where: { connectionId: conn.id } })).keyVersion).toBe(1); // dry run changed nothing

    const report = await rotateSecrets(prisma, { ring: ringV2 });
    expect(report.versionsBefore).toEqual({ v1: 3 });
    expect(report.reencrypted).toEqual({ credentials: 1, webhooks: 1, oauthStates: 1 });

    // Everything is now readable with ONLY the new key, and plaintext is unchanged.
    const cred = await prisma.credentialReference.findUniqueOrThrow({ where: { connectionId: conn.id } });
    expect(cred.keyVersion).toBe(2);
    expect(JSON.parse(decryptSecret(cred.encrypted, ringOnlyV2)).accessToken).toBe("ghp_rotation_token_value_123456");
    const hook = await prisma.webhookSubscription.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(decryptSecret(hook.secretEncrypted, ringOnlyV2)).toBe("whsec_abc");
    const states = await prisma.oAuthState.findMany({ where: { organizationId: org.id } });
    expect(states).toHaveLength(1);
    expect(decryptSecret(states[0]!.codeVerifierEncrypted, ringOnlyV2)).toBe("verifier");

    const again = await rotateSecrets(prisma, { ring: ringV2 });
    expect(again.reencrypted).toEqual({ credentials: 0, webhooks: 0, oauthStates: 0 });
    expect(again.versionsBefore).toEqual({ v2: 3 });

    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: org.id, action: "security.secrets_rotated" } });
    expect(audit?.data).toMatchObject({ toKeyVersion: 2, itemsReencrypted: 2 });
  });
});
