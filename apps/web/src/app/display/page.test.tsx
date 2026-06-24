/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
  })),
}));

// next/navigation: the page reads useSearchParams() (?scoped=) and useRouter()
// (Esc / close → /dashboard). `searchParamsValue` is mutable so individual
// tests can flip the page into scoped mode.
let searchParamsValue = new URLSearchParams("");
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsValue,
  useRouter: () => ({ push: pushMock }),
}));

// The scoped board fetches via the api helper; the public board uses fetch.
const apiGetMock = vi.fn(
  async (..._args: any[]): Promise<{ success: boolean; data: any[] }> => ({
    success: true,
    data: [],
  }),
);
vi.mock("@/lib/api", () => ({
  api: { get: (...args: any[]) => apiGetMock(...args) },
}));

import TokenDisplayPage from "./page";

describe("TokenDisplayPage", () => {
  beforeEach(() => {
    searchParamsValue = new URLSearchParams("");
    pushMock.mockReset();
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({ success: true, data: [] });
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("renders the hospital name in the header", async () => {
    render(<TokenDisplayPage />);
    await waitFor(() =>
      expect(screen.getByText(/medcore hospital/i)).toBeInTheDocument()
    );
  });

  it("renders 'No doctors on duty today' empty state", async () => {
    render(<TokenDisplayPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no doctors on duty today/i)
      ).toBeInTheDocument()
    );
  });

  it("renders populated doctor cards", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              doctorId: "d1",
              doctorName: "Asha Gupta",
              specialization: "Cardiology",
              currentToken: 7,
              waitingCount: 3,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    render(<TokenDisplayPage />);
    await waitFor(() =>
      expect(screen.getByText(/asha gupta/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/cardiology/i)).toBeInTheDocument();
  });

  it("falls back gracefully and surfaces offline state when fetch fails", async () => {
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    render(<TokenDisplayPage />);
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(screen.getAllByText(/offline/i).length).toBeGreaterThan(0);
  });

  it("renders the auto-refresh footer hint", async () => {
    render(<TokenDisplayPage />);
    await waitFor(() =>
      expect(screen.getByText(/token display board/i)).toBeInTheDocument()
    );
  });

  it("public (unscoped) board has NO close button and uses the public fetch", async () => {
    render(<TokenDisplayPage />);
    await waitFor(() =>
      expect(screen.getByText(/medcore hospital/i)).toBeInTheDocument()
    );
    expect(screen.queryByTestId("display-close-button")).toBeNull();
    expect((globalThis as any).fetch).toHaveBeenCalled();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("scoped board fetches the tenant-scoped /queue via the api helper, shows a close button, and Esc returns to the dashboard", async () => {
    searchParamsValue = new URLSearchParams("scoped=1");
    apiGetMock.mockResolvedValue({
      success: true,
      data: [
        {
          doctorId: "d1",
          doctorName: "Asha Gupta",
          specialization: "Cardiology",
          currentToken: 7,
          waitingCount: 3,
        },
      ],
    });
    render(<TokenDisplayPage />);
    await waitFor(() =>
      expect(screen.getByText(/asha gupta/i)).toBeInTheDocument()
    );
    // Tenant-scoped path: api.get("/queue") fired, raw public fetch did not.
    expect(apiGetMock).toHaveBeenCalledWith("/queue");
    // Close button present; clicking it returns to the dashboard.
    const close = screen.getByTestId("display-close-button");
    close.click();
    expect(pushMock).toHaveBeenCalledWith("/dashboard");
    // Esc also returns to the dashboard.
    pushMock.mockReset();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(pushMock).toHaveBeenCalledWith("/dashboard");
  });
});
