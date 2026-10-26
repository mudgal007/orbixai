import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Private, loopback, link-local, CGNAT, multicast and cloud-metadata ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export class SsrfError extends Error {}

/** Guards user-supplied outbound URLs (webhooks, future custom APIs / MCP endpoints). */
export async function assertSafeOutboundUrl(raw: string, opts: { allowPrivate?: boolean } = {}): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(opts.allowPrivate && url.protocol === "http:")) {
    throw new SsrfError("Only https URLs are allowed");
  }
  if (url.username || url.password) throw new SsrfError("Credentials in URLs are not allowed");
  if (opts.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new SsrfError("URL resolves to a private or reserved address");
  }
  return url;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifyGithubSignature(secret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"), header);
}

export function verifySlackSignature(
  secret: string,
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !signature) return false;
  if (Math.abs(nowSec - Number(timestamp)) > 300) return false; // replay window
  return safeEqual("v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex"), signature);
}

/** Outbound webhook signature header value: `t=<unix>,v1=<hmac_sha256(t + "." + body)>`. */
export function signOutboundWebhook(secret: string, body: string, nowSec = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSec},v1=${createHmac("sha256", secret).update(`${nowSec}.${body}`).digest("hex")}`;
}
