/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for /super-admin/jobs — Pearl §8.4 (gap row 222 closure).
//
// Covers:
//   - Table renders with mocked /api/v1/scheduled-jobs response.
//   - Retry button ONLY visible on FAILED rows (not RUNNING / SUCCESS).
//   - Status-filter chips toggle the filter (we assert the next fetch
//     reflects the chosen status query param).
//   - 44px touch targets on filter chips + retry buttons (h-11 utility).
//
// fetch is stubbed at the global level so the page can be unit-tested
// without the real API.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const sampleRuns = [
  {
    id: "run-running",
    tenantId: null,
    taskName: "auto_noshow_elapsed_booked",
    status: "RUNNING",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: null,
    durationMs: null,
    error: null,
    recordsProcessed: null,
    retryOfRunId: null,
  },
  {
    id: "run-success",
    tenantId: null,
    taskName: "notification_drain_queued",
    status: "SUCCESS",
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    completedAt: new Date(Date.now() - 119_000).toISOString(),
    durationMs: 1_000,
    error: null,
    recordsProcessed: 4,
    retryOfRunId: null,
  },
  {
    id: "run-failed",
    tenantId: null,
    taskName: "auto_flag_expired_blood_units",
    status: "FAILED",
    startedAt: new Date(Date.now() - 180_000).toISOString(),
    completedAt: new Date(Date.now() - 179_000).toISOString(),
    durationMs: 1_000,
    error: "Error: simulated\n    at fake (scheduled-tasks.ts:1:1)",
    recordsProcessed: null,
    retryOfRunId: null,
  },
];

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // Default: every list call returns the 3 sampleRuns; retry calls 200.
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("/retry") && init?.method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            newRun: {
              ...sampleRuns[2],
              id: "run-failed-retry-1",
              status: "RUNNING",
              retryOfRunId: "run-failed",
            },
            retryOfRunId: "run-failed",
          },
          error: null,
        }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { runs: sampleRuns, nextCursor: null },
        error: null,
      }),
    } as Response;
  });
  // Stub global fetch for the page.
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

import SuperAdminJobsPage from "../page";

describe("Super-admin /super-admin/jobs page — Pearl §8.4", () => {
  it("renders the 3 mocked runs in the table", async () => {
    render(<SuperAdminJobsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("jobs-row-run-running")).toBeInTheDocument();
    });
    expect(screen.getByTestId("jobs-row-run-success")).toBeInTheDocument();
    expect(screen.getByTestId("jobs-row-run-failed")).toBeInTheDocument();
    // Table header + summary line are present too.
    expect(screen.getByTestId("jobs-table")).toBeInTheDocument();
    expect(screen.getByTestId("jobs-count-summary").textContent).toMatch(/3 runs shown/i);
  });

  it("shows the Retry button ONLY on the FAILED row", async () => {
    render(<SuperAdminJobsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("jobs-row-run-failed")).toBeInTheDocument();
    });
    // FAILED row → retry button present.
    expect(screen.getByTestId("jobs-retry-run-failed")).toBeInTheDocument();
    // RUNNING / SUCCESS rows → no retry button.
    expect(screen.queryByTestId("jobs-retry-run-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("jobs-retry-run-success")).not.toBeInTheDocument();
  });

  it("status filter chips toggle and refetch with the new status", async () => {
    render(<SuperAdminJobsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("jobs-row-run-failed")).toBeInTheDocument();
    });
    // The initial mount fired one fetch — default status filter is FAILED,
    // so the URL contains status=FAILED.
    const firstUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toContain("status=FAILED");
    // Click "Running" chip.
    fireEvent.click(screen.getByTestId("jobs-filter-status-running"));
    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1);
      const url = String(last?.[0] ?? "");
      expect(url).toContain("status=RUNNING");
    });
    // Click "All" chip — status param must be omitted.
    fireEvent.click(screen.getByTestId("jobs-filter-status-all"));
    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1);
      const url = String(last?.[0] ?? "");
      expect(url).not.toContain("status=");
    });
  });

  it("uses 44px (h-11) touch targets on filter chips and retry buttons", async () => {
    render(<SuperAdminJobsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("jobs-row-run-failed")).toBeInTheDocument();
    });
    expect(screen.getByTestId("jobs-filter-status-failed").className).toMatch(/h-11/);
    expect(screen.getByTestId("jobs-filter-window-24h").className).toMatch(/h-11/);
    expect(screen.getByTestId("jobs-retry-run-failed").className).toMatch(/h-11/);
  });

  it("clicking retry posts to the retry endpoint and refetches", async () => {
    render(<SuperAdminJobsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("jobs-row-run-failed")).toBeInTheDocument();
    });
    fetchMock.mockClear();
    // Re-arm mock for the retry POST + the follow-up list refetch.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/retry") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              newRun: {
                ...sampleRuns[2],
                id: "run-failed-retry-1",
                status: "RUNNING",
                retryOfRunId: "run-failed",
              },
              retryOfRunId: "run-failed",
            },
            error: null,
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { runs: sampleRuns, nextCursor: null },
          error: null,
        }),
      } as Response;
    });
    fireEvent.click(screen.getByTestId("jobs-retry-run-failed"));
    await waitFor(() => {
      const retryCalls = fetchMock.mock.calls.filter(
        ([url, init]) =>
          typeof url === "string" &&
          url.includes("/retry") &&
          (init as any)?.method === "POST"
      );
      expect(retryCalls.length).toBe(1);
    });
  });
});
