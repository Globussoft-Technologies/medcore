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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/analytics/reports",
}));

import ReportsPage from "./page";

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asReception() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u2", name: "Rec", email: "r@x.com", role: "RECEPTION" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("ReportsPage (analytics builder)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerPush.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("smoke renders the Report Builder heading for ADMIN", async () => {
    asAdmin();
    render(<ReportsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /report builder/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the five built-in report-type buttons", async () => {
    asAdmin();
    render(<ReportsPage />);
    await waitFor(() =>
      expect(screen.getByText(/revenue report/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/appointments report/i)).toBeInTheDocument();
    expect(screen.getByText(/patient growth/i)).toBeInTheDocument();
    expect(screen.getByText(/ipd admissions/i)).toBeInTheDocument();
    expect(screen.getByText(/pharmacy dispensing/i)).toBeInTheDocument();
  });

  it("renders the empty-state message when revenue data is empty", async () => {
    asAdmin();
    apiMock.get.mockResolvedValue({ data: [] });
    render(<ReportsPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no data for this configuration/i)
      ).toBeInTheDocument()
    );
  });

  it("renders rows when revenue endpoint returns sample data", async () => {
    asAdmin();
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/analytics/revenue"))
        return Promise.resolve({
          data: [
            {
              date: "2026-04-01",
              total: 1500,
              cash: 1500,
              card: 0,
              upi: 0,
              online: 0,
              insurance: 0,
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    render(<ReportsPage />);
    await waitFor(() =>
      expect(screen.getByText("2026-04-01")).toBeInTheDocument()
    );
  });

  it("redirects RECEPTION role to /dashboard/analytics", async () => {
    asReception();
    render(<ReportsPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard/analytics")
    );
  });

  it("keeps rendering when the analytics endpoint rejects", async () => {
    asAdmin();
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<ReportsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /report builder/i })
      ).toBeInTheDocument()
    );
  });
});
