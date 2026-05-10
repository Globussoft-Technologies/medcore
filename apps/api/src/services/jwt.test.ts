// Tests for services/jwt.ts — the algorithm-agnostic JWT signing + verification
// helper introduced with issue #482's RS256/EdDSA migration scaffold.
//
// What's covered
//   1. Default behaviour (no env vars set) — must still be HS256 with
//      JWT_SECRET, identical to the legacy `jwt.sign(payload, secret)` path.
//   2. RS256 mode — sign with private PEM, verify with public PEM.
//   3. Misconfigured RS256 (private/public key missing) — getJwtConfig throws
//      a helpful error.
//   4. Dual-verify cutover mode — primary RS256, with HS256 fallback for
//      in-flight tokens minted before the cutover.
//   5. Dual-verify safety — without the fallback flag, an HS256-minted token
//      MUST NOT verify under RS256-primary. (This is the security contract:
//      the fallback is opt-in and time-limited.)
//
// The keypair fixtures live in apps/api/src/test/fixtures/jwt-test-*.pem.
// They are clearly labelled NOT-FOR-PRODUCTION — see the README in that dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import {
  __resetJwtConfigForTests,
  getJwtConfig,
  signAccessToken,
  verifyAccessToken,
} from "./jwt";

const FIXTURES_DIR = path.resolve(__dirname, "../test/fixtures");
const TEST_PRIVATE_KEY = fs.readFileSync(
  path.join(FIXTURES_DIR, "jwt-test-private.pem"),
  "utf8",
);
const TEST_PUBLIC_KEY = fs.readFileSync(
  path.join(FIXTURES_DIR, "jwt-test-public.pem"),
  "utf8",
);

const HS_SECRET = "hs256-test-secret-do-not-use-in-prod";

// Snapshot env vars we mutate per-case, restore after each test.
const ENV_KEYS = [
  "JWT_ALG",
  "JWT_SECRET",
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "JWT_DUAL_VERIFY_HS256_FALLBACK",
] as const;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  originalEnv = {};
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetJwtConfigForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  __resetJwtConfigForTests();
});

describe("getJwtConfig — defaults", () => {
  it("falls back to HS256 with JWT_SECRET when JWT_ALG is unset", () => {
    process.env.JWT_SECRET = HS_SECRET;
    const cfg = getJwtConfig();
    expect(cfg.alg).toBe("HS256");
    expect(cfg.signingKey).toBe(HS_SECRET);
    expect(cfg.verifyKey).toBe(HS_SECRET);
    expect(cfg.dualVerifyHs256Fallback).toBe(false);
    expect(cfg.source).toBe("default");
  });

  it("rejects an unrecognised JWT_ALG value", () => {
    process.env.JWT_ALG = "NONE";
    expect(() => getJwtConfig()).toThrowError(/unsupported JWT_ALG/);
  });

  it("requires both private and public key when JWT_ALG=RS256", () => {
    process.env.JWT_ALG = "RS256";
    expect(() => getJwtConfig()).toThrowError(
      /requires both JWT_PRIVATE_KEY and JWT_PUBLIC_KEY/,
    );
  });
});

describe("HS256 mode (current default)", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = HS_SECRET;
  });

  it("signs + verifies a payload roundtrip", () => {
    const token = signAccessToken({ userId: "u1", role: "ADMIN" });
    const decoded = verifyAccessToken<{ userId: string; role: string }>(token);
    expect(decoded.userId).toBe("u1");
    expect(decoded.role).toBe("ADMIN");
  });

  it("a token signed with the legacy raw-jwt path still verifies", () => {
    // This is the backward-compat contract: every token currently in flight
    // was minted via `jwt.sign(payload, process.env.JWT_SECRET)`. After the
    // refactor lands, those tokens MUST keep verifying or every active
    // session 401s.
    const legacy = jwt.sign({ userId: "u2", role: "DOCTOR" }, HS_SECRET);
    const decoded = verifyAccessToken<{ userId: string; role: string }>(legacy);
    expect(decoded.userId).toBe("u2");
    expect(decoded.role).toBe("DOCTOR");
  });

  it("rejects a token signed with the wrong secret", () => {
    const bad = jwt.sign({ userId: "u3" }, "different-secret");
    expect(() => verifyAccessToken(bad)).toThrow();
  });
});

describe("RS256 mode", () => {
  beforeEach(() => {
    process.env.JWT_ALG = "RS256";
    process.env.JWT_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.JWT_PUBLIC_KEY = TEST_PUBLIC_KEY;
    process.env.JWT_SECRET = HS_SECRET; // still set; should NOT be used to verify
  });

  it("signs with the private PEM and verifies with the public PEM", () => {
    const token = signAccessToken({ userId: "u-rs", role: "ADMIN" });
    // Sanity: the alg header should reflect RS256.
    const header = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
    );
    expect(header.alg).toBe("RS256");

    const decoded = verifyAccessToken<{ userId: string; role: string }>(token);
    expect(decoded.userId).toBe("u-rs");
    expect(decoded.role).toBe("ADMIN");
  });

  it("rejects an HS256-signed token (dual-verify flag NOT set)", () => {
    // Security contract: without the explicit fallback flag, a token signed
    // under the old HS256 + JWT_SECRET path MUST NOT verify under
    // RS256-primary. Otherwise the fallback isn't time-bounded — it would be
    // effectively always-on.
    const hsToken = jwt.sign({ userId: "u4" }, HS_SECRET);
    expect(() => verifyAccessToken(hsToken)).toThrow();
  });
});

describe("Dual-verify mode (RS256 primary + HS256 fallback)", () => {
  beforeEach(() => {
    process.env.JWT_ALG = "RS256";
    process.env.JWT_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.JWT_PUBLIC_KEY = TEST_PUBLIC_KEY;
    process.env.JWT_SECRET = HS_SECRET;
    process.env.JWT_DUAL_VERIFY_HS256_FALLBACK = "1";
  });

  it("verifies an RS256-signed token via the primary path", () => {
    const token = signAccessToken({ userId: "u-rs", role: "ADMIN" });
    const decoded = verifyAccessToken<{ userId: string; role: string }>(token);
    expect(decoded.userId).toBe("u-rs");
  });

  it("verifies an HS256-signed legacy token via the fallback", () => {
    // This is the cutover scenario: deployment has flipped JWT_ALG to RS256
    // but there are still browser sessions holding HS256-signed tokens that
    // were issued ~minutes before the deploy. With the flag on, those tokens
    // verify cleanly via the HS256 fallback. Without the flag (next test
    // group), they 401 — which is the long-term steady state.
    const legacyHs = jwt.sign({ userId: "u-legacy", role: "NURSE" }, HS_SECRET);
    const decoded = verifyAccessToken<{ userId: string; role: string }>(
      legacyHs,
    );
    expect(decoded.userId).toBe("u-legacy");
    expect(decoded.role).toBe("NURSE");
  });

  it("still rejects a token signed with neither the RS256 key nor JWT_SECRET", () => {
    const bogus = jwt.sign({ userId: "attacker" }, "completely-different-secret");
    expect(() => verifyAccessToken(bogus)).toThrow();
  });

  it("the fallback does NOT activate when the primary alg IS HS256", () => {
    // Sanity: if a deployment somehow has JWT_ALG=HS256 + the flag set
    // (misconfiguration), we don't want a quiet "retry HS256" loop that
    // hides errors. The flag is a no-op in that mode.
    process.env.JWT_ALG = "HS256";
    process.env.JWT_DUAL_VERIFY_HS256_FALLBACK = "1";
    __resetJwtConfigForTests();
    const bad = jwt.sign({ userId: "x" }, "another-secret");
    expect(() => verifyAccessToken(bad)).toThrow();
  });
});

describe("Dual-verify safety: token from old alg DOES NOT bypass when flag is off", () => {
  it("HS256-signed token fails under RS256-primary without the fallback flag", () => {
    process.env.JWT_ALG = "RS256";
    process.env.JWT_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.JWT_PUBLIC_KEY = TEST_PUBLIC_KEY;
    process.env.JWT_SECRET = HS_SECRET;
    // JWT_DUAL_VERIFY_HS256_FALLBACK intentionally unset.
    __resetJwtConfigForTests();

    const legacyHs = jwt.sign({ userId: "u-legacy" }, HS_SECRET);
    expect(() => verifyAccessToken(legacyHs)).toThrow();
  });
});
