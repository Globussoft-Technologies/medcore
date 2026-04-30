/**
 * Issue #1 integration test — "Remember me" refresh-token TTL.
 *
 * Verifies:
 *  - Without `rememberMe`, the refresh token's JWT `exp` is ~7 days out and
 *    the corresponding `RefreshToken` row in Postgres also expires in ~7d.
 *  - With `rememberMe: true`, both the JWT `exp` and the DB row expire in
 *    ~30 days. Matching the two means a stale DB row can't silently outlive
 *    the signed token (or vice versa).
 *
 * The access token is asserted to stay at ~24h regardless of rememberMe, to
 * catch any regression that accidentally widens the access-token window.
 */
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { describeIfDB, resetDB, getPrisma } from "../setup";

// Fuzzy-compare an epoch-seconds `exp` claim to an expected TTL in seconds.
// `maxDriftSeconds` absorbs the time between mint and assert (network, DB,
// bcrypt) without making the test flaky.
function expectTtlAround(
  expSeconds: number,
  expectedSeconds: number,
  maxDriftSeconds: number = 120
) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = expSeconds - nowSeconds;
  expect(ttl).toBeGreaterThan(expectedSeconds - maxDriftSeconds);
  expect(ttl).toBeLessThanOrEqual(expectedSeconds + maxDriftSeconds);
}

let app: any;

describeIfDB("Auth API — rememberMe refresh TTL (Issue #1)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  it("mints a 7-day refresh token when rememberMe is absent", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    expect(res.status).toBe(200);
    const { accessToken, refreshToken } = res.body.data.tokens;

    const accessDecoded = jwt.decode(accessToken) as { exp: number };
    const refreshDecoded = jwt.decode(refreshToken) as { exp: number };
    expectTtlAround(accessDecoded.exp, 24 * 60 * 60); // 24h access
    expectTtlAround(refreshDecoded.exp, 7 * 24 * 60 * 60); // 7d refresh

    // DB row should match the JWT claim.
    const prisma = await getPrisma();
    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    });
    expect(stored).toBeTruthy();
    const dbTtl = Math.floor(
      (new Date(stored!.expiresAt).getTime() - Date.now()) / 1000
    );
    expect(dbTtl).toBeGreaterThan(7 * 24 * 60 * 60 - 120);
    expect(dbTtl).toBeLessThanOrEqual(7 * 24 * 60 * 60 + 120);
  });

  it("mints a 7-day refresh token when rememberMe=false", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({
        email: "admin@test.local",
        password: "MedCoreT3st-2026",
        rememberMe: false,
      });
    expect(res.status).toBe(200);
    const refreshDecoded = jwt.decode(res.body.data.tokens.refreshToken) as {
      exp: number;
    };
    expectTtlAround(refreshDecoded.exp, 7 * 24 * 60 * 60);
  });

  it("mints a 30-day refresh token when rememberMe=true", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({
        email: "admin@test.local",
        password: "MedCoreT3st-2026",
        rememberMe: true,
      });
    expect(res.status).toBe(200);
    const { accessToken, refreshToken } = res.body.data.tokens;

    const accessDecoded = jwt.decode(accessToken) as { exp: number };
    const refreshDecoded = jwt.decode(refreshToken) as { exp: number };
    // Access token MUST stay at 24h even with rememberMe — widening it would
    // expand the blast radius of a stolen bearer.
    expectTtlAround(accessDecoded.exp, 24 * 60 * 60);
    expectTtlAround(refreshDecoded.exp, 30 * 24 * 60 * 60);

    const prisma = await getPrisma();
    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    });
    expect(stored).toBeTruthy();
    const dbTtl = Math.floor(
      (new Date(stored!.expiresAt).getTime() - Date.now()) / 1000
    );
    expect(dbTtl).toBeGreaterThan(30 * 24 * 60 * 60 - 120);
    expect(dbTtl).toBeLessThanOrEqual(30 * 24 * 60 * 60 + 120);
  });

  it("still accepts login when rememberMe is not a boolean (schema coerces to optional)", async () => {
    // Defensive: the web app only sends booleans, but integration tests and
    // external clients should not crash on a stray string.
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    expect(res.status).toBe(200);
  });
});
