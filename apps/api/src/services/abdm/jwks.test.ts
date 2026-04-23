import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSign, generateKeyPairSync, KeyObject } from "node:crypto";
import {
  _peekJwksCache,
  _resetJwksCache,
  fetchJwks,
  verifyGatewaySignature,
} from "./jwks";

// ── Test helpers ──────────────────────────────────────────────────────────

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rsaKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function publicKeyToJwk(publicKey: KeyObject, kid: string) {
  const jwk = publicKey.export({ format: "jwk" }) as any;
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

function signJwt(args: {
  privateKey: KeyObject;
  kid: string;
  claims: Record<string, unknown>;
  alg?: string;
}): string {
  const alg = args.alg ?? "RS256";
  const header = { alg, typ: "JWT", kid: args.kid };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(args.claims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const sigBuf = signer.sign(args.privateKey);
  const sigB64 = b64url(sigBuf);
  return `${signingInput}.${sigB64}`;
}

function mockJwksFetch(jwks: { keys: any[] }, counter: { calls: number }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    counter.calls++;
    return new Response(JSON.stringify(jwks), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

const TEST_JWKS_URL = "https://dev.abdm.gov.in/gateway/v0.5/certs";

beforeEach(() => {
  _resetJwksCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetJwksCache();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("fetchJwks — caching", () => {
  it("fetches once and serves the 2nd call from cache", async () => {
    const kp = rsaKeyPair();
    const jwk = publicKeyToJwk(kp.publicKey, "kid-A");
    const counter = { calls: 0 };
    mockJwksFetch({ keys: [jwk] }, counter);

    const first = await fetchJwks(TEST_JWKS_URL);
    const second = await fetchJwks(TEST_JWKS_URL);

    expect(first.keys[0].kid).toBe("kid-A");
    expect(second.keys[0].kid).toBe("kid-A");
    expect(counter.calls).toBe(1);
    expect(_peekJwksCache()?.url).toBe(TEST_JWKS_URL);
  });

  it("forceRefresh bypasses the cache", async () => {
    const kp = rsaKeyPair();
    const jwk = publicKeyToJwk(kp.publicKey, "kid-A");
    const counter = { calls: 0 };
    mockJwksFetch({ keys: [jwk] }, counter);

    await fetchJwks(TEST_JWKS_URL);
    await fetchJwks(TEST_JWKS_URL, { forceRefresh: true });

    expect(counter.calls).toBe(2);
  });
});

describe("verifyGatewaySignature", () => {
  it("accepts a valid JWT signed by a JWKS key", async () => {
    const kp = rsaKeyPair();
    const jwk = publicKeyToJwk(kp.publicKey, "kid-A");
    const counter = { calls: 0 };
    mockJwksFetch({ keys: [jwk] }, counter);

    const nowSec = Math.floor(Date.now() / 1000);
    const jwt = signJwt({
      privateKey: kp.privateKey,
      kid: "kid-A",
      claims: { sub: "abdm-gateway", iat: nowSec, exp: nowSec + 300 },
    });

    const result = await verifyGatewaySignature(`Bearer ${jwt}`, undefined, {
      jwksUrl: TEST_JWKS_URL,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.sub).toBe("abdm-gateway");
      expect(result.kid).toBe("kid-A");
    }
  });

  it("rejects a JWT signed with a different key", async () => {
    const real = rsaKeyPair();
    const impostor = rsaKeyPair();
    const jwk = publicKeyToJwk(real.publicKey, "kid-A");
    const counter = { calls: 0 };
    mockJwksFetch({ keys: [jwk] }, counter);

    const nowSec = Math.floor(Date.now() / 1000);
    const jwt = signJwt({
      privateKey: impostor.privateKey,
      kid: "kid-A",
      claims: { sub: "attacker", exp: nowSec + 300 },
    });

    const result = await verifyGatewaySignature(`Bearer ${jwt}`, undefined, {
      jwksUrl: TEST_JWKS_URL,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("signature");
    }
  });

  it("rejects an expired JWT", async () => {
    const kp = rsaKeyPair();
    const jwk = publicKeyToJwk(kp.publicKey, "kid-A");
    mockJwksFetch({ keys: [jwk] }, { calls: 0 });

    const nowSec = Math.floor(Date.now() / 1000);
    const jwt = signJwt({
      privateKey: kp.privateKey,
      kid: "kid-A",
      claims: { sub: "abdm-gateway", exp: nowSec - 3600 }, // expired 1h ago
    });

    const result = await verifyGatewaySignature(`Bearer ${jwt}`, undefined, {
      jwksUrl: TEST_JWKS_URL,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("expired");
    }
  });

  it("rejects a JWT whose kid is not in the JWKS (after forced refresh)", async () => {
    const kp = rsaKeyPair();
    const jwk = publicKeyToJwk(kp.publicKey, "kid-A");
    const counter = { calls: 0 };
    mockJwksFetch({ keys: [jwk] }, counter);

    const nowSec = Math.floor(Date.now() / 1000);
    const jwt = signJwt({
      privateKey: kp.privateKey,
      kid: "kid-ZZZ", // unknown kid
      claims: { exp: nowSec + 300 },
    });

    const result = await verifyGatewaySignature(`Bearer ${jwt}`, undefined, {
      jwksUrl: TEST_JWKS_URL,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("kid");
    }
    // The miss triggers a forced refresh — 2 fetches total.
    expect(counter.calls).toBe(2);
  });

  it("rejects requests with no Authorization header", async () => {
    const result = await verifyGatewaySignature(undefined, undefined, {
      jwksUrl: TEST_JWKS_URL,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/Authorization/i);
    }
  });

  it("rejects non-Bearer Authorization schemes", async () => {
    const result = await verifyGatewaySignature("Basic dXNlcjpwYXNz", undefined, {
      jwksUrl: TEST_JWKS_URL,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/Bearer/i);
    }
  });

  it("rejects malformed JWTs", async () => {
    const result = await verifyGatewaySignature("Bearer not.a.jwt.at.all", undefined, {
      jwksUrl: TEST_JWKS_URL,
    });
    expect(result.valid).toBe(false);
  });
});
