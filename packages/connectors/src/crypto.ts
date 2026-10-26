import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Versioned key ring for secrets at rest.
 *   ORBIX_ENCRYPTION_KEY           legacy single key; treated as version 1
 *   ORBIX_ENCRYPTION_KEYS          "3:<base64>,2:<base64>" — every version that may still be in use
 *   ORBIX_ENCRYPTION_KEY_VERSION   version used for new encryptions (defaults to the highest)
 * Envelopes record their version, so old data stays readable while `pnpm keys:rotate` re-encrypts it.
 */
export interface KeyRing {
  current: number;
  keys: Map<number, Buffer>;
}

function parseKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error(`${label} must be 32 bytes, base64-encoded`);
  return key;
}

export function loadKeyRing(env: NodeJS.ProcessEnv = process.env): KeyRing {
  const keys = new Map<number, Buffer>();
  for (const entry of (env.ORBIX_ENCRYPTION_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(":");
    const version = Number(entry.slice(0, idx));
    if (idx < 1 || !Number.isInteger(version) || version < 1) throw new Error(`Invalid ORBIX_ENCRYPTION_KEYS entry "${entry.slice(0, 8)}…" (expected <version>:<base64>)`);
    keys.set(version, parseKey(entry.slice(idx + 1), `ORBIX_ENCRYPTION_KEYS v${version}`));
  }
  if (env.ORBIX_ENCRYPTION_KEY) {
    const legacy = parseKey(env.ORBIX_ENCRYPTION_KEY, "ORBIX_ENCRYPTION_KEY");
    const existing = keys.get(1);
    if (existing && !existing.equals(legacy)) throw new Error("ORBIX_ENCRYPTION_KEY conflicts with version 1 in ORBIX_ENCRYPTION_KEYS");
    keys.set(1, legacy);
  }
  if (keys.size === 0) throw new Error("ORBIX_ENCRYPTION_KEY (or ORBIX_ENCRYPTION_KEYS) is not set");
  const current = env.ORBIX_ENCRYPTION_KEY_VERSION ? Number(env.ORBIX_ENCRYPTION_KEY_VERSION) : Math.max(...keys.keys());
  if (!keys.has(current)) throw new Error(`ORBIX_ENCRYPTION_KEY_VERSION=${current} has no matching key`);
  return { current, keys };
}

/** AES-256-GCM envelope: "v<version>:<iv>:<tag>:<ciphertext>" (base64url parts). */
export function encryptSecret(plaintext: string, ring: KeyRing = loadKeyRing()): { encrypted: string; keyVersion: number } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.keys.get(ring.current)!, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: [`v${ring.current}`, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":"),
    keyVersion: ring.current,
  };
}

export function envelopeVersion(envelope: string): number {
  const m = /^v(\d+):/.exec(envelope);
  if (!m) throw new Error("Unsupported credential envelope");
  return Number(m[1]);
}

export function decryptSecret(envelope: string, ring: KeyRing = loadKeyRing()): string {
  const [, iv, tag, ct] = envelope.split(":");
  const version = envelopeVersion(envelope);
  const key = ring.keys.get(version);
  if (!key) throw new Error(`Encryption key v${version} is not configured (add it to ORBIX_ENCRYPTION_KEYS)`);
  if (!iv || !tag || !ct) throw new Error("Unsupported credential envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
