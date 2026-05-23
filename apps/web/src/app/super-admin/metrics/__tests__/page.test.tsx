/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for /super-admin/metrics — Pearl §8.4 (gap rows 219 + 220).
//
// Covers:
//   - 7 stat cards render with mocked totals values.
//   - 2 perTenant rows render in the table with name + plan + counts.
//   - Sort toggle on userCount reverses the row order.
//   - API 403 path surfaces as an inline error alert.
//
// fetch is stubbed at the global level so the page can be unit-tested
// without the real API.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const sampleResponse = {
  success: true,
  data: {
    totals: {
      tenants: 4,
      activeTenants: 3,
      users: 128,
      patients: 942,
      appointmentsLast7d: 57,
      invoicesLast30d: 211,
      campaignsActive: 6,
    },
    perTenant: [
      {
        tenantId: "t-1",
        tenantName: "Alpha Hospital",
        plan: "PRO",
        active: true,
        userCount: 80,
        patientCount: 600,
        appointmentsLast7d: 30,
        invoicesLast30d: 150,
        createdAt: new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString(),
      },
      {
        tenantId: "t-2",
        tenantName: "Beta Clinic",
        plan: "BASIC",
        active: false,
        userCount: 20,
        patientCount: 200,
        appointmentsLast7d: 5,
        invoicesLast30d: 30,
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString(),
      },
    ],
  },
  error: null,
};

const fetchMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({}),
}));

function mockOk() {
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => sampleResponse,
  }));
}

beforeEach(() => {
  fetchMock.mockReset();
  mockOk();
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

import SuperAdminMetricsPage from "../page";

describe("Super-admin /super-admin/metrics page — Pearl §8.4", () => {
  it("renders all 7 stat cards with mocked totals values", async () => {
    render(<SuperAdminMetricsPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-metrics-value-tenants").textContent,
      ).toContain("4");
    });
    const expectedKeys: Array<[string, string]> = [
      ["tenants", "4"],
      ["activeTenants", "3"],
      ["users", "128"],
      ["patients", "942"],
      ["appointmentsLast7d", "57"],
      ["invoicesLast30d", "211"],
      ["campaignsActive", "6"],
    ];
    for (const [k, v] of expectedKeys) {
      const el = screen.getByTestId(`super-admin-metrics-value-${k}`);
      expect(el).toBeInTheDocument();
      expect(el.textContent).toContain(v);
    }
    expect(
      screen.getAllByTestId(/^super-admin-metrics-card-/).length,
    ).toBe(7);
  });

  it("renders both perTenant rows with name + plan badge", async () => {
    render(<SuperAdminMetricsPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-metrics-row-t-1"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("super-admin-metrics-row-t-2"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("super-admin-metrics-plan-t-1").textContent,
    ).toMatch(/PRO/);
    expect(
      screen.getByTestId("super-admin-metrics-plan-t-2").textContent,
    ).toMatch(/BASIC/);
    expect(
      screen.getByTestId("super-admin-metrics-count-summary").textContent,
    ).toMatch(/2 tenants shown/);
  });

  it("toggling sort on userCount reverses the row order", async () => {
    render(<SuperAdminMetricsPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-metrics-row-t-1"),
      ).toBeInTheDocument();
    });
    // Default sort is userCount desc → Alpha (80) first, Beta (20) second.
    const initialRows = screen.getAllByTestId(/^super-admin-metrics-row-/);
    expect(initialRows[0]!.getAttribute("data-testid")).toBe(
      "super-admin-metrics-row-t-1",
    );

    // Click the userCount sort button → flips to asc, so Beta (20) first.
    fireEvent.click(
      screen.getByTestId("super-admin-metrics-sort-userCount"),
    );
    await waitFor(() => {
      const after = screen.getAllByTestId(/^super-admin-metrics-row-/);
      expect(after[0]!.getAttribute("data-testid")).toBe(
        "super-admin-metrics-row-t-2",
      );
    });
  });

  it("surfaces an API failure as an inline error alert", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        data: null,
        error: "Only super-admins can view cross-tenant metrics",
      }),
    }));
    render(<SuperAdminMetricsPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-metrics-error").textContent,
      ).toMatch(/super-admins/i);
    });
  });
});
