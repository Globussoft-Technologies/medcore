// Integration tests for the AI staff roster router (/api/v1/ai/roster).
// The staff-scheduler service is mocked so we can assert route behaviour
// (persist → apply → history) without touching real shift data.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { describeIfDB, resetDB, getAuthToken } from "../setup";

vi.mock("../../services/ai/staff-scheduler", () => {
  return {
    generateRosterProposal: vi.fn(async (input: any) => ({
      startDate: input.startDate,
      days: input.days,
      department: input.department,
      proposals: [
        {
          date: input.startDate,
          shifts: [
            {
              shiftType: "MORNING",
              requiredCount: 2,
              assignedStaff: [
                { userId: "u1", name: "Dr Alice", role: "DOCTOR", reason: "senior" },
                { userId: "u2", name: "Nurse Bob", role: "NURSE", reason: "balance" },
              ],
              understaffed: false,
            },
          ],
        },
      ],
      warnings: ["test warning"],
      violationsIfApplied: [],
    })),
    materializeRoster: vi.fn(async () => ({ created: 2 })),
  };
});

let app: express.Express;
let adminToken: string;
let nurseToken: string;
let patientToken: string;
let storeFile: string;

describeIfDB("AI Roster API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    patientToken = await getAuthToken("PATIENT");

    storeFile = path.join(
      os.tmpdir(),
      `ai-roster-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    );
    process.env.AI_ROSTER_STORE_PATH = storeFile;

    const { aiRosterRouter } = await import("../../routes/ai-roster");
    const { errorHandler } = await import("../../middleware/error");
    app = express();
    app.use(express.json());
    app.use("/api/v1/ai/roster", aiRosterRouter);
    app.use(errorHandler);
  });

  beforeEach(async () => {
    // Fresh store each test
    await fs.rm(storeFile, { force: true });
  });

  // ─── POST /propose ────────────────────────────────────────────────────

  it("POST /propose generates and persists a proposal for ADMIN", async () => {
    const res = await request(app)
      .post("/api/v1/ai/roster/propose")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ startDate: "2026-05-01", days: 7, department: "cardiology" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.status).toBe("PROPOSED");
    expect(res.body.data.proposals).toHaveLength(1);
    expect(Array.isArray(res.body.data.warnings)).toBe(true);
  });

  it("POST /propose rejects NURSE (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/roster/propose")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ startDate: "2026-05-01", days: 7, department: "cardiology" });
    expect(res.status).toBe(403);
  });

  it("POST /propose rejects unauthenticated (401)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/roster/propose")
      .send({ startDate: "2026-05-01", days: 7, department: "cardiology" });
    expect(res.status).toBe(401);
  });

  it("POST /propose returns 400 on invalid days value", async () => {
    const res = await request(app)
      .post("/api/v1/ai/roster/propose")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ startDate: "2026-05-01", days: 5, department: "cardiology" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/days/i);
  });

  it("POST /propose returns 400 on invalid date format", async () => {
    const res = await request(app)
      .post("/api/v1/ai/roster/propose")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ startDate: "05/01/2026", days: 7, department: "cardiology" });
    expect(res.status).toBe(400);
  });

  // ─── POST /apply ──────────────────────────────────────────────────────

  it("POST /apply requires confirm: true", async () => {
    // First propose
    const proposeRes = await request(app)
      .post("/api/v1/ai/roster/propose")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ startDate: "2026-05-10", days: 7, department: "general" });
    const id = proposeRes.body.data.id;

    const applyRes = await request(app)
      .post("/api/v1/ai/roster/apply")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ id });
    expect(applyRes.status).toBe(400);
    expect(applyRes.body.error).toMatch(/confirm/i);
  });

  it("POST /apply materializes the roster when confirm=true", async () => {
    const proposeRes = await request(app)
      .post("/api/v1/ai/roster/propose")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ startDate: "2026-05-11", days: 7, department: "general" });
    const id = proposeRes.body.data.id;

    const applyRes = await request(app)
      .post("/api/v1/ai/roster/apply")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ id, confirm: true });
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.data.status).toBe("APPLIED");
    expect(applyRes.body.data.createdShifts).toBe(2);
  });

  it("POST /apply returns 409 when proposal already applied", async () => {
    const proposeRes = await request(app)
      .post("/api/v1/ai/roster/propose")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ startDate: "2026-05-12", days: 7, department: "general" });
    const id = proposeRes.body.data.id;

    await request(app)
      .post("/api/v1/ai/roster/apply")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ id, confirm: true });
    const second = await request(app)
      .post("/api/v1/ai/roster/apply")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ id, confirm: true });
    expect(second.status).toBe(409);
  });

  it("POST /apply returns 404 for unknown id", async () => {
    const res = await request(app)
      .post("/api/v1/ai/roster/apply")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ id: "550e8400-e29b-41d4-a716-446655440000", confirm: true });
    expect(res.status).toBe(404);
  });

  // ─── GET /history ─────────────────────────────────────────────────────

  it("GET /history lists proposals for ADMIN", async () => {
    await request(app)
      .post("/api/v1/ai/roster/propose")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ startDate: "2026-05-20", days: 7, department: "general" });

    const res = await request(app)
      .get("/api/v1/ai/roster/history")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0]).toHaveProperty("status");
    expect(res.body.data[0]).toHaveProperty("department");
  });

  it("GET /history rejects non-ADMIN (403)", async () => {
    const res = await request(app)
      .get("/api/v1/ai/roster/history")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /history rejects PATIENT (403)", async () => {
    const res = await request(app)
      .get("/api/v1/ai/roster/history")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });
});
