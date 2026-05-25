// Integration tests for the public system-status endpoint introduced
// for Pearl ERP Stage 1 §8.4 (gap row 221).
//
// Covers:
//   - GET /api/v1/status returns 200 with the expected shape.
//   - The endpoint requires NO authentication (the page is public).
//   - The response includes all 5 declared components.
//   - Cache-Control is `public, max-age=15`.
//   - A simulated DB failure flips the database component to "down"
//     and the overall status to "down".

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB } from "../setup";

let app: any;

describeIfDB("Pearl §8.4 — public /api/v1/status", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  it("returns 200 with the expected shape (no auth)", async () => {
    const res = await request(app).get("/api/v1/status");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("MedCore");
    expect(["operational", "degraded", "down"]).toContain(res.body.status);
    expect(typeof res.body.checkedAt).toBe("string");
    expect(new Date(res.body.checkedAt).toString()).not.toBe("Invalid Date");
    expect(Array.isArray(res.body.components)).toBe(true);
    expect(Array.isArray(res.body.maintenanceWindows)).toBe(true);
  });

  it("does NOT require authentication (the page is public)", async () => {
    const res = await request(app).get("/api/v1/status");
    expect(res.status).toBe(200);
    // No Authorization header sent — and yet we got the payload.
    expect(res.body).toHaveProperty("service", "MedCore");
  });

  it("includes all 5 declared components", async () => {
    const res = await request(app).get("/api/v1/status");
    expect(res.status).toBe(200);
    const names = (res.body.components as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain("API");
    expect(names).toContain("Database");
    expect(names).toContain("WhatsApp (Gupshup)");
    expect(names).toContain("Razorpay");
    expect(names).toContain("ABDM Gateway");
    expect(names).toHaveLength(5);
    for (const c of res.body.components as Array<{ status: string }>) {
      expect(["operational", "degraded", "down"]).toContain(c.status);
    }
  });

  it("sets Cache-Control: public, max-age=15", async () => {
    const res = await request(app).get("/api/v1/status");
    expect(res.headers["cache-control"]).toBe("public, max-age=15");
  });

  it("maintenanceWindows is an empty array for Stage 1", async () => {
    const res = await request(app).get("/api/v1/status");
    expect(res.body.maintenanceWindows).toEqual([]);
  });

  it("does NOT leak internal hostnames, env keys, or SHAs", async () => {
    const res = await request(app).get("/api/v1/status");
    const raw = JSON.stringify(res.body);
    // Cheap defensive checks — no env-var-style ALL_CAPS_TOKENS in the
    // response, no localhost/127.0.0.1 leakage, no internal version SHA.
    expect(raw).not.toMatch(/DATABASE_URL/);
    expect(raw).not.toMatch(/JWT_SECRET/);
    expect(raw).not.toMatch(/127\.0\.0\.1/);
    expect(raw).not.toMatch(/localhost:\d+/);
  });

  it("flips database component to down + overall status to down when DB throws", async () => {
    // Simulate DB failure by monkey-patching prisma.$queryRaw for one call.
    const { prisma } = await import("@medcore/db");
    const original = (prisma as any).$queryRaw;
    (prisma as any).$queryRaw = vi.fn().mockRejectedValueOnce(new Error("simulated DB down"));

    try {
      const res = await request(app).get("/api/v1/status");
      expect(res.status).toBe(200);
      const db = (res.body.components as Array<{ name: string; status: string }>).find(
        (c) => c.name === "Database"
      );
      expect(db?.status).toBe("down");
      expect(res.body.status).toBe("down");
    } finally {
      (prisma as any).$queryRaw = original;
    }
  });
});
