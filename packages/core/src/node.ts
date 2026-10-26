import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { canonicalJson } from "./canonical";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** scrypt password hash: "scrypt$N$r$p$salt$hash" (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Hash bound into approvals and idempotency keys: any change to the payload changes the hash. */
export function hashPayload(payload: unknown): string {
  return sha256(canonicalJson(payload));
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export * from "./index";
