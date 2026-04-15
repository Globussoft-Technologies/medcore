/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, routerReplace } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerReplace: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/admin-console",
}));

import AdminConsolePage from "../admin-console/page";

function defaultGet(url: string) {
  if (url.includes("/analytics/overview"))
    return {
      data: {
        newPatients: 12,
        admissions: 4,
        discharges: 2,
        surgeries: 1,
        erCases: 3,
        totalRevenue: 50000,
      },
    };
  if (url.includes("/complaints")) return { data: [] };
  if (url.includes("/pharmacy/inventory?lowStock"))
    return { meta: { total: 2 } };
  if (url.includes("/pharmacy/inventory?expiring"))
    return { meta: { total: 1 } };
  if (url.includes("/bloodbank/inventory/summary")) return { data: [] };
  if (url.includes("/audit")) return { meta: { total: 0 } };
  if (url.includes("/leaves")) return { data: [] };
  if (url.includes("/expenses")) return { data: [] };
  if (url.includes("/purchase-orders")) return { data: [] };
  if (url.includes("/wards")) return { data: [] };
  if (url.includes("/hr/duty-roster")) return { data: [] };
  if (url.includes("/surgery")) return { data: [] };
  if (url.includes("/users")) return { data: [] };
  return { data: [] };
}

describe("AdminConsolePage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerReplace.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      isLoading: false,
    });
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(defaultGet(url))
    );
    // Real fetch for /api/health used in admin-console
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    document.documentElement.classList.remove("dark");
  });

  it("renders the Admin Console heading for admin user", async () => {
    render(<AdminConsolePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /admin console/i })
      ).toBeInTheDocument()
    );
  });

  it("renders KPI card headings (System Health, Critical Alerts, Today Snapshot)", async () => {
    render(<AdminConsolePage />);
    await waitFor(() => {
      expect(screen.getByText(/system health/i)).toBeInTheDocument();
      expect(screen.getByText(/critical alerts/i)).toBeInTheDocument();
      expect(screen.getByText(/today snapshot/i)).toBeInTheDocument();
    });
  });

  it("handles grouped /hr/duty-roster response without crashing", async () => {
    // Regression guard for the recent grouped-roster fix.
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/hr/duty-roster"))
        return Promise.resolve({
          data: {
            groups: [
              { role: "DOCTOR", users: [{ id: "u2", name: "Doc" }] },
            ],
          },
        });
      return Promise.resolve(defaultGet(url));
    });
    render(<AdminConsolePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /admin console/i })
      ).toBeInTheDocument()
    );
  });

  it("shows the restricted message for non-admin users", async () => {
    authMock.mockReturnValue({
      user: { id: "u2", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      isLoading: false,
    });
    render(<AdminConsolePage />);
    expect(
      screen.getByText(/admin console restricted to administrators/i)
    ).toBeInTheDocument();
  });

  it("redirects non-admin users via router.replace", async () => {
    authMock.mockReturnValue({
      user: { id: "u2", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      isLoading: false,
    });
    render(<AdminConsolePage />);
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("continues rendering when health check fetch throws", async () => {
    (globalThis as any).fetch = vi.fn(() => Promise.reject(new Error("down")));
    render(<AdminConsolePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /admin console/i })
      ).toBeInTheDocument()
    );
  });
});
