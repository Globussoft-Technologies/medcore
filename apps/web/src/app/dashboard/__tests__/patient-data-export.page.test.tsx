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
  usePathname: () => "/dashboard/patient-data-export",
}));

import PatientDataExportPage from "../patient-data-export/page";

describe("PatientDataExportPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerPush.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "p1", name: "Pat", email: "p@x.com", role: "PATIENT" },
        isLoading: false,
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Download My Data heading for PATIENT", async () => {
    render(<PatientDataExportPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /download my data/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the format radio options", async () => {
    render(<PatientDataExportPage />);
    await waitFor(() => screen.getByRole("heading", { name: /download my data/i }));
    expect(screen.getAllByRole("radio").length).toBeGreaterThanOrEqual(3);
  });

  it("shows 'No exports yet' empty state initially", async () => {
    render(<PatientDataExportPage />);
    await waitFor(() =>
      expect(screen.getByText(/no exports yet/i)).toBeInTheDocument()
    );
  });

  it("renders Request export button", async () => {
    render(<PatientDataExportPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /request export/i })
      ).toBeInTheDocument()
    );
  });

  it("redirects non-PATIENT role away from page", async () => {
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Doc", email: "d@x.com", role: "DOCTOR" },
        isLoading: false,
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    render(<PatientDataExportPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard")
    );
  });
});
