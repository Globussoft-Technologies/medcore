// Integration tests for the expenses router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";

let app: any;
let adminToken: string;
let receptionToken: string;
let nurseToken: string;

const today = () => new Date().toISOString().slice(0, 10);

describeIfDB("Expenses API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("admin-created expense is auto-APPROVED", async () => {
    const res = await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        category: "UTILITIES",
        amount: 5000,
        description: "Monthly electricity",
        date: today(),
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.approvalStatus).toBe("APPROVED");
  });

  it("reception-created expense OVER threshold goes PENDING (business rule)", async () => {
    const res = await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        category: "EQUIPMENT",
        amount: 200000,
        description: "Ventilator",
        date: today(),
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.approvalStatus).toBe("PENDING");
  });

  it("lists expenses", async () => {
    await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        category: "OTHER",
        amount: 100,
        description: "Misc",
        date: today(),
      });
    const res = await request(app)
      .get("/api/v1/expenses")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("requires auth (401)", async () => {
    const res = await request(app).get("/api/v1/expenses");
    expect(res.status).toBe(401);
  });

  it("nurse cannot create expenses (403)", async () => {
    const res = await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        category: "OTHER",
        amount: 50,
        description: "Attempt",
        date: today(),
      });
    expect(res.status).toBe(403);
  });

  it("rejects bad payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ category: "NOT_A_CATEGORY", amount: -1 });
    expect(res.status).toBe(400);
  });

  // Issue #64: future-dated expenses must be rejected at the API level so
  // even direct POSTs (bypassing the form) can't poison month-end totals.
  it("rejects future-dated expense (400)", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yyyyMmDd = tomorrow.toISOString().slice(0, 10);
    const res = await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        category: "OTHER",
        amount: 100,
        description: "Tomorrow's lunch",
        date: yyyyMmDd,
      });
    expect(res.status).toBe(400);
  });

  it("rejects far-future-dated expense (the original 01/01/2030 bug)", async () => {
    const res = await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        category: "OTHER",
        amount: 999,
        description: "Way in the future",
        date: "2030-01-01",
      });
    expect(res.status).toBe(400);
  });

  it("approves a pending expense (side-effect: APPROVED + approvedBy)", async () => {
    const create = await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        category: "EQUIPMENT",
        amount: 200000,
        description: "X-Ray Machine",
        date: today(),
      });
    const id = create.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/expenses/${id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ approved: true });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.approvalStatus).toBe("APPROVED");
    expect(res.body.data?.approvedBy).toBeTruthy();
  });

  it("rejects an already-approved expense with 400", async () => {
    const create = await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        category: "OTHER",
        amount: 200,
        description: "Already approved",
        date: today(),
      });
    const res = await request(app)
      .patch(`/api/v1/expenses/${create.body.data.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ approved: true });
    expect(res.status).toBe(400);
  });

  it("pending queue lists only PENDING expenses", async () => {
    await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        category: "RENT",
        amount: 300000,
        description: "Q2 Rent",
        date: today(),
      });
    const res = await request(app)
      .get("/api/v1/expenses/pending")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.count).toBeGreaterThanOrEqual(1);
  });

  it("summary groups by category and totals", async () => {
    const res = await request(app)
      .get("/api/v1/expenses/summary")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.grandTotal).toBe("number");
  });

  it("upserts a budget (admin)", async () => {
    const res = await request(app)
      .post("/api/v1/expenses/budgets")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        category: "UTILITIES",
        year: 2026,
        month: 4,
        amount: 50000,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.amount).toBe(50000);
  });
});
