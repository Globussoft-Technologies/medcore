// Integration test: password reset codes survive a "process restart".
//
// Before the fix the codes lived in an in-memory `Map`, so any API restart
// (PM2 reload, deploy, crash) silently invalidated every outstanding reset
// code. We now persist them in `password_reset_codes`. This test exercises
// the persistence boundary: write a code via /forgot-password, drop the
// in-process state by re-importing the router fresh, and confirm
// /reset-password still accepts it.

import { it, expect, beforeAll, describe } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { createUserFixture } from "../factories";

let app: any;

describeIfDB("Auth persistence (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  describe("password reset code", () => {
    it("survives a simulated process restart and remains usable", async () => {
      const prisma = await getPrisma();
      const user = await createUserFixture({
        email: `reset_persist_${Date.now()}@test.local`,
        role: "RECEPTION",
        password: "old-password-123",
      });

      // 1. Issue a reset code via the public endpoint.
      const issue = await request(app)
        .post("/api/v1/auth/forgot-password")
        .send({ email: user.email });
      expect(issue.status).toBe(200);

      const stored = await prisma.passwordResetCode.findFirst({
        where: { userId: user.id, usedAt: null },
        orderBy: { createdAt: "desc" },
      });
      expect(stored).not.toBeNull();
      expect(stored.code).toMatch(/^\d{6}$/);
      expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // 2. Simulate a restart: clear vitest's module cache for ../../app and
      //    re-import. Anything held in-memory by the previous instance is gone;
      //    the reset code only survives if it is in Postgres.
      const { vi } = await import("vitest");
      vi.resetModules();
      const fresh = await import("../../app");
      const restartedApp = fresh.app;

      // 3. Use the code against the restarted app.
      const reset = await request(restartedApp)
        .post("/api/v1/auth/reset-password")
        .send({
          email: user.email,
          code: stored.code,
          newPassword: "brand-new-password-456",
        });
      expect(reset.status).toBe(200);

      // 4. Code is now marked used so a replay must fail.
      const after = await prisma.passwordResetCode.findUnique({
        where: { id: stored.id },
      });
      expect(after?.usedAt).not.toBeNull();

      const replay = await request(restartedApp)
        .post("/api/v1/auth/reset-password")
        .send({
          email: user.email,
          code: stored.code,
          newPassword: "another-password-789",
        });
      expect(replay.status).toBe(400);

      // 5. Login with new password works.
      const login = await request(restartedApp)
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: "brand-new-password-456" });
      expect(login.status).toBe(200);
      expect(login.body?.data?.tokens?.accessToken).toBeTruthy();
    });

    it("rejects an expired reset code (simulated time-forward)", async () => {
      const prisma = await getPrisma();
      const user = await createUserFixture({
        email: `reset_expire_${Date.now()}@test.local`,
        role: "RECEPTION",
      });

      // Create a code that is already expired by writing directly to the DB.
      const expired = await prisma.passwordResetCode.create({
        data: {
          userId: user.id,
          code: "999999",
          expiresAt: new Date(Date.now() - 60 * 1000),
        },
      });
      expect(expired.id).toBeTruthy();

      const res = await request(app)
        .post("/api/v1/auth/reset-password")
        .send({
          email: user.email,
          code: "999999",
          newPassword: "should-not-work-123",
        });
      expect(res.status).toBe(400);
    });

    it("issuing a new code invalidates older outstanding codes for the same user", async () => {
      const prisma = await getPrisma();
      const user = await createUserFixture({
        email: `reset_rotate_${Date.now()}@test.local`,
        role: "RECEPTION",
      });

      await request(app)
        .post("/api/v1/auth/forgot-password")
        .send({ email: user.email });
      const first = await prisma.passwordResetCode.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
      });
      expect(first).not.toBeNull();

      await request(app)
        .post("/api/v1/auth/forgot-password")
        .send({ email: user.email });
      const remaining = await prisma.passwordResetCode.findMany({
        where: { userId: user.id, usedAt: null },
      });
      // Only the most recent unused code should exist.
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).not.toBe(first.id);
    });
  });
});
