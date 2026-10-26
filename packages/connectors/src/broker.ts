import { ExecutionError } from "@orbix/core";
import type { PrismaClient } from "@orbix/db";
import { decryptSecret, encryptSecret } from "./crypto";
import { refreshAccessToken } from "./oauth";

interface StoredSecret {
  accessToken: string;
  refreshToken?: string;
}

/**
 * Credential broker. The only component that decrypts provider tokens. Tokens are handed to a
 * connector call through a closure and are never placed into run context, prompts, logs or traces.
 */
export class CredentialBroker {
  constructor(private readonly prisma: PrismaClient) {}

  async store(input: {
    organizationId: string;
    connectionId: string;
    kind: "oauth" | "token";
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }): Promise<void> {
    const secret: StoredSecret = { accessToken: input.accessToken, refreshToken: input.refreshToken };
    const { encrypted, keyVersion } = encryptSecret(JSON.stringify(secret));
    await this.prisma.credentialReference.upsert({
      where: { connectionId: input.connectionId },
      create: { organizationId: input.organizationId, connectionId: input.connectionId, kind: input.kind, encrypted, keyVersion, expiresAt: input.expiresAt },
      update: { encrypted, keyVersion, expiresAt: input.expiresAt, rotatedAt: new Date() },
    });
  }

  /** Returns a usable access token, refreshing when it is within 60s of expiry. Enforces tenancy. */
  async getAccessToken(organizationId: string, connectionId: string): Promise<string> {
    const cred = await this.prisma.credentialReference.findUnique({
      where: { connectionId },
      include: { connection: true },
    });
    if (!cred || cred.organizationId !== organizationId || cred.connection.organizationId !== organizationId) {
      throw new ExecutionError("permission", "Credential not found for this organization");
    }
    if (cred.connection.status === "REVOKED") throw new ExecutionError("permission", "Connection has been revoked");
    const secret = JSON.parse(decryptSecret(cred.encrypted)) as StoredSecret;

    if (cred.expiresAt && cred.expiresAt.getTime() - Date.now() < 60_000) {
      if (!secret.refreshToken) throw new ExecutionError("permission", "Access token expired and no refresh token is available");
      const refreshed = await refreshAccessToken(cred.connection.provider, secret.refreshToken);
      await this.store({
        organizationId,
        connectionId,
        kind: "oauth",
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? secret.refreshToken,
        expiresAt: refreshed.expiresAt,
      });
      return refreshed.accessToken;
    }
    return secret.accessToken;
  }

  async readSecret(organizationId: string, connectionId: string): Promise<StoredSecret | null> {
    const cred = await this.prisma.credentialReference.findUnique({ where: { connectionId } });
    if (!cred || cred.organizationId !== organizationId) return null;
    return JSON.parse(decryptSecret(cred.encrypted)) as StoredSecret;
  }
}
