// Integration test for the auth router. Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB } from "../setup";

let app: any;

describeIfDB("Auth API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  it("registers a new user", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        name: "New User",
        email: "newuser@test.local",
        phone: "9111111111",
        password: "MedCoreT3st-2026",
        role: "RECEPTION",
      });
    expect(res.status).toBeLessThan(400);
  });

  it("logs in the seeded admin", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    expect(res.status).toBe(200);
    expect(res.body?.data?.tokens?.accessToken).toBeTruthy();
  });

  it("rejects bad credentials", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "wrong-password" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects malformed payload with 400", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});
