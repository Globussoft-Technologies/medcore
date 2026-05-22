// Smoke / behaviour tests for the BulkEditDoctorsModal component
// (Pearl ERP Stage 1 §3.1, gap row 74).
//
// What this file covers:
//   - The Submit button is disabled until at least one "Apply" toggle is on
//     (the don't-clobber-untouched-fields guard from the parent's UX brief).
//   - When the admin toggles ONLY appointmentMode + tokenPrefix, the POST
//     body sent to /doctors/bulk-update contains ONLY those two fields,
//     never the other 4 — proves we don't accidentally include un-toggled
//     fields in the payload.
//   - The modal lists the doctor count it received as a prop.
//   - 44px touch-target invariant on the toggles and the Submit button
//     (covers the mobile-friendly constraint in the parent brief).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/field-errors", () => ({
  extractFieldErrors: () => null,
}));

import { BulkEditDoctorsModal } from "../BulkEditDoctorsModal";

const DOCTOR_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];

describe("BulkEditDoctorsModal (Pearl §3.1)", () => {
  beforeEach(() => {
    apiMock.post.mockReset();
    apiMock.post.mockResolvedValue({
      data: { updatedCount: DOCTOR_IDS.length, updatedDoctorIds: DOCTOR_IDS },
    });
  });

  it("shows the number of selected doctors", () => {
    render(
      <BulkEditDoctorsModal
        doctorIds={DOCTOR_IDS}
        onClose={() => {}}
        onSuccess={() => {}}
      />,
    );
    const counter = screen.getByTestId("doctor-bulk-edit-count");
    expect(counter.textContent).toBe(String(DOCTOR_IDS.length));
  });

  it("Submit button is disabled when no field is toggled on (avoid no-op POSTs)", () => {
    render(
      <BulkEditDoctorsModal
        doctorIds={DOCTOR_IDS}
        onClose={() => {}}
        onSuccess={() => {}}
      />,
    );
    const submit = screen.getByTestId("doctor-bulk-edit-submit");
    expect(submit).toBeDisabled();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submits ONLY the toggled fields — untoggled fields stay out of the payload", async () => {
    const onSuccess = vi.fn();
    render(
      <BulkEditDoctorsModal
        doctorIds={DOCTOR_IDS}
        onClose={() => {}}
        onSuccess={onSuccess}
      />,
    );

    // Toggle ON only mode + tokenPrefix. Leave token-start, daily-limit,
    // near-turn, and policy OFF.
    fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
    fireEvent.click(screen.getByTestId("bulk-field-token-prefix-toggle"));

    // Change values on the toggled fields.
    fireEvent.change(screen.getByTestId("bulk-field-mode-input"), {
      target: { value: "SLOT" },
    });
    fireEvent.change(screen.getByTestId("bulk-field-token-prefix-input"), {
      target: { value: "OPD" },
    });

    fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/doctors/bulk-update");
    expect(body.doctorIds).toEqual(DOCTOR_IDS);
    expect(body.updates).toEqual({
      appointmentMode: "SLOT",
      tokenPrefix: "OPD",
    });
    // Explicitly assert the un-toggled keys are ABSENT — the parent
    // brief calls this the "don't accidentally clobber untouched
    // fields" invariant.
    expect(body.updates).not.toHaveProperty("tokenStartNumber");
    expect(body.updates).not.toHaveProperty("dailyAppointmentLimit");
    expect(body.updates).not.toHaveProperty("nearTurnAlertThreshold");
    expect(body.updates).not.toHaveProperty("lastHourPolicy");

    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith(DOCTOR_IDS.length),
    );
  });

  it("Apply toggles + Submit button meet the 44px touch-target invariant", () => {
    render(
      <BulkEditDoctorsModal
        doctorIds={DOCTOR_IDS}
        onClose={() => {}}
        onSuccess={() => {}}
      />,
    );
    // The toggle labels carry the touch-target classes (min-h-[44px]
    // min-w-[44px]) because the visible click area is the label wrapping
    // the checkbox, not the bare 16x16 input.
    const toggleLabels = [
      "bulk-field-mode-label",
      "bulk-field-token-prefix-label",
      "bulk-field-token-start-label",
      "bulk-field-daily-limit-label",
      "bulk-field-near-turn-label",
      "bulk-field-policy-label",
    ];
    for (const id of toggleLabels) {
      const el = screen.getByTestId(id);
      expect(el.className).toMatch(/min-h-\[44px\]/);
      expect(el.className).toMatch(/min-w-\[44px\]/);
    }
    // Submit button also pins 44px so it's tappable on mobile.
    const submit = screen.getByTestId("doctor-bulk-edit-submit");
    expect(submit.className).toMatch(/min-h-\[44px\]/);
  });
});
