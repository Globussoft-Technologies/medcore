/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, routerPush, toastErrorMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerPush: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({
  toast: { error: toastErrorMock, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
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
    toastErrorMock.mockReset();
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

  // Issue #942: clicking Apply with an inverted custom range previously fanned
  // out 18 analytics endpoints and zeroed the Appointments + Revenue widgets.
  // The Apply handler must now toast and refuse to mutate the active range.
  it("rejects an inverted From > To range on Apply with a toast and no new fetch", async () => {
    asAdmin();
    render(<AnalyticsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /analytics dashboard/i })).toBeInTheDocument()
    );
    const fromInput = document.getElementById("analytics-filter-from") as HTMLInputElement;
    const toInput = document.getElementById("analytics-filter-to") as HTMLInputElement;
    // Date input onChanges set `pendingFrom`/`pendingTo` AND `setPreset("custom")`,
    // and the preset change re-runs the loadAll effect. Set the inputs first
    // and let those re-fetches settle, then clear so the assertion window only
    // sees what happens AFTER the user clicks Apply.
    fireEvent.change(fromInput, { target: { value: "2026-05-01" } });
    fireEvent.change(toInput, { target: { value: "2026-04-01" } });
    await waitFor(() =>
      expect(apiMock.get.mock.calls.some((c) => String(c[0]).startsWith("/analytics"))).toBe(true)
    );
    apiMock.get.mockClear();
    toastErrorMock.mockClear();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/must be on or before/i))
    );
    // Apply did NOT fan out the analytics endpoints — `from`/`to` stayed put.
    const analyticsFetchCalls = apiMock.get.mock.calls.filter((c) =>
      String(c[0]).startsWith("/analytics")
    );
    expect(analyticsFetchCalls).toHaveLength(0);
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
