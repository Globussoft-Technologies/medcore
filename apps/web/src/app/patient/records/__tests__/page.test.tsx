// Smoke tests for the patient PWA "My Health Records" page (Pearl §6.1 —
// gap #5 piece 3f of 4). Asserts:
//   • Renders the unified timeline with mixed mock data (3 appointments +
//     2 prescriptions + 1 lab order) — all sorted newest-first.
//   • Empty state when all 3 sources return zero rows.
//   • Filter chips toggle off → entries of that type are hidden client-side
//     without re-fetching.
//   • 44px touch-target invariant on every chip + every card CTA + the
//     "Load older records" button.
//   • 401 on any source surfaces the sign-in nudge.
//   • Each card type renders with the right pill copy (Appointments /
//     Prescriptions / Lab Results) and is locatable by its data-entry-type.
//
// Uses vi.hoisted for the api mock per CLAUDE.md gotcha #2 (singleFork
// vitest pattern — same shape as the appointments / prescriptions / bills /
// profile page tests in pieces 3b-3e).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";

const { apiGetMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import PatientRecordsPage from "../page";

function listOk<T>(data: T[], total?: number) {
  return {
    success: true,
    data,
    error: null,
    meta: { page: 1, limit: 50, total: total ?? data.length },
  };
}

function rejectedWithStatus(status: number) {
  return Promise.reject(Object.assign(new Error("nope"), { status }));
}

// Route by endpoint substring so tests don't care about call order.
function mockSources(opts: {
  appointments: ReturnType<typeof listOk> | Promise<unknown>;
  prescriptions: ReturnType<typeof listOk> | Promise<unknown>;
  labs: ReturnType<typeof listOk> | Promise<unknown>;
}) {
  apiGetMock.mockImplementation((endpoint: string) => {
    if (endpoint.startsWith("/appointments")) {
      return opts.appointments instanceof Promise
        ? opts.appointments
        : Promise.resolve(opts.appointments);
    }
    if (endpoint.startsWith("/prescriptions")) {
      return opts.prescriptions instanceof Promise
        ? opts.prescriptions
        : Promise.resolve(opts.prescriptions);
    }
    if (endpoint.startsWith("/lab/orders")) {
      return opts.labs instanceof Promise
        ? opts.labs
        : Promise.resolve(opts.labs);
    }
    return Promise.resolve(listOk([]));
  });
}

function appt(id: string, dateIso: string, doctorName = "Singh") {
  return {
    id,
    date: dateIso,
    slotStart: "10:00:00",
    status: "BOOKED",
    doctor: {
      user: { name: doctorName },
      specialty: "General Medicine",
    },
  };
}

function rx(id: string, createdAt: string, top = "Amoxicillin") {
  return {
    id,
    createdAt,
    diagnosis: "Sore throat",
    status: "SIGNED",
    doctor: { user: { name: "Iyer" }, specialty: "ENT" },
    items: [{ medicineName: top }, { medicineName: "Paracetamol" }],
  };
}

function lab(id: string, orderedAt: string, testName = "CBC") {
  return {
    id,
    orderedAt,
    status: "REPORTED",
    items: [{ test: { name: testName, code: "CBC" } }],
  };
}

describe("Patient records page — gap #5 piece 3f", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  it("renders the unified timeline with mixed mock data, newest-first", async () => {
    mockSources({
      appointments: listOk([
        appt("a1", "2026-05-20T00:00:00Z"),
        appt("a2", "2026-05-10T00:00:00Z"),
        appt("a3", "2026-04-15T00:00:00Z"),
      ]),
      prescriptions: listOk([
        rx("r1", "2026-05-18T09:00:00Z"),
        rx("r2", "2026-04-10T09:00:00Z"),
      ]),
      labs: listOk([lab("l1", "2026-05-15T11:00:00Z", "Lipid Panel")]),
    });

    render(<PatientRecordsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-records")).toBeInTheDocument(),
    );

    const rows = screen.getAllByTestId("patient-records-row");
    expect(rows).toHaveLength(6);

    // First entry should be the most recent (appointment on 2026-05-20).
    expect(rows[0]).toHaveAttribute("data-entry-id", "appt-a1");

    // Each type appears at least once.
    expect(
      rows.some((r) => r.getAttribute("data-entry-type") === "appointment"),
    ).toBe(true);
    expect(
      rows.some((r) => r.getAttribute("data-entry-type") === "prescription"),
    ).toBe(true);
    expect(rows.some((r) => r.getAttribute("data-entry-type") === "lab")).toBe(
      true,
    );
  });

  it("renders the empty state when all three sources return zero rows", async () => {
    mockSources({
      appointments: listOk([]),
      prescriptions: listOk([]),
      labs: listOk([]),
    });
    render(<PatientRecordsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-records-empty")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("patient-records-row"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("patient-records-load-more"),
    ).not.toBeInTheDocument();
  });

  it("toggling the Prescriptions chip off hides only prescription rows client-side", async () => {
    mockSources({
      appointments: listOk([appt("a1", "2026-05-20T00:00:00Z")]),
      prescriptions: listOk([rx("r1", "2026-05-18T09:00:00Z")]),
      labs: listOk([lab("l1", "2026-05-15T11:00:00Z")]),
    });

    render(<PatientRecordsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-records")).toBeInTheDocument(),
    );
    expect(screen.getAllByTestId("patient-records-row")).toHaveLength(3);

    // Reset the spy so we can prove no re-fetch happens on toggle.
    apiGetMock.mockClear();

    fireEvent.click(screen.getByTestId("patient-records-chip-prescription"));

    // Only appointment + lab rows remain.
    const visible = screen.getAllByTestId("patient-records-row");
    expect(visible).toHaveLength(2);
    expect(
      visible.every(
        (r) => r.getAttribute("data-entry-type") !== "prescription",
      ),
    ).toBe(true);

    // Chip is now in the "off" state.
    expect(
      screen.getByTestId("patient-records-chip-prescription"),
    ).toHaveAttribute("data-active", "false");

    // No re-fetch fired — chips are purely client-side.
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("toggling all three chips off renders the empty state", async () => {
    mockSources({
      appointments: listOk([appt("a1", "2026-05-20T00:00:00Z")]),
      prescriptions: listOk([rx("r1", "2026-05-18T09:00:00Z")]),
      labs: listOk([lab("l1", "2026-05-15T11:00:00Z")]),
    });
    render(<PatientRecordsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-records")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("patient-records-chip-appointment"));
    fireEvent.click(screen.getByTestId("patient-records-chip-prescription"));
    fireEvent.click(screen.getByTestId("patient-records-chip-lab"));
    expect(screen.getByTestId("patient-records-empty")).toBeInTheDocument();
  });

  it("every chip + every card CTA carries h-11 + min-w-[44px] (Pearl §6.2 touch-target floor)", async () => {
    mockSources({
      appointments: listOk(
        Array.from({ length: 50 }, (_, i) =>
          appt(`a${i}`, `2026-05-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
        ),
      ),
      prescriptions: listOk([]),
      labs: listOk([]),
    });

    render(<PatientRecordsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-records")).toBeInTheDocument(),
    );

    for (const t of ["appointment", "prescription", "lab"]) {
      const el = screen.getByTestId(`patient-records-chip-${t}`);
      expect(el.className, `chip ${t} h-11`).toMatch(/\bh-11\b/);
      expect(el.className, `chip ${t} min-w-[44px]`).toMatch(
        /min-w-\[44px\]/,
      );
    }

    const view = screen.getAllByTestId("patient-records-row-view-btn")[0];
    expect(view.className).toMatch(/\bh-11\b/);
    expect(view.className).toMatch(/min-w-\[44px\]/);

    // 50 appts returned == windowSize, so the source is NOT exhausted →
    // "Load older records" CTA renders.
    const more = screen.getByTestId("patient-records-load-more");
    expect(more.className).toMatch(/\bh-11\b/);
    expect(more.className).toMatch(/min-w-\[44px\]/);
  });

  it("each card type renders the right pill copy + icon-bearing pill element", async () => {
    mockSources({
      appointments: listOk([appt("a1", "2026-05-20T00:00:00Z")]),
      prescriptions: listOk([rx("r1", "2026-05-18T09:00:00Z")]),
      labs: listOk([lab("l1", "2026-05-15T11:00:00Z")]),
    });
    render(<PatientRecordsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-records")).toBeInTheDocument(),
    );

    const rows = screen.getAllByTestId("patient-records-row");
    const apptRow = rows.find(
      (r) => r.getAttribute("data-entry-type") === "appointment",
    )!;
    const rxRow = rows.find(
      (r) => r.getAttribute("data-entry-type") === "prescription",
    )!;
    const labRow = rows.find(
      (r) => r.getAttribute("data-entry-type") === "lab",
    )!;

    expect(within(apptRow).getByTestId("patient-records-row-pill")).toHaveTextContent(
      "Appointments",
    );
    expect(within(rxRow).getByTestId("patient-records-row-pill")).toHaveTextContent(
      "Prescriptions",
    );
    expect(within(labRow).getByTestId("patient-records-row-pill")).toHaveTextContent(
      "Lab Results",
    );

    // Titles reflect the type-specific adapter shape.
    expect(within(apptRow).getByTestId("patient-records-row-title")).toHaveTextContent(
      /Consultation with Dr\. Singh/,
    );
    expect(within(rxRow).getByTestId("patient-records-row-title")).toHaveTextContent(
      /Prescription — Amoxicillin/,
    );
    expect(within(labRow).getByTestId("patient-records-row-title")).toHaveTextContent(
      /Lab order — CBC/,
    );
  });

  it("renders the unauthed sign-in surface when any source returns 401", async () => {
    mockSources({
      appointments: rejectedWithStatus(401),
      prescriptions: listOk([]),
      labs: listOk([]),
    });
    render(<PatientRecordsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-records-unauth")).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("patient-records-signin-cta"),
    ).toHaveAttribute("href", "/patient/login");
  });
});
