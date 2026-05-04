// Integration tests for hardened HTTP security headers — apps/api/src/app.ts.
// Closes #475: prior to this suite, ZERO tests asserted any of the
// helmet-managed headers, so a regression that disabled or misconfigured
// helmet would have shipped silently. This file is the categorical guard:
// every header listed in the issue gets one assertion on a representative
// endpoint (the shallow `/api/health`, which is public and DB-independent
// for the response itself — though importing `app.ts` still requires Prisma
// to be reachable, hence the `describeIfDB` gate matching repo convention).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB } from "../setup";

let app: any;

describeIfDB("Security headers — apps/api/src/app.ts (closes #475)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  it("sets X-Frame-Options DENY (clickjacking guard)", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("sets Content-Security-Policy with restrictive default-src", async () => {
    const res = await request(app).get("/api/health");
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("sets Strict-Transport-Security with 2y maxAge + includeSubDomains + preload", async () => {
    const res = await request(app).get("/api/health");
    const hsts = res.headers["strict-transport-security"];
    expect(hsts).toBeDefined();
    expect(hsts).toContain("max-age=63072000");
    expect(hsts).toContain("includeSubDomains");
    expect(hsts).toContain("preload");
  });

  it("sets X-Content-Type-Options nosniff", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets Referrer-Policy strict-origin-when-cross-origin", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("does NOT leak X-Powered-By (Express stack disclosure)", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("applies the same hardened headers to 401 responses on protected routes", async () => {
    // Headers must be set EVEN when downstream middleware short-circuits with
    // an error. Helmet is mounted before auth, so this is the regression
    // guard: if anyone reorders middleware, this test fails.
    const res = await request(app).get("/api/v1/patients");
    expect(res.status).toBe(401);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
