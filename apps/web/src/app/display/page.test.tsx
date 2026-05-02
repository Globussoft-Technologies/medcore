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

import TokenDisplayPage from "./page";

describe("TokenDisplayPage", () => {
  beforeEach(() => {
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
});
