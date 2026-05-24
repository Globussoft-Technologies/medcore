// Smoke tests for the patient PWA Book Appointment 3-step flow
// (Pearl §6.1 — gap row 161). Asserts:
//   • Step 1 renders the doctor list with mode badges from GET /doctors.
//   • Picking a TOKEN-mode doctor advances to step 2 and shows the token-mode
//     info card (no slot grid; no /slots fetch should fire).
//   • Picking a SLOT-mode doctor advances to step 2, fires GET
//     /doctors/:id/slots?date=YYYY-MM-DD, renders a grid, and Confirm posts
//     POST /appointments/book with { patientId, doctorId, date, slotId }.
//
// Mock layer: vi.hoisted api mock + next/navigation router mock (same
// pattern as bills/[id]/pay tests).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiGetMock, apiPostMock, routerPushMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  routerPushMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock, replace: vi.fn(), back: vi.fn() }),
}));

import PatientBookAppointmentPage from "../page";

const PATIENT_ID = "patient-fixture-1";

function meOk(opts: { patientId?: string | null } = {}) {
  return {
    success: true,
    error: null,
    data: {
      id: "user-1",
      role: "PATIENT",
      patient: { id: opts.patientId ?? PATIENT_ID },
    },
  };
}

function listOk<T>(data: T[]) {
  return { success: true, data, error: null, meta: { total: data.length } };
}

function oneOk<T>(data: T) {
  return { success: true, data, error: null };
}

const TOKEN_DOCTOR = {
  id: "doc-token",
  specialty: "General Medicine",
  appointmentMode: "TOKEN" as const,
  tokenPrefix: "T",
  user: { id: "u-doc-token", name: "Rao", isActive: true },
};
const SLOT_DOCTOR = {
  id: "doc-slot",
  specialty: "Dermatology",
  appointmentMode: "SLOT" as const,
  user: { id: "u-doc-slot", name: "Mehta", isActive: true },
};

describe("Patient PWA — Book Appointment (gap row 161)", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    routerPushMock.mockReset();
  });

  it("renders the doctor list from /doctors with mode badges", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/doctors")) {
        return Promise.resolve(listOk([TOKEN_DOCTOR, SLOT_DOCTOR]));
      }
      if (endpoint.startsWith("/auth/me")) {
        return Promise.resolve(meOk());
      }
      return Promise.resolve(listOk([]));
    });

    render(<PatientBookAppointmentPage />);

    await waitFor(() => {
      expect(screen.getByTestId("pwa-book")).toBeInTheDocument();
    });

    // Both doctor buttons render with mode badge testids
    expect(
      screen.getByTestId(`pwa-book-doctor-${TOKEN_DOCTOR.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`pwa-book-doctor-${SLOT_DOCTOR.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`pwa-book-doctor-${TOKEN_DOCTOR.id}-mode`),
    ).toHaveTextContent(/token/i);
    expect(
      screen.getByTestId(`pwa-book-doctor-${SLOT_DOCTOR.id}-mode`),
    ).toHaveTextContent(/slot/i);
  });

  it("selecting a TOKEN-mode doctor shows the token-mode info card (no slot fetch)", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/doctors") && !endpoint.includes("/slots")) {
        return Promise.resolve(listOk([TOKEN_DOCTOR]));
      }
      if (endpoint.startsWith("/auth/me")) {
        return Promise.resolve(meOk());
      }
      if (endpoint.includes("/slots")) {
        // Should NOT be called for TOKEN-mode — fail loudly if it is.
        throw new Error("slots endpoint must not be called for TOKEN mode");
      }
      return Promise.resolve(listOk([]));
    });

    render(<PatientBookAppointmentPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId(`pwa-book-doctor-${TOKEN_DOCTOR.id}`),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByTestId(`pwa-book-doctor-${TOKEN_DOCTOR.id}`),
    );

    await waitFor(() => {
      expect(screen.getByTestId("pwa-book-date-input")).toBeInTheDocument();
      expect(screen.getByTestId("pwa-book-token-info")).toBeInTheDocument();
    });
    // SLOT-mode-only testids should be absent
    expect(screen.queryByTestId("pwa-book-slots-grid")).toBeNull();
    expect(screen.queryByTestId("pwa-book-slots-loading")).toBeNull();
  });

  it("selecting a SLOT-mode doctor + slot + Confirm posts to /appointments/book with slotId", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/doctors") && !endpoint.includes("/slots")) {
        return Promise.resolve(listOk([SLOT_DOCTOR]));
      }
      if (endpoint.startsWith("/auth/me")) {
        return Promise.resolve(meOk());
      }
      if (endpoint.includes(`/doctors/${SLOT_DOCTOR.id}/slots`)) {
        return Promise.resolve(
          oneOk({
            date: "2026-12-01",
            slots: [
              { startTime: "09:00", endTime: "09:15", isAvailable: true },
              { startTime: "09:15", endTime: "09:30", isAvailable: false },
              { startTime: "09:30", endTime: "09:45", isAvailable: true },
            ],
            blocked: false,
          }),
        );
      }
      return Promise.resolve(listOk([]));
    });
    apiPostMock.mockResolvedValue({
      success: true,
      error: null,
      data: { id: "appt-1", slotStart: "09:00" },
    });

    render(<PatientBookAppointmentPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId(`pwa-book-doctor-${SLOT_DOCTOR.id}`),
      ).toBeInTheDocument(),
    );

    // Step 1 → 2
    fireEvent.click(
      screen.getByTestId(`pwa-book-doctor-${SLOT_DOCTOR.id}`),
    );
    await waitFor(() =>
      expect(screen.getByTestId("pwa-book-date-input")).toBeInTheDocument(),
    );

    // Step 2 — wait for slots to load
    await waitFor(() => {
      expect(screen.getByTestId("pwa-book-slots-grid")).toBeInTheDocument();
      expect(screen.getByTestId("pwa-book-slot-09:00")).toBeInTheDocument();
    });

    // Pick a slot and advance to confirm
    fireEvent.click(screen.getByTestId("pwa-book-slot-09:00"));
    fireEvent.click(screen.getByTestId("pwa-book-next-to-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("pwa-book-summary")).toBeInTheDocument(),
    );

    // Step 3 — confirm fires POST /appointments/book with slotId
    fireEvent.click(screen.getByTestId("pwa-book-confirm-btn"));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    const [postEndpoint, postBody] = apiPostMock.mock.calls[0];
    expect(postEndpoint).toBe("/appointments/book");
    expect(postBody).toMatchObject({
      patientId: PATIENT_ID,
      doctorId: SLOT_DOCTOR.id,
      slotId: "09:00",
    });
    expect(typeof (postBody as { date?: string }).date).toBe("string");

    // Success → router push to /patient/appointments
    await waitFor(() =>
      expect(routerPushMock).toHaveBeenCalledWith("/patient/appointments"),
    );
  });
});
