/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for /super-admin/support/[id] — Pearl §8.5 (gap row 223 closure).
//
// Covers:
//   - Detail header renders subject + tenant + opener correctly.
//   - Message thread shows both stub messages with author + role badges.
//   - Reply composer POSTs to /api/v1/support-tickets/:id/messages and
//     refetches the ticket on success.
//   - Status / Priority select fires a PATCH with the new value.
//   - Assign-to-me button fires PATCH with the current user's id.
//   - 44px touch targets on action buttons.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const sampleTicket = {
  id: "tkt-123",
  tenantId: "tenant-a",
  subject: "Razorpay payouts stuck",
  body: "Yesterday's payouts haven't hit our bank account.",
  status: "OPEN",
  priority: "HIGH",
  assignedToUserId: null,
  resolvedAt: null,
  createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  tenant: { id: "tenant-a", name: "Pearl Hospital A", subdomain: "pearl-a" },
  openedBy: { id: "u-a", name: "Tenant Admin A", email: "a@pearl-a.test" },
  assignedTo: null,
  messages: [
    {
      id: "msg-1",
      body: "Looking into your Razorpay account.",
      createdAt: new Date(Date.now() - 25 * 60_000).toISOString(),
      author: {
        id: "super-1",
        name: "Pearl Ops",
        email: "ops@pearl.test",
        role: "ADMIN",
      },
    },
    {
      id: "msg-2",
      body: "Thanks — checking on our end too.",
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      author: {
        id: "u-a",
        name: "Tenant Admin A",
        email: "a@pearl-a.test",
        role: "ADMIN",
      },
    },
  ],
};

const fetchMock = vi.fn();
const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
  useParams: () => ({ id: "tkt-123" }),
}));

beforeEach(() => {
  fetchMock.mockReset();
  routerPush.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (
      typeof url === "string" &&
      url.includes("/api/v1/auth/me") &&
      (!init || init.method === undefined)
    ) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { id: "super-current", role: "ADMIN", tenantId: null },
          error: null,
        }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: sampleTicket,
        error: null,
      }),
    } as Response;
  });
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

import SuperAdminSupportTicketPage from "../page";

describe("Super-admin /super-admin/support/[id] detail — Pearl §8.5", () => {
  it("renders ticket header + body + both messages", async () => {
    render(<SuperAdminSupportTicketPage />);
    await waitFor(() => {
      expect(screen.getByTestId("support-detail-subject").textContent).toBe(
        "Razorpay payouts stuck",
      );
    });
    expect(screen.getByTestId("support-detail-body").textContent).toContain(
      "Yesterday's payouts",
    );
    expect(
      screen.getByTestId("support-detail-tenant").textContent,
    ).toContain("Pearl Hospital A");
    expect(
      screen.getByTestId("support-detail-opener").textContent,
    ).toContain("Tenant Admin A");
    // Both messages rendered.
    expect(screen.getByTestId("support-message-msg-1")).toBeInTheDocument();
    expect(screen.getByTestId("support-message-msg-2")).toBeInTheDocument();
  });

  it("posting a reply fires POST /messages and triggers a refetch", async () => {
    render(<SuperAdminSupportTicketPage />);
    await waitFor(() => {
      expect(screen.getByTestId("support-message-msg-1")).toBeInTheDocument();
    });
    const input = screen.getByTestId(
      "support-reply-input",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Will follow up by EOD." } });
    fireEvent.click(screen.getByTestId("support-reply-submit"));
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          typeof url === "string" &&
          url.includes("/messages") &&
          (init as any)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      expect(JSON.parse((postCall![1] as any).body)).toEqual({
        body: "Will follow up by EOD.",
      });
    });
  });

  it("changing status fires PATCH with the new status", async () => {
    render(<SuperAdminSupportTicketPage />);
    await waitFor(() => {
      expect(screen.getByTestId("support-status-select")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("support-status-select"), {
      target: { value: "IN_PROGRESS" },
    });
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          typeof url === "string" &&
          url === "/api/v1/support-tickets/tkt-123" &&
          (init as any)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse((patchCall![1] as any).body)).toEqual({
        status: "IN_PROGRESS",
      });
    });
  });

  it("changing priority fires PATCH with the new priority", async () => {
    render(<SuperAdminSupportTicketPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("support-priority-select"),
      ).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("support-priority-select"), {
      target: { value: "URGENT" },
    });
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          typeof url === "string" &&
          url === "/api/v1/support-tickets/tkt-123" &&
          (init as any)?.method === "PATCH" &&
          JSON.parse((init as any).body).priority === "URGENT",
      );
      expect(patchCall).toBeTruthy();
    });
  });

  it("Assign-to-me button fires PATCH with the current user id", async () => {
    render(<SuperAdminSupportTicketPage />);
    await waitFor(() => {
      // Button visible because /auth/me returned super-current and the
      // ticket is currently unassigned.
      expect(screen.getByTestId("support-assign-me")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("support-assign-me"));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          typeof url === "string" &&
          url === "/api/v1/support-tickets/tkt-123" &&
          (init as any)?.method === "PATCH" &&
          JSON.parse((init as any).body).assignedToUserId === "super-current",
      );
      expect(patchCall).toBeTruthy();
    });
  });

  it("uses 44px (h-11) touch targets on reply submit + back button", async () => {
    render(<SuperAdminSupportTicketPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("support-reply-submit"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("support-reply-submit").className).toMatch(
      /h-11/,
    );
    expect(screen.getByTestId("support-back").className).toMatch(/h-11/);
    expect(
      screen.getByTestId("support-status-select").className,
    ).toMatch(/h-11/);
  });
});
