import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_VERSION = 1;

function loadKey(): Buffer {
  const raw = process.env.ORBIX_ENCRYPTION_KEY;
  if (!raw) throw new Error("ORBIX_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ORBIX_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

/** AES-256-GCM envelope: "v1:<iv>:<tag>:<ciphertext>" (base64url parts). */
export function encryptSecret(plaintext: string): { encrypted: string; keyVersion: number } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: [`v${KEY_VERSION}`, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":"),
    keyVersion: KEY_VERSION,
  };
}

export function decryptSecret(envelope: string): string {
  const [version, iv, tag, ct] = envelope.split(":");
  if (version !== `v${KEY_VERSION}` || !iv || !tag || !ct) throw new Error("Unsupported credential envelope");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
