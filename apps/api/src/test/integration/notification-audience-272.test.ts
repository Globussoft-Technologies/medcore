// Regression test for issue #272 (Apr 28 2026):
//
// > Reception sees a patient-only "Discharge Summary — Your discharge has
// > been processed" notification.
//
// Root cause: packages/db/src/seed-notifications-history.ts picked any
// active user as the recipient for every template, so patient-templated
// copy ("Your discharge has been processed", "Your prescription is ready",
// "Your bill has been generated", etc.) was landing in staff inboxes.
//
// Fix: tag every template with the recipient role(s) it's appropriate for
// and pick the seed recipient from the matching role pool.
//
// This test pins both halves of that contract:
//   1. Every template carries a non-empty `audience: Role[]`.
//   2. The patient-only templates listed in the bug report (DISCHARGE,
//      ADMISSION, PRESCRIPTION_READY, BILL_GENERATED, PAYMENT_RECEIVED,
//      LAB_RESULT_READY, MEDICATION_DUE, APPOINTMENT_*) target ONLY
//      Role.PATIENT — never DOCTOR/NURSE/RECEPTION/ADMIN/etc.

import { describe, it, expect } from "vitest";
import {
  Role,
  NotificationType,
  NOTIFICATION_SEED_TEMPLATES as TEMPLATES,
} from "@medcore/db";

describe("Issue #272 — notification template audience scoping", () => {
  it("every seed template declares a non-empty audience", () => {
    for (const tpl of TEMPLATES) {
      expect(tpl.audience, `template ${tpl.type} has empty audience`).toBeTruthy();
      expect(tpl.audience.length).toBeGreaterThan(0);
    }
  });

  it("DISCHARGE notifications target ONLY Role.PATIENT (the bug)", () => {
    const discharge = TEMPLATES.find((t) => t.type === NotificationType.DISCHARGE);
    expect(discharge).toBeDefined();
    expect(discharge!.audience).toEqual([Role.PATIENT]);
    // Specifically: RECEPTION must not be in the audience.
    expect(discharge!.audience).not.toContain(Role.RECEPTION);
    expect(discharge!.audience).not.toContain(Role.DOCTOR);
    expect(discharge!.audience).not.toContain(Role.NURSE);
    expect(discharge!.audience).not.toContain(Role.ADMIN);
  });

  it("all patient-copy templates target only Role.PATIENT", () => {
    const patientOnly: NotificationType[] = [
      NotificationType.DISCHARGE,
      NotificationType.ADMISSION,
      NotificationType.PRESCRIPTION_READY,
      NotificationType.BILL_GENERATED,
      NotificationType.PAYMENT_RECEIVED,
      NotificationType.LAB_RESULT_READY,
      NotificationType.MEDICATION_DUE,
      NotificationType.APPOINTMENT_BOOKED,
      NotificationType.APPOINTMENT_REMINDER,
      NotificationType.APPOINTMENT_CANCELLED,
      NotificationType.TOKEN_CALLED,
    ];
    for (const t of patientOnly) {
      const tpl = TEMPLATES.find((x) => x.type === t);
      expect(tpl, `missing template for ${t}`).toBeDefined();
      expect(
        tpl!.audience,
        `${t} should be PATIENT-only — leak risk for staff inbox`
      ).toEqual([Role.PATIENT]);
    }
  });
});
