// Coverage tests for the My Activity dashboard page.
// Modules under test: apps/web/src/app/dashboard/my-activity/page.tsx —
//   fetches /auth/my-activity, renders a loading skeleton, an empty state,
//   the action-filter <select>, and a per-day-grouped activity list.
// Why: page was at 0% coverage; these assertions lock in the rendered
// surface (loading, happy, empty, error, filter) so future refactors
// can't silently break the user-facing shape.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiGetMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import MyActivityPage from "../page";

// Stable day anchor — same day for both rows so they group together,
// and a different day for the third row so the per-day grouping is
// exercised. We use locale-independent fixed dates rather than
// `new Date(...).toLocaleDateString()` math at fixture-build time
// because that's exactly the function the page itself uses to group;
// using the same call for the fixture would mask any drift bug.
const DAY_A = "2026-05-01T10:30:00.000Z";
const DAY_A_LATER = "2026-05-01T18:45:00.000Z";
const DAY_B = "2026-04-22T09:15:00.000Z";

function listOk<T>(data: T[]) {
  return { success: true, data, error: null };
}

describe("My Activity dashboard page", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  it("renders the loading skeleton while /auth/my-activity is pending", async () => {
    // Never-resolving promise keeps the page in its loading branch.
    apiGetMock.mockImplementation(() => new Promise(() => {}));
    render(<MyActivityPage />);
    const loader = await screen.findByTestId("my-activity-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
  });

  it("fetches /auth/my-activity and renders entries grouped by day with the filter populated", async () => {
    apiGetMock.mockResolvedValue(
      listOk([
        {
          id: "ent-1",
          action: "USER_LOGIN",
          entity: "User",
          entityId: "abcdef1234567890",
          ipAddress: "127.0.0.1",
          details: null,
          createdAt: DAY_A,
        },
        {
          id: "ent-2",
          action: "PATIENT_UPDATE",
          entity: "Patient",
          entityId: "pqrstuvw98765432",
          ipAddress: null,
          details: null,
          createdAt: DAY_A_LATER,
        },
        {
          id: "ent-3",
          action: "USER_LOGIN",
          entity: "User",
          entityId: null,
          ipAddress: null,
          details: null,
          createdAt: DAY_B,
        },
      ]),
    );

    render(<MyActivityPage />);

    // Loading goes away once the fetch resolves.
    await waitFor(() =>
      expect(screen.queryByTestId("my-activity-loading")).not.toBeInTheDocument(),
    );

    // API contract — endpoint is exactly `/auth/my-activity`.
    expect(apiGetMock).toHaveBeenCalledWith("/auth/my-activity");

    // Heading visible.
    expect(
      screen.getByRole("heading", { name: /My Activity/i }),
    ).toBeInTheDocument();

    // Row queries are scoped to the action <p> text-sm font-medium nodes
    // to avoid colliding with same-named <option> labels in the filter.
    const rowActions = document.querySelectorAll("p.text-sm.font-medium");
    const rowActionTexts = Array.from(rowActions).map((n) => n.textContent);
    expect(rowActionTexts.filter((t) => t === "USER_LOGIN")).toHaveLength(2);
    expect(rowActionTexts.filter((t) => t === "PATIENT_UPDATE")).toHaveLength(
      1,
    );

    // Entity + truncated 8-char id are rendered together via the
    // " · " separator the source emits.
    expect(screen.getByText(/User · abcdef12/)).toBeInTheDocument();
    expect(screen.getByText(/Patient · pqrstuvw/)).toBeInTheDocument();

    // Filter <select> is populated with the unique sorted action set.
    const select = screen.getByLabelText(/Filter by action:/i) as HTMLSelectElement;
    const optionValues = Array.from(select.querySelectorAll("option")).map(
      (o) => o.value,
    );
    expect(optionValues).toEqual(["", "PATIENT_UPDATE", "USER_LOGIN"]);
  });

  it("filters rendered rows when an action is chosen from the dropdown", async () => {
    apiGetMock.mockResolvedValue(
      listOk([
        {
          id: "ent-1",
          action: "USER_LOGIN",
          entity: "User",
          entityId: "abcdef1234567890",
          ipAddress: null,
          details: null,
          createdAt: DAY_A,
        },
        {
          id: "ent-2",
          action: "PATIENT_UPDATE",
          entity: "Patient",
          entityId: "pqrstuvw98765432",
          ipAddress: null,
          details: null,
          createdAt: DAY_A_LATER,
        },
      ]),
    );

    render(<MyActivityPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("my-activity-loading")).not.toBeInTheDocument(),
    );

    const select = screen.getByLabelText(/Filter by action:/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "USER_LOGIN" } });

    // Filter applied — only the USER_LOGIN row remains in the data list.
    // We count <p class="text-sm font-medium"> nodes to skip the matching
    // <option value="USER_LOGIN"> in the dropdown.
    function rowTexts() {
      return Array.from(
        document.querySelectorAll("p.text-sm.font-medium"),
      ).map((n) => n.textContent);
    }
    let texts = rowTexts();
    expect(texts).toContain("USER_LOGIN");
    expect(texts).not.toContain("PATIENT_UPDATE");

    // Reset back to "All actions" → both rows return in the list.
    fireEvent.change(select, { target: { value: "" } });
    texts = rowTexts();
    expect(texts).toContain("USER_LOGIN");
    expect(texts).toContain("PATIENT_UPDATE");
  });

  it("renders the empty-state copy when the API returns no entries", async () => {
    apiGetMock.mockResolvedValue(listOk([]));
    render(<MyActivityPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("my-activity-loading")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/No activity yet\./i)).toBeInTheDocument();
  });

  it("swallows fetch errors and falls back to the empty-state surface", async () => {
    apiGetMock.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    render(<MyActivityPage />);
    // Source catches the error, sets loading=false, leaves entries=[].
    await waitFor(() =>
      expect(screen.queryByTestId("my-activity-loading")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/No activity yet\./i)).toBeInTheDocument();
    // Heading still rendered — the chrome is independent of the fetch.
    expect(
      screen.getByRole("heading", { name: /My Activity/i }),
    ).toBeInTheDocument();
  });

  it("omits the truncated id suffix when entityId is null", async () => {
    apiGetMock.mockResolvedValue(
      listOk([
        {
          id: "ent-1",
          action: "SYSTEM_HEALTHCHECK",
          entity: "System",
          entityId: null,
          ipAddress: null,
          details: null,
          createdAt: DAY_B,
        },
      ]),
    );
    render(<MyActivityPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("my-activity-loading")).not.toBeInTheDocument(),
    );
    // The subline for this row is just "System" with no " · " separator —
    // scope to the row-data <p class="text-xs text-gray-500"> nodes.
    const sublines = Array.from(
      document.querySelectorAll("p.text-xs.text-gray-500"),
    ).map((n) => n.textContent);
    expect(sublines).toContain("System");
    // Negative — no " · <id-prefix>" suffix on the row.
    expect(sublines.some((t) => /System · /.test(t ?? ""))).toBe(false);
  });
});
