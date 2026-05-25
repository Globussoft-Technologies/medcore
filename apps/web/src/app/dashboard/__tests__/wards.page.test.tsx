/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock, socketMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  socketMock: { connect: vi.fn(), disconnect: vi.fn(), emit: vi.fn(), on: vi.fn(), off: vi.fn(), connected: false },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/wards",
}));

import WardsPage from "../wards/page";

const sampleWards = [
  {
    id: "w1",
    name: "General Ward",
    type: "GENERAL",
    floor: "1",
    totalBeds: 10,
    availableBeds: 6,
    occupiedBeds: 3,
    cleaningBeds: 1,
    maintenanceBeds: 0,
    beds: [],
  },
];

describe("WardsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("renders Wards heading with empty data", async () => {
    render(<WardsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /wards/i })).toBeInTheDocument()
    );
  });

  it("renders populated ward list", async () => {
    apiMock.get.mockResolvedValue({ data: sampleWards });
    render(<WardsPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/General Ward/).length).toBeGreaterThan(0);
    });
  });

  it("shows loading state while fetching", async () => {
    let resolve: (v: any) => void = () => {};
    apiMock.get.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<WardsPage />);
    const loader = await screen.findByTestId("wards-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
    resolve({ data: [] });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<WardsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /wards/i })).toBeInTheDocument()
    );
  });

  it("fetches /wards endpoint on mount", async () => {
    render(<WardsPage />);
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/wards"))).toBe(true);
    });
  });

  // ── Issue #36: Add Bed dialog surfaces API 400 via toast.error ─────
  it("Add Bed submit with bad data shows toast.error with field-level details", async () => {
    const expandedWard = {
      ...sampleWards[0],
      beds: [],
    };
    apiMock.get.mockResolvedValue({ data: [expandedWard] });

    // Simulate the real API client error envelope: status=400, payload
    // carries `details` array. The addBed handler MUST stringify those
    // into the toast.
    const apiError = Object.assign(new Error("Validation failed"), {
      status: 400,
      payload: {
        error: "Validation failed",
        details: [{ field: "bedNumber", message: "String must contain at least 1 character(s)" }],
      },
    });
    apiMock.post.mockRejectedValue(apiError);

    render(<WardsPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/General Ward/).length).toBeGreaterThan(0);
    });

    const user = userEvent.setup();

    // Expand the ward so the per-ward "Add Bed" button shows up. Issue #719
    // (2026-05-08) added a top-level `add-bed-cta` button that ALSO carries
    // the same accessible name, so scope the query to the inline per-ward
    // testid to avoid an ambiguous role match.
    await user.click(screen.getByText(/General Ward/));

    const addBedBtn = await screen.findByTestId("add-bed-inline-w1");
    await user.click(addBedBtn);

    // Inline form appears — type something then submit to trigger the
    // API call (the server-side 400 is what we're simulating).
    const bedNumInput = await screen.findByPlaceholderText(/bed number/i);
    await user.type(bedNumInput, "X-1");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalled();
    });
    const msg = String(toastMock.error.mock.calls.at(-1)?.[0] ?? "");
    expect(msg).toMatch(/validation failed/i);
    expect(msg).toMatch(/bedNumber/);
  });
});
