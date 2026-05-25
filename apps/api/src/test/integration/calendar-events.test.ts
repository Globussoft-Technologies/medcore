// Integration tests for apps/api/src/routes/calendar-events.ts (Issue #718).
// What: every endpoint of the admin-managed CalendarEvent CRUD — list / read /
//   create / update / delete — exercised with supertest against the live
//   app + a real test DB (gated by describeIfDB).
// Which modules: routes/calendar-events.ts, middleware/auth (authorize),
//   middleware/validate (Zod), middleware/audit (fire-and-forget on this
//   route — see CLAUDE.md note 1, hence waitForAuditFlush() before reading
//   the AuditLog row).
// Why: file shipped 2026-05-08 with 0% integration coverage. Locks in: (a)
//   happy paths for list/read/create/update/delete; (b) Zod validation
//   (endAt > startAt refine, title length, color length, empty-string color
//   coercion, null color clear-semantics on update); (c) RBAC matrix (read =
//   any authed staff role; write = ADMIN/DOCTOR/RECEPTION; delete = ADMIN
//   only); (d) audit row written for every mutation; (e) 404 path on
//   missing id. Cross-tenant isolation is intentionally skipped via
//   it.skip pending Issue #995 (route uses un-scoped prisma — see header
//   note next to that test).

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;
let adminToken: string;
let doctorToken: string;
let receptionToken: string;
let nurseToken: string;
let pharmacistToken: string;
let labTechToken: string;
let patientToken: string;
let adminUserId: string;

const validEvent = () => ({
  title: "Quarterly Town Hall",
  category: "TOWN_HALL",
  startAt: "2026-06-01T10:00:00+05:30",
  endAt: "2026-06-01T11:00:00+05:30",
  color: "bg-blue-500",
  description: "All-hands.",
});

describeIfDB("Calendar events API (Issue #718 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    nurseToken = await getAuthToken("NURSE");
    pharmacistToken = await getAuthToken("PHARMACIST");
    labTechToken = await getAuthToken("LAB_TECH");
    patientToken = await getAuthToken("PATIENT");

    const prisma = await getPrisma();
    const admin = await prisma.user.findUnique({
      where: { email: "admin@test.local" },
    });
    adminUserId = admin.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ─────────────────────────────────────────────────────────
  // POST /api/v1/calendar-events
  // ─────────────────────────────────────────────────────────

  it("POST creates a calendar event (happy path, ADMIN)", async () => {
    const res = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(validEvent());
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.id).toBeTruthy();
    expect(res.body.data?.title).toBe("Quarterly Town Hall");
    expect(res.body.data?.category).toBe("TOWN_HALL");
    expect(res.body.data?.color).toBe("bg-blue-500");
    expect(res.body.data?.createdById).toBe(adminUserId);

    const prisma = await getPrisma();
    const audit = await waitForAuditFlush(prisma, {
      action: "CALENDAR_EVENT_CREATE",
      entity: "calendarEvent",
      entityId: res.body.data.id,
    });
    expect(audit).toBeTruthy();
  });

  it("POST defaults category to OTHER when omitted (Zod default)", async () => {
    const body = validEvent();
    delete (body as any).category;
    const res = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body.data?.category).toBe("OTHER");
  });

  it("POST trims title whitespace before storing", async () => {
    const res = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ...validEvent(), title: "  Trimmed Title  " });
    expect(res.status).toBe(201);
    expect(res.body.data?.title).toBe("Trimmed Title");
  });

  it("POST DOCTOR and RECEPTION can also create (RBAC: write-allowed roles)", async () => {
    const r1 = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send(validEvent());
    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send(validEvent());
    expect(r2.status).toBe(201);
  });

  it("POST 403 for NURSE / PHARMACIST / LAB_TECH / PATIENT (RBAC: read-only or excluded roles)", async () => {
    for (const tok of [nurseToken, pharmacistToken, labTechToken, patientToken]) {
      const res = await request(app)
        .post("/api/v1/calendar-events")
        .set("Authorization", `Bearer ${tok}`)
        .send(validEvent());
      expect(res.status).toBe(403);
    }
  });

  it("POST 401 when no auth header is sent", async () => {
    const res = await request(app)
      .post("/api/v1/calendar-events")
      .send(validEvent());
    expect(res.status).toBe(401);
  });

  it("POST 400 when endAt == startAt (Zod refine: strict >)", async () => {
    const res = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ...validEvent(),
        startAt: "2026-06-01T10:00:00+05:30",
        endAt: "2026-06-01T10:00:00+05:30",
      });
    expect(res.status).toBe(400);
  });

  it("POST 400 when endAt before startAt", async () => {
    const res = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ...validEvent(),
        startAt: "2026-06-01T12:00:00+05:30",
        endAt: "2026-06-01T10:00:00+05:30",
      });
    expect(res.status).toBe(400);
  });

  it("POST 400 when title is too short", async () => {
    const res = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ...validEvent(), title: "A" });
    expect(res.status).toBe(400);
  });

  it("POST 400 for an unknown category", async () => {
    const res = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ...validEvent(), category: "PARTY" });
    expect(res.status).toBe(400);
  });

  it("POST 400 when startAt has no timezone offset", async () => {
    const res = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ...validEvent(), startAt: "2026-06-01T10:00:00" });
    expect(res.status).toBe(400);
  });

  it("POST coerces empty-string color to undefined (stored as null in DB)", async () => {
    const res = await request(app)
      .post("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ...validEvent(), color: "" });
    expect(res.status).toBe(201);
    expect(res.body.data?.color).toBeNull();
  });

  // ─────────────────────────────────────────────────────────
  // GET /api/v1/calendar-events
  // ─────────────────────────────────────────────────────────

  it("GET / lists events ordered by startAt ASC (happy path)", async () => {
    const prisma = await getPrisma();
    // Wipe so we can assert ordering deterministically.
    await prisma.calendarEvent.deleteMany({});
    const e1 = await prisma.calendarEvent.create({
      data: {
        title: "Later",
        category: "OTHER",
        startAt: new Date("2026-07-01T12:00:00Z"),
        endAt: new Date("2026-07-01T13:00:00Z"),
      },
    });
    const e2 = await prisma.calendarEvent.create({
      data: {
        title: "Earlier",
        category: "OTHER",
        startAt: new Date("2026-06-01T12:00:00Z"),
        endAt: new Date("2026-06-01T13:00:00Z"),
      },
    });

    const res = await request(app)
      .get("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((x: any) => x.id);
    expect(ids.indexOf(e2.id)).toBeLessThan(ids.indexOf(e1.id));
  });

  it("GET / filters by from/to query (date range)", async () => {
    const prisma = await getPrisma();
    await prisma.calendarEvent.deleteMany({});
    const inRange = await prisma.calendarEvent.create({
      data: {
        title: "In Range",
        category: "OTHER",
        startAt: new Date("2026-06-15T10:00:00Z"),
        endAt: new Date("2026-06-15T11:00:00Z"),
      },
    });
    await prisma.calendarEvent.create({
      data: {
        title: "Out of Range",
        category: "OTHER",
        startAt: new Date("2026-08-01T10:00:00Z"),
        endAt: new Date("2026-08-01T11:00:00Z"),
      },
    });

    const res = await request(app)
      .get("/api/v1/calendar-events?from=2026-06-01&to=2026-06-30")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((x: any) => x.id);
    expect(ids).toContain(inRange.id);
    expect(ids.length).toBe(1);
  });

  it("GET / respects limit query (clamped to [1, 1000])", async () => {
    const res = await request(app)
      .get("/api/v1/calendar-events?limit=1")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });

  it("GET / allowed for every staff role (NURSE / PHARMACIST / LAB_TECH included)", async () => {
    for (const tok of [adminToken, doctorToken, receptionToken, nurseToken, pharmacistToken, labTechToken]) {
      const res = await request(app)
        .get("/api/v1/calendar-events")
        .set("Authorization", `Bearer ${tok}`);
      expect(res.status).toBe(200);
    }
  });

  it("GET / 403 for PATIENT (RBAC: not in the staff allow-list)", async () => {
    const res = await request(app)
      .get("/api/v1/calendar-events")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("GET / 401 with no auth header", async () => {
    const res = await request(app).get("/api/v1/calendar-events");
    expect(res.status).toBe(401);
  });

  // ─────────────────────────────────────────────────────────
  // GET /api/v1/calendar-events/:id
  // ─────────────────────────────────────────────────────────

  it("GET /:id returns the event (happy path)", async () => {
    const prisma = await getPrisma();
    const e = await prisma.calendarEvent.create({
      data: {
        title: "Lookup target",
        category: "OTHER",
        startAt: new Date("2026-06-01T10:00:00Z"),
        endAt: new Date("2026-06-01T11:00:00Z"),
      },
    });
    const res = await request(app)
      .get(`/api/v1/calendar-events/${e.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(e.id);
    expect(res.body.data?.title).toBe("Lookup target");
  });

  it("GET /:id returns 404 for an unknown id", async () => {
    const res = await request(app)
      .get("/api/v1/calendar-events/550e8400-e29b-41d4-a716-446655440000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("GET /:id 403 for PATIENT", async () => {
    const prisma = await getPrisma();
    const e = await prisma.calendarEvent.create({
      data: {
        title: "Hidden from patient",
        category: "OTHER",
        startAt: new Date("2026-06-01T10:00:00Z"),
        endAt: new Date("2026-06-01T11:00:00Z"),
      },
    });
    const res = await request(app)
      .get(`/api/v1/calendar-events/${e.id}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // ─────────────────────────────────────────────────────────
  // PATCH /api/v1/calendar-events/:id
  // ─────────────────────────────────────────────────────────

  it("PATCH /:id updates the event (happy path)", async () => {
    const prisma = await getPrisma();
    const e = await prisma.calendarEvent.create({
      data: {
        title: "Original",
        category: "OTHER",
        startAt: new Date("2026-06-01T10:00:00Z"),
        endAt: new Date("2026-06-01T11:00:00Z"),
      },
    });
    const res = await request(app)
      .patch(`/api/v1/calendar-events/${e.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Renamed", category: "MARKETING" });
    expect(res.status).toBe(200);
    expect(res.body.data?.title).toBe("Renamed");
    expect(res.body.data?.category).toBe("MARKETING");

    const audit = await waitForAuditFlush(prisma, {
      action: "CALENDAR_EVENT_UPDATE",
      entity: "calendarEvent",
      entityId: e.id,
    });
    expect(audit).toBeTruthy();
  });

  it("PATCH /:id accepts null color (clear-semantics)", async () => {
    const prisma = await getPrisma();
    const e = await prisma.calendarEvent.create({
      data: {
        title: "Has color",
        category: "OTHER",
        startAt: new Date("2026-06-01T10:00:00Z"),
        endAt: new Date("2026-06-01T11:00:00Z"),
        color: "bg-red-500",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/calendar-events/${e.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ color: null });
    expect(res.status).toBe(200);
    expect(res.body.data?.color).toBeNull();
  });

  it("PATCH /:id updates startAt and endAt together (string → Date coercion in handler)", async () => {
    const prisma = await getPrisma();
    const e = await prisma.calendarEvent.create({
      data: {
        title: "Reschedule",
        category: "OTHER",
        startAt: new Date("2026-06-01T10:00:00Z"),
        endAt: new Date("2026-06-01T11:00:00Z"),
      },
    });
    const res = await request(app)
      .patch(`/api/v1/calendar-events/${e.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        startAt: "2026-07-01T14:00:00Z",
        endAt: "2026-07-01T15:00:00Z",
      });
    expect(res.status).toBe(200);
    expect(new Date(res.body.data.startAt).toISOString()).toBe(
      "2026-07-01T14:00:00.000Z"
    );
    expect(new Date(res.body.data.endAt).toISOString()).toBe(
      "2026-07-01T15:00:00.000Z"
    );
  });

  it("PATCH /:id 400 when both startAt+endAt provided and endAt <= startAt (Zod conditional refine)", async () => {
    const prisma = await getPrisma();
    const e = await prisma.calendarEvent.create({
      data: {
        title: "Bad reschedule",
        category: "OTHER",
        startAt: new Date("2026-06-01T10:00:00Z"),
        endAt: new Date("2026-06-01T11:00:00Z"),
      },
    });
    const res = await request(app)
      .patch(`/api/v1/calendar-events/${e.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        startAt: "2026-07-01T15:00:00Z",
        endAt: "2026-07-01T14:00:00Z",
      });
    expect(res.status).toBe(400);
  });

  it("PATCH /:id accepts startAt-only patch (refine skipped when endAt missing)", async () => {
    const prisma = await getPrisma();
    const e = await prisma.calendarEvent.create({
      data: {
        title: "Slide start",
        category: "OTHER",
        startAt: new Date("2026-06-01T10:00:00Z"),
        endAt: new Date("2026-06-01T12:00:00Z"),
      },
    });
    const res = await request(app)
      .patch(`/api/v1/calendar-events/${e.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ startAt: "2026-06-01T11:00:00Z" });
    expect(res.status).toBe(200);
  });

  it("PATCH /:id 404 on unknown id", async () => {
    const res = await request(app)
      .patch("/api/v1/calendar-events/550e8400-e29b-41d4-a716-446655440000")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Won't land" });
    expect(res.status).toBe(404);
  });

  it("PATCH /:id 403 for NURSE / PHARMACIST / LAB_TECH / PATIENT", async () => {
    const prisma = await getPrisma();
    const e = await prisma.calendarEvent.create({
      data: {
        title: "Protected",
        category: "OTHER",
        startAt: new Date("2026-06-01T10:00:00Z"),
        endAt: new Date("2026-06-01T11:00:00Z"),
      },
    });
    for (const tok of [nurseToken, pharmacistToken, labTechToken, patientToken]) {
      const res = await request(app)
        .patch(`/api/v1/calendar-events/${e.id}`)
        .set("Authorization", `Bearer ${tok}`)
        .send({ title: "Forbidden edit" });
      expect(res.status).toBe(403);
    }
  });

  it("PATCH /:id 401 with no auth header", async () => {
    const res = await request(app)
      .patch("/api/v1/calendar-events/550e8400-e29b-41d4-a716-446655440000")
      .send({ title: "x" });
    expect(res.status).toBe(401);
  });

  // ─────────────────────────────────────────────────────────
  // DELETE /api/v1/calendar-events/:id
  // ─────────────────────────────────────────────────────────

  it("DELETE /:id removes the event (happy path, ADMIN only)", async () => {
    const prisma = await getPrisma();
    const e = await prisma.calendarEvent.create({
      data: {
        title: "To delete",
        category: "OTHER",
        startAt: new Date("2026-06-01T10:00:00Z"),
        endAt: new Date("2026-06-01T11:00:00Z"),
      },
    });
    const res = await request(app)
      .delete(`/api/v1/calendar-events/${e.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(e.id);

    const after = await prisma.calendarEvent.findUnique({ where: { id: e.id } });
    expect(after).toBeNull();

    const audit = await waitForAuditFlush(prisma, {
      action: "CALENDAR_EVENT_DELETE",
      entity: "calendarEvent",
      entityId: e.id,
    });
    expect(audit).toBeTruthy();
  });

  it("DELETE /:id 404 on unknown id", async () => {
    const res = await request(app)
      .delete("/api/v1/calendar-events/550e8400-e29b-41d4-a716-446655440000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("DELETE /:id 403 for DOCTOR and RECEPTION (delete is ADMIN-only, narrower than create)", async () => {
    const prisma = await getPrisma();
    const e = await prisma.calendarEvent.create({
      data: {
        title: "ADMIN-only delete",
        category: "OTHER",
        startAt: new Date("2026-06-01T10:00:00Z"),
        endAt: new Date("2026-06-01T11:00:00Z"),
      },
    });
    const r1 = await request(app)
      .delete(`/api/v1/calendar-events/${e.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r1.status).toBe(403);
    const r2 = await request(app)
      .delete(`/api/v1/calendar-events/${e.id}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(r2.status).toBe(403);
    // Confirm still present after the 403s.
    const still = await prisma.calendarEvent.findUnique({ where: { id: e.id } });
    expect(still).not.toBeNull();
  });

  it("DELETE /:id 401 with no auth header", async () => {
    const res = await request(app).delete(
      "/api/v1/calendar-events/550e8400-e29b-41d4-a716-446655440000"
    );
    expect(res.status).toBe(401);
  });

  // ─────────────────────────────────────────────────────────
  // Cross-tenant isolation — KNOWN BUG, see Issue #995
  // ─────────────────────────────────────────────────────────
  //
  // The route uses the un-scoped `prisma` import (NOT tenantScopedPrisma)
  // and the `where` clauses do not include `tenantId`. So an ADMIN in
  // Tenant B can list/read/patch/delete Tenant A's events. We can't fix
  // the source here (hard rule: NEVER edit source from the test cron),
  // so the assertion is skipped pending Issue #995.

  it.skip("GET / by Tenant B ADMIN must not see Tenant A events — TODO: unskip when issue #995 is fixed", async () => {
    // When #995 lands, this should:
    //   - Create tenantA + tenantB with their own ADMIN users
    //   - Seed a CalendarEvent stamped tenantId=tenantA.id
    //   - GET /api/v1/calendar-events with tenantB's admin token
    //   - Expect that the tenantA event does NOT appear in the response
    expect(true).toBe(false);
  });
});
