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

  // Issue #750 (May 2026): a single broadcast was fanning out as 50+
  // duplicate notification rows because every channel in `channels`
  // created its own row and overlapping audience filters double-counted.
  // We now write at most ONE row per (broadcast, user), enforced by a
  // unique constraint on `dedupKey = '${broadcastId}:${userId}'` and
  // an upsert in the broadcast handler. This test broadcasts to the
  // same audience across 4 channels and asserts ONE row lands per
  // user, not 4.
  it("Issue #750 — broadcast across N channels writes ONE row per user (dedup)", async () => {
    // Ensure the audience pool has at least 2 users — getAuthToken
    // creates the row idempotently if it doesn't exist, so this is
    // safe to call here without affecting the rest of the suite.
    await getAuthToken("DOCTOR");
    await getAuthToken("RECEPTION");
    const prisma = await getPrisma();
    const targets = await prisma.user.findMany({
      where: { role: { in: ["NURSE", "DOCTOR", "RECEPTION"] }, isActive: true },
      take: 3,
      select: { id: true },
    });
    expect(targets.length).toBeGreaterThan(0);

    // Snapshot the count of broadcast-originated rows before our test
    // so we can compute the delta cleanly even when the suite has
    // already created some.
    const before = await prisma.notification.count({
      where: { dedupKey: { not: null } },
    });

    const res = await request(app)
      .post("/api/v1/notifications/broadcast")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Issue 750 dedup test",
        message: "If you see this once per user, dedup works.",
        audience: { userIds: targets.map((t: any) => t.id) },
        // Four channels — pre-fix this would have written 4 × N rows.
        channels: ["PUSH", "EMAIL", "SMS", "WHATSAPP"],
      });
    expect([200, 201]).toContain(res.status);
    const broadcastId = res.body.data?.id as string;
    expect(broadcastId).toBeTruthy();

    // The unique constraint should have collapsed (broadcastId × user)
    // to exactly N rows — one per targeted user — even though the
    // broadcast carried 4 channels.
    const afterRowsForBroadcast = await prisma.notification.findMany({
      where: { broadcastId },
      select: { userId: true, channel: true, dedupKey: true },
    });
    expect(afterRowsForBroadcast.length).toBe(targets.length);

    // Each row's dedupKey is the canonical "${broadcastId}:${userId}".
    for (const r of afterRowsForBroadcast) {
      expect(r.dedupKey).toBe(`${broadcastId}:${r.userId}`);
    }

    // Net rows added is exactly N (no leakage into pre-existing rows).
    const after = await prisma.notification.count({
      where: { dedupKey: { not: null } },
    });
    expect(after - before).toBe(targets.length);

    // Sanity: sentCount on the broadcast row matches the user count.
    expect(res.body.data?.sentCount).toBe(targets.length);
  });

  // Issue #733 (May 2026): "Mark all as read" updated the badge but rows
  // still showed unread style on refresh. Server-side cause was easy to
  // verify (the updateMany SQL is correct); client-side cause was that
  // the page rendered against a non-existent `read` boolean instead of
  // the API's actual `readAt` timestamp. This test pins the SERVER
  // contract — after PATCH /read-all every row MUST have a non-null
  // readAt — so any future regression that reverts the SQL to a no-op
  // (e.g. flipping the where clause to readAt: { not: null }) fails
  // here before it ships.
  it("Issue #733 — PATCH /read-all stamps readAt on every previously-unread row", async () => {
    const prisma = await getPrisma();
    // Seed 3 unread notifications for the nurse user.
    const seeded = await Promise.all(
      [1, 2, 3].map((i) =>
        prisma.notification.create({
          data: {
            userId: nurseUserId,
            type: "APPOINTMENT_BOOKED",
            channel: "PUSH",
            title: `Mark-all #${i}`,
            message: `body ${i}`,
          },
        })
      )
    );
    expect(seeded.every((n: any) => n.readAt === null)).toBe(true);

    const patchRes = await request(app)
      .patch("/api/v1/notifications/read-all")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data?.count).toBeGreaterThanOrEqual(3);

    // Refetch and confirm every row now carries a readAt — this is the
    // exact server-truth signal the frontend's `isRead = !!readAt`
    // derivation now keys off.
    const listRes = await request(app)
      .get("/api/v1/notifications?limit=100")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(listRes.status).toBe(200);
    const rows = listRes.body.data as Array<{ id: string; readAt: string | null }>;
    const seededRows = rows.filter((r) => seeded.some((s: any) => s.id === r.id));
    expect(seededRows.length).toBe(3);
    for (const r of seededRows) {
      expect(r.readAt, `row ${r.id} should have readAt after mark-all`).toBeTruthy();
    }
  });
});
