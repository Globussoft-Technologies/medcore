/* eslint-disable @typescript-eslint/no-explicit-any */
// Lab Result Intelligence dashboard — Sprint 2.
// Pins down: role gate (DOCTOR ok, PATIENT redirects), KPI empty-state
// rendering, and the severity-filter → API-query wiring.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock, routerReplace } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  routerReplace: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: routerReplace,
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/lab-intel",
}));

import LabIntelPage from "../lab-intel/page";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const sampleAggregates = {
  criticalsThisWeek: 3,
  patientsWithTrendConcerns: 7,
  testsOutsideRefRange: 12,
  averageDeviationPct: 14.2,
};

const sampleCriticals = [
  {
    id: "lr1",
    patientId: "p1",
    patientName: "Asha Roy",
    testName: "Potassium",
    result: "6.4",
    unit: "mEq/L",
    referenceRange: "3.5-5.0",
    severity: "CRITICAL" as const,
    flaggedAt: new Date("2026-04-29T10:00:00Z").toISOString(),
    labOrderId: "lo1",
  },
];

function setRoute(url: string): URL {
  return new URL(url, "http://localhost/");
}

function makeMockGetForRoles(opts?: {
  aggregates?: any;
  criticals?: any[];
  deviations?: any[];
}) {
  return (url: string) => {
    if (url.startsWith("/ai/lab-intel/aggregates")) {
      return Promise.resolve({ data: opts?.aggregates ?? sampleAggregates });
    }
    if (url.startsWith("/ai/lab-intel/critical")) {
      return Promise.resolve({ data: opts?.criticals ?? sampleCriticals });
    }
    if (url.startsWith("/ai/lab-intel/deviations")) {
      return Promise.resolve({ data: opts?.deviations ?? [] });
    }
    return Promise.resolve({ data: [] });
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("LabIntelPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerReplace.mockReset();
    toastMock.error.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Dr Singh", email: "d@x.com", role: "DOCTOR" },
      token: "tok",
      isLoading: false,
    });
  });

  it("renders for a DOCTOR with header, KPI tiles, and a populated row", async () => {
    apiMock.get.mockImplementation(makeMockGetForRoles());
    render(<LabIntelPage />);

    await waitFor(() => {
      expect(screen.getByTestId("lab-intel-page")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /lab result intelligence/i })
      ).toBeInTheDocument();
    });

    // KPI tiles render with concrete numbers from the aggregates payload.
    await waitFor(() => {
      expect(screen.getByTestId("lab-intel-kpi-criticals")).toHaveTextContent(
        "3"
      );
      expect(screen.getByTestId("lab-intel-kpi-deviations")).toHaveTextContent(
        "7"
      );
    });

    // The critical-row link uses the row testid hook. DataTable renders the
    // row in BOTH the desktop table and the mobile card stack, so we use
    // getAllByTestId rather than getByTestId.
    await waitFor(() =>
      expect(screen.getAllByTestId("lab-intel-row-lr1").length).toBeGreaterThan(
        0
      )
    );
    expect(screen.getAllByText(/Asha Roy/i).length).toBeGreaterThan(0);

    // No redirect triggered for DOCTOR.
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("redirects PATIENT to /dashboard/not-authorized", async () => {
    authMock.mockReturnValue({
      user: { id: "p1", name: "Pat", email: "p@x.com", role: "PATIENT" },
      token: "tok",
      isLoading: false,
    });
    apiMock.get.mockImplementation(makeMockGetForRoles());

    render(<LabIntelPage />);

    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledTimes(1);
    });
    const target = String(routerReplace.mock.calls[0][0]);
    const u = setRoute(target);
    expect(u.pathname).toBe("/dashboard/not-authorized");
    expect(u.searchParams.get("from")).toBe("/dashboard/lab-intel");
    expect(toastMock.error).toHaveBeenCalled();
  });

  it("KPI tile shows 0 / em-dash when aggregates are empty", async () => {
    // Aggregates endpoint returns no useful payload — page should fall back
    // to the safe `0` default and never display NaN/undefined.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/ai/lab-intel/aggregates")) {
        return Promise.reject(new Error("503"));
      }
      if (url.startsWith("/ai/lab-intel/critical")) {
        return Promise.resolve({ data: [] });
      }
      if (url.startsWith("/ai/lab-intel/deviations")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: [] });
    });

    render(<LabIntelPage />);

    await waitFor(() => {
      const tile = screen.getByTestId("lab-intel-kpi-criticals");
      // Either the safe-default "0" or the unavailable "—" sentinel is fine.
      expect(tile.textContent).toMatch(/0|—/);
    });
    await waitFor(() =>
      expect(screen.getByTestId("lab-intel-empty")).toBeInTheDocument()
    );
  });

  it("changing the severity filter updates the API query", async () => {
    apiMock.get.mockImplementation(makeMockGetForRoles({ criticals: [] }));
    const user = userEvent.setup();
    render(<LabIntelPage />);

    // Wait for the initial load (no severity qs).
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.startsWith("/ai/lab-intel/critical"))).toBe(
        true
      );
    });
    apiMock.get.mockClear();

    // Apply CRITICAL filter.
    const sel = screen.getByTestId("lab-intel-severity") as HTMLSelectElement;
    await user.selectOptions(sel, "CRITICAL");

    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      const criticalCall = calls.find((u) =>
        u.startsWith("/ai/lab-intel/critical")
      );
      expect(criticalCall).toBeDefined();
      expect(criticalCall).toMatch(/severity=CRITICAL/);
    });
  });
});
