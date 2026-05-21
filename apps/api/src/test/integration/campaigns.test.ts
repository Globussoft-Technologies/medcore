// Integration tests for Pearl ERP Stage 1 §5.1 gap item #4
// piece 1 of 4 — Campaign CRUD API.
//
// What's covered:
//   1. POST creates a Campaign + GET-list returns it + GET :id includes
//      the audience + _count.sends
//   2. PATCH updates name + flips status DRAFT → SCHEDULED
//   3. PATCH directly to COMPLETED is rejected (409) — operator can't
//      take a campaign to a dispatcher-only terminal state
//   4. PATCH from CANCELLED → SCHEDULED is rejected (409) — terminal
//   5. DELETE soft-cancels a DRAFT (status=CANCELLED, cancelledAt set)
//   6. DELETE on a COMPLETED campaign is rejected (409)
//   7. RBAC: RECEPTION cannot POST/GET/PATCH/DELETE (403)
//   8. sendWindow validation: only-start, only-end → 400; start >= end → 400
//   9. Multi-tenant isolation: tenant A's campaigns are not in tenant B's list
//  10. POST /:id/sends/preview returns the piece-1 stub
//      { estimatedRecipients: 0 }
//
// Direct-prisma seeding pattern mirrors branches.test.ts so two tenants +
// per-tenant ADMIN users can be exercised in one suite.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { __resetTenantValidationCacheForTests } from "../../middleware/tenant";

const JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

let app: any;
let tenantAId: string;
let tenantBId: string;
let adminAToken: string;
let adminBToken: string;
let receptionAToken: string;

function signWith(role: string, userId: string, email: string, tenantId: string | null) {
  return jwt.sign({ userId, email, role, tenantId: tenantId ?? null }, JWT_SECRET, {
    expiresIn: "1h",
  });
}

describeIfDB("Campaigns API (Pearl §5.1 piece 1 of 4 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    __resetTenantValidationCacheForTests();

    const prisma = await getPrisma();
    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);

    const ts = Date.now();
    const tenantA = await prisma.tenant.create({
      data: {
        name: "Tenant A Campaign",
        subdomain: `tenant-a-camp-${ts}`,
        plan: "BASIC",
        active: true,
      },
    });
    const tenantB = await prisma.tenant.create({
      data: {
        name: "Tenant B Campaign",
        subdomain: `tenant-b-camp-${ts}`,
        plan: "BASIC",
        active: true,
      },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const adminA = await prisma.user.create({
      data: {
        email: `admin-a-camp-${ts}@test.local`,
        name: "Admin A Camp",
        phone: "9100000010",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantAId,
      },
    });
    const adminB = await prisma.user.create({
      data: {
        email: `admin-b-camp-${ts}@test.local`,
        name: "Admin B Camp",
        phone: "9100000011",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantBId,
      },
    });
    const receptionA = await prisma.user.create({
      data: {
        email: `reception-a-camp-${ts}@test.local`,
        name: "Reception A Camp",
        phone: "9100000012",
        passwordHash,
        role: "RECEPTION",
        tenantId: tenantAId,
      },
    });
    adminAToken = signWith("ADMIN", adminA.id, adminA.email, tenantAId);
    adminBToken = signWith("ADMIN", adminB.id, adminB.email, tenantBId);
    receptionAToken = signWith("RECEPTION", receptionA.id, receptionA.email, tenantAId);

    const mod = await import("../../app");
    app = mod.app;
  });

  it("POST creates a Campaign with sane defaults", async () => {
    const res = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "April HTN nudges",
        description: "Reminder series for hypertensive patients",
        channels: ["WHATSAPP", "SMS"],
        body: "Hi {{patient.firstName}}, time for your BP check.",
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe("April HTN nudges");
    expect(res.body.data.status).toBe("DRAFT");
    expect(res.body.data.kind).toBe("BROADCAST");
    expect(res.body.data.channels).toEqual(["WHATSAPP", "SMS"]);
    expect(res.body.data.tenantId).toBe(tenantAId);
    expect(res.body.data.createdById).toBeTruthy();
  });

  it("GET / lists campaigns for the caller's tenant + includes _count.sends", async () => {
    const res = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toHaveProperty("_count");
    expect(res.body.data[0]._count).toHaveProperty("sends");
  });

  it("PATCH updates name + transitions DRAFT → SCHEDULED", async () => {
    const list = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`);
    const target = list.body.data.find((c: any) => c.name === "April HTN nudges");
    expect(target).toBeTruthy();

    const res = await request(app)
      .patch(`/api/v1/campaigns/${target.id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "April HTN nudges (v2)", status: "SCHEDULED" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("April HTN nudges (v2)");
    expect(res.body.data.status).toBe("SCHEDULED");
  });

  it("GET /:id includes the audience field + _count.sends", async () => {
    const list = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`);
    const target = list.body.data[0];

    const res = await request(app)
      .get(`/api/v1/campaigns/${target.id}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("audience");
    expect(res.body.data._count).toHaveProperty("sends");
  });

  it("PATCH status=COMPLETED is rejected by Zod (operator cannot set dispatcher-only state)", async () => {
    const list = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`);
    const target = list.body.data[0];

    const res = await request(app)
      .patch(`/api/v1/campaigns/${target.id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ status: "COMPLETED" });
    // Schema rejects COMPLETED from operatorWriteableStatusEnum → 400.
    expect(res.status).toBe(400);
  });

  it("PATCH DRAFT→RUNNING is rejected by the state-machine guard (dispatcher-only path)", async () => {
    // RUNNING stays in operatorWriteableStatusEnum because PAUSED→RUNNING
    // is a legitimate resume path. DRAFT→RUNNING is blocked by the route's
    // OPERATOR_STATUS_TRANSITIONS map with 409 — not by Zod.
    const list = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`);
    const target = list.body.data[0];

    const res = await request(app)
      .patch(`/api/v1/campaigns/${target.id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ status: "RUNNING" });
    expect(res.status).toBe(409);
  });

  it("PATCH invalid state-machine transition is rejected with 409", async () => {
    // Create a fresh DRAFT then cancel via PATCH, then try to PATCH back to SCHEDULED.
    const create = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Cancelled probe", channels: ["EMAIL"], status: "DRAFT" });
    expect(create.status).toBe(201);
    const id = create.body.data.id;

    const cancel = await request(app)
      .patch(`/api/v1/campaigns/${id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ status: "CANCELLED" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe("CANCELLED");

    // CANCELLED is terminal — reject the next operator-initiated transition.
    const reanimate = await request(app)
      .patch(`/api/v1/campaigns/${id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ status: "SCHEDULED" });
    expect(reanimate.status).toBe(409);
  });

  it("DELETE soft-cancels a DRAFT campaign", async () => {
    const create = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Delete probe", channels: ["SMS"] });
    expect(create.status).toBe(201);
    const id = create.body.data.id;

    const del = await request(app)
      .delete(`/api/v1/campaigns/${id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ cancelReason: "no longer needed" });
    expect(del.status).toBe(200);
    expect(del.body.data.status).toBe("CANCELLED");
    expect(del.body.data.cancelledAt).toBeTruthy();
    expect(del.body.data.cancelReason).toBe("no longer needed");
  });

  it("DELETE on a COMPLETED campaign returns 409", async () => {
    // Manually flip status to COMPLETED via prisma since the API doesn't expose it.
    const prisma = await getPrisma();
    const created = await prisma.campaign.create({
      data: {
        tenantId: tenantAId,
        name: "Completed probe",
        channels: ["EMAIL"],
        status: "COMPLETED",
      },
    });

    const del = await request(app)
      .delete(`/api/v1/campaigns/${created.id}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(del.status).toBe(409);
  });

  it("RBAC: RECEPTION cannot POST a campaign (403)", async () => {
    const res = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${receptionAToken}`)
      .send({ name: "Sneaky", channels: ["SMS"] });
    expect(res.status).toBe(403);
  });

  it("RBAC: RECEPTION cannot GET list (403)", async () => {
    const res = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${receptionAToken}`);
    expect(res.status).toBe(403);
  });

  it("RBAC: RECEPTION cannot PATCH (403)", async () => {
    const list = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`);
    const any = list.body.data[0];

    const res = await request(app)
      .patch(`/api/v1/campaigns/${any.id}`)
      .set("Authorization", `Bearer ${receptionAToken}`)
      .send({ name: "Hijacked" });
    expect(res.status).toBe(403);
  });

  it("RBAC: RECEPTION cannot DELETE (403)", async () => {
    const list = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`);
    const any = list.body.data.find((c: any) => c.status === "DRAFT") ?? list.body.data[0];

    const res = await request(app)
      .delete(`/api/v1/campaigns/${any.id}`)
      .set("Authorization", `Bearer ${receptionAToken}`);
    expect(res.status).toBe(403);
  });

  it("sendWindow: only start → 400", async () => {
    const res = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Window probe 1", channels: ["SMS"], sendWindowStart: 540 });
    expect(res.status).toBe(400);
  });

  it("sendWindow: only end → 400", async () => {
    const res = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Window probe 2", channels: ["SMS"], sendWindowEnd: 1200 });
    expect(res.status).toBe(400);
  });

  it("sendWindow: start >= end → 400", async () => {
    const res = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "Window probe 3",
        channels: ["SMS"],
        sendWindowStart: 1300,
        sendWindowEnd: 1000,
      });
    expect(res.status).toBe(400);
  });

  it("sendWindow: valid 540..1260 (09:00..21:00) accepted", async () => {
    const res = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "Window probe OK",
        channels: ["SMS"],
        sendWindowStart: 540,
        sendWindowEnd: 1260,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.sendWindowStart).toBe(540);
    expect(res.body.data.sendWindowEnd).toBe(1260);
  });

  it("Multi-tenant: tenant A's campaigns are not visible in tenant B's list", async () => {
    // Seed a campaign on tenant B so the list isn't trivially empty.
    const post = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ name: "Tenant B private", channels: ["EMAIL"] });
    expect(post.status).toBe(201);

    const listA = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(listA.status).toBe(200);
    for (const c of listA.body.data) expect(c.tenantId).toBe(tenantAId);

    const listB = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminBToken}`);
    expect(listB.status).toBe(200);
    for (const c of listB.body.data) expect(c.tenantId).toBe(tenantBId);

    // GET-detail on tenant B's campaign with tenant A's token → 404.
    const bCampaignId = listB.body.data[0].id;
    const cross = await request(app)
      .get(`/api/v1/campaigns/${bCampaignId}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(cross.status).toBe(404);
  });

  it("POST /:id/sends/preview on a campaign with no audience → 0 + note", async () => {
    // Pearl §5.1 piece 2a (2026-05-21). Preview now returns a real audience-
    // compiled count when the campaign has an audience attached; for the
    // older test fixtures (campaigns created earlier in this suite without
    // an audienceId), the response carries 0 + a "No audience attached"
    // note instead of the piece-1 stub message.
    const list = await request(app)
      .get("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`);
    const target = list.body.data.find((c: any) => !c.audienceId);
    expect(target).toBeTruthy();

    const res = await request(app)
      .post(`/api/v1/campaigns/${target.id}/sends/preview`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.estimatedRecipients).toBe(0);
    expect(res.body.data.note).toMatch(/No audience/i);
  });

  it("POST /:id/sends/preview with an audience compiles the rules and returns the real count (piece 2a)", async () => {
    // Pearl §5.1 piece 2a — seed 2 female + 1 male patients on tenant A,
    // create a CampaignAudience with `gender eq FEMALE`, link a Campaign
    // to it, then hit preview and expect estimatedRecipients == 2.
    const prisma = await getPrisma();

    const audience = await prisma.campaignAudience.create({
      data: {
        tenantId: tenantAId,
        name: "Preview test — females",
        rules: { filters: [{ field: "gender", op: "eq", value: "FEMALE" }] },
      },
    });

    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);
    const ts2 = Date.now();
    async function seedPatient(gender: "MALE" | "FEMALE", idx: number) {
      const user = await prisma.user.create({
        data: {
          email: `prev-${gender.toLowerCase()}-${idx}-${ts2}@test.local`,
          name: `Preview ${gender} ${idx}`,
          phone: `94${String(ts2).slice(-7)}${idx}`,
          passwordHash,
          role: "PATIENT",
          tenantId: tenantAId,
        },
      });
      return prisma.patient.create({
        data: {
          userId: user.id,
          mrNumber: `MR-PREV-${ts2}-${idx}`,
          gender,
          tenantId: tenantAId,
        },
      });
    }
    await seedPatient("FEMALE", 1);
    await seedPatient("FEMALE", 2);
    await seedPatient("MALE", 3);

    const camp = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "Preview-piece-2a campaign",
        channels: ["SMS"],
        audienceId: audience.id,
      });
    expect(camp.status).toBe(201);

    const preview = await request(app)
      .post(`/api/v1/campaigns/${camp.body.data.id}/sends/preview`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(preview.status).toBe(200);
    expect(preview.body.data.estimatedRecipients).toBe(2);
    expect(preview.body.data.audienceName).toBe("Preview test — females");
    expect(Array.isArray(preview.body.data.sampleIds)).toBe(true);
    expect(preview.body.data.sampleIds.length).toBe(2);

    // Side effect: audience.estimatedSize + lastComputedAt updated.
    const refreshed = await prisma.campaignAudience.findUnique({
      where: { id: audience.id },
    });
    expect(refreshed?.estimatedSize).toBe(2);
    expect(refreshed?.lastComputedAt).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────
  // Pearl §5.1 piece 2b — dispatcher (POST /:id/dispatch)
  // ─────────────────────────────────────────────────────────
  //
  // Channel adapters stub themselves when their *_API_URL / *_API_KEY
  // env vars are absent (default in CI), so the happy-path test does
  // not need a network mock — `result.ok` is always true and the
  // CampaignSend rows land with status="SENT". Address-missing and
  // opt-out branches are exercised explicitly.

  it("POST /:id/dispatch fans out to compiled audience × channels (piece 2b)", async () => {
    const prisma = await getPrisma();

    // Audience: female patients on tenant A.
    const aud = await prisma.campaignAudience.create({
      data: {
        tenantId: tenantAId,
        name: "Dispatch test — females",
        rules: { filters: [{ field: "gender", op: "eq", value: "FEMALE" }] },
      },
    });

    // Two FEMALE patients (in-audience) + one MALE (excluded).
    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);
    const ts = Date.now();
    async function seed(gender: "MALE" | "FEMALE", i: number) {
      const u = await prisma.user.create({
        data: {
          email: `disp-${gender.toLowerCase()}-${i}-${ts}@test.local`,
          name: `Disp ${gender} ${i}`,
          phone: `95${String(ts).slice(-7)}${i}`,
          passwordHash,
          role: "PATIENT",
          tenantId: tenantAId,
        },
      });
      return prisma.patient.create({
        data: {
          userId: u.id,
          mrNumber: `MR-DISP-${ts}-${i}`,
          gender,
          tenantId: tenantAId,
        },
      });
    }
    await seed("FEMALE", 1);
    await seed("FEMALE", 2);
    await seed("MALE", 3);

    // Campaign on 2 channels with a token-substituting body.
    const created = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "Dispatch piece-2b",
        channels: ["WHATSAPP", "SMS"],
        body: "Hi {{patient.firstName}}, MR {{patient.mrNumber}}.",
        audienceId: aud.id,
      });
    expect(created.status).toBe(201);
    const campId = created.body.data.id;

    const res = await request(app)
      .post(`/api/v1/campaigns/${campId}/dispatch`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.total).toBe(4); // 2 patients × 2 channels
    expect(res.body.data.summary.sent).toBe(4);
    expect(res.body.data.summary.failed).toBe(0);
    expect(res.body.data.summary.suppressed).toBe(0);

    // Campaign transitioned through RUNNING to COMPLETED.
    const after = await prisma.campaign.findUnique({ where: { id: campId } });
    expect(after?.status).toBe("COMPLETED");
    expect(after?.startedAt).toBeTruthy();
    expect(after?.completedAt).toBeTruthy();

    // CampaignSend rows persisted.
    const sends = await prisma.campaignSend.findMany({
      where: { campaignId: campId },
    });
    expect(sends.length).toBe(4);
    expect(sends.every((s: { status: string }) => s.status === "SENT")).toBe(true);
    expect(sends.every((s: { sentAt: Date | null }) => s.sentAt !== null)).toBe(true);
  });

  it("POST /:id/dispatch records SUPPRESSED for a patient opted out of the channel", async () => {
    const prisma = await getPrisma();

    const aud = await prisma.campaignAudience.create({
      data: {
        tenantId: tenantAId,
        name: "Dispatch opt-out test",
        rules: { filters: [{ field: "gender", op: "eq", value: "FEMALE" }] },
      },
    });

    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);
    const ts = Date.now() + 1;
    const user = await prisma.user.create({
      data: {
        email: `optout-${ts}@test.local`,
        name: "OptOut Patient",
        phone: `96${String(ts).slice(-7)}0`,
        passwordHash,
        role: "PATIENT",
        tenantId: tenantAId,
      },
    });
    await prisma.patient.create({
      data: {
        userId: user.id,
        mrNumber: `MR-OPT-${ts}`,
        gender: "FEMALE",
        tenantId: tenantAId,
      },
    });
    await prisma.notificationPreference.create({
      data: { userId: user.id, channel: "SMS", enabled: false },
    });

    const camp = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "Dispatch opt-out",
        channels: ["SMS"],
        body: "hello",
        audienceId: aud.id,
      });
    expect(camp.status).toBe(201);

    const res = await request(app)
      .post(`/api/v1/campaigns/${camp.body.data.id}/dispatch`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.sent).toBe(0);
    expect(res.body.data.summary.suppressed).toBe(1);

    const sends = await prisma.campaignSend.findMany({
      where: { campaignId: camp.body.data.id },
    });
    expect(sends.length).toBe(1);
    expect(sends[0].status).toBe("SUPPRESSED");
    expect(sends[0].failureReason).toMatch(/opted out/i);
  });

  it("POST /:id/dispatch rejects 400 when no audience attached", async () => {
    const created = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "No-audience camp", channels: ["SMS"], body: "x" });
    expect(created.status).toBe(201);

    const res = await request(app)
      .post(`/api/v1/campaigns/${created.body.data.id}/dispatch`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/audience/i);
  });

  it("POST /:id/dispatch returns 409 for terminal CANCELLED state", async () => {
    const prisma = await getPrisma();
    const aud = await prisma.campaignAudience.create({
      data: { tenantId: tenantAId, name: "Cancelled-camp", rules: {} },
    });
    const created = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "To-cancel",
        channels: ["SMS"],
        body: "x",
        audienceId: aud.id,
      });
    expect(created.status).toBe(201);

    // DELETE soft-cancels (DRAFT → CANCELLED).
    await request(app)
      .delete(`/api/v1/campaigns/${created.body.data.id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .expect(200);

    const res = await request(app)
      .post(`/api/v1/campaigns/${created.body.data.id}/dispatch`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/terminal|CANCELLED/);
  });

  it("POST /:id/dispatch returns 409 when outside the configured send window", async () => {
    // Pick a window that excludes ALL minutes of the day, so the test is
    // timezone-agnostic: start === end + 1 — clamp is `mod >= start && mod < end`.
    const prisma = await getPrisma();
    const aud = await prisma.campaignAudience.create({
      data: { tenantId: tenantAId, name: "Window-camp", rules: {} },
    });
    const camp = await request(app)
      .post("/api/v1/campaigns")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "Outside-window",
        channels: ["SMS"],
        body: "x",
        audienceId: aud.id,
      });
    expect(camp.status).toBe(201);
    // Set an unreachable window directly on the row (the Zod schema's
    // start < end refine rejects 0/0, but a 1-minute window {0, 1} that
    // we know the test won't hit is fine for the runtime guard test).
    await prisma.campaign.update({
      where: { id: camp.body.data.id },
      data: { sendWindowStart: 0, sendWindowEnd: 1 },
    });

    const res = await request(app)
      .post(`/api/v1/campaigns/${camp.body.data.id}/dispatch`)
      .set("Authorization", `Bearer ${adminAToken}`);
    // Only assert 409 when the current IST minute is not 0 (the only
    // ambiguous minute is 00:00 IST = 18:30 UTC the prior day).
    const istMin =
      ((new Date().getUTCHours() * 60 + new Date().getUTCMinutes()) + 5 * 60 + 30) % (24 * 60);
    if (istMin !== 0) {
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/window/i);
      expect(res.body.nextWindowStart).toBeTruthy();
    }
  });
});
