/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/predictions",
}));

import PredictionsPage from "./page";

const samplePredictions = [
  {
    appointmentId: "a1",
    riskScore: 0.82,
    riskLevel: "high" as const,
    factors: ["History of no-shows", "Long wait"],
    recommendation: "Call to confirm",
    appointment: {
      id: "a1",
      slotStart: "09:00",
      slotEnd: "09:15",
      date: "2026-04-23",
      patientName: "Ravi Kumar",
      patientId: "p1",
      doctorName: "Dr. Singh",
      doctorId: "d1",
    },
  },
  {
    appointmentId: "a2",
    riskScore: 0.15,
    riskLevel: "low" as const,
    factors: [],
    recommendation: "No action",
    appointment: {
      id: "a2",
      slotStart: "10:00",
      slotEnd: "10:15",
      date: "2026-04-23",
      patientName: "Asha Patel",
      patientId: "p2",
      doctorName: "Dr. Gupta",
      doctorId: "d2",
    },
  },
];

describe("PredictionsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", role: "ADMIN" }, token: "tok" };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders the header and initial prompt before any load", () => {
    render(<PredictionsPage />);
    expect(
      screen.getByRole("heading", { name: /no-show predictions/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/select a date and click/i)
    ).toBeInTheDocument();
  });

  it("shows the spinner while the request is in flight", async () => {
    let resolveFn: (v: any) => void = () => {};
    apiMock.get.mockImplementation(() => new Promise((r) => (resolveFn = r)));
    const user = userEvent.setup();
    const { container } = render(<PredictionsPage />);
    await user.click(screen.getByRole("button", { name: /load predictions/i }));
    await waitFor(() => {
      // The spinner uses animate-spin class
      expect(container.querySelector(".animate-spin")).not.toBeNull();
    });
    resolveFn({ success: true, data: [] });
  });

  it("loads predictions and renders the summary + table", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: samplePredictions });
    const user = userEvent.setup();
    render(<PredictionsPage />);
    await user.click(screen.getByRole("button", { name: /load predictions/i }));
    await waitFor(() => {
      expect(screen.getByText("Ravi Kumar")).toBeInTheDocument();
      expect(screen.getByText("Asha Patel")).toBeInTheDocument();
      // high-risk count = 1
      expect(screen.getByText(/high risk/i)).toBeInTheDocument();
    });
  });

  it("renders the empty-state card when the API returns zero rows", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    const user = userEvent.setup();
    render(<PredictionsPage />);
    await user.click(screen.getByRole("button", { name: /load predictions/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/no booked appointments found for this date/i)
      ).toBeInTheDocument()
    );
  });

  it("shows the error banner when the endpoint rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("Server error"));
    const user = userEvent.setup();
    render(<PredictionsPage />);
    await user.click(screen.getByRole("button", { name: /load predictions/i }));
    await waitFor(() =>
      expect(screen.getByText(/server error/i)).toBeInTheDocument()
    );
  });

  it("includes the selected date in the request URL", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    const user = userEvent.setup();
    render(<PredictionsPage />);
    await user.click(screen.getByRole("button", { name: /load predictions/i }));
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(
        urls.some((u) => u.includes("/ai/predictions/no-show/batch?date="))
      ).toBe(true);
    });
  });
});
