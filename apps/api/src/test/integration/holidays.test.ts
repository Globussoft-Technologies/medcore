// Integration tests for the public-read holidays endpoint introduced for
// Issue #749. The /dashboard/calendar grid renders for every authed
// staff role (and PATIENT in some flows), but the existing
// /api/v1/hr-ops/holidays endpoint is admin-only — so the calendar
// could not display holiday cells for non-admins. This route exposes
// the same Holiday rows in a minimally-projected, read-only shape.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let nurseToken: string;
let doctorToken: string;
let patientToken: string;

describeIfDB("Issue #749 — public read-only /api/v1/holidays", () => {
  beforeAll(async () => {
    await resetDB();
    nurseToken = await getAuthToken("NURSE");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;

    const prisma = await getPrisma();
    await prisma.holiday.create({
      data: {
        date: new Date("2026-08-15T00:00:00.000Z"),
        name: "Independence Day",
        type: "PUBLIC",
        description: "Internal-policy notes that should NOT leak via this endpoint",
      },
    });
    await prisma.holiday.create({
      data: {
        date: new Date("2026-10-02T00:00:00.000Z"),
        name: "Gandhi Jayanti",
        type: "PUBLIC",
      },
    });
  });

  it("NURSE can read holidays without 403 (the bug)", async () => {
    const res = await request(app)
      .get("/api/v1/holidays?year=2026")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("DOCTOR can read holidays", async () => {
    const res = await request(app)
      .get("/api/v1/holidays?year=2026")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("PATIENT can read holidays (calendar surfaces them too)", async () => {
    const res = await request(app)
      .get("/api/v1/holidays?year=2026")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
  });

  it("from/to window narrows the result set", async () => {
    const res = await request(app)
      .get("/api/v1/holidays?from=2026-09-01&to=2026-12-31")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    const names = (res.body.data as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("Gandhi Jayanti");
    expect(names).not.toContain("Independence Day");
  });

  it("the projection drops `description` (policy notes stay internal)", async () => {
    const res = await request(app)
      .get("/api/v1/holidays?year=2026")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    for (const row of res.body.data) {
      expect(row).not.toHaveProperty("description");
      // The minimal projection contract — only these fields surface.
      expect(row).toHaveProperty("id");
      expect(row).toHaveProperty("date");
      expect(row).toHaveProperty("name");
      expect(row).toHaveProperty("type");
    }
  });

  it("rejects unauthenticated callers", async () => {
    const res = await request(app).get("/api/v1/holidays?year=2026");
    expect(res.status).toBe(401);
  });

  it("rejects non-numeric year with 400", async () => {
    const res = await request(app)
      .get("/api/v1/holidays?year=banana")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(400);
  });
});
