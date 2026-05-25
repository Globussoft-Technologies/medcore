/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pearl ERP Stage 1 §7.1 (gap row 183) — PatientCRMActivity component coverage.
 *
 * What / which modules / why:
 *   - Verifies the CRM-history timeline component that renders on the doctor's
 *     patient-detail page:
 *       1. Fetches GET /leads/by-patient/:patientId on mount.
 *       2. Renders a skeleton with aria-busy while loading.
 *       3. Renders the lead source pill, created/converted dates, assignee
 *          row, and last-5 activities timeline on a successful fetch.
 *       4. Renders the "no CRM history" empty-state when the API returns 404
 *          (the walk-in case — patient was not converted from a lead).
 *       5. Renders the error banner with role="alert" for non-404 failures.
 *       6. Caps the activity timeline at 5 rows even when the API returns more.
 *       7. Renders the "No activity recorded yet" sub-empty-state when the
 *          lead has zero activities.
 *       8. Hides itself entirely (returns null, no fetch) for PATIENT users.
 *       9. Each source value maps to its expected colour-pill class.
 *
 *   - Source under test: apps/web/src/components/PatientCRMActivity.tsx
 *   - Mocks @/lib/api (network) and @/lib/store (useAuthStore).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: {
    user: { id: "u1", role: "DOCTOR", name: "Dr Test" } as
      | { id: string; role: string; name: string }
      | null,
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({
  useAuthStore: () => ({ user: authMock.user }),
}));

import { PatientCRMActivity } from "../PatientCRMActivity";

const SAMPLE_LEAD = {
  id: "lead-1",
  name: "Aarav Mehta",
  source: "WHATSAPP",
  status: "CONVERTED",
  createdAt: "2026-04-01T10:00:00.000Z",
  convertedAt: "2026-04-15T12:30:00.000Z",
  notes: "Hot lead — wanted teleconsult",
  assignedToUser: { id: "sales-1", name: "Priya Sales", role: "RECEPTION" },
  activities: [
    {
      id: "act-1",
      type: "CALL_OUT",
      body: "Spoke about cardiology consult",
      createdAt: "2026-04-02T09:00:00.000Z",
      authorUser: { id: "sales-1", name: "Priya Sales", role: "RECEPTION" },
    },
    {
      id: "act-2",
      type: "EMAIL_OUT",
      body: "Sent appointment options",
      createdAt: "2026-04-05T14:30:00.000Z",
      authorUser: { id: "sales-1", name: "Priya Sales", role: "RECEPTION" },
    },
    {
      id: "act-3",
      type: "NOTE",
      body: null,
      createdAt: "2026-04-10T08:00:00.000Z",
      authorUser: null,
    },
  ],
};

describe("PatientCRMActivity (Pearl §7.1, gap row 183)", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    authMock.user = { id: "u1", role: "DOCTOR", name: "Dr Test" };
  });

  it("shows a skeleton with aria-busy=true while the fetch is in-flight", async () => {
    // Never-resolving promise keeps the component pinned in loading.
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<PatientCRMActivity patientId="pat-1" />);

    const skeleton = await screen.findByTestId("patient-crm-loading");
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveAttribute("aria-busy", "true");
  });

  it("fetches /leads/by-patient/:patientId and renders the source pill, dates, assignee, and activity timeline on success", async () => {
    apiMock.get.mockResolvedValue({ data: SAMPLE_LEAD });
    render(<PatientCRMActivity patientId="pat-1" />);

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/leads/by-patient/pat-1");
    });

    // Source pill — underscore is replaced with space.
    const sourcePill = await screen.findByTestId("patient-crm-source");
    expect(sourcePill).toHaveTextContent(/Source:\s*WHATSAPP/);

    // Assignee row.
    expect(screen.getByText(/Assigned to Priya Sales/)).toBeInTheDocument();

    // Converted-at row present.
    expect(screen.getByTestId("patient-crm-converted-at")).toBeInTheDocument();

    // Activity rows render — 3 here.
    const rows = await screen.findAllByTestId("patient-crm-activity-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(/CALL OUT/);
    expect(rows[0]).toHaveTextContent(/Spoke about cardiology consult/);
    expect(rows[0]).toHaveTextContent(/by Priya Sales/);

    // Row 3 has no body and no author — assert it still renders without those subtitles.
    expect(rows[2]).toHaveTextContent(/NOTE/);
    expect(rows[2]).not.toHaveTextContent(/by /);
  });

  it("renders the empty-state and NOT an error when the API returns a 404 (walk-in / no lead case)", async () => {
    apiMock.get.mockRejectedValue(new Error("Request failed with status 404 — No lead found"));
    render(<PatientCRMActivity patientId="pat-1" />);

    const empty = await screen.findByTestId("patient-crm-empty");
    expect(empty).toHaveTextContent(/No CRM history/i);
    expect(screen.queryByTestId("patient-crm-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("patient-crm-activities")).not.toBeInTheDocument();
  });

  it("renders the error banner with role=alert for non-404 failures", async () => {
    apiMock.get.mockRejectedValue(new Error("500 Internal Server Error"));
    render(<PatientCRMActivity patientId="pat-1" />);

    const err = await screen.findByTestId("patient-crm-error");
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveTextContent(/Could not load CRM history/i);
    expect(err).toHaveTextContent(/500 Internal Server Error/);
  });

  it("caps the activity timeline at 5 rows even when the API returns more", async () => {
    const manyActivities = Array.from({ length: 9 }).map((_, i) => ({
      id: `act-${i}`,
      type: "CALL_IN",
      body: `Activity body ${i}`,
      createdAt: "2026-04-02T09:00:00.000Z",
      authorUser: null,
    }));
    apiMock.get.mockResolvedValue({
      data: { ...SAMPLE_LEAD, activities: manyActivities },
    });
    render(<PatientCRMActivity patientId="pat-1" />);

    const rows = await screen.findAllByTestId("patient-crm-activity-row");
    expect(rows).toHaveLength(5);
  });

  it("renders the no-activities sub-empty-state when the lead has zero activities", async () => {
    apiMock.get.mockResolvedValue({
      data: { ...SAMPLE_LEAD, activities: [] },
    });
    render(<PatientCRMActivity patientId="pat-1" />);

    const noAct = await screen.findByTestId("patient-crm-no-activities");
    expect(noAct).toHaveTextContent(/No activity recorded yet/i);
    expect(screen.queryByTestId("patient-crm-activities")).not.toBeInTheDocument();
  });

  it("hides converted-at row when the lead has no convertedAt date", async () => {
    apiMock.get.mockResolvedValue({
      data: { ...SAMPLE_LEAD, convertedAt: null },
    });
    render(<PatientCRMActivity patientId="pat-1" />);

    await screen.findByTestId("patient-crm-source");
    expect(screen.queryByTestId("patient-crm-converted-at")).not.toBeInTheDocument();
  });

  it("returns null (renders nothing, fires no fetch) for PATIENT users — PII / sales-context separation", async () => {
    authMock.user = { id: "u-pat", role: "PATIENT", name: "Patient X" };
    const { container } = render(<PatientCRMActivity patientId="pat-1" />);

    expect(container.firstChild).toBeNull();
    // Allow the effect to settle, then assert no fetch went out.
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders for ADMIN, RECEPTION, NURSE staff roles (each fetches the CRM endpoint)", async () => {
    for (const role of ["ADMIN", "RECEPTION", "NURSE"]) {
      cleanup();
      apiMock.get.mockReset();
      apiMock.get.mockResolvedValue({ data: SAMPLE_LEAD });
      authMock.user = { id: `u-${role}`, role, name: `User ${role}` };

      render(<PatientCRMActivity patientId="pat-1" />);
      await waitFor(() => {
        expect(apiMock.get).toHaveBeenCalledWith("/leads/by-patient/pat-1");
      });
      expect(await screen.findByTestId("patient-crm-history")).toBeInTheDocument();
    }
  });

  it.each([
    ["WEB", "bg-blue-100"],
    ["WHATSAPP", "bg-green-100"],
    ["PHONE", "bg-amber-100"],
    ["REFERRAL", "bg-purple-100"],
    ["CAMP", "bg-cyan-100"],
    ["GOOGLE_ADS", "bg-rose-100"],
    ["FACEBOOK_ADS", "bg-indigo-100"],
    ["WALK_IN", "bg-gray-100"],
    ["OTHER", "bg-gray-100"],
    ["UNKNOWN_SOURCE_FALLS_BACK_TO_OTHER", "bg-gray-100"],
  ])("maps source=%s to the expected colour-pill class %s", async (source, expectedClass) => {
    apiMock.get.mockResolvedValue({ data: { ...SAMPLE_LEAD, source } });
    render(<PatientCRMActivity patientId="pat-1" />);

    const pill = await screen.findByTestId("patient-crm-source");
    expect(pill.className).toContain(expectedClass);
  });

  it("re-fetches when patientId changes (effect dependency)", async () => {
    apiMock.get.mockResolvedValue({ data: SAMPLE_LEAD });
    const { rerender } = render(<PatientCRMActivity patientId="pat-1" />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/leads/by-patient/pat-1");
    });

    rerender(<PatientCRMActivity patientId="pat-2" />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/leads/by-patient/pat-2");
    });
    expect(apiMock.get).toHaveBeenCalledTimes(2);
  });
});
