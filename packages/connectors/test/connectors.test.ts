import { createHmac, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeOutboundUrl,
  buildAuthorizeUrl,
  createPkcePair,
  decryptSecret,
  encryptSecret,
  envelopeVersion,
  loadKeyRing,
  isPrivateAddress,
  oauthConfig,
  verifyGithubSignature,
  verifySlackSignature,
} from "../src";
import { toIssue } from "../src/github/real";

beforeAll(() => {
  process.env.ORBIX_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("credential encryption", () => {
  it("round-trips and detects tampering", () => {
    const { encrypted } = encryptSecret("xoxb-secret-token");
    expect(encrypted).not.toContain("xoxb");
    expect(decryptSecret(encrypted)).toBe("xoxb-secret-token");
    const parts = encrypted.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});

describe("oauth", () => {
  it("builds a PKCE S256 authorize URL with state", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const url = new URL(buildAuthorizeUrl(oauthConfig("github"), { state: "abc", redirectUri: "http://localhost:4000/cb", codeChallenge: challenge }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("abc");
  });
});

describe("webhook signatures", () => {
  it("verifies GitHub HMAC", () => {
    const body = '{"action":"opened"}';
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifyGithubSignature("s3cret", body, sig)).toBe(true);
    expect(verifyGithubSignature("wrong", body, sig)).toBe(false);
  });
  it("verifies Slack signature and rejects replays", () => {
    const ts = "1700000000";
    const body = "token=x";
    const sig = "v0=" + createHmac("sha256", "sign").update(`v0:${ts}:${body}`).digest("hex");
    expect(verifySlackSignature("sign", body, ts, sig, 1700000100)).toBe(true);
    expect(verifySlackSignature("sign", body, ts, sig, 1700009999)).toBe(false);
  });
});

describe("SSRF guard", () => {
  it("classifies private ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "172.20.0.1", "::1", "fd00::1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("140.82.112.3")).toBe(false);
  });
  it("rejects http, credentials and private IP literals", async () => {
    await expect(assertSafeOutboundUrl("http://example.com")).rejects.toThrow();
    await expect(assertSafeOutboundUrl("https://user:pw@example.com")).rejects.toThrow();
    await expect(assertSafeOutboundUrl("https://169.254.169.254/latest")).rejects.toThrow();
  });
});

describe("github mapping", () => {
  it("maps API issues and computes staleness", () => {
    const now = Date.parse("2026-01-20T00:00:00Z");
    const i = toIssue(
      { number: 1, title: "t", html_url: "u", body: null, state: "open", updated_at: "2026-01-10T00:00:00Z", labels: [{ name: "bug" }], repository_url: "https://api.github.com/repos/a/b" },
      now,
    );
    expect(i).toMatchObject({ repo: "a/b", daysStale: 10, labels: ["bug"], body: "" });
  });
});

describe("key ring", () => {
  const k1 = randomBytes(32).toString("base64");
  const k2 = randomBytes(32).toString("base64");

  it("treats the legacy single key as version 1", () => {
    const ring = loadKeyRing({ ORBIX_ENCRYPTION_KEY: k1 });
    expect(ring.current).toBe(1);
    expect(encryptSecret("x", ring).encrypted.startsWith("v1:")).toBe(true);
  });

  it("encrypts with the newest version and still decrypts older envelopes", () => {
    const old = encryptSecret("legacy-secret", loadKeyRing({ ORBIX_ENCRYPTION_KEY: k1 })).encrypted;
    const ring = loadKeyRing({ ORBIX_ENCRYPTION_KEYS: `2:${k2},1:${k1}` });
    expect(ring.current).toBe(2);
    expect(decryptSecret(old, ring)).toBe("legacy-secret");
    const fresh = encryptSecret("new-secret", ring);
    expect(fresh.keyVersion).toBe(2);
    expect(envelopeVersion(fresh.encrypted)).toBe(2);
  });

  it("can pin the encryption version during a staged rollout", () => {
    const ring = loadKeyRing({ ORBIX_ENCRYPTION_KEYS: `2:${k2},1:${k1}`, ORBIX_ENCRYPTION_KEY_VERSION: "1" });
    expect(encryptSecret("x", ring).keyVersion).toBe(1);
  });

  it("fails clearly when a needed key is missing or keys conflict", () => {
    const v2 = encryptSecret("x", loadKeyRing({ ORBIX_ENCRYPTION_KEYS: `2:${k2}` })).encrypted;
    expect(() => decryptSecret(v2, loadKeyRing({ ORBIX_ENCRYPTION_KEY: k1 }))).toThrow(/v2 is not configured/);
    expect(() => loadKeyRing({ ORBIX_ENCRYPTION_KEYS: `1:${k2}`, ORBIX_ENCRYPTION_KEY: k1 })).toThrow(/conflicts/);
    expect(() => loadKeyRing({ ORBIX_ENCRYPTION_KEYS: "nope" })).toThrow(/Invalid/);
    expect(() => loadKeyRing({})).toThrow(/not set/);
  });
});
