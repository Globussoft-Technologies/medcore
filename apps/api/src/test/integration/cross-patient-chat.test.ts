// Cross-patient BOLA regression suite — chat, issue #511.
//
// What this file covers
// ---------------------
// `apps/api/src/routes/chat.ts` was swept under the issue #511 expanded
// audit criterion. The chat ACL is participant-membership (not patient-
// row ownership), and 12 of the 13 `/rooms/:id/*` and `/messages/:id/*`
// handlers already had the canonical participant-or-ADMIN check. The one
// gap was POST `/api/v1/chat/rooms/:id/typing` — it broadcast a typing
// indicator into the room's socket channel without verifying that the
// caller was actually a participant. Any authed user (including a
// PATIENT that knew the room id) could spam typing events into staff
// conversations, leaking presence and adding noise.
//
// Per cited route the suite asserts:
//   1. PATIENT (non-participant) → 403 (the bug)
//   2. PATIENT (participant) → 200 (positive control — patient ↔ doctor
//      DM is the design intent)
//   3. ADMIN → 200 (agent-console triage bypass, issue #189)

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createDoctorFixture } from "../factories";

let app: any;
let adminToken: string;
let patientAToken: string;
let patientBToken: string;
let patientAUserId: string;
let doctorUserId: string;
let dmRoomId: string; // PATIENT-A ↔ DOCTOR

async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_chat_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000005",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-CHAT-${label}-${Date.now()}`,
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

describeIfDB("Cross-patient BOLA — chat (issue #511)", () => {
  beforeAll(async () => {
    await resetDB();
    const prisma = await getPrisma();
    adminToken = await getAuthToken("ADMIN");

    const a = await createPatientWithToken("A");
    const b = await createPatientWithToken("B");
    patientAToken = a.token;
    patientBToken = b.token;
    patientAUserId = a.userId;

    const doctor = await createDoctorFixture();
    doctorUserId = doctor.userId;

    // Build a 1-on-1 DM room: PATIENT-A ↔ DOCTOR
    const room = await prisma.chatRoom.create({
      data: {
        isGroup: false,
        createdBy: patientAUserId,
        participants: {
          create: [{ userId: patientAUserId }, { userId: doctorUserId }],
        },
      },
    });
    dmRoomId = room.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ──────────────────────────────────────────────────────────
  // POST /chat/rooms/:id/typing — participant-membership BOLA
  // ──────────────────────────────────────────────────────────

  it("chat/rooms/:id/typing: non-participant PATIENT-B denied (403)", async () => {
    const res = await request(app)
      .post(`/api/v1/chat/rooms/${dmRoomId}/typing`)
      .set("Authorization", `Bearer ${patientBToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("chat/rooms/:id/typing: participant PATIENT-A allowed (200)", async () => {
    const res = await request(app)
      .post(`/api/v1/chat/rooms/${dmRoomId}/typing`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({});
    expect(res.status).toBe(200);
  });

  it("chat/rooms/:id/typing: ADMIN bypass (200)", async () => {
    const res = await request(app)
      .post(`/api/v1/chat/rooms/${dmRoomId}/typing`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
  });
});
