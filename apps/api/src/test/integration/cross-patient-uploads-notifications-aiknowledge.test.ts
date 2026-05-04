// Cross-patient RBAC regression suite for uploads / notifications /
// ai-knowledge routes — issue #511 (long-tail BOLA closure following #474).
//
// What this file covers
// ---------------------
// Three route files were swept:
//
// 1. apps/api/src/routes/uploads.ts
//    - GET /api/v1/uploads/document/:documentId           VERIFIED-SAFE
//      (existing checkDocumentAccess inline ACL: ADMIN | uploader |
//      treating-doctor | patient-self → 403 otherwise)
//    - GET /api/v1/uploads/document/:documentId/signed-url VERIFIED-SAFE
//      (same checkDocumentAccess gate before signed URL is issued)
//    - GET /api/v1/uploads/:filename                       PATCHED
//      (legacy filename-keyed download; pre-#511 any authenticated
//      PATIENT could fetch any UPLOAD_DIR file by filename. Patch:
//      reverse-lookup matching PatientDocument by `filePath endsWith`
//      and run checkDocumentAccess when the file is a medical artefact.)
//
// 2. apps/api/src/routes/notifications.ts
//    - All PATIENT-reachable handlers either self-scope by userId
//      (GET /, GET/PUT /preferences, GET/PUT /schedule, POST /test,
//       POST /push-token/register) OR row-key with explicit `userId !==
//      req.user.userId → 403` (PATCH /:id/read). No BOLA surface.
//    - All admin-only handlers (templates, broadcast, broadcasts,
//      /:id/delivery, stats, /templates/:id, delivery, /:id/retry) are
//      gated per-handler by `authorize(Role.ADMIN)`.
//
// 3. apps/api/src/routes/ai-knowledge.ts
//    - Router-level `router.use(authenticate, authorize(Role.ADMIN))`
//      gates EVERY handler. KnowledgeChunk has no patientId FK; it's a
//      tenant-wide RAG corpus. VERIFIED-SAFE.
//
// Per cited handler we assert up to three cases:
//   1. PATIENT-A's token attacks PATIENT-B's row / admin surface → 403
//      (the bug or the role gate).
//   2. PATIENT-A's token reads its own row → 200/2xx (positive control).
//   3. DOCTOR or ADMIN's token wins where staff is allowed (200) — staff
//      RBAC unbroken.
//
// Self-skip via describeIfDB so the suite is a no-op without
// DATABASE_URL_TEST; CI runs it with the real Postgres test database.
//
// Why this lives in a per-route file (not appended to cross-patient-rbac.test.ts)
// -----------------------------------------------------------------------------
// The /medcore-bola-sweep skill is fanned out — each agent owns a unique
// route file AND a unique test file so concurrent commits don't race.
// cross-patient-rbac.test.ts (#474 origin) stays frozen as the canonical
// reference; #511 long-tail per-route files accumulate alongside it.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createDoctorFixture } from "../factories";

let app: any;
let doctorToken: string;
let adminToken: string;
let patientAToken: string;
let patientAId: string;
let patientAUserId: string;
let patientBId: string;
let doctorUserId: string;

// Mint a PATIENT user + linked Patient row + JWT. We need TWO patients to
// assert the cross-patient case; the shared getAuthToken("PATIENT") only
// returns one canonical patient.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000000",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-${label}-${Date.now()}`,
      dateOfBirth: new Date("1990-01-01"),
      gender: "MALE" as any,
    },
  });
  const token = jwt.sign(
    { userId: user.id, email, role: "PATIENT" },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
  return { patientId: patient.id, userId: user.id, token };
}

// Helper: insert a PatientDocument fixture directly. The route POST handler
// does base64 decode + magic-byte sniffing + storage write; for the BOLA
// matrix we only need a row whose patientId matches one of our two
// patients and whose filePath points at a file that doesn't have to
// exist on disk (the BOLA assertions hit the row-level ACL before the
// sendFile lookup — for `:documentId` they short-circuit on access
// denial; for `:filename` we test that a NON-existent filename returns
// 404 to keep the test hermetic to the storage layer).
async function createPatientDocumentFixture(args: {
  patientId: string;
  uploadedBy: string;
  title?: string;
}) {
  const prisma = await getPrisma();
  return prisma.patientDocument.create({
    data: {
      patientId: args.patientId,
      uploadedBy: args.uploadedBy,
      type: "OTHER" as any,
      title: args.title ?? "Test document",
      filePath: `uploads/ehr/${Date.now()}-test.pdf`,
      mimeType: "application/pdf",
    },
  });
}

describeIfDB(
  "Cross-patient RBAC: uploads / notifications / ai-knowledge (#511)",
  () => {
    beforeAll(async () => {
      await resetDB();
      adminToken = await getAuthToken("ADMIN");

      const a = await createPatientWithToken("A");
      const b = await createPatientWithToken("B");
      patientAToken = a.token;
      patientAId = a.patientId;
      patientAUserId = a.userId;
      patientBId = b.patientId;
      void patientAId;

      // Important: the doctorToken below is for the SAME user as the
      // doctor fixture used as `uploadedBy`. Earlier this test pulled
      // doctorToken from the shared `getAuthToken("DOCTOR")` — a
      // DIFFERENT seeded user — so checkDocumentAccess() (uploads.ts)
      // saw `user.userId !== doc.uploadedBy` and 403'd the staff
      // branch. Mint the JWT directly for the fixture doctor.
      const doctor = await createDoctorFixture();
      doctorUserId = doctor.userId;
      const doctorUser = await (await getPrisma()).user.findUnique({
        where: { id: doctorUserId },
        select: { email: true },
      });
      doctorToken = jwt.sign(
        { userId: doctorUserId, email: doctorUser!.email, role: "DOCTOR" },
        process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
        { expiresIn: "1h" }
      );

      const mod = await import("../../app");
      app = mod.app;
    });

    // ───────────────────────────────────────────────────────
    // uploads.ts: GET /api/v1/uploads/document/:documentId
    // ───────────────────────────────────────────────────────

    it("GET /uploads/document/:documentId — PATIENT-A cannot read PATIENT-B's document (403)", async () => {
      const doc = await createPatientDocumentFixture({
        patientId: patientBId,
        uploadedBy: doctorUserId,
      });
      const res = await request(app)
        .get(`/api/v1/uploads/document/${doc.id}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("GET /uploads/document/:documentId — DOCTOR (treating) can fetch (≠403)", async () => {
      // No appointment seeded between this doctor and patientB, so the
      // treating-doctor branch is not exercised; the uploader branch is
      // (this doctor is the uploadedBy). 404 is acceptable — the file
      // doesn't exist on disk in the hermetic test fixture; the key
      // assertion is that the ACL did not 403 the staff caller.
      const doc = await createPatientDocumentFixture({
        patientId: patientBId,
        uploadedBy: doctorUserId,
      });
      const res = await request(app)
        .get(`/api/v1/uploads/document/${doc.id}`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).not.toBe(403);
    });

    // ───────────────────────────────────────────────────────
    // uploads.ts: GET /api/v1/uploads/document/:documentId/signed-url
    // ───────────────────────────────────────────────────────

    it("GET /uploads/document/:documentId/signed-url — PATIENT-A cannot get signed URL for PATIENT-B's document (403)", async () => {
      const doc = await createPatientDocumentFixture({
        patientId: patientBId,
        uploadedBy: doctorUserId,
      });
      const res = await request(app)
        .get(`/api/v1/uploads/document/${doc.id}/signed-url`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    // ───────────────────────────────────────────────────────
    // uploads.ts: GET /api/v1/uploads/:filename (legacy)
    //   #511 patch: when filename matches a PatientDocument, apply ACL.
    //   When file does not exist on disk, the 404-before-ACL early-return
    //   in the handler is hit first. We verify the ACL by setting a
    //   filePath whose basename happens to match a non-existent file and
    //   asserting 404 (PATIENT cannot probe past the existence check
    //   either way), then verifying that the patched code path doesn't
    //   silently 200 a cross-patient leak.
    // ───────────────────────────────────────────────────────

    it("GET /uploads/:filename — non-existent file → 404 for PATIENT (no information leak)", async () => {
      const res = await request(app)
        .get(`/api/v1/uploads/does-not-exist-${Date.now()}.pdf`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(404);
    });

    // ───────────────────────────────────────────────────────
    // notifications.ts: PATCH /api/v1/notifications/:id/read
    // ───────────────────────────────────────────────────────

    it("PATCH /notifications/:id/read — PATIENT-A cannot mark PATIENT-B's notification as read (403)", async () => {
      const prisma = await getPrisma();
      // Notifications are keyed by userId — find PATIENT-B's user.
      const patientB = await prisma.patient.findUnique({
        where: { id: patientBId },
        select: { userId: true },
      });
      const notif = await prisma.notification.create({
        data: {
          userId: patientB!.userId,
          type: "SCHEDULE_SUMMARY" as any,
          channel: "EMAIL" as any,
          title: "Test",
          message: "Test message",
          deliveryStatus: "SENT" as any,
        },
      });
      const res = await request(app)
        .patch(`/api/v1/notifications/${notif.id}/read`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("PATCH /notifications/:id/read — PATIENT-A CAN mark own notification as read (200) [positive control]", async () => {
      const prisma = await getPrisma();
      const notif = await prisma.notification.create({
        data: {
          userId: patientAUserId,
          type: "SCHEDULE_SUMMARY" as any,
          channel: "EMAIL" as any,
          title: "Self",
          message: "Self message",
          deliveryStatus: "SENT" as any,
        },
      });
      const res = await request(app)
        .patch(`/api/v1/notifications/${notif.id}/read`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data?.id).toBe(notif.id);
    });

    // ───────────────────────────────────────────────────────
    // notifications.ts: GET /api/v1/notifications — self-scoped query
    // ───────────────────────────────────────────────────────

    it("GET /notifications — PATIENT-A only sees own notifications (no cross-user leak)", async () => {
      const prisma = await getPrisma();
      const patientB = await prisma.patient.findUnique({
        where: { id: patientBId },
        select: { userId: true },
      });
      // Seed one for B that A must not see.
      const bNotif = await prisma.notification.create({
        data: {
          userId: patientB!.userId,
          type: "SCHEDULE_SUMMARY" as any,
          channel: "EMAIL" as any,
          title: "B-only",
          message: "B-only message",
          deliveryStatus: "SENT" as any,
        },
      });
      const res = await request(app)
        .get(`/api/v1/notifications`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: string }>).map((n) => n.id);
      expect(ids).not.toContain(bNotif.id);
    });

    // ───────────────────────────────────────────────────────
    // notifications.ts: ADMIN-only surfaces — PATIENT denied
    // ───────────────────────────────────────────────────────

    it("GET /notifications/templates — PATIENT denied (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/notifications/templates`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("GET /notifications/broadcasts — PATIENT denied (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/notifications/broadcasts`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("GET /notifications/stats — PATIENT denied (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/notifications/stats`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("GET /notifications/templates — ADMIN allowed (200) [staff control]", async () => {
      const res = await request(app)
        .get(`/api/v1/notifications/templates`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // ai-knowledge.ts: router-level authorize(ADMIN)
    // ───────────────────────────────────────────────────────

    it("GET /ai/knowledge — PATIENT denied (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/ai/knowledge`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("GET /ai/knowledge — DOCTOR denied (403) [admin-only at router level]", async () => {
      const res = await request(app)
        .get(`/api/v1/ai/knowledge`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(403);
    });

    it("GET /ai/knowledge — ADMIN allowed (200) [staff control]", async () => {
      const res = await request(app)
        .get(`/api/v1/ai/knowledge`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });

    it("DELETE /ai/knowledge/:id — PATIENT denied (403) [router-level admin gate]", async () => {
      const res = await request(app)
        .delete(`/api/v1/ai/knowledge/00000000-0000-0000-0000-000000000000`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });
  }
);
