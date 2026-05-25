/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for /super-admin/dpdp — Pearl §8.6 (gap row 224 closure).
//
// Covers:
//   - Table renders with mocked /api/v1/dpdp-workbench/requests response.
//   - PENDING row shows BOTH Execute + Reject buttons; COMPLETED row
//     shows neither; FAILED row shows ONLY Execute (no Reject).
//   - Filter chips toggle and the URL query param reflects the choice.
//   - Touch targets are 44px (h-11) on filter chips + action buttons.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const sampleRequests = [
  {
    id: "req-pending",
    tenantId: "tenant-a",
    patientId: "pat-abcdef1234567890",
    requestedBy: "patient-xyz",
    requestedByRole: "PATIENT",
    reason: "Self-filed",
    status: "PENDING",
    requestedAt: new Date(Date.now() - 60_000).toISOString(),
    executedAt: null,
    executedBy: null,
    failureReason: null,
    executionReceipt: null,
  },
  {
    id: "req-completed",
    tenantId: "tenant-a",
    patientId: "pat-2222222222222222",
    requestedBy: "admin-1",
    requestedByRole: "SUPER_ADMIN",
    reason: null,
    status: "COMPLETED",
    requestedAt: new Date(Date.now() - 120_000).toISOString(),
    executedAt: new Date(Date.now() - 110_000).toISOString(),
    executedBy: "admin-1",
    failureReason: null,
    executionReceipt: {
      purgedTables: ["Appointment", "Vitals"],
      purgedRows: { Appointment: 3, Vitals: 5 },
      anonymizedTables: ["Patient", "User"],
      retainedTables: ["AuditLog"],
      notes: "",
    },
  },
  {
    id: "req-failed",
    tenantId: "tenant-b",
    patientId: "pat-3333333333333333",
    requestedBy: "dpo@example.com",
    requestedByRole: "DPO_EXTERNAL",
    reason: "DPO request",
    status: "FAILED",
    requestedAt: new Date(Date.now() - 180_000).toISOString(),
    executedAt: new Date(Date.now() - 170_000).toISOString(),
    executedBy: "admin-1",
    failureReason: "FK constraint blocked Appointment delete",
    executionReceipt: null,
  },
];

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { requests: sampleRequests, nextCursor: null },
        error: null,
      }),
    } as Response;
  });
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

import SuperAdminDpdpPage from "../page";

describe("Super-admin /super-admin/dpdp page — Pearl §8.6", () => {
  it("renders the mocked requests in the table", async () => {
    render(<SuperAdminDpdpPage />);
    await waitFor(() => {
      expect(screen.getByTestId("dpdp-row-req-pending")).toBeInTheDocument();
    });
    expect(screen.getByTestId("dpdp-row-req-completed")).toBeInTheDocument();
    expect(screen.getByTestId("dpdp-row-req-failed")).toBeInTheDocument();
    expect(screen.getByTestId("dpdp-table")).toBeInTheDocument();
    expect(screen.getByTestId("dpdp-count-summary").textContent).toMatch(
      /3 requests shown/i,
    );
  });

  it("shows Execute + Reject only on the PENDING row; COMPLETED row shows neither", async () => {
    render(<SuperAdminDpdpPage />);
    await waitFor(() => {
      expect(screen.getByTestId("dpdp-row-req-pending")).toBeInTheDocument();
    });
    // PENDING → both.
    expect(screen.getByTestId("dpdp-execute-req-pending")).toBeInTheDocument();
    expect(screen.getByTestId("dpdp-reject-req-pending")).toBeInTheDocument();
    // COMPLETED → neither.
    expect(
      screen.queryByTestId("dpdp-execute-req-completed"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("dpdp-reject-req-completed"),
    ).not.toBeInTheDocument();
    // FAILED → Execute only (re-try) but no Reject.
    expect(screen.getByTestId("dpdp-execute-req-failed")).toBeInTheDocument();
    expect(
      screen.queryByTestId("dpdp-reject-req-failed"),
    ).not.toBeInTheDocument();
  });

  it("status filter chips toggle and refetch with the new status", async () => {
    render(<SuperAdminDpdpPage />);
    await waitFor(() => {
      expect(screen.getByTestId("dpdp-row-req-pending")).toBeInTheDocument();
    });
    const firstUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toContain("status=PENDING");
    fireEvent.click(screen.getByTestId("dpdp-filter-status-completed"));
    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1);
      const url = String(last?.[0] ?? "");
      expect(url).toContain("status=COMPLETED");
    });
    fireEvent.click(screen.getByTestId("dpdp-filter-status-all"));
    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1);
      const url = String(last?.[0] ?? "");
      expect(url).not.toContain("status=");
    });
  });

  it("uses h-11 touch targets on filter chips + action buttons", async () => {
    render(<SuperAdminDpdpPage />);
    await waitFor(() => {
      expect(screen.getByTestId("dpdp-row-req-pending")).toBeInTheDocument();
    });
    expect(screen.getByTestId("dpdp-filter-status-pending").className).toMatch(
      /h-11/,
    );
    expect(screen.getByTestId("dpdp-execute-req-pending").className).toMatch(
      /h-11/,
    );
    expect(screen.getByTestId("dpdp-reject-req-pending").className).toMatch(
      /h-11/,
    );
  });
});
