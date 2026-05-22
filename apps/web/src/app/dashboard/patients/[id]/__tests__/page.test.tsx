// Pearl ERP Stage 1 §7.1 (gap row 183) — CRM History section on the
// patient-detail page.
//
// What: vitest + RTL coverage for the PatientCRMActivity component
//       rendered by apps/web/src/app/dashboard/patients/[id]/page.tsx.
//       We test the component directly (not the 5k-line page) — the
//       existing detail-header.a11y.test.tsx file in this same directory
//       uses the same isolated-fixture pattern.
//
// Which modules:
//   - apps/web/src/components/PatientCRMActivity.tsx
//   - apps/web/src/app/dashboard/patients/[id]/page.tsx (renders it)
//   - apps/api/src/routes/leads.ts GET /leads/by-patient/:patientId
//
// Why: closes Pearl gap row 183. Asserts the four invariants the
//      doctor-facing surface must hold:
//        1. Renders Lead + activities for a converted patient.
//        2. Renders empty-state when no Lead links to the patient (404).
//        3. Hidden for PATIENT role (PII separation).
//        4. Source pill carries 44px min-height touch target.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Mock the api module BEFORE importing the component so the useEffect's
// fetch can be intercepted deterministically. Vitest hoists vi.mock() to
// the top of the file, but we re-assign the mock implementation per test.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn() },
}));

// Mock the auth store; tests set `currentRole` to drive role-gating.
let currentRole: string | null = "DOCTOR";
vi.mock("@/lib/store", () => ({
  useAuthStore: () => ({ user: currentRole ? { role: currentRole } : null }),
}));

import { api } from "@/lib/api";
import { PatientCRMActivity } from "@/components/PatientCRMActivity";

const mockedGet = vi.mocked(api.get);

const LEAD_FIXTURE = {
  id: "lead-1",
  name: "Aarav Sharma",
  source: "WHATSAPP",
  status: "CONVERTED",
  createdAt: "2026-04-10T09:30:00.000Z",
  convertedAt: "2026-04-15T11:00:00.000Z",
  notes: "Asked about pediatric package",
  assignedToUser: { id: "u-rec-1", name: "Rashmi (Reception)", role: "RECEPTION" },
  activities: [
    {
      id: "act-1",
      type: "CONVERSION",
      body: "Converted to patient MR000123",
      createdAt: "2026-04-15T11:00:00.000Z",
      authorUser: { id: "u-rec-1", name: "Rashmi (Reception)", role: "RECEPTION" },
    },
    {
      id: "act-2",
      type: "CALL",
      body: "Spoke for 3 min; sent pricing PDF on WhatsApp",
      createdAt: "2026-04-12T15:00:00.000Z",
      authorUser: { id: "u-rec-1", name: "Rashmi (Reception)", role: "RECEPTION" },
    },
    {
      id: "act-3",
      type: "STATUS_CHANGE",
      body: "NEW → QUALIFIED",
      createdAt: "2026-04-11T10:00:00.000Z",
      authorUser: null,
    },
  ],
};

describe("PatientCRMActivity — Pearl §7.1 gap row 183", () => {
  beforeEach(() => {
    mockedGet.mockReset();
    currentRole = "DOCTOR";
  });

  it("renders the CRM History section with source pill + dates + activities for a converted patient (DOCTOR view)", async () => {
    mockedGet.mockResolvedValueOnce({ data: LEAD_FIXTURE } as any);
    render(<PatientCRMActivity patientId="pat-1" />);

    // Section heading is present (visible to staff).
    expect(await screen.findByRole("heading", { name: /CRM History/i })).toBeInTheDocument();
    // Endpoint was hit with the by-patient path (static-before-dynamic
    // route per CLAUDE.md §14).
    expect(mockedGet).toHaveBeenCalledWith("/leads/by-patient/pat-1");

    // Source pill renders the lead source.
    const sourcePill = await screen.findByTestId("patient-crm-source");
    expect(sourcePill.textContent).toMatch(/WHATSAPP/);
    // Conversion date row renders.
    expect(screen.getByTestId("patient-crm-converted-at")).toBeInTheDocument();

    // Activities timeline renders rows for each LeadActivity.
    const rows = await screen.findAllByTestId("patient-crm-activity-row");
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toMatch(/CONVERSION/);
    expect(rows[1].textContent).toMatch(/CALL/);
    expect(rows[2].textContent).toMatch(/STATUS CHANGE/);
  });

  it("caps the activity list at 5 rows even when more are returned", async () => {
    const many = {
      ...LEAD_FIXTURE,
      activities: Array.from({ length: 8 }, (_, i) => ({
        id: `act-${i}`,
        type: "NOTE",
        body: `note ${i}`,
        createdAt: "2026-04-10T09:30:00.000Z",
        authorUser: null,
      })),
    };
    mockedGet.mockResolvedValueOnce({ data: many } as any);
    render(<PatientCRMActivity patientId="pat-1" />);
    const rows = await screen.findAllByTestId("patient-crm-activity-row");
    expect(rows.length).toBe(5);
  });

  it("renders the empty-state when no Lead links to the patient (404)", async () => {
    mockedGet.mockRejectedValueOnce(new Error("HTTP 404: No lead links to this patient"));
    render(<PatientCRMActivity patientId="pat-1" />);
    const empty = await screen.findByTestId("patient-crm-empty");
    expect(empty.textContent).toMatch(/not converted from a lead/i);
    // Section is still visible (just shows empty-state copy).
    expect(screen.getByRole("heading", { name: /CRM History/i })).toBeInTheDocument();
  });

  it("renders nothing for the PATIENT role (PII separation)", async () => {
    currentRole = "PATIENT";
    const { container } = render(<PatientCRMActivity patientId="pat-1" />);
    // No section heading + no fetch call — full short-circuit.
    expect(screen.queryByRole("heading", { name: /CRM History/i })).toBeNull();
    expect(mockedGet).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it("renders for ADMIN and RECEPTION roles too (full staff visibility)", async () => {
    for (const role of ["ADMIN", "RECEPTION"]) {
      currentRole = role;
      mockedGet.mockResolvedValueOnce({ data: LEAD_FIXTURE } as any);
      const { unmount } = render(<PatientCRMActivity patientId={`pat-${role}`} />);
      expect(await screen.findByRole("heading", { name: /CRM History/i })).toBeInTheDocument();
      unmount();
    }
  });

  it("source pill is a 44px-min-height touch target (mobile a11y)", async () => {
    mockedGet.mockResolvedValueOnce({ data: LEAD_FIXTURE } as any);
    render(<PatientCRMActivity patientId="pat-1" />);
    const pill = await screen.findByTestId("patient-crm-source");
    // The component pins `min-h-[44px]` on the pill so touch surfaces meet
    // the WCAG 2.5.5 target-size minimum on tablets at the bedside.
    expect(pill.className).toMatch(/min-h-\[44px\]/);
  });

  it("shows a loading skeleton while the fetch is pending", async () => {
    const deferred: { resolve?: (v: unknown) => void } = {};
    mockedGet.mockImplementationOnce(
      () => new Promise<unknown>((resolve) => {
        deferred.resolve = resolve;
      }) as Promise<{ data: unknown }>,
    );
    render(<PatientCRMActivity patientId="pat-1" />);
    expect(screen.getByTestId("patient-crm-loading")).toBeInTheDocument();
    // Resolve to clean up the pending promise.
    deferred.resolve?.({ data: LEAD_FIXTURE });
    await waitFor(() =>
      expect(screen.queryByTestId("patient-crm-loading")).toBeNull(),
    );
  });
});
