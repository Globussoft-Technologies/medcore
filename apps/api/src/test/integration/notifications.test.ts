// Integration tests for notifications router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let adminToken: string;
let nurseToken: string;
let nurseUserId: string;

describeIfDB("Notifications API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
    const prisma = await getPrisma();
    const nurseUser = await prisma.user.findUnique({
      where: { email: "nurse@test.local" },
    });
    nurseUserId = nurseUser!.id;
  });

  it("returns user notifications list (initially empty)", async () => {
    const res = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("filters by unreadOnly", async () => {
    const res = await request(app)
      .get("/api/v1/notifications?unreadOnly=true")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
  });

  it("marks a notification as read", async () => {
    const prisma = await getPrisma();
    const n = await prisma.notification.create({
      data: {
        userId: nurseUserId,
        type: "APPOINTMENT_BOOKED",
        channel: "PUSH",
        title: "Test",
        message: "test",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/notifications/${n.id}/read`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.readAt).toBeTruthy();
  });

  it("forbids marking another user's notification as read", async () => {
    const prisma = await getPrisma();
    // Create notification for admin user
    const admin = await prisma.user.findUnique({
      where: { email: "admin@test.local" },
    });
    const n = await prisma.notification.create({
      data: {
        userId: admin!.id,
        type: "BILL_GENERATED",
        channel: "EMAIL",
        title: "Admin-only",
        message: "msg",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/notifications/${n.id}/read`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("gets notification preferences (defaults)", async () => {
    const res = await request(app)
      .get("/api/v1/notifications/preferences")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("updates notification preferences", async () => {
    const res = await request(app)
      .put("/api/v1/notifications/preferences")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        preferences: [
          { channel: "EMAIL", enabled: true },
          { channel: "SMS", enabled: false },
        ],
      });
    expect([200, 201]).toContain(res.status);
  });

  it("rejects non-array preferences payload (400)", async () => {
    const res = await request(app)
      .put("/api/v1/notifications/preferences")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ preferences: "nope" });
    expect(res.status).toBe(400);
  });

  it("creates a notification template (admin)", async () => {
    const res = await request(app)
      .post("/api/v1/notifications/templates")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "APPOINTMENT_BOOKED",
        channel: "SMS",
        name: "Appt Reminder SMS",
        body: "Dear {name}, your appointment is booked.",
        isActive: true,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.name).toBe("Appt Reminder SMS");
  });

  it("lists notification templates", async () => {
    const res = await request(app)
      .get("/api/v1/notifications/templates")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("updates delivery status", async () => {
    const prisma = await getPrisma();
    const n = await prisma.notification.create({
      data: {
        userId: nurseUserId,
        type: "PAYMENT_RECEIVED",
        channel: "EMAIL",
        title: "Paid",
        message: "Thanks",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/notifications/${n.id}/delivery`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "DELIVERED" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.deliveryStatus).toBe("DELIVERED");
    expect(res.body.data?.deliveredAt).toBeTruthy();
  });

  it("retries a failed notification (admin)", async () => {
    const prisma = await getPrisma();
    const n = await prisma.notification.create({
      data: {
        userId: nurseUserId,
        type: "BILL_GENERATED",
        channel: "EMAIL",
        title: "Failed",
        message: "retry me",
        deliveryStatus: "FAILED",
      },
    });
    const res = await request(app)
      .post(`/api/v1/notifications/${n.id}/retry`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBeLessThan(500);
  });

  it("returns delivery stats (admin)", async () => {
    const res = await request(app)
      .get("/api/v1/notifications/stats")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.byStatus).toBeTruthy();
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/v1/notifications");
    expect(res.status).toBe(401);
  });
});
