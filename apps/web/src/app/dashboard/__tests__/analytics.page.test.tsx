/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, routerPush } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/analytics",
}));

import AnalyticsPage from "../analytics/page";

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asPatient() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u3", name: "Pat", email: "p@x.com", role: "PATIENT" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("AnalyticsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerPush.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("smoke renders the Analytics Dashboard heading for ADMIN", async () => {
    asAdmin();
    render(<AnalyticsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /analytics dashboard/i })
      ).toBeInTheDocument()
    );
  });

  it("calls a representative subset of analytics endpoints on mount", async () => {
    asAdmin();
    render(<AnalyticsPage />);
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/analytics/overview"))).toBe(true);
      expect(urls.some((u) => u.includes("/analytics/appointments"))).toBe(
        true
      );
      expect(urls.some((u) => u.includes("/analytics/revenue"))).toBe(true);
    });
  });

  it("keeps rendering even when every analytics endpoint rejects", async () => {
    asAdmin();
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<AnalyticsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /analytics dashboard/i })
      ).toBeInTheDocument()
    );
  });

  it("redirects PATIENT role away from the page", async () => {
    asPatient();
    render(<AnalyticsPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("does not crash on empty data from every endpoint", async () => {
    asAdmin();
    apiMock.get.mockResolvedValue({ data: [] });
    render(<AnalyticsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /analytics dashboard/i })
      ).toBeInTheDocument()
    );
  });
});
