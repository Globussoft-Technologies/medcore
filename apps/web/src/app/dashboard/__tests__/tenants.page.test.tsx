/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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
];

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
    apiMock.get.mockResolvedValue({ data: [] });
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("tenants-page")).toBeInTheDocument()
    );
  });

  it("renders populated tenant rows", async () => {
    apiMock.get.mockResolvedValue({ data: tenants });
    render(<TenantsAdminPage />);
    await waitFor(() =>
      expect(screen.getByText("St. Johns")).toBeInTheDocument()
    );
    expect(screen.getByText("stjohns")).toBeInTheDocument();
  });

  it("shows empty-state message when no tenants", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
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
});
