/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, routerReplace, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerReplace: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/admin-console",
}));

import AdminConsolePage from "../admin-console/page";

function defaultGet(url: string) {
  if (url.includes("/analytics/overview"))
    return {
      data: {
        newPatients: 12,
        admissions: 4,
        discharges: 2,
        surgeries: 1,
        erCases: 3,
        totalRevenue: 50000,
      },
    };
  if (url.includes("/complaints")) return { data: [] };
  if (url.includes("/pharmacy/inventory?lowStock"))
    return { meta: { total: 2 } };
  if (url.includes("/pharmacy/inventory?expiring"))
    return { meta: { total: 1 } };
  if (url.includes("/bloodbank/inventory/summary"))
    return { data: { byBloodGroup: {}, byComponent: {}, totalAvailable: 0, expiringSoon: 0 } };
  if (url.includes("/audit")) return { meta: { total: 0 }, data: [] };
  if (url.includes("/leaves")) return { data: [] };
  if (url.includes("/expenses")) return { data: [] };
  if (url.includes("/purchase-orders")) return { data: [] };
  if (url.includes("/wards")) return { data: [] };
  if (url.includes("/hr/duty-roster")) return { data: [] };
  if (url.includes("/surgery")) return { data: [] };
  if (url.includes("/users")) return { data: [] };
  return { data: [] };
}

describe("AdminConsolePage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
    routerReplace.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      isLoading: false,
    });
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(defaultGet(url))
    );
    // Real fetch for /api/health used in admin-console
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    document.documentElement.classList.remove("dark");
  });

  it("renders the Admin Console heading for admin user", async () => {
    render(<AdminConsolePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /admin console/i })
      ).toBeInTheDocument()
    );
  });

  it("renders KPI card headings (System Health, Critical Alerts, Today Snapshot)", async () => {
    render(<AdminConsolePage />);
    await waitFor(() => {
      expect(screen.getByText(/system health/i)).toBeInTheDocument();
      expect(screen.getByText(/critical alerts/i)).toBeInTheDocument();
      expect(screen.getByText(/today snapshot/i)).toBeInTheDocument();
    });
  });

  it("handles grouped /hr/duty-roster response without crashing", async () => {
    // Regression guard for the recent grouped-roster fix.
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/hr/duty-roster"))
        return Promise.resolve({
          data: {
            groups: [
              { role: "DOCTOR", users: [{ id: "u2", name: "Doc" }] },
            ],
          },
        });
      return Promise.resolve(defaultGet(url));
    });
    render(<AdminConsolePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /admin console/i })
      ).toBeInTheDocument()
    );
  });

  it("shows the restricted message for non-admin users", async () => {
    authMock.mockReturnValue({
      user: { id: "u2", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      isLoading: false,
    });
    render(<AdminConsolePage />);
    expect(
      screen.getByText(/admin console restricted to administrators/i)
    ).toBeInTheDocument();
  });

  it("redirects non-admin users via router.replace", async () => {
    authMock.mockReturnValue({
      user: { id: "u2", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      isLoading: false,
    });
    render(<AdminConsolePage />);
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("continues rendering when health check fetch throws", async () => {
    (globalThis as any).fetch = vi.fn(() => Promise.reject(new Error("down")));
    render(<AdminConsolePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /admin console/i })
      ).toBeInTheDocument()
    );
  });

  // Regression guard for Issue #47 (2026-04-24, expanded 2026-05-09):
  // when Errors (1h) > 0, the admin-console must render a breakdown table
  // so ops can distinguish bot traffic from a real auth outage. The table
  // is hidden when count is 0. As of 2026-05-09 the URL shape is
  // `actionIn=LOGIN_FAILED,PRESCRIPTION_REJECTED,...` (canonical
  // ERROR_ACTIONS list) instead of `action=LOGIN_FAILED` so the count
  // covers every error-shaped audit action, not just login failures.
  it("Issue #47: renders error breakdown table when errors > 0", async () => {
    apiMock.get.mockImplementation((url: string) => {
      // Pretend there are 125 errors; the scalar /audit?limit=1 returns
      // meta.total and the /audit?limit=100 returns sample rows the page
      // uses to derive (uniqueIps, topIp, topIpCount). The page now sends
      // `actionIn=...,...&limit=N` rather than `action=LOGIN_FAILED&limit=N`.
      if (url.includes("actionIn=") && url.includes("limit=100")) {
        const data = Array.from({ length: 100 }, (_, i) => ({
          id: `a${i}`,
          action: "LOGIN_FAILED",
          ipAddress: i < 60 ? "203.0.113.10" : i < 95 ? "203.0.113.20" : "203.0.113.30",
          details: {},
        }));
        return Promise.resolve({ data });
      }
      if (url.includes("actionIn=") && url.includes("limit=1")) {
        return Promise.resolve({ meta: { total: 125 } });
      }
      if (url.includes("/audit?")) {
        return Promise.resolve({ meta: { total: 300 }, data: [] });
      }
      return Promise.resolve(defaultGet(url));
    });

    render(<AdminConsolePage />);
    const table = await screen.findByTestId("error-breakdown");
    expect(table).toBeInTheDocument();
    // The breakdown should label the dominant action and surface IP context.
    // The table wrapper renders before the row cells settle from the fetched
    // data, so anchor on `findByText` for the dominant action — that polls
    // until the row populates — and then sync-check the siblings, which are
    // guaranteed in the same render pass.
    expect(await screen.findByText(/LOGIN_FAILED/)).toBeInTheDocument();
    expect(screen.getByText(/likely bot traffic/i)).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.10/)).toBeInTheDocument();
  });

  it("Issue #47: hides error breakdown when errorCount is 0", async () => {
    // Default mocks return zero errors; the breakdown element must be absent.
    render(<AdminConsolePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /admin console/i })
      ).toBeInTheDocument()
    );
    expect(screen.queryByTestId("error-breakdown")).not.toBeInTheDocument();
  });

  // Regression guard for Issue #48 (2026-04-24): "Registered" stayed at 0
  // because the widget read a key the server did not return. Now the
  // analytics API aliases `newPatients = newPatientsInPeriod` — verify
  // the widget renders the value the API provides.
  // Regression guard for Issue #936 (2026-05-24): already-approved
  // expenses lingered on the Pending Approvals card with the Approve
  // button still enabled. Two fixes:
  //   (a) On a successful approval the row is optimistically pruned and
  //       the `Expenses (N)` counter decrements immediately.
  //   (b) When the server rejects with "already APPROVED" the client
  //       still prunes the stale row + bumps the refresh tick (rather
  //       than leaving the row clickable forever).
  //   (c) While the PATCH is in flight, the Approve button is disabled
  //       so a double-click cannot race the optimistic prune.
  it("Issue #936: successful expense approval prunes the row and decrements the counter", async () => {
    const expenses = [
      { id: "e1", description: "Patient refreshment supplies", amount: 1767 },
      { id: "e2", description: "IV cannula stock replenishment", amount: 2988 },
    ];
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/expenses")) return Promise.resolve({ data: expenses });
      return Promise.resolve(defaultGet(url));
    });
    apiMock.patch.mockResolvedValue({ data: { id: "e1", approvalStatus: "APPROVED" } });

    const user = userEvent.setup();
    render(<AdminConsolePage />);

    // Wait for the populated card.
    await waitFor(() => {
      expect(screen.getByText(/Patient refreshment supplies/)).toBeInTheDocument();
    });
    // Counter starts at 2.
    expect(screen.getByText(/Expenses \(2\)/)).toBeInTheDocument();

    const approveBtn = screen.getByRole("button", {
      name: /Approve Patient refreshment supplies/,
    });
    await user.click(approveBtn);

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/expenses/e1/approve",
        { approved: true },
      );
    });
    // Row gone, counter decremented to 1.
    await waitFor(() => {
      expect(
        screen.queryByText(/Patient refreshment supplies/),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/Expenses \(1\)/)).toBeInTheDocument();
    });
  });

  it("Issue #936: already-APPROVED 4xx prunes the stale row instead of leaving it clickable", async () => {
    // Server-side state: e1 is already APPROVED, so the /expenses?status=PENDING
    // refetch should NOT return it. The page's pre-fix bug was that even when
    // the user clicked Approve and the server 4xx'd "already APPROVED", the
    // dead row stayed clickable forever.
    let serverPendingExpenses: any[] = [
      { id: "e1", description: "Patient refreshment supplies", amount: 1767 },
    ];
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/expenses"))
        return Promise.resolve({ data: serverPendingExpenses });
      return Promise.resolve(defaultGet(url));
    });
    const err = Object.assign(new Error("Expense is already APPROVED"), {
      status: 400,
      payload: { error: "Expense is already APPROVED" },
    });
    apiMock.patch.mockImplementation(async () => {
      // Mirror server reality: by the time the admin clicks, the expense is
      // already APPROVED upstream — so the next refetch returns an empty list.
      serverPendingExpenses = [];
      throw err;
    });

    const user = userEvent.setup();
    render(<AdminConsolePage />);

    await waitFor(() => {
      expect(screen.getByText(/Patient refreshment supplies/)).toBeInTheDocument();
    });

    const approveBtn = screen.getByRole("button", {
      name: /Approve Patient refreshment supplies/,
    });
    await user.click(approveBtn);

    // Surfaced the real error to the admin.
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalled();
    });
    // Row pruned and counter decremented to 0 even though the PATCH 4xx'd.
    await waitFor(() => {
      expect(
        screen.queryByText(/Patient refreshment supplies/),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/Expenses \(0\)/)).toBeInTheDocument();
    });
  });

  it("Issue #936: Approve button disables while the PATCH is in flight", async () => {
    const expenses = [
      { id: "e1", description: "Patient refreshment supplies", amount: 1767 },
    ];
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/expenses")) return Promise.resolve({ data: expenses });
      return Promise.resolve(defaultGet(url));
    });
    // Hold the PATCH open so we can observe the disabled state.
    let resolvePatch: (v: unknown) => void = () => {};
    apiMock.patch.mockReturnValue(
      new Promise((resolve) => {
        resolvePatch = resolve;
      }),
    );

    const user = userEvent.setup();
    render(<AdminConsolePage />);

    await waitFor(() => {
      expect(screen.getByText(/Patient refreshment supplies/)).toBeInTheDocument();
    });

    const approveBtn = screen.getByRole("button", {
      name: /Approve Patient refreshment supplies/,
    });
    expect(approveBtn).not.toBeDisabled();
    await user.click(approveBtn);

    await waitFor(() => {
      const busy = screen.getByRole("button", {
        name: /Approve Patient refreshment supplies/,
      });
      expect(busy).toBeDisabled();
    });

    // Double-click while busy must not fire a second PATCH.
    await user.click(approveBtn);
    expect(apiMock.patch).toHaveBeenCalledTimes(1);

    // Resolve to let the test exit cleanly.
    resolvePatch({ data: { id: "e1", approvalStatus: "APPROVED" } });
    await waitFor(() => {
      expect(
        screen.queryByText(/Patient refreshment supplies/),
      ).not.toBeInTheDocument();
    });
  });

  it("Issue #48: Today Snapshot renders newPatients count from API", async () => {
    render(<AdminConsolePage />);
    // The Snap widget formats numeric values via toLocaleString("en-IN").
    // For 12 that renders as "12". Walk up from the label to the outer
    // card (two levels: span/text → header div → card div) and assert
    // the card body contains the API value.
    await waitFor(() => {
      const registeredLabel = screen.getByText(/registered/i);
      // closest() on the text node's parent element walks to .rounded-lg.
      const card = registeredLabel.closest("div.rounded-lg");
      expect(card).toBeTruthy();
      expect(card?.textContent).toMatch(/12/);
    });
  });
});
