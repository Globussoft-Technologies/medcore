// Pearl ERP Stage 1 §6 (gap row 329 — patient WhatsApp confirmation
// within 60s of appointment booking).
//
// What this asserts:
//   - POST /api/v1/appointments/book → 201 immediately, then the
//     fire-and-forget `onAppointmentBooked` trigger fans out to
//     `sendNotification`, which writes one Notification row per enabled
//     channel and dispatches via the WhatsApp adapter
//     (apps/api/src/services/channels/whatsapp.ts).
//   - The WhatsApp Notification row reaches `deliveryStatus = SENT`
//     within 60_000 ms of the booking POST start (the PRD SLA).
//   - Conditional gating: when the patient has explicitly disabled the
//     WHATSAPP channel via NotificationPreference (channel=WHATSAPP,
//     enabled=false), NO WhatsApp Notification row is written for them
//     for the booking — the dispatch respects the suppression.
//
// Why we don't hit the wire:
//   The integration suite runs without WHATSAPP_API_URL / WHATSAPP_API_KEY
//   set, so `sendViaEnv` (services/channels/whatsapp.ts:106) returns a
//   stub success synchronously. We also override globalThis.fetch as a
//   defensive guard so any accidental network call short-circuits to a
//   captured stub response instead of leaving the test host.
//
// Test creds: admin@test.local / MedCoreT3st-2026 (NOT the prod-seed
// admin@medcore.local). See CLAUDE.md §6.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture, createDoctorFixture } from "../factories";

const APPOINTMENT_WHATSAPP_SLA_MS = 60_000;

let app: any;
let receptionToken: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origFetch: any;
const stubCalls: string[] = [];

/**
 * Poll the Notification table for a row matching the (userId, channel,
 * type, deliveryStatus) tuple. Mirrors `waitForAuditFlush` from
 * helpers/audit-wait.ts but targets `Notification` instead of `AuditLog`
 * — the WhatsApp dispatch is fire-and-forget (`.catch(console.error)`
 * at routes/appointments.ts:371), so an immediate findFirst would race
 * the deferred write.
 */
async function waitForNotification(
  prisma: any,
  match: {
    userId: string;
    channel: string;
    type: string;
    deliveryStatus?: string;
  },
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? APPOINTMENT_WHATSAPP_SLA_MS;
  const pollMs = opts.pollMs ?? 50;
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const row = await prisma.notification.findFirst({
      where: {
        userId: match.userId,
        channel: match.channel as any,
        type: match.type as any,
        ...(match.deliveryStatus
          ? { deliveryStatus: match.deliveryStatus as any }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    if (row) return row;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `waitForNotification timeout after ${timeoutMs}ms for ${JSON.stringify(match)}`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

describeIfDB("Pearl §6 row 329 — appointment booking → WhatsApp confirmation < 60s", () => {
  beforeAll(async () => {
    await resetDB();
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;

    // Defensive: capture any provider fetch attempts. With
    // WHATSAPP_API_URL unset (default in CI), `sendViaEnv` short-circuits
    // to a stub before fetch is ever called — but if some other channel
    // adapter (push, etc.) does fetch out, we record it without erroring
    // so the timing assertion stays clean.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    origFetch = (globalThis as any).fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      stubCalls.push(url);
      // Return a neutral success envelope; channels treat 2xx as ok.
      return new Response(JSON.stringify({ ok: true, messageId: `stub-${Date.now()}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  });

  afterAll(() => {
    if (origFetch) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = origFetch;
    }
  });

  it("dispatches WhatsApp confirmation Notification (SENT) within 60s of booking POST", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    // Tomorrow @ 09:00 — matches the existing appointments.test.ts
    // pattern and avoids the #491 past-time guard.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const t0 = Date.now();
    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        date: tomorrow,
        slotId: "09:00",
        notes: "Pearl §6 row 329 timing probe",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body?.data?.status).toBe("BOOKED");

    // Poll for the WhatsApp dispatch (fire-and-forget; routes/appointments.ts:371
    // does `onAppointmentBooked(appointment).catch(console.error)`).
    const prisma = await getPrisma();
    const whatsappRow = await waitForNotification(prisma, {
      userId: patient.userId,
      channel: "WHATSAPP",
      type: "APPOINTMENT_BOOKED",
      deliveryStatus: "SENT",
    });
    const t1 = Date.now();
    const elapsedMs = t1 - t0;

    // Sanity: the row matches the patient and carries the booking message.
    expect(whatsappRow.userId).toBe(patient.userId);
    expect(whatsappRow.channel).toBe("WHATSAPP");
    expect(whatsappRow.type).toBe("APPOINTMENT_BOOKED");
    expect(whatsappRow.deliveryStatus).toBe("SENT");
    // The message body is built by onAppointmentBooked in
    // services/notification-triggers.ts:54 and includes the patient name.
    expect(whatsappRow.message).toContain(patient.user.name);
    expect(whatsappRow.sentAt).toBeTruthy();

    // The PRD SLA: < 60s.
    expect(elapsedMs).toBeLessThan(APPOINTMENT_WHATSAPP_SLA_MS);
    // Surface the measured ms in the reporter for SLA-budget tracking.
    // eslint-disable-next-line no-console
    console.log(
      `[Pearl §6 row 329] WhatsApp APPOINTMENT_BOOKED Notification reached SENT in ${elapsedMs} ms ` +
        `(budget: ${APPOINTMENT_WHATSAPP_SLA_MS} ms). stub-fetch calls during window: ${stubCalls.length}`,
    );
  });

  it("respects NotificationPreference: WHATSAPP=disabled patient gets NO WhatsApp row for the booking", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();

    // Explicitly disable the WHATSAPP channel for this patient. The
    // gating in services/notification.ts:219-232 reads this row and
    // skips the WHATSAPP channel — the loop never creates a row for it.
    await prisma.notificationPreference.create({
      data: {
        userId: patient.userId,
        channel: "WHATSAPP" as any,
        enabled: false,
      },
    });

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        date: tomorrow,
        slotId: "10:00",
        notes: "Pearl §6 row 329 negative path",
      });
    expect([200, 201]).toContain(res.status);

    // Wait until at least one Notification row exists for this booking
    // (proves the trigger ran), so the absence-of-WhatsApp assertion is
    // not just racing the deferred write.
    await waitForNotification(prisma, {
      userId: patient.userId,
      channel: "PUSH",
      type: "APPOINTMENT_BOOKED",
    });

    const whatsappRow = await prisma.notification.findFirst({
      where: {
        userId: patient.userId,
        channel: "WHATSAPP" as any,
        type: "APPOINTMENT_BOOKED" as any,
      },
    });
    expect(whatsappRow).toBeNull();
  });
});
