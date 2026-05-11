// Integration tests for the leave-management workflow (approve/reject,
// shift synchronization, balance increment side-effects).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createUserFixture, createShiftFixture } from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;
let nurseUser: any;

async function pendingLeave(userId: string, overrides: Partial<any> = {}) {
  const prisma = await getPrisma();
  const from = overrides.fromDate || new Date();
  const to = overrides.toDate || new Date(Date.now() + 86400000);
  return prisma.leaveRequest.create({
    data: {
      userId,
      type: overrides.type || "CASUAL",
      fromDate: from,
      toDate: to,
      totalDays: overrides.totalDays ?? 2,
      reason: overrides.reason || "Test reason",
      status: "PENDING",
    },
  });
}

describeIfDB("Leave management workflow (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
    const prisma = await getPrisma();
    nurseUser = await prisma.user.findUnique({
      where: { email: "nurse@test.local" },
    });
  });

  it("admin approves a pending leave (status + approver stamped)", async () => {
    const leave = await pendingLeave(nurseUser.id);
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "APPROVED" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("APPROVED");
    expect(res.body.data?.approvedBy).toBeTruthy();
    expect(res.body.data?.approvedAt).toBeTruthy();
  });

  it("approval converts overlapping SCHEDULED shifts to LEAVE (side-effect)", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const prisma = await getPrisma();
    // Create shift for today
    const shift = await createShiftFixture({
      userId: user.id,
      overrides: { date: new Date(), status: "SCHEDULED" },
    });
    const leave = await prisma.leaveRequest.create({
      data: {
        userId: user.id,
        type: "SICK",
        fromDate: new Date(Date.now() - 3600_000),
        toDate: new Date(Date.now() + 3600_000),
        totalDays: 1,
        reason: "Fever",
        status: "PENDING",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "APPROVED" });
    expect([200, 201]).toContain(res.status);

    // Give fire-and-forget a moment, then verify
    await new Promise((r) => setTimeout(r, 150));
    const updatedShift = await prisma.staffShift.findUnique({
      where: { id: shift.id },
    });
    expect(updatedShift?.status).toBe("LEAVE");
  });

  it("admin rejects a pending leave with a reason", async () => {
    const leave = await pendingLeave(nurseUser.id, { reason: "plan X" });
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rejectionReason: "Short staff on those days" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("REJECTED");
    expect(res.body.data?.rejectionReason).toBe(
      "Short staff on those days"
    );
  });

  it("cannot approve a leave that is not PENDING (400)", async () => {
    const prisma = await getPrisma();
    const leave = await prisma.leaveRequest.create({
      data: {
        userId: nurseUser.id,
        type: "CASUAL",
        fromDate: new Date(),
        toDate: new Date(Date.now() + 86400000),
        totalDays: 2,
        reason: "x",
        status: "APPROVED",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "APPROVED" });
    expect(res.status).toBe(400);
  });

  it("approve returns 404 for unknown leave id", async () => {
    const res = await request(app)
      .patch(
        "/api/v1/leaves/550e8400-e29b-41d4-a716-446655440000/approve"
      )
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "APPROVED" });
    expect(res.status).toBe(404);
  });

  it("non-admin cannot approve (403)", async () => {
    const leave = await pendingLeave(nurseUser.id);
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/approve`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "APPROVED" });
    expect(res.status).toBe(403);
  });

  it("approve endpoint requires auth (401)", async () => {
    const leave = await pendingLeave(nurseUser.id);
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/approve`)
      .send({ status: "APPROVED" });
    expect(res.status).toBe(401);
  });

  it("approve rejects malformed payload (400)", async () => {
    const leave = await pendingLeave(nurseUser.id);
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "NOT_A_STATUS" });
    expect(res.status).toBe(400);
  });

  it("pending queue visible to admins (and includes our new leave)", async () => {
    const leave = await pendingLeave(nurseUser.id, { reason: "queue test" });
    const res = await request(app)
      .get("/api/v1/leaves/pending")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((l: any) => l.id);
    expect(ids).toContain(leave.id);
  });

  it("approving a leave increments leave balance used (business rule)", async () => {
    const user = await createUserFixture({ role: "NURSE" });
    const prisma = await getPrisma();
    const leave = await prisma.leaveRequest.create({
      data: {
        userId: user.id,
        type: "CASUAL",
        fromDate: new Date(),
        toDate: new Date(Date.now() + 2 * 86400000),
        totalDays: 3,
        reason: "family",
        status: "PENDING",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "APPROVED" });
    expect([200, 201]).toContain(res.status);

    await new Promise((r) => setTimeout(r, 150));
    const year = leave.fromDate.getFullYear();
    const balance = await prisma.leaveBalance.findUnique({
      where: {
        userId_type_year: { userId: user.id, type: "CASUAL", year },
      },
    });
    expect(balance?.used).toBeGreaterThanOrEqual(3);
  });

  it("reject endpoint rejects leave that is not PENDING (400)", async () => {
    const prisma = await getPrisma();
    const leave = await prisma.leaveRequest.create({
      data: {
        userId: nurseUser.id,
        type: "CASUAL",
        fromDate: new Date(),
        toDate: new Date(),
        totalDays: 1,
        reason: "already rejected",
        status: "REJECTED",
        rejectionReason: "prior",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/leaves/${leave.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rejectionReason: "retry" });
    expect(res.status).toBe(400);
  });
});
