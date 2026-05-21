// Integration tests for Pearl ERP Stage 1 §7.2 gap item #2 — piece 2a
// (2026-05-21): the `branchScopedPrisma` extension wrapper + the global
// `branchContextMiddleware` + `withBranchContext` Express middlewares.
//
// What's covered (end-to-end through the live API → ALS → Prisma extension):
//
//   1. POST /api/v1/appointments/book WITH `X-Branch-Id` header → the
//      created row carries `branchId` stamped by the extension (no route
//      change was needed beyond switching to `branchScopedPrisma`).
//   2. GET /api/v1/appointments WITH `X-Branch-Id` → only the matching
//      branch's appointments appear; a second branch's appointments are
//      invisible. Proves the read-path auto-filter.
//   3. POST /api/v1/appointments/book WITHOUT `X-Branch-Id` → the legacy
//      shape is preserved: row created with `branchId = null`, GET returns
//      everything, no surprise filtering.
//
// Seeds two Branch rows under the SAME tenant so the scoping is genuinely
// being exercised by the extension (not by the existing per-tenant filter).
// Uses the standard `describeIfDB` / `resetDB` / `getAuthToken` / `getPrisma`
// helpers + `createPatientFixture` / `createDoctorFixture` factories so the
// suite matches the existing appointments.test.ts shape.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
} from "../factories";

let app: any;
let token: string;
let branchAId: string;
let branchBId: string;
let tenantId: string;

describeIfDB("Branch scoping (Pearl §7.2 piece 2a — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const prisma = await getPrisma();

    // Use the standard RECEPTION token. The seeded user has tenantId=NULL
    // so the global tenant middleware never opens a tenant ALS scope on
    // these requests — that keeps the test focused on branch scoping
    // (the independent ALS channel governed by `X-Branch-Id`) without
    // having to also align Patient/Doctor fixture tenantId values.
    token = await getAuthToken("RECEPTION");

    // We still need a Tenant row because the Branch model has a required
    // `tenantId String` column. The two branches sit under that tenant;
    // the JWT and the appointment rows do NOT carry tenantId, but that's
    // fine — tenant scoping is a no-op when the JWT has no tenant claim
    // (the global middleware skips opening the scope), so the branch
    // extension acts in isolation here.
    const tenant = await prisma.tenant.create({
      data: {
        name: "Branch-Scoping Tenant",
        subdomain: `branch-scope-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    tenantId = tenant.id;

    const branchA = await prisma.branch.create({
      data: {
        tenantId,
        name: "Branch Alpha",
        code: "ALPHA",
        isDefault: true,
        active: true,
      },
    });
    const branchB = await prisma.branch.create({
      data: {
        tenantId,
        name: "Branch Beta",
        code: "BETA",
        isDefault: false,
        active: true,
      },
    });
    branchAId = branchA.id;
    branchBId = branchB.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  it("auto-stamps branchId on POST /appointments/book when X-Branch-Id is set", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    // PR #521 + tests/appointments.test.ts convention: book tomorrow with
    // a HH:MM slotId so the past-time guard doesn't fire mid-day in CI.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Branch-Id", branchAId)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        date: tomorrow,
        slotId: "10:00",
        notes: "Branch Alpha booking",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.id).toBeTruthy();

    // The route does not echo branchId in its response payload (it never
    // selected it), so verify directly via the DB. The extension should
    // have injected branchId into the create payload.
    const prisma = await getPrisma();
    const row = await prisma.appointment.findUnique({
      where: { id: res.body.data.id },
      select: { branchId: true },
    });
    expect(row?.branchId).toBe(branchAId);
  });

  it("auto-filters GET /appointments by branch when X-Branch-Id is set", async () => {
    // Book one appointment in Branch Beta so the GET filter has something
    // to exclude when we query Branch Alpha (the Alpha booking from the
    // previous test still exists under tenantId).
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const betaRes = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Branch-Id", branchBId)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        date: tomorrow,
        slotId: "11:00",
        notes: "Branch Beta booking",
      });
    expect([200, 201]).toContain(betaRes.status);
    const betaApptId = betaRes.body.data.id;

    // Now GET /appointments scoped to Branch Alpha — should NOT include
    // the Branch Beta appointment.
    const alphaList = await request(app)
      .get("/api/v1/appointments")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Branch-Id", branchAId);
    expect(alphaList.status).toBe(200);
    const alphaIds = (alphaList.body.data as Array<{ id: string }>).map((r) => r.id);
    expect(alphaIds).not.toContain(betaApptId);

    // And conversely Branch Beta MUST contain the Beta row.
    const betaList = await request(app)
      .get("/api/v1/appointments")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Branch-Id", branchBId);
    expect(betaList.status).toBe(200);
    const betaIds = (betaList.body.data as Array<{ id: string }>).map((r) => r.id);
    expect(betaIds).toContain(betaApptId);
  });

  it("preserves legacy behaviour when no X-Branch-Id is supplied (no stamp, no filter)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    // POST without the header — branchId should land as NULL.
    const legacy = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        date: tomorrow,
        slotId: "12:00",
        notes: "Legacy booking — no branch context",
      });
    expect([200, 201]).toContain(legacy.status);
    const prisma = await getPrisma();
    const row = await prisma.appointment.findUnique({
      where: { id: legacy.body.data.id },
      select: { branchId: true },
    });
    expect(row?.branchId).toBeNull();

    // GET without the header — should return ALL appointments for the
    // tenant (both branched + unbranched), not filtered to anyone branch.
    const list = await request(app)
      .get("/api/v1/appointments")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const ids = (list.body.data as Array<{ id: string; branchId?: string | null }>).map(
      (r) => r.id,
    );
    expect(ids).toContain(legacy.body.data.id);
    // And it should ALSO contain the previously-branched rows (proves no
    // accidental filter when context is empty).
    const branchedCount = (list.body.data as any[]).filter(
      (r: any) => r.branchId === branchAId || r.branchId === branchBId,
    ).length;
    expect(branchedCount).toBeGreaterThanOrEqual(2);
  });
});
