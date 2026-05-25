/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for /super-admin/support — Pearl §8.5 (gap row 223 closure).
//
// Covers:
//   - Table renders mocked /api/v1/support-tickets response.
//   - Status-filter chips toggle the filter and refetch with the new
//     status query param (no fetch on chip that matches current).
//   - Priority-filter chips toggle similarly.
//   - Tenant text filter is client-side: typing narrows the rendered rows
//     without firing a new fetch.
//   - 44px (h-11) touch targets on filter chips + row Open buttons.
//
// fetch is stubbed at the global level so the page can be unit-tested
// without the real API.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const sampleTickets = [
  {
    id: "tkt-open-pearl-a",
    tenantId: "tenant-a",
    subject: "Razorpay payouts stuck",
    status: "OPEN",
    priority: "HIGH",
    updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    tenant: {
      id: "tenant-a",
      name: "Pearl Hospital A",
      subdomain: "pearl-a",
    },
    openedBy: { id: "u-a", name: "Tenant Admin A", email: "a@pearl-a.test" },
    assignedTo: null,
  },
  {
    id: "tkt-progress-b",
    tenantId: "tenant-b",
    subject: "WhatsApp inbox not posting",
    status: "IN_PROGRESS",
    priority: "URGENT",
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    createdAt: new Date(Date.now() - 120 * 60_000).toISOString(),
    tenant: {
      id: "tenant-b",
      name: "Pearl Hospital B",
      subdomain: "pearl-b",
    },
    openedBy: { id: "u-b", name: "Tenant Admin B", email: "b@pearl-b.test" },
    assignedTo: { id: "super-1", name: "Pearl Ops", email: "ops@pearl.test" },
  },
  {
    id: "tkt-resolved-a",
    tenantId: "tenant-a",
    subject: "Old issue — done",
    status: "RESOLVED",
    priority: "NORMAL",
    updatedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    createdAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
    tenant: {
      id: "tenant-a",
      name: "Pearl Hospital A",
      subdomain: "pearl-a",
    },
    openedBy: { id: "u-a", name: "Tenant Admin A", email: "a@pearl-a.test" },
    assignedTo: null,
  },
];

const fetchMock = vi.fn();

// Next navigation hooks aren't used by the list page, but the layout
// imports them — guard with a stub so the import resolves cleanly when
// the page is rendered in isolation.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({}),
}));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { tickets: sampleTickets, nextCursor: null },
      error: null,
    }),
  }));
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

import SuperAdminSupportPage from "../page";

describe("Super-admin /super-admin/support page — Pearl §8.5", () => {
  it("renders the 3 mocked tickets (initial filter is OPEN — but the mock returns all)", async () => {
    render(<SuperAdminSupportPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("support-row-tkt-open-pearl-a"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("support-row-tkt-progress-b"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("support-row-tkt-resolved-a"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("support-count-summary").textContent).toMatch(
      /3 tickets shown/i,
    );
  });

  it("status filter chip toggles and refetches with the new status query param", async () => {
    render(<SuperAdminSupportPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("support-row-tkt-open-pearl-a"),
      ).toBeInTheDocument();
    });
    // Initial fetch carries status=OPEN (the default).
    const firstUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toContain("status=OPEN");
    fireEvent.click(screen.getByTestId("support-filter-status-in_progress"));
    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1);
      expect(String(last?.[0] ?? "")).toContain("status=IN_PROGRESS");
    });
    // "All" → no status query param.
    fireEvent.click(screen.getByTestId("support-filter-status-all"));
    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1);
      expect(String(last?.[0] ?? "")).not.toContain("status=");
    });
  });

  it("priority filter chip toggles and refetches with the new priority query param", async () => {
    render(<SuperAdminSupportPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("support-row-tkt-open-pearl-a"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("support-filter-priority-urgent"));
    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1);
      expect(String(last?.[0] ?? "")).toContain("priority=URGENT");
    });
  });

  it("tenant text filter narrows the rendered rows without firing fetch", async () => {
    render(<SuperAdminSupportPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("support-row-tkt-progress-b"),
      ).toBeInTheDocument();
    });
    const fetchCountBefore = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByTestId("support-tenant-filter"), {
      target: { value: "pearl-b" },
    });
    // After the filter is applied, only the B-tenant row should be in
    // the table.
    await waitFor(() => {
      expect(
        screen.queryByTestId("support-row-tkt-open-pearl-a"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByTestId("support-row-tkt-progress-b"),
    ).toBeInTheDocument();
    // Same fetch count — the tenant filter is purely client-side.
    expect(fetchMock.mock.calls.length).toBe(fetchCountBefore);
  });

  it("uses 44px (h-11) touch targets on chips, filter input, and row Open buttons", async () => {
    render(<SuperAdminSupportPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("support-row-tkt-open-pearl-a"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("support-filter-status-open").className,
    ).toMatch(/h-11/);
    expect(
      screen.getByTestId("support-filter-priority-urgent").className,
    ).toMatch(/h-11/);
    expect(screen.getByTestId("support-tenant-filter").className).toMatch(
      /h-11/,
    );
    expect(
      screen.getByTestId("support-open-tkt-open-pearl-a").className,
    ).toMatch(/h-11/);
  });

  it("shows an Empty state if no tickets are returned", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { tickets: [], nextCursor: null },
        error: null,
      }),
    }));
    render(<SuperAdminSupportPage />);
    await waitFor(() => {
      expect(screen.getByTestId("support-empty")).toBeInTheDocument();
    });
  });
});
