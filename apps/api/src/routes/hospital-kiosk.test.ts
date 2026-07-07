/**
 * Hospital kiosk — tenant-from-QR resolution + authenticated /me payload.
 *
 * The "one hospital QR" objective requires a guest scan to land on the CORRECT
 * hospital. The QR carries `?tenantId=<uuid>` or `?code=<PG-01>`; the kiosk's
 * resolveTenant must honour them (and fall back to the default tenant only when
 * neither is present). These tests drive GET /hospital-kiosk/session (public,
 * no auth) with a mocked @medcore/db and assert the resolved tenant.
 *
 * The GET /me block covers the authenticated patient payload — specifically
 * that it now returns `gender` + `dateOfBirth` so the kiosk booking form can
 * auto-fill + lock a logged-in patient's demographics (only Reason-for-visit
 * stays editable).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { prismaMock, jwtMock } = vi.hoisted(() => {
  const base: any = {
    tenant: { findUnique: vi.fn(), findFirst: vi.fn() },
    systemConfig: { findMany: vi.fn(async () => []) },
    doctor: { findMany: vi.fn(async () => []) },
    patient: { findUnique: vi.fn() },
    appointment: { findMany: vi.fn(async () => []) },
    prescription: { findMany: vi.fn(async () => []) },
    invoice: { findMany: vi.fn(async () => []) },
    labOrder: { findMany: vi.fn(async () => []) },
    referral: { findMany: vi.fn(async () => []) },
    notification: { findMany: vi.fn(async () => []) },
  };
  return { prismaMock: base, jwtMock: { verifyAccessToken: vi.fn() } };
});

vi.mock("@medcore/db", async () => {
  const actual = await vi.importActual<any>("@medcore/db");
  return { ...actual, prisma: prismaMock, tenantScopedPrisma: prismaMock };
});

// optionalAuth() decodes the bearer/cookie token via verifyAccessToken.
vi.mock("../services/jwt", () => ({
  verifyAccessToken: jwtMock.verifyAccessToken,
}));

let app: express.Express;

const PEARL = { id: "t-pearl", active: true, name: "Pearl Hospital", subdomain: "pearl" };
const SUNRISE = { id: "t-sunrise", active: true, name: "Sunrise Hospital", subdomain: "sunrise" };
const DEFAULT_TENANT = { id: "t-default", name: "MedCore Default", subdomain: "default" };

beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.systemConfig.findMany.mockResolvedValue([]);
  prismaMock.doctor.findMany.mockResolvedValue([]);
  // Authenticated-patient sub-queries default to empty; individual tests
  // override patient.findUnique.
  prismaMock.appointment.findMany.mockResolvedValue([]);
  prismaMock.prescription.findMany.mockResolvedValue([]);
  prismaMock.invoice.findMany.mockResolvedValue([]);
  prismaMock.labOrder.findMany.mockResolvedValue([]);
  prismaMock.referral.findMany.mockResolvedValue([]);
  prismaMock.notification.findMany.mockResolvedValue([]);
  prismaMock.patient.findUnique.mockResolvedValue(null);
  // findUnique resolves the active-tenant + hospital-info lookups by id.
  prismaMock.tenant.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.id === PEARL.id) return PEARL;
    if (where.id === SUNRISE.id) return SUNRISE;
    return null;
  });
  // findFirst is only the default fallback.
  prismaMock.tenant.findFirst.mockResolvedValue(DEFAULT_TENANT);

  const mod = await import("./hospital-kiosk");
  const errMod = await import("../middleware/error");
  app = express();
  app.use(express.json());
  app.use("/api/v1/hospital-kiosk", mod.hospitalKioskRouter);
  app.use(errMod.errorHandler);
});

describe("GET /hospital-kiosk/session — tenant-from-QR", () => {
  it("resolves the hospital from a QR-carried ?tenantId", async () => {
    const res = await request(app).get(
      `/api/v1/hospital-kiosk/session?tenantId=${SUNRISE.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).toBe(SUNRISE.id);
    expect(res.body.data.hospital.name).toBe("Sunrise Hospital");
    // Guest gets a temporary patient id.
    expect(res.body.data.guest.temporaryPatientId).toMatch(/^TMP-\d{8}-[0-9A-F]{6}$/);
  });

  it("resolves the hospital from a QR-carried ?code (SystemConfig tenant:<id>:code)", async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue([
      { key: "tenant:t-pearl:code", value: "PG-01" },
      { key: "tenant:t-sunrise:code", value: "SUN-02" },
    ]);
    const res = await request(app).get("/api/v1/hospital-kiosk/session?code=PG-01");
    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).toBe(PEARL.id);
    expect(res.body.data.hospital.name).toBe("Pearl Hospital");
  });

  it("matches the code case-insensitively", async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue([
      { key: "tenant:t-pearl:code", value: "PG-01" },
    ]);
    const res = await request(app).get("/api/v1/hospital-kiosk/session?code=pg-01");
    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).toBe(PEARL.id);
  });

  it("falls back to the default tenant when no tenantId/code is supplied", async () => {
    const res = await request(app).get("/api/v1/hospital-kiosk/session");
    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).toBe(DEFAULT_TENANT.id);
  });

  it("falls back to default when the code does not match any tenant", async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue([
      { key: "tenant:t-pearl:code", value: "PG-01" },
    ]);
    const res = await request(app).get(
      "/api/v1/hospital-kiosk/session?code=NOPE-99",
    );
    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).toBe(DEFAULT_TENANT.id);
  });
});

describe("GET /hospital-kiosk/me — authenticated patient payload", () => {
  const PATIENT = {
    id: "p-1",
    mrNumber: "MC01000001",
    contactEmail: "sourav@example.com",
    gender: "MALE",
    dateOfBirth: new Date("1998-06-29T00:00:00.000Z"),
    user: { name: "Sourav Adak", phone: "9876543210", email: "user@example.com" },
  };

  it("returns gender + dateOfBirth (YYYY-MM-DD) so the booking form can auto-fill", async () => {
    jwtMock.verifyAccessToken.mockReturnValue({
      userId: "u-1",
      email: "user@example.com",
      role: "PATIENT",
    });
    prismaMock.patient.findUnique.mockResolvedValue(PATIENT);

    const res = await request(app)
      .get("/api/v1/hospital-kiosk/me")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(true);
    expect(res.body.data.patient).toMatchObject({
      name: "Sourav Adak",
      phone: "9876543210",
      gender: "MALE",
      dateOfBirth: "1998-06-29",
    });
  });

  it("serialises a null dateOfBirth as null (no crash)", async () => {
    jwtMock.verifyAccessToken.mockReturnValue({
      userId: "u-1",
      email: "user@example.com",
      role: "PATIENT",
    });
    prismaMock.patient.findUnique.mockResolvedValue({
      ...PATIENT,
      dateOfBirth: null,
      gender: null,
    });

    const res = await request(app)
      .get("/api/v1/hospital-kiosk/me")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body.data.patient.dateOfBirth).toBeNull();
    expect(res.body.data.patient.gender).toBeNull();
  });

  it("treats a request with no token as an unauthenticated guest", async () => {
    const res = await request(app).get("/api/v1/hospital-kiosk/me");
    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(false);
    expect(res.body.data.patient).toBeUndefined();
  });
});
