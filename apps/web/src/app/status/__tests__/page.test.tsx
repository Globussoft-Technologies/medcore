/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for /status — Pearl ERP Stage 1 §8.4 (gap row 221 closure).
//
// Covers:
//   - The overall status pill renders with the right headline.
//   - All 5 components from the mocked response appear with status pills.
//   - The "No scheduled maintenance." empty state renders when the
//     maintenanceWindows array is empty.
//   - The manual Refresh button uses a 44px touch target (h-11
//     implied via `.touch-target`).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const samplePayload = {
  service: "MedCore",
  status: "operational",
  checkedAt: "2026-05-23T10:00:00.000Z",
  components: [
    { name: "API", status: "operational" },
    { name: "Database", status: "operational", responseTimeMs: 8 },
    { name: "WhatsApp (Gupshup)", status: "degraded" },
    { name: "Razorpay", status: "operational" },
    { name: "ABDM Gateway", status: "degraded" },
  ],
  maintenanceWindows: [],
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => samplePayload,
  });
  vi.stubGlobal("fetch", fetchMock);
});

import StatusPage from "../page";

describe("/status (public)", () => {
  it("renders the headline + last-checked timestamp", async () => {
    render(<StatusPage />);
    await waitFor(() => {
      expect(screen.getByText(/All systems operational/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId("status-checked-at").textContent).not.toBe("—");
  });

  it("renders all 5 components with status pills", async () => {
    render(<StatusPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId("status-component")).toHaveLength(5);
    });
    // Each declared component name appears.
    expect(screen.getByText("API")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.getByText("WhatsApp (Gupshup)")).toBeInTheDocument();
    expect(screen.getByText("Razorpay")).toBeInTheDocument();
    expect(screen.getByText("ABDM Gateway")).toBeInTheDocument();
    // Response time surface for the DB row.
    expect(screen.getByText(/Response time: 8 ms/)).toBeInTheDocument();
  });

  it("renders the empty maintenance-windows state", async () => {
    render(<StatusPage />);
    await waitFor(() => {
      expect(screen.getByTestId("status-maintenance")).toBeInTheDocument();
    });
    expect(screen.getByText(/No scheduled maintenance\./i)).toBeInTheDocument();
  });

  it("Refresh CTA carries the .touch-target invariant", async () => {
    render(<StatusPage />);
    const btn = await screen.findByTestId("status-refresh");
    expect(btn.className).toContain("touch-target");
  });

  it("calls the public /api/v1/status endpoint (no auth header)", async () => {
    render(<StatusPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/status");
    // No Authorization header is set by the page.
    expect((opts as any)?.headers?.Authorization).toBeUndefined();
  });
});
