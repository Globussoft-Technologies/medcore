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
  usePathname: () => "/dashboard/tenants/test-id/onboarding",
  useParams: () => ({ id: "test-id" }),
}));

import TenantOnboardingPage from "../tenants/[id]/onboarding/page";

const detail = {
  data: {
    id: "test-id",
    name: "St. Johns",
    subdomain: "stjohns",
    active: true,
    config: {
      hospital_name: "St. Johns",
      hospital_phone: "+919999999999",
      hospital_email: "info@stjohns.test",
      hospital_address: "Bangalore",
    },
  },
};

const onboardingResp = {
  data: {
    tenantId: "test-id",
    steps: { account_created: new Date().toISOString() },
  },
};

describe("TenantOnboardingPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerPush.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Tenant Onboarding heading for ADMIN", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/onboarding")) return Promise.resolve(onboardingResp);
      if (url.includes("/tenants/")) return Promise.resolve(detail);
      return Promise.resolve({ data: {} });
    });
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /tenant onboarding/i })
      ).toBeInTheDocument()
    );
  });

  it("renders all onboarding step rows", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/onboarding")) return Promise.resolve(onboardingResp);
      if (url.includes("/tenants/")) return Promise.resolve(detail);
      return Promise.resolve({ data: {} });
    });
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("tenant-onboarding-step-account_created")
      ).toBeInTheDocument()
    );
    expect(
      screen.getByTestId("tenant-onboarding-step-first_doctor")
    ).toBeInTheDocument();
  });

  it("renders progress bar element", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/onboarding"))
        return Promise.resolve({
          data: { tenantId: "test-id", steps: {} },
        });
      if (url.includes("/tenants/")) return Promise.resolve(detail);
      return Promise.resolve({ data: {} });
    });
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("tenant-onboarding-progress")
      ).toBeInTheDocument()
    );
  });

  it("keeps rendering and toasts when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalled()
    );
    expect(
      screen.getByRole("heading", { name: /tenant onboarding/i })
    ).toBeInTheDocument();
  });

  it("redirects non-ADMIN role away from page", async () => {
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u9", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard")
    );
  });
});
