/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, toastMock, routerPush } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  routerPush: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string) => fallback ?? _k,
    setLang: vi.fn(),
    lang: "en",
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/tenants",
}));

import TenantsAdminPage from "../tenants/page";

const tenants = [
  {
    id: "t1",
    name: "St. Johns",
    subdomain: "stjohns",
    plan: "PRO",
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: {
      userCount: 12,
      patientCount: 200,
      invoicesLast30Days: 80,
      storageBytes: 1024,
    },
  },
  {
    // Pearl §8.1 row 204 test — second tenant is intentionally OUTSIDE
    // the metrics rollup (no perTenant row for it). The page should
    // render `—` for its metrics-sourced KPIs that have no `stats`
    // fallback (Appts 7d).
    id: "t2",
    name: "Edge Clinic",
    subdomain: "edge",
    plan: "BASIC",
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: {
      userCount: 3,
      patientCount: 9,
      invoicesLast30Days: 0,
      storageBytes: 0,
    },
  },
];

const metricsResponse = {
  data: {
    totals: {
      tenants: 2,
      activeTenants: 2,
      users: 15,
      patients: 209,
      appointmentsLast7d: 18,
      invoicesLast30d: 84,
      campaignsActive: 0,
    },
    perTenant: [
      {
        tenantId: "t1",
        tenantName: "St. Johns",
        plan: "PRO",
        active: true,
        userCount: 12,
        patientCount: 200,
        appointmentsLast7d: 18,
        invoicesLast30d: 84,
        createdAt: new Date().toISOString(),
      },
    ],
  },
  error: null,
};

/**
 * Pearl §8.1 row 204 — route api.get calls by URL prefix so the
 * tenants list and metrics rollup can resolve independently.
 */
function routeApiGet(
  tenantsResult: { data: typeof tenants } | Error = { data: tenants },
  metricsResult:
    | { data: { perTenant: typeof metricsResponse.data.perTenant } }
    | Error
    | { delay: number } = metricsResponse,
) {
  apiMock.get.mockImplementation(async (url: string) => {
    if (url.startsWith("/super-admin/metrics")) {
      if (metricsResult instanceof Error) throw metricsResult;
      if ("delay" in metricsResult) {
        // Never-resolving promise to keep the cell in the loading
        // phase for the duration of the test.
        return new Promise(() => {});
      }
      return metricsResult;
    }
    if (tenantsResult instanceof Error) throw tenantsResult;
    return tenantsResult;
  });
}

describe("TenantsAdminPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerPush.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Tenants page testid for ADMIN", async () => {
    routeApiGet({ data: [] });
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenants-page")).toBeInTheDocument()
    );
  });

  it("renders populated tenant rows", async () => {
    routeApiGet();
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByText("St. Johns")).toBeInTheDocument()
    );
    expect(screen.getByText("stjohns")).toBeInTheDocument();
  });

  it("shows empty-state message when no tenants", async () => {
    routeApiGet({ data: [] });
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenants-empty")).toBeInTheDocument()
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenants-page")).toBeInTheDocument()
    );
  });

  it("redirects non-ADMIN role away from page", async () => {
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u9", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard")
    );
  });

  // ─── Pearl §8.1 row 204 — per-tenant KPI cells ───────────────────

  it("renders per-tenant KPI cells from /super-admin/metrics after fetch (Pearl §8.1 row 204)", async () => {
    routeApiGet();
    render(<TenantsAdminPage />);
    // Wait for the metrics fetch to land — the row populates with
    // values from perTenant rather than the per-tenant `stats` block.
    await waitFor(() =>
      expect(screen.getByTestId("tenant-kpi-appts7d-stjohns")).toHaveTextContent(
        "18",
      ),
    );
    expect(
      screen.getByTestId("tenant-kpi-users-stjohns"),
    ).toHaveTextContent("12");
    expect(
      screen.getByTestId("tenant-kpi-patients-stjohns"),
    ).toHaveTextContent("200");
    expect(
      screen.getByTestId("tenant-kpi-invoices30d-stjohns"),
    ).toHaveTextContent("84");
    // Verify the metrics endpoint was actually called.
    expect(apiMock.get).toHaveBeenCalledWith("/super-admin/metrics");
  });

  it("renders SkeletonText placeholder in KPI cells while metrics fetch is in-flight (Pearl §8.1 row 204)", async () => {
    routeApiGet({ data: tenants }, { delay: 1 });
    render(<TenantsAdminPage />);
    // Wait for tenant rows to land (tenants list resolves immediately).
    await waitFor(() =>
      expect(screen.getByText("St. Johns")).toBeInTheDocument(),
    );
    // The KPI cell is still in the loading phase — it renders a
    // skeleton placeholder (no numeric content) rather than the value.
    const apptsCell = screen.getByTestId("tenant-kpi-appts7d-stjohns");
    expect(apptsCell).toBeInTheDocument();
    // Skeleton renders a div with class `mc-skeleton` rather than text.
    expect(apptsCell.querySelector(".mc-skeleton")).not.toBeNull();
    expect(apptsCell.textContent?.trim()).toBe("");
  });

  it("renders em-dash for tenants beyond the top-20 metrics cap (Pearl §8.1 row 204)", async () => {
    routeApiGet();
    render(<TenantsAdminPage />);
    // Wait for metrics to finish so we are NOT seeing a loading
    // skeleton — `edge` tenant has no perTenant row, so its
    // Appts-7d cell (no `stats` fallback) renders an em-dash with
    // the explanatory tooltip.
    await waitFor(() =>
      expect(screen.getByTestId("tenant-kpi-appts7d-edge")).toHaveTextContent(
        "—",
      ),
    );
    const edgeApptsCell = screen.getByTestId("tenant-kpi-appts7d-edge");
    expect(edgeApptsCell.getAttribute("title")).toBe(
      "Metrics shown for top-20 tenants by user count",
    );
  });

  it("degrades to em-dash when metrics fetch fails but list still renders (Pearl §8.1 row 204)", async () => {
    routeApiGet({ data: tenants }, new Error("metrics 5xx"));
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenant-kpi-appts7d-stjohns")).toHaveTextContent(
        "—",
      ),
    );
    // The tenants list itself still renders despite the metrics
    // failure — the page degrades gracefully.
    expect(screen.getByText("St. Johns")).toBeInTheDocument();
  });

  // ─── Pearl §8.1 row 206 — per-row suspend/restore buttons ───────────

  it("renders the per-row Suspend button for an active tenant and POSTs /:id/deactivate on confirm (Pearl §8.1 row 206)", async () => {
    routeApiGet();
    apiMock.post.mockResolvedValue({ data: { id: "t1", active: false } });
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenant-row-suspend-stjohns")).toBeInTheDocument(),
    );
    // Restore button is NOT rendered while the tenant is active.
    expect(
      screen.queryByTestId("tenant-row-restore-stjohns"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tenant-row-suspend-stjohns"));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/tenants/t1/deactivate"),
    );
  });

  it("renders the per-row Restore button for a suspended tenant and POSTs /:id/restore on confirm (Pearl §8.1 row 206)", async () => {
    const suspended = [
      { ...tenants[0], active: false },
      tenants[1],
    ];
    routeApiGet({ data: suspended });
    apiMock.post.mockResolvedValue({ data: { id: "t1", active: true } });
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenant-row-restore-stjohns")).toBeInTheDocument(),
    );
    // Suspend button is NOT rendered for an inactive tenant.
    expect(
      screen.queryByTestId("tenant-row-suspend-stjohns"),
    ).not.toBeInTheDocument();
    // SUSPENDED badge renders for the inactive row.
    expect(
      screen.getByTestId("tenant-suspended-badge-stjohns"),
    ).toHaveTextContent("SUSPENDED");
    // The row carries the data-tenant-active="false" hook for the
    // desaturated row styling.
    expect(
      screen.getByTestId("tenant-row-stjohns").getAttribute("data-tenant-active"),
    ).toBe("false");

    fireEvent.click(screen.getByTestId("tenant-row-restore-stjohns"));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/tenants/t1/restore"),
    );
  });
});
