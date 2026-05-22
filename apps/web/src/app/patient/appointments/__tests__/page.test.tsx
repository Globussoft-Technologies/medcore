// Smoke tests for the patient PWA "My Appointments" page (Pearl §6.1 — gap #5
// piece 3b of 4). Asserts:
//   • Upcoming + Past sections render with mocked data.
//   • Empty state renders correctly when no appointments.
//   • Reschedule button only visible on reschedulable rows (BOOKED/CHECKED_IN +
//     future date).
//   • Cancel button only visible on non-terminal rows.
//   • Share-location only renders when branch.address is hydrated.
//   • Every CTA satisfies the 44px (h-11 + min-w-[44px]) touch-target floor.
//   • Reschedule submit posts to the right endpoint with the right body.
//   • Cancel submit posts to /:id/status with { status: "CANCELLED" }.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";

const { apiGetMock, apiPatchMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    patch: apiPatchMock,
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import PatientAppointmentsPage from "../page";

const HOUR = 60 * 60 * 1000;
const FUTURE = new Date(Date.now() + 48 * HOUR).toISOString();
const PAST = new Date(Date.now() - 48 * HOUR).toISOString();

function listOk<T>(data: T[]) {
  return { success: true, data, error: null, meta: { total: data.length } };
}

function rejectedWithStatus(status: number) {
  return Promise.reject(Object.assign(new Error("nope"), { status }));
}

function bookActive(id: string, dateIso: string) {
  return {
    id,
    date: dateIso,
    slotStart: "10:30:00",
    tokenNumber: 7,
    status: "BOOKED",
    doctor: { user: { name: "Sharma" }, specialty: "Obstetrics" },
  };
}

function completedRow(id: string, dateIso: string) {
  return {
    id,
    date: dateIso,
    slotStart: "09:00:00",
    tokenNumber: 3,
    status: "COMPLETED",
    doctor: { user: { name: "Mehta" }, specialty: "General" },
  };
}

describe("Patient appointments page — gap #5 piece 3b", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
  });

  it("renders Upcoming + Past sections with mocked data", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.includes("status=BOOKED")) {
        return Promise.resolve(listOk([bookActive("appt-up-1", FUTURE)]));
      }
      if (endpoint.includes("status=COMPLETED")) {
        return Promise.resolve(listOk([completedRow("appt-past-1", PAST)]));
      }
      return Promise.resolve(listOk([]));
    });

    render(<PatientAppointmentsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("patient-appointments")).toBeInTheDocument();
    });

    // Upcoming section visible, with the BOOKED row
    const upcoming = screen.getByTestId("patient-appointments-upcoming");
    expect(within(upcoming).getByText(/Dr\. Sharma/)).toBeInTheDocument();
    expect(within(upcoming).getByText(/Obstetrics/)).toBeInTheDocument();

    // Past section visible BUT list hidden behind the toggle
    const pastSection = screen.getByTestId("patient-appointments-past");
    expect(pastSection).toBeInTheDocument();
    expect(
      screen.queryByTestId("patient-appointments-past-list"),
    ).not.toBeInTheDocument();

    // Toggle "Show past appointments"
    fireEvent.click(screen.getByTestId("patient-appointments-past-toggle"));

    const pastList = await screen.findByTestId(
      "patient-appointments-past-list",
    );
    expect(within(pastList).getByText(/Dr\. Mehta/)).toBeInTheDocument();
  });

  it("renders empty state when no appointments exist", async () => {
    apiGetMock.mockResolvedValue(listOk([]));
    render(<PatientAppointmentsPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("patient-appointments-empty"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("patient-appointments-empty-book-cta"),
    ).toHaveAttribute("href", "/patient/appointments/book");
  });

  it("hides Cancel + Reschedule buttons on terminal-status (past) rows", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.includes("status=COMPLETED")) {
        return Promise.resolve(listOk([completedRow("appt-past-1", PAST)]));
      }
      return Promise.resolve(listOk([]));
    });

    render(<PatientAppointmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("patient-appointments")).toBeInTheDocument();
    });

    // Reveal past list
    fireEvent.click(screen.getByTestId("patient-appointments-past-toggle"));
    const pastList = await screen.findByTestId(
      "patient-appointments-past-list",
    );

    // No mutate-CTAs on completed rows
    expect(
      within(pastList).queryByTestId("patient-appointments-reschedule-btn"),
    ).not.toBeInTheDocument();
    expect(
      within(pastList).queryByTestId("patient-appointments-cancel-btn"),
    ).not.toBeInTheDocument();
  });

  it("shows Reschedule + Cancel buttons on a BOOKED future row", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.includes("status=BOOKED")) {
        return Promise.resolve(listOk([bookActive("appt-up-1", FUTURE)]));
      }
      return Promise.resolve(listOk([]));
    });

    render(<PatientAppointmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("patient-appointments")).toBeInTheDocument();
    });

    const upcoming = screen.getByTestId("patient-appointments-upcoming");
    expect(
      within(upcoming).getByTestId("patient-appointments-reschedule-btn"),
    ).toBeInTheDocument();
    expect(
      within(upcoming).getByTestId("patient-appointments-cancel-btn"),
    ).toBeInTheDocument();
  });

  it("every interactive CTA carries h-11 + min-w-[44px] (Pearl §6.2 touch-target floor)", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.includes("status=BOOKED")) {
        return Promise.resolve(
          listOk([
            {
              ...bookActive("appt-up-1", FUTURE),
              branch: { id: "b-1", name: "Main", address: "1 Demo Rd" },
            },
          ]),
        );
      }
      return Promise.resolve(listOk([]));
    });
    render(<PatientAppointmentsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-appointments")).toBeInTheDocument(),
    );

    const ctaTestIds = [
      "patient-appointments-book-cta",
      "patient-appointments-reschedule-btn",
      "patient-appointments-cancel-btn",
      "patient-appointments-share-location",
    ];
    for (const testId of ctaTestIds) {
      const el = screen.getByTestId(testId);
      expect(el.className, `${testId} must include h-11`).toMatch(/\bh-11\b/);
      expect(el.className, `${testId} must include min-w-[44px]`).toMatch(
        /min-w-\[44px\]/,
      );
    }
  });

  it("share-location is hidden when branch.address is absent", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.includes("status=BOOKED")) {
        return Promise.resolve(listOk([bookActive("appt-up-1", FUTURE)]));
      }
      return Promise.resolve(listOk([]));
    });
    render(<PatientAppointmentsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-appointments")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("patient-appointments-share-location"),
    ).not.toBeInTheDocument();
  });

  it("share-location opens a Google Maps URL when branch.address is hydrated", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.includes("status=BOOKED")) {
        return Promise.resolve(
          listOk([
            {
              ...bookActive("appt-up-1", FUTURE),
              branch: {
                id: "b-1",
                name: "Main",
                address: "12 MG Rd, Bengaluru",
              },
            },
          ]),
        );
      }
      return Promise.resolve(listOk([]));
    });
    render(<PatientAppointmentsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-appointments")).toBeInTheDocument(),
    );
    const link = screen.getByTestId("patient-appointments-share-location");
    expect(link).toHaveAttribute("target", "_blank");
    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("https://maps.google.com/");
    expect(href).toContain(encodeURIComponent("12 MG Rd, Bengaluru"));
  });

  it("submitting reschedule PATCHes /appointments/:id/reschedule with { date, slotStart }", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.includes("status=BOOKED")) {
        return Promise.resolve(listOk([bookActive("appt-up-1", FUTURE)]));
      }
      return Promise.resolve(listOk([]));
    });
    apiPatchMock.mockResolvedValue({ success: true, data: {}, error: null });

    render(<PatientAppointmentsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-appointments")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("patient-appointments-reschedule-btn"));
    const modal = await screen.findByTestId(
      "patient-appointments-reschedule-modal",
    );
    expect(modal).toBeInTheDocument();

    const dateInput = screen.getByTestId(
      "patient-appointments-reschedule-date",
    );
    const timeInput = screen.getByTestId(
      "patient-appointments-reschedule-time",
    );
    fireEvent.change(dateInput, { target: { value: "2099-12-31" } });
    fireEvent.change(timeInput, { target: { value: "15:30" } });
    fireEvent.click(
      screen.getByTestId("patient-appointments-reschedule-submit"),
    );

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith(
        "/appointments/appt-up-1/reschedule",
        { date: "2099-12-31", slotStart: "15:30" },
      );
    });
  });

  it("submitting cancel PATCHes /appointments/:id/status with { status: 'CANCELLED' }", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.includes("status=BOOKED")) {
        return Promise.resolve(listOk([bookActive("appt-up-1", FUTURE)]));
      }
      return Promise.resolve(listOk([]));
    });
    apiPatchMock.mockResolvedValue({ success: true, data: {}, error: null });

    render(<PatientAppointmentsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-appointments")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("patient-appointments-cancel-btn"));
    const modal = await screen.findByTestId(
      "patient-appointments-cancel-modal",
    );
    expect(modal).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("patient-appointments-cancel-submit"));

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith(
        "/appointments/appt-up-1/status",
        { status: "CANCELLED" },
      );
    });
  });

  it("renders the unauthed sign-in surface when /appointments returns 401", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.includes("/appointments")) return rejectedWithStatus(401);
      return Promise.resolve(listOk([]));
    });
    render(<PatientAppointmentsPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("patient-appointments-unauth"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("patient-appointments-signin-cta"),
    ).toHaveAttribute("href", "/patient/login");
  });
});
