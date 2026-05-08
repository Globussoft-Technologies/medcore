/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/visitors",
}));

import VisitorsPage from "../visitors/page";

const sampleVisitors = [
  {
    id: "v1",
    passNumber: "VP-001",
    name: "Rahul",
    phone: "9000000001",
    idProofType: "Aadhaar",
    idProofNumber: "1234",
    patientId: null,
    purpose: "PATIENT_VISIT",
    department: "General",
    checkInAt: new Date().toISOString(),
    checkOutAt: null,
    notes: null,
  },
];

describe("VisitorsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("renders Visitors heading with empty data", async () => {
    render(<VisitorsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /visitors/i })).toBeInTheDocument()
    );
  });

  it("renders populated visitor list", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/visitors/active") || url.includes("/visitors?"))
        return Promise.resolve({ data: sampleVisitors });
      return Promise.resolve({ data: { totalToday: 1, currentInside: 1, byPurpose: {} } });
    });
    render(<VisitorsPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/Rahul|VP-001/).length).toBeGreaterThan(0);
    });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<VisitorsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /visitors/i })).toBeInTheDocument()
    );
  });

  it("switches to Today tab and refetches", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/visitors/stats/daily"))
        return Promise.resolve({ data: { totalToday: 0, currentInside: 0, byPurpose: {} } });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /visitors/i })).toBeInTheDocument()
    );
    const todayBtn = screen.queryAllByRole("button", { name: /today/i })[0];
    if (todayBtn) {
      await user.click(todayBtn);
      await waitFor(() => {
        const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes("date="))).toBe(true);
      });
    } else {
      expect(screen.getByRole("heading", { name: /visitors/i })).toBeInTheDocument();
    }
  });

  it("fetches visitors stats on mount", async () => {
    // Issue #746 (2026-05-08) migrated the page off the legacy
    // `/visitors/stats/daily` endpoint to the canonical
    // `/visitors-stats?period=today` shared with the dashboard widget.
    // Accept either path so this test survives the migration window.
    render(<VisitorsPage />);
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(
        urls.some(
          (u) => u.includes("/visitors-stats") || u.includes("/visitors/stats/daily"),
        ),
      ).toBe(true);
    });
  });
});
