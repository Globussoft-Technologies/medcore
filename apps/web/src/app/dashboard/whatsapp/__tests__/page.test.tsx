// Smoke tests for /dashboard/whatsapp — Pearl §6.1 gap row 167 piece 3j-iii of 4.
//
// What / which modules / why:
//   - Asserts the reception inbox list page renders the filter chips,
//     the row count from the mocked API, the empty-state when the list
//     is empty, the not-allowed surface for PATIENT, and the 44px
//     touch-target invariant on every CTA.
//   - Covers apps/web/src/app/dashboard/whatsapp/page.tsx.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

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
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/whatsapp",
}));

import WhatsAppInboxPage from "../page";

function asRole(role: string) {
  authMock.mockImplementation((selector: any) => {
    const state = { user: { id: `u-${role}`, role, name: role, email: `${role}@x.com` } };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function row(overrides: Partial<any> = {}) {
  return {
    id: "c1",
    phone: "+919876543210",
    status: "OPEN",
    unreadCount: 2,
    lastMessageAt: new Date(Date.now() - 60_000).toISOString(),
    lastInboundAt: new Date(Date.now() - 60_000).toISOString(),
    assignedToUserId: null,
    patient: null,
    _count: { messages: 4 },
    ...overrides,
  };
}

describe("/dashboard/whatsapp — Pearl §6.1 piece 3j-iii (list)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.get.mockResolvedValue({ data: { conversations: [], nextCursor: null } });
  });

  it("renders the four filter chips (Open / All / Snoozed / Closed)", async () => {
    asRole("RECEPTION");
    render(<WhatsAppInboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-inbox-filters")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("wa-inbox-filter-open")).toBeInTheDocument();
    expect(screen.getByTestId("wa-inbox-filter-all")).toBeInTheDocument();
    expect(screen.getByTestId("wa-inbox-filter-snoozed")).toBeInTheDocument();
    expect(screen.getByTestId("wa-inbox-filter-closed")).toBeInTheDocument();
  });

  it("renders the empty state when GET returns 0 conversations", async () => {
    asRole("RECEPTION");
    render(<WhatsAppInboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-inbox-empty")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("wa-inbox-empty").textContent).toMatch(/no conversations/i);
  });

  it("renders one row per conversation from the API and a per-row unread badge", async () => {
    asRole("RECEPTION");
    apiMock.get.mockResolvedValueOnce({
      data: {
        conversations: [
          row({ id: "c1", unreadCount: 2 }),
          row({
            id: "c2",
            unreadCount: 0,
            status: "CLOSED",
            patient: {
              id: "p1",
              mrNumber: "MR0001",
              user: { id: "u1", name: "Aarav Sharma" },
            },
          }),
          row({ id: "c3", unreadCount: 1, status: "SNOOZED" }),
        ],
        nextCursor: null,
      },
    });
    render(<WhatsAppInboxPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId("wa-inbox-row")).toHaveLength(3);
    });
    // Patient-matched row shows the patient name.
    expect(screen.getByText("Aarav Sharma")).toBeInTheDocument();
    // Per-row unread badge present on the two unread rows.
    expect(screen.getAllByTestId("wa-inbox-row-unread")).toHaveLength(2);
    // Header total unread badge sums to 3 (2 + 0 + 1).
    expect(screen.getByTestId("wa-inbox-unread-badge").textContent).toBe("3");
  });

  it("clicking a filter chip refetches with the new status param", async () => {
    asRole("RECEPTION");
    render(<WhatsAppInboxPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringContaining("status=OPEN"),
      ),
    );
    fireEvent.click(screen.getByTestId("wa-inbox-filter-snoozed"));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringContaining("status=SNOOZED"),
      ),
    );
  });

  it("Refresh + filter chips carry the h-11 44px touch-target class", async () => {
    asRole("RECEPTION");
    render(<WhatsAppInboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-inbox-refresh")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("wa-inbox-refresh").className).toMatch(/h-11/);
    expect(screen.getByTestId("wa-inbox-refresh").className).toMatch(/min-w-\[44px\]/);
    expect(screen.getByTestId("wa-inbox-filter-open").className).toMatch(/h-11/);
    expect(screen.getByTestId("wa-inbox-filter-open").className).toMatch(/min-w-\[44px\]/);
  });

  it("renders the not-allowed surface for the PATIENT role", () => {
    asRole("PATIENT");
    render(<WhatsAppInboxPage />);
    expect(screen.getByTestId("wa-inbox-not-allowed")).toBeInTheDocument();
    // No filter chips for non-allowed roles.
    expect(screen.queryByTestId("wa-inbox-filters")).not.toBeInTheDocument();
  });

  it("surfaces the sign-in nudge when GET returns 401", async () => {
    asRole("RECEPTION");
    apiMock.get.mockRejectedValueOnce(new Error("Request failed with 401"));
    render(<WhatsAppInboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-inbox-unauth")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("wa-inbox-signin-cta")).toBeInTheDocument();
  });
});
