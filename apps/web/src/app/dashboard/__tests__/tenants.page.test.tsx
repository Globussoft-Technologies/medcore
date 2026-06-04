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
    // The page fetches the dynamic plan catalog for the filter + create
    // dropdowns. Return an empty catalog so tenant names don't leak into the
    // filter <option>s (and list cells fall back to the raw plan key, as
    // before the dynamic-plans change).
    if (url.startsWith("/platform-billing/plans")) {
      return { data: [] };
    }
    if (tenantsResult instanceof Error) throw tenantsResult;
    return tenantsResult;
  });
}

describe("TenantsAdminPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
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
    // Subdomain column was removed from the operator UI (we now
    // auto-derive the slug from Hospital Name on create and never show
    // it in the list). Use the row-level testid as a stable anchor that
    // proves the row rendered without depending on the removed cell.
    expect(screen.getByTestId("tenant-row-stjohns")).toBeInTheDocument();
    expect(screen.getByTestId("tenant-row-edge")).toBeInTheDocument();
  });

  it("does NOT render the Subdomain column or any subdomain text in the list (post-2026-05-27 UI scrub)", async () => {
    routeApiGet();
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByText("St. Johns")).toBeInTheDocument(),
    );
    // The slug used to render as `stjohns` in a mono-font cell. After
    // the scrub there's no Subdomain header, no cell text, and the
    // search hint no longer mentions subdomain.
    expect(screen.queryByText("stjohns")).not.toBeInTheDocument();
    expect(screen.queryByText("Subdomain")).not.toBeInTheDocument();
    const search = screen.getByTestId("tenants-search") as HTMLInputElement;
    expect(search.placeholder).not.toMatch(/subdomain/i);
    expect(search.placeholder).toMatch(/name/i);
  });

  it("Create Tenant modal renders without a Subdomain input and POSTs an auto-derived slug (post-2026-05-27 UI scrub)", async () => {
    routeApiGet({ data: [] });
    apiMock.post.mockResolvedValue({
      data: { tenant: { id: "new-id" } },
    });
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenants-empty")).toBeInTheDocument(),
    );

    // Open the create modal.
    fireEvent.click(screen.getByTestId("tenants-create-open"));
    await waitFor(() =>
      expect(screen.getByTestId("tenants-create-modal")).toBeInTheDocument(),
    );

    // The subdomain input must not exist anywhere in the modal.
    expect(
      screen.queryByTestId("tenants-create-subdomain"),
    ).not.toBeInTheDocument();

    // Fill in only the user-visible fields.
    fireEvent.change(screen.getByTestId("tenants-create-name"), {
      target: { value: "Apollo Mumbai" },
    });
    fireEvent.change(screen.getByTestId("tenants-create-admin-name"), {
      target: { value: "Dr. Alice" },
    });
    fireEvent.change(screen.getByTestId("tenants-create-admin-email"), {
      target: { value: "alice@apollo.com" },
    });
    fireEvent.change(screen.getByTestId("tenants-create-admin-password"), {
      target: { value: "TempPass123" },
    });

    fireEvent.click(screen.getByTestId("tenants-create-submit"));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());

    // The POST body must still carry a `subdomain` (backend requires it),
    // and it must be derived from the Hospital Name via the local slugify
    // (spaces → hyphens, lowercase, alnum + hyphen only).
    const [path, body] = apiMock.post.mock.calls[0] as [string, any];
    expect(path).toBe("/tenants");
    expect(body.name).toBe("Apollo Mumbai");
    expect(body.subdomain).toBe("apollo-mumbai");
    expect(body.adminEmail).toBe("alice@apollo.com");
  });

  it("Create Tenant modal slugifies edge characters into a valid subdomain (post-2026-05-27 UI scrub)", async () => {
    routeApiGet({ data: [] });
    apiMock.post.mockResolvedValue({
      data: { tenant: { id: "new-id-2" } },
    });
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenants-empty")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("tenants-create-open"));
    await waitFor(() =>
      expect(screen.getByTestId("tenants-create-modal")).toBeInTheDocument(),
    );

    // Punctuation + multiple spaces must collapse to single hyphens and
    // be stripped at the edges.
    fireEvent.change(screen.getByTestId("tenants-create-name"), {
      target: { value: "  St. John's Medical Center!! " },
    });
    fireEvent.change(screen.getByTestId("tenants-create-admin-name"), {
      target: { value: "Dr. Bob" },
    });
    fireEvent.change(screen.getByTestId("tenants-create-admin-email"), {
      target: { value: "bob@stjohns.com" },
    });
    fireEvent.change(screen.getByTestId("tenants-create-admin-password"), {
      target: { value: "TempPass123" },
    });
    fireEvent.click(screen.getByTestId("tenants-create-submit"));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());

    const body = (apiMock.post.mock.calls[0] as [string, any])[1];
    expect(body.subdomain).toBe("st-john-s-medical-center");
    // No leading/trailing hyphen, no double hyphens.
    expect(body.subdomain).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(body.subdomain).not.toMatch(/--/);
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

  // ─── Pearl §8.2 row 212 — per-tenant idle session timeout ─────────

  it("PATCHes /tenants/:id with sessionIdleMinutes when the drawer Save button is clicked (Pearl §8.2 row 212)", async () => {
    routeApiGet();
    // Detail fetch — the drawer reads `detail.sessionIdleMinutes`
    // to seed the controlled input.
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/super-admin/metrics")) return metricsResponse;
      if (url === "/tenants/t1") {
        return {
          data: {
            ...tenants[0],
            sessionIdleMinutes: 30,
            admins: [],
            config: {},
          },
        };
      }
      return { data: tenants };
    });
    apiMock.patch.mockResolvedValue({
      data: { ...tenants[0], sessionIdleMinutes: 60 },
    });

    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenant-detail-stjohns")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("tenant-detail-stjohns"));

    // Drawer opens, input seeded with persisted value after the
    // detail fetch resolves.
    await waitFor(() =>
      expect(
        (screen.getByTestId("tenants-detail-session-idle-input") as HTMLInputElement)
          .value,
      ).toBe("30"),
    );
    const input = screen.getByTestId("tenants-detail-session-idle-input");

    // Save button starts disabled (no diff yet).
    expect(
      (screen.getByTestId("tenants-detail-session-idle-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Type a new value → save unlocks → click → PATCH fires.
    fireEvent.change(input, { target: { value: "60" } });
    expect(
      (screen.getByTestId("tenants-detail-session-idle-save") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByTestId("tenants-detail-session-idle-save"));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/tenants/t1", {
        sessionIdleMinutes: 60,
      }),
    );
  });

  it("disables the Save button + shows an error when the idle-timeout value is out of range (Pearl §8.2 row 212)", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/super-admin/metrics")) return metricsResponse;
      if (url === "/tenants/t1") {
        return {
          data: {
            ...tenants[0],
            sessionIdleMinutes: 30,
            admins: [],
            config: {},
          },
        };
      }
      return { data: tenants };
    });

    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenant-detail-stjohns")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("tenant-detail-stjohns"));

    const input = await screen.findByTestId(
      "tenants-detail-session-idle-input",
    );
    // Wait for the /tenants/t1 detail fetch to settle so the drawer's
    // detail-load effect has already seeded the draft to the loaded value (30).
    // Otherwise, under full-suite load, that fetch can resolve AFTER we type
    // below and clobber the edited value — clearing the error (flaky).
    await waitFor(() => expect(input).toHaveValue(30));

    // Below floor (5) → error + Save stays disabled.
    fireEvent.change(input, { target: { value: "4" } });
    await waitFor(() =>
      expect(
        screen.getByTestId("tenants-detail-session-idle-error"),
      ).toHaveTextContent("Minimum 5 minutes"),
    );
    expect(
      (screen.getByTestId("tenants-detail-session-idle-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Above ceiling (1440) → error.
    fireEvent.change(input, { target: { value: "2000" } });
    await waitFor(() =>
      expect(
        screen.getByTestId("tenants-detail-session-idle-error"),
      ).toHaveTextContent("Maximum 1440 minutes (24 h)"),
    );
    expect(
      (screen.getByTestId("tenants-detail-session-idle-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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
