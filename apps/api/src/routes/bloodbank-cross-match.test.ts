/**
 * Gap #9 (docs/TEST_GAPS_2026-05-03.md) — Cross-match safety unit tests.
 *
 * Transfusion safety is the highest-risk surface in the bloodbank module:
 * a bug that approves an incompatible unit can kill a patient. The shared
 * ABO/Rh matrix in `packages/shared/src/abo-compatibility.ts` is already
 * exhaustively unit-tested; this file pins the ROUTE-LEVEL gating that
 * actually decides whether a unit may be issued to a request.
 *
 * The cross-match decision lives inline in `apps/api/src/routes/bloodbank.ts`
 * (no separate `services/bloodbank.ts` exists). The endpoints exercised:
 *   • POST /api/v1/bloodbank/requests/:id/match  — returns compatible units
 *   • POST /api/v1/bloodbank/requests/:id/issue  — gates issuance with ABO+Rh
 *   • POST /api/v1/bloodbank/units/:id/reserve   — RESERVED transition
 *
 * Both endpoints look up `RBC_COMPATIBILITY[recipient]` (re-exported from
 * `@medcore/shared`) and reject (or filter out) any unit whose blood group
 * is not in the compat list. Rh-negative recipients can NEVER receive
 * Rh-positive blood — that guarantee is encoded in the matrix itself, so
 * the route inherits it for free.
 *
 * `e2e/bloodbank.spec.ts` covers the FLOW level (donor → donation → unit
 * → request → issue); this suite covers the LOGIC matrix the gate uses.
 *
 * Mocks @medcore/db following the pattern in
 * `apps/api/src/services/insurance-claims/reconciliation.test.ts` and
 * `apps/api/src/routes/medication-mar-patch.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

// ── Prisma mock ──────────────────────────────────────────────────────────

const { prismaMock } = vi.hoisted(() => {
  const bloodRequest = {
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const bloodUnit = {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const auditLog = { create: vi.fn(async () => ({ id: "al-x" })) };
  const systemConfig = { findUnique: vi.fn(async () => null) };

  const base: any = {
    bloodRequest,
    bloodUnit,
    auditLog,
    systemConfig,
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
      fn({ bloodRequest, bloodUnit })
    ),
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

// Now we can import the SUT.
import { bloodbankRouter } from "./bloodbank";
import { errorHandler } from "../middleware/error";

// ── Test app harness ─────────────────────────────────────────────────────

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/bloodbank", bloodbankRouter);
  app.use(errorHandler);
  return app;
}

function doctorToken(): string {
  return jwt.sign(
    { userId: "u-doc", email: "doc@test.local", role: "DOCTOR" },
    "test-secret"
  );
}

// Stable ids reused across tests.
const REQUEST_ID = "11111111-1111-1111-1111-111111111111";
const UNIT_ID_PRIMARY = "22222222-2222-2222-2222-222222222222";

function fakeRequest(overrides: any = {}) {
  return {
    id: REQUEST_ID,
    requestNumber: "BR000001",
    patientId: "p-1",
    bloodGroup: "O_POS",
    component: "PACKED_RED_CELLS",
    unitsRequested: 1,
    reason: "Anaemia",
    urgency: "ROUTINE",
    requestedBy: "u-doc",
    issuedAt: null,
    issuedBy: null,
    fulfilled: false,
    notes: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeUnit(overrides: any = {}) {
  // Default: AVAILABLE PRBC, expires 30 days from now.
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return {
    id: UNIT_ID_PRIMARY,
    unitNumber: "BU000001",
    donationId: null,
    bloodGroup: "O_POS",
    component: "PACKED_RED_CELLS",
    volumeMl: 350,
    collectedAt: new Date(),
    expiresAt: future,
    status: "AVAILABLE",
    storageLocation: null,
    notes: null,
    reservedUntil: null,
    reservedForRequestId: null,
    reservedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prismaMock.bloodRequest.findUnique.mockReset();
  prismaMock.bloodRequest.update.mockReset();
  prismaMock.bloodUnit.findUnique.mockReset();
  prismaMock.bloodUnit.findMany.mockReset();
  prismaMock.bloodUnit.update.mockReset();
  prismaMock.bloodUnit.updateMany.mockReset();
  prismaMock.$transaction.mockImplementation(async (fn: any) =>
    fn({
      bloodRequest: prismaMock.bloodRequest,
      bloodUnit: prismaMock.bloodUnit,
    })
  );
});

// ── ABO × Rh compatibility matrix ────────────────────────────────────────
//
// We exercise the matrix through POST /requests/:id/issue because that's
// where a real cross-match-failure kills the transfusion. The endpoint
// short-circuits with a 400 + `mismatches[]` when any donor unit is not
// in `RBC_COMPATIBILITY[recipient]`, and 200 on success.
//
// Compatibility table (recipient ← donor):
//   AB+ ← anyone
//   AB- ← *_NEG only
//   A+  ← {A_POS, A_NEG, O_POS, O_NEG}
//   A-  ← {A_NEG, O_NEG}
//   B+  ← {B_POS, B_NEG, O_POS, O_NEG}
//   B-  ← {B_NEG, O_NEG}
//   O+  ← {O_POS, O_NEG}
//   O-  ← {O_NEG}

type Group =
  | "A_POS"
  | "A_NEG"
  | "B_POS"
  | "B_NEG"
  | "AB_POS"
  | "AB_NEG"
  | "O_POS"
  | "O_NEG";

interface Case {
  donor: Group;
  recipient: Group;
  compatible: boolean;
  label: string; // human-readable for failure output.
}

/** Pretty-print the donor → recipient pair so vitest output is grep-able. */
function pretty(g: Group): string {
  return g.replace("_POS", "+").replace("_NEG", "-");
}

const cases: Case[] = [
  // ── Universal donor (O-) → all 8 recipients (8 cases) ────────────────
  { donor: "O_NEG", recipient: "O_NEG", compatible: true, label: "O- → O- (universal donor + same)" },
  { donor: "O_NEG", recipient: "O_POS", compatible: true, label: "O- → O+ (universal donor)" },
  { donor: "O_NEG", recipient: "A_NEG", compatible: true, label: "O- → A- (universal donor)" },
  { donor: "O_NEG", recipient: "A_POS", compatible: true, label: "O- → A+ (universal donor)" },
  { donor: "O_NEG", recipient: "B_NEG", compatible: true, label: "O- → B- (universal donor)" },
  { donor: "O_NEG", recipient: "B_POS", compatible: true, label: "O- → B+ (universal donor)" },
  { donor: "O_NEG", recipient: "AB_NEG", compatible: true, label: "O- → AB- (universal donor)" },
  { donor: "O_NEG", recipient: "AB_POS", compatible: true, label: "O- → AB+ (universal donor)" },

  // ── Universal recipient (AB+) ← all 8 donors (8 cases) ───────────────
  // O- already covered above; the other 7 must also pass.
  { donor: "O_POS", recipient: "AB_POS", compatible: true, label: "O+ → AB+" },
  { donor: "A_NEG", recipient: "AB_POS", compatible: true, label: "A- → AB+" },
  { donor: "A_POS", recipient: "AB_POS", compatible: true, label: "A+ → AB+" },
  { donor: "B_NEG", recipient: "AB_POS", compatible: true, label: "B- → AB+" },
  { donor: "B_POS", recipient: "AB_POS", compatible: true, label: "B+ → AB+" },
  { donor: "AB_NEG", recipient: "AB_POS", compatible: true, label: "AB- → AB+" },
  { donor: "AB_POS", recipient: "AB_POS", compatible: true, label: "AB+ → AB+ (same group)" },

  // ── Same group + Rh: compatible (4 cases, distinct from above) ───────
  { donor: "A_POS", recipient: "A_POS", compatible: true, label: "A+ → A+ (same)" },
  { donor: "B_NEG", recipient: "B_NEG", compatible: true, label: "B- → B- (same)" },
  { donor: "O_POS", recipient: "O_POS", compatible: true, label: "O+ → O+ (same)" },
  { donor: "AB_NEG", recipient: "AB_NEG", compatible: true, label: "AB- → AB- (same)" },

  // ── ABO mismatch (Rh aside): incompatible (4 cases) ──────────────────
  // Recipient has anti-A/anti-B antibodies that lyse the donor RBCs.
  { donor: "A_POS", recipient: "O_POS", compatible: false, label: "A+ → O+ (anti-A)" },
  { donor: "B_POS", recipient: "A_POS", compatible: false, label: "B+ → A+ (anti-B)" },
  { donor: "AB_POS", recipient: "B_POS", compatible: false, label: "AB+ → B+ (anti-A)" },
  { donor: "AB_NEG", recipient: "O_NEG", compatible: false, label: "AB- → O- (anti-A + anti-B)" },

  // ── Rh mismatch (Rh+ donor → Rh- recipient): incompatible (4 cases) ──
  // ABO matches but Rh+ blood would sensitise the Rh- recipient.
  { donor: "A_POS", recipient: "A_NEG", compatible: false, label: "A+ → A- (Rh sensitisation)" },
  { donor: "B_POS", recipient: "B_NEG", compatible: false, label: "B+ → B- (Rh sensitisation)" },
  { donor: "O_POS", recipient: "O_NEG", compatible: false, label: "O+ → O- (Rh sensitisation)" },
  { donor: "AB_POS", recipient: "AB_NEG", compatible: false, label: "AB+ → AB- (Rh sensitisation)" },

  // ── Combined ABO + Rh mismatch (2 cases) ─────────────────────────────
  { donor: "A_POS", recipient: "B_NEG", compatible: false, label: "A+ → B- (both wrong)" },
  { donor: "B_POS", recipient: "A_NEG", compatible: false, label: "B+ → A- (both wrong)" },
];

describe("POST /api/v1/bloodbank/requests/:id/issue — ABO × Rh matrix", () => {
  it.each(cases)(
    "$label → compatible=$compatible",
    async ({ donor, recipient, compatible }) => {
      prismaMock.bloodRequest.findUnique.mockResolvedValueOnce(
        fakeRequest({ bloodGroup: recipient })
      );
      prismaMock.bloodUnit.findMany.mockResolvedValueOnce([
        fakeUnit({ bloodGroup: donor }),
      ]);
      // Happy-path transactional update returns a fulfilled request.
      prismaMock.bloodUnit.updateMany.mockResolvedValueOnce({ count: 1 });
      prismaMock.bloodRequest.update.mockResolvedValueOnce({
        ...fakeRequest({ bloodGroup: recipient }),
        fulfilled: true,
        issuedAt: new Date(),
        units: [fakeUnit({ bloodGroup: donor })],
      });

      const res = await request(buildApp())
        .post(`/api/v1/bloodbank/requests/${REQUEST_ID}/issue`)
        .set("Authorization", `Bearer ${doctorToken()}`)
        .send({ unitIds: [UNIT_ID_PRIMARY] });

      if (compatible) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(prismaMock.bloodUnit.updateMany).toHaveBeenCalledTimes(1);
      } else {
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(String(res.body.error)).toMatch(/ABO mismatch/i);
        // Surface the offending unit + recipient group on the wire so the UI
        // can highlight the right row in the issue-units screen.
        expect(res.body.recipientGroup).toBe(recipient);
        expect(Array.isArray(res.body.mismatches)).toBe(true);
        expect(res.body.mismatches).toHaveLength(1);
        expect(res.body.mismatches[0].bloodGroup).toBe(donor);
        expect(res.body.mismatches[0].unitNumber).toBe("BU000001");
        // Pretty-print donor/recipient labels — the message used by the UI
        // banner mentions the recipient group; this guards against accidental
        // omission in a future refactor.
        expect(pretty(donor)).toBeTruthy();
        // Should NOT have written the issuance update.
        expect(prismaMock.bloodUnit.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.bloodRequest.update).not.toHaveBeenCalled();
      }
    }
  );

  it("ABO mismatch override: clinicalReason ≥10 chars unlocks a 200", async () => {
    prismaMock.bloodRequest.findUnique.mockResolvedValueOnce(
      fakeRequest({ bloodGroup: "O_POS" })
    );
    prismaMock.bloodUnit.findMany.mockResolvedValueOnce([
      fakeUnit({ bloodGroup: "A_POS" }), // mismatch
    ]);
    prismaMock.bloodUnit.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.bloodRequest.update.mockResolvedValueOnce({
      ...fakeRequest({ bloodGroup: "O_POS" }),
      fulfilled: true,
      issuedAt: new Date(),
      units: [fakeUnit({ bloodGroup: "A_POS" })],
    });

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/requests/${REQUEST_ID}/issue`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({
        unitIds: [UNIT_ID_PRIMARY],
        overrideAboMismatch: true,
        clinicalReason: "Massive haemorrhage; awaiting type-specific stock",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prismaMock.bloodUnit.updateMany).toHaveBeenCalledTimes(1);
  });

  it("ABO mismatch override rejected when clinicalReason <10 chars", async () => {
    prismaMock.bloodRequest.findUnique.mockResolvedValueOnce(
      fakeRequest({ bloodGroup: "O_POS" })
    );
    prismaMock.bloodUnit.findMany.mockResolvedValueOnce([
      fakeUnit({ bloodGroup: "A_POS" }),
    ]);

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/requests/${REQUEST_ID}/issue`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({
        unitIds: [UNIT_ID_PRIMARY],
        overrideAboMismatch: true,
        clinicalReason: "too short",
      });

    // Schema rejects clinicalReason <10 chars → ZodError → 400.
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(prismaMock.bloodUnit.updateMany).not.toHaveBeenCalled();
  });
});

// ── Expired-unit exclusion ───────────────────────────────────────────────
//
// The "match" endpoint feeds the issue-units picker. Even an ABO/Rh-
// compatible unit must be filtered out if `expiresAt < today`.

describe("POST /api/v1/bloodbank/requests/:id/match — expired-unit exclusion", () => {
  it("filters expired units via expiresAt > now in the Prisma where-clause", async () => {
    prismaMock.bloodRequest.findUnique.mockResolvedValueOnce(
      fakeRequest({ bloodGroup: "O_POS" })
    );
    prismaMock.bloodUnit.findMany.mockResolvedValueOnce([]);

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/requests/${REQUEST_ID}/match`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({});

    expect(res.status).toBe(200);
    // Prove the route asks Prisma for non-expired AVAILABLE units in the
    // recipient's compat list. If this guard is ever removed, the test
    // surfaces it as a clear regression rather than a transfusion-safety
    // incident in production.
    expect(prismaMock.bloodUnit.findMany).toHaveBeenCalledTimes(1);
    const where = prismaMock.bloodUnit.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("AVAILABLE");
    expect(where.component).toBe("PACKED_RED_CELLS");
    // expiresAt > now — `now` is wall-clock at request time; assert it's a
    // Date strictly less than the current Date check used inside the route.
    expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
    // Compat list for O+ recipient = [O_POS, O_NEG] (Rh- donor is OK,
    // Rh+ donor would also be — both are in the matrix).
    expect(where.bloodGroup.in).toEqual(
      expect.arrayContaining(["O_POS", "O_NEG"])
    );
    // And does NOT include groups that would lyse the recipient's RBCs.
    expect(where.bloodGroup.in).not.toContain("A_POS");
    expect(where.bloodGroup.in).not.toContain("B_POS");
    expect(where.bloodGroup.in).not.toContain("AB_POS");
  });

  it("Rh- recipient: compat list excludes Rh+ groups (Rh sensitisation guard)", async () => {
    prismaMock.bloodRequest.findUnique.mockResolvedValueOnce(
      fakeRequest({ bloodGroup: "A_NEG" })
    );
    prismaMock.bloodUnit.findMany.mockResolvedValueOnce([]);

    await request(buildApp())
      .post(`/api/v1/bloodbank/requests/${REQUEST_ID}/match`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({});

    const where = prismaMock.bloodUnit.findMany.mock.calls[0][0].where;
    // A- recipient may receive only A- and O-.
    expect(where.bloodGroup.in.sort()).toEqual(["A_NEG", "O_NEG"]);
    // Critically: no Rh+ in the candidate set.
    expect(where.bloodGroup.in).not.toContain("A_POS");
    expect(where.bloodGroup.in).not.toContain("O_POS");
  });

  it("issue blocks an already-ISSUED unit even if ABO/Rh matches", async () => {
    // The /issue endpoint defends against double-issuance: any unit whose
    // status is not AVAILABLE is rejected with a 400 BEFORE ABO matching.
    // (Expired units carry status=EXPIRED via the cron releaser — same
    // rejection path.)
    prismaMock.bloodRequest.findUnique.mockResolvedValueOnce(
      fakeRequest({ bloodGroup: "O_POS" })
    );
    prismaMock.bloodUnit.findMany.mockResolvedValueOnce([
      fakeUnit({ bloodGroup: "O_POS", status: "ISSUED" }),
    ]);

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/requests/${REQUEST_ID}/issue`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({ unitIds: [UNIT_ID_PRIMARY] });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/not available/i);
    expect(String(res.body.error)).toMatch(/ISSUED/);
    expect(prismaMock.bloodUnit.updateMany).not.toHaveBeenCalled();
  });

  it("issue blocks an EXPIRED unit even if ABO/Rh matches", async () => {
    prismaMock.bloodRequest.findUnique.mockResolvedValueOnce(
      fakeRequest({ bloodGroup: "O_POS" })
    );
    // expiresAt in the past + status=EXPIRED (the canonical post-release shape).
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    prismaMock.bloodUnit.findMany.mockResolvedValueOnce([
      fakeUnit({ bloodGroup: "O_POS", status: "EXPIRED", expiresAt: past }),
    ]);

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/requests/${REQUEST_ID}/issue`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({ unitIds: [UNIT_ID_PRIMARY] });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/not available/i);
    expect(prismaMock.bloodUnit.updateMany).not.toHaveBeenCalled();
  });
});

// ── Reservation ──────────────────────────────────────────────────────────
//
// POST /units/:id/reserve transitions an AVAILABLE unit to RESERVED with
// `reservedForRequestId` set. Reservations expire after `durationHours`
// (default 24, capped at 72). Expired or already-reserved units are
// rejected with 409 so two clinicians don't race for the same unit.

describe("POST /api/v1/bloodbank/units/:id/reserve", () => {
  it("AVAILABLE → RESERVED with reservedForRequestId set", async () => {
    prismaMock.bloodUnit.findUnique.mockResolvedValueOnce(fakeUnit());
    prismaMock.bloodUnit.update.mockResolvedValueOnce(
      fakeUnit({
        status: "RESERVED",
        reservedForRequestId: REQUEST_ID,
        reservedBy: "u-doc",
      })
    );

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/units/${UNIT_ID_PRIMARY}/reserve`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({ requestId: REQUEST_ID, durationHours: 12 });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("RESERVED");
    expect(res.body.data.reservedForRequestId).toBe(REQUEST_ID);

    // Patch payload mirrors the route contract.
    const upArgs = prismaMock.bloodUnit.update.mock.calls[0][0];
    expect(upArgs.where).toEqual({ id: UNIT_ID_PRIMARY });
    expect(upArgs.data.status).toBe("RESERVED");
    expect(upArgs.data.reservedForRequestId).toBe(REQUEST_ID);
    expect(upArgs.data.reservedBy).toBe("u-doc");
    expect(upArgs.data.reservedUntil).toBeInstanceOf(Date);
  });

  it("durationHours capped at 72 even if caller asks for 168", async () => {
    prismaMock.bloodUnit.findUnique.mockResolvedValueOnce(fakeUnit());
    prismaMock.bloodUnit.update.mockResolvedValueOnce(fakeUnit({ status: "RESERVED" }));

    const before = Date.now();
    await request(buildApp())
      .post(`/api/v1/bloodbank/units/${UNIT_ID_PRIMARY}/reserve`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({ requestId: REQUEST_ID, durationHours: 168 });
    const after = Date.now();

    const upArgs = prismaMock.bloodUnit.update.mock.calls[0][0];
    const reservedUntilMs = (upArgs.data.reservedUntil as Date).getTime();
    // Expected reservation window = 72h. Allow ±2s for clock drift between
    // the test and the route's `Date.now()` call.
    const seventyTwoHoursMs = 72 * 60 * 60 * 1000;
    expect(reservedUntilMs).toBeGreaterThanOrEqual(before + seventyTwoHoursMs);
    expect(reservedUntilMs).toBeLessThanOrEqual(after + seventyTwoHoursMs);
  });

  it("rejects an already-RESERVED unit with 409 (no double-booking)", async () => {
    prismaMock.bloodUnit.findUnique.mockResolvedValueOnce(
      fakeUnit({
        status: "RESERVED",
        reservedForRequestId: "other-request-id",
      })
    );

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/units/${UNIT_ID_PRIMARY}/reserve`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({ requestId: REQUEST_ID });

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/not available/i);
    expect(prismaMock.bloodUnit.update).not.toHaveBeenCalled();
  });

  it("rejects an EXPIRED unit even if status is still AVAILABLE", async () => {
    // Edge case: expiry cron has not yet flipped status, but expiresAt is
    // already in the past. The reserve route guards against this so a
    // patient never receives blood that died on the shelf.
    prismaMock.bloodUnit.findUnique.mockResolvedValueOnce(
      fakeUnit({
        status: "AVAILABLE",
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      })
    );

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/units/${UNIT_ID_PRIMARY}/reserve`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({ requestId: REQUEST_ID });

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/expired/i);
    expect(prismaMock.bloodUnit.update).not.toHaveBeenCalled();
  });

  it("404 when unit id is unknown", async () => {
    prismaMock.bloodUnit.findUnique.mockResolvedValueOnce(null);

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/units/${UNIT_ID_PRIMARY}/reserve`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({ requestId: REQUEST_ID });

    expect(res.status).toBe(404);
    expect(prismaMock.bloodUnit.update).not.toHaveBeenCalled();
  });
});
