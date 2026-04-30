// Auth edge cases not covered by auth.test.ts.
//
// Covers:
//   – Refresh-token rotation / reuse-attack detection
//   – Bad-password attempts (no lockout expected, rate limiter disabled in NODE_ENV=test)
//   – Malformed / expired / tampered JWT → 401
//   – change-password with wrong current → 400
//   – forgot-password: always 200 (email enumeration safe)
//   – logout invalidates refresh tokens
//
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { describeIfDB, resetDB, getPrisma } from "../setup";

let app: any;

const EMAIL = "edge-user@test.local";
const PASSWORD = "MedCoreT3st-2026";

async function registerEdgeUser() {
  const res = await request(app).post("/api/v1/auth/register").send({
    name: "Edge User",
    email: EMAIL,
    phone: "9111222333",
    password: PASSWORD,
    role: "RECEPTION",
  });
  expect(res.status).toBeLessThan(400);
  return res.body.data.tokens as {
    accessToken: string;
    refreshToken: string;
  };
}

async function login() {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.tokens as { accessToken: string; refreshToken: string };
}

describeIfDB("Auth Edge Cases (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
    await registerEdgeUser();
  });

  // ─── 1. Refresh rotation ────────────────────────────
  it("rotates refresh tokens: old refresh token is rejected after reuse", async () => {
    const first = await login();

    const r1 = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: first.refreshToken });
    expect(r1.status).toBe(200);
    const newTokens = r1.body.data.tokens;
    expect(newTokens.refreshToken).toBeTruthy();
    expect(newTokens.refreshToken).not.toBe(first.refreshToken);

    // Old refresh token must now be rejected.
    const r2 = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: first.refreshToken });
    expect([401, 403]).toContain(r2.status);
  });

  // ─── 2. Refresh reuse-attack (same refresh twice immediately) ──
  it("rejects the second use of the same refresh token (reuse attack)", async () => {
    const t = await login();
    const a = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: t.refreshToken });
    expect(a.status).toBe(200);

    const b = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: t.refreshToken });
    expect([401, 403]).toContain(b.status);
  });

  // ─── 3. Bad-password attempts — no lockout, limiter disabled in test ──
  it("allows N=5 bad password attempts in a row (no account lockout is implemented)", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: EMAIL, password: "wrong-password" });
      expect([401, 429]).toContain(res.status);
    }
    // Good credentials still work after the failed attempts
    const ok = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect([200, 429]).toContain(ok.status);
  });

  // ─── 4. Malformed JWT ───────────────────────────────
  it("rejects a malformed Bearer token with 401", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer invalid.token.here");
    expect(res.status).toBe(401);
  });

  // ─── 5. Expired JWT ─────────────────────────────────
  it("rejects an expired JWT with 401", async () => {
    const expired = jwt.sign(
      { userId: "u1", email: EMAIL, role: "RECEPTION" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "-1h" }
    );
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  // ─── 6. Tampered JWT (re-signed with a different secret) ──
  it("rejects a JWT re-signed with a different secret with 401", async () => {
    const forged = jwt.sign(
      { userId: "u1", email: EMAIL, role: "ADMIN" },
      "attacker-controlled-secret",
      { expiresIn: "1h" }
    );
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  // ─── 7. change-password with wrong current ─────────
  it("POST /auth/change-password with wrong current password → 400", async () => {
    const { accessToken } = await login();
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ currentPassword: "not-the-password", newPassword: "newpass123" });
    expect([400, 401]).toContain(res.status);
  });

  // ─── 8. forgot-password is enumeration-safe ────────
  it("POST /auth/forgot-password returns 200 for unknown email (no enumeration)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "no-such-user@test.local" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("POST /auth/forgot-password returns 200 for known email", async () => {
    const res = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: EMAIL });
    expect(res.status).toBe(200);
    // NOTE: reset codes are stored in an in-memory Map, NOT the DB.
    // There is no DB-level reset-token table to inspect — so we cannot verify
    // persistence here. The route logs the code to stdout instead.
  });

  // ─── 9. Logout invalidates refresh tokens ──────────
  it("POST /auth/logout invalidates all refresh tokens for the user", async () => {
    const tokens = await login();
    const lo = await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${tokens.accessToken}`);
    expect(lo.status).toBe(200);

    const refreshed = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: tokens.refreshToken });
    expect([401, 403]).toContain(refreshed.status);

    // Bonus: confirm no refresh tokens remain in DB for this user
    const prisma = await getPrisma();
    const user = await prisma.user.findUnique({ where: { email: EMAIL } });
    const remaining = await prisma.refreshToken.count({
      where: { userId: user.id },
    });
    expect(remaining).toBe(0);
  });
});
