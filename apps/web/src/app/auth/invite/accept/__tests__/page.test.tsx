/* eslint-disable @typescript-eslint/no-explicit-any */
// Component tests for the staff invite-accept page — Pearl §8.2
// (gap row 213 closure, 2026-05-23).
//
// Covers:
//   - Loading → ready transition after GET /:token returns metadata.
//   - 410 from GET surfaces the invalid-invitation banner.
//   - Missing ?token surfaces the invalid-invitation banner without any
//     network call.
//   - Successful POST /:token/accept renders the done state.
//   - Server error response is shown on the form (state returns to ready).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { routerPush, searchParams } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchParams,
  usePathname: () => "/auth/invite/accept",
}));

import InviteAcceptPage from "../page";

const VALID_METADATA = {
  email: "newhire@example.com",
  role: "NURSE",
  tenantName: "Sunrise Hospital",
  expiresAt: "2026-05-26T10:00:00.000Z",
};

function mockFetchOnce(response: {
  ok: boolean;
  status: number;
  body: unknown;
}) {
  (global.fetch as any).mockResolvedValueOnce({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  });
}

describe("/auth/invite/accept — Pearl §8.2 staff-invite landing", () => {
  beforeEach(() => {
    routerPush.mockReset();
    (global.fetch as any) = vi.fn();
    // Reset the shared params object — set the token to the canonical
    // fixture by default; individual tests can override.
    Array.from(searchParams.keys()).forEach((k) => searchParams.delete(k));
    searchParams.set("token", "a".repeat(64));
  });

  it("renders metadata after the GET resolves with the invite shape", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      body: { success: true, data: VALID_METADATA, error: null },
    });
    render(<InviteAcceptPage />);
    expect(screen.getByTestId("invite-loading")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("invite-metadata")).toBeInTheDocument();
    });
    expect(screen.getByTestId("invite-email").textContent).toBe(
      "newhire@example.com",
    );
    expect(screen.getByTestId("invite-role").textContent).toBe("NURSE");
    expect(screen.getByTestId("invite-tenant").textContent).toBe(
      "Sunrise Hospital",
    );
  });

  it("surfaces the invalid-invitation banner on a 410 GET response", async () => {
    mockFetchOnce({
      ok: false,
      status: 410,
      body: {
        success: false,
        data: null,
        error: "Invite is invalid or has expired",
      },
    });
    render(<InviteAcceptPage />);
    await waitFor(() => {
      expect(screen.getByTestId("invite-invalid")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/invitation link is invalid or has expired/i),
    ).toBeInTheDocument();
  });

  it("shows the invalid banner immediately when no ?token is present", async () => {
    searchParams.delete("token");
    render(<InviteAcceptPage />);
    expect(screen.getByTestId("invite-invalid")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("renders the done state and bounces to /login after a successful accept", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      body: { success: true, data: VALID_METADATA, error: null },
    });
    mockFetchOnce({
      ok: true,
      status: 200,
      body: {
        success: true,
        data: { userId: "u1", email: VALID_METADATA.email, role: "NURSE" },
        error: null,
      },
    });
    render(<InviteAcceptPage />);
    await waitFor(() => {
      expect(screen.getByTestId("invite-metadata")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("invite-password-input"), {
      target: { value: "Br0nzeFalc0n!" },
    });
    fireEvent.click(screen.getByTestId("invite-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("invite-done")).toBeInTheDocument();
    });
    // The redirect fires 1200ms after the done state via real setTimeout;
    // waitFor polls until router.push is invoked or times out.
    await waitFor(
      () => {
        expect(routerPush).toHaveBeenCalledWith("/login?invited=1");
      },
      { timeout: 3000 },
    );
  });

  it("renders the server error and keeps the form when accept POST fails", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      body: { success: true, data: VALID_METADATA, error: null },
    });
    mockFetchOnce({
      ok: false,
      status: 400,
      body: {
        success: false,
        data: null,
        error: "This password is too common — please choose a less predictable password",
      },
    });
    render(<InviteAcceptPage />);
    await waitFor(() => {
      expect(screen.getByTestId("invite-metadata")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("invite-password-input"), {
      target: { value: "password1234" },
    });
    fireEvent.click(screen.getByTestId("invite-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("invite-error")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/too common/i),
    ).toBeInTheDocument();
    // Still on the form (not "done").
    expect(screen.queryByTestId("invite-done")).not.toBeInTheDocument();
  });
});
