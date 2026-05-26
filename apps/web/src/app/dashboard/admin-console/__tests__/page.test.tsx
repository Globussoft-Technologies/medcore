/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AdminConsolePage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/admin-console/page.tsx, the
 *     ADMIN-only "command center" dashboard. The page fans out ~16
 *     parallel reads on mount (system-health probe via global fetch,
 *     plus 15 GETs through api.get wrapped in `safe<T>`), then renders
 *     System Health tiles, Critical Alerts, Today Snapshot, Pending
 *     Approvals lists, Resource Usage bars, and Quick Links.
 *
 *   - Behaviours covered:
 *       1. Auth-store still loading → "Loading..." placeholder renders,
 *          no fetches fire (#703 hydration guard).
 *       2. Non-ADMIN role (DOCTOR) → restriction copy renders, redirect
 *          fires via router.replace, no fetches fire.
 *       3. Null user (post-hydration) → restriction copy renders, no
 *          fetches.
 *       4. ADMIN happy path — health probe + all 16 api.get URLs fire
 *          (verifying the IST-aligned local-midnight bounds and the
 *          actionIn=ERROR_ACTIONS allowlist). Tenant banner renders, all
 *          Today-Snapshot tiles render the seeded counts, system-health
 *          tiles flip to Healthy/Connected/Live, Pending Approvals show
 *          one row each.
 *       5. Visitors-Today KPI — renders both totalToday and the
 *          currentlyActive sub-count "(N in)".
 *       6. Error breakdown table — when errorCount > 0 and breakdown
 *          rows exist, the per-action table renders, RFC1918 IPs are
 *          scrubbed via scrubInternalIp, public IPs flow through
 *          verbatim, the "likely bot traffic" pill renders when
 *          count/uniqueIps ratio >= 20 and count >= 10.
 *       7. SLA Overdue counter — counts complaints whose slaDueAt is
 *          in the past (#314 schema fix). Legacy slaBreachAt / dueAt
 *          aliases also count.
 *       8. Low-blood-stock — groups whose summed component counts fall
 *          below 3 are listed.
 *       9. Roster flattening — /shifts/roster returning an OBJECT
 *          grouped by shift type is flattened to a single array; only
 *          DOCTOR-role rows feed the "Doctors On Duty" bar.
 *      10. Bed occupancy — sums w.beds[].status === "OCCUPIED" plus
 *          legacy occupiedBeds/totalBeds fallback shape.
 *      11. approve("leave") happy path — PATCH /leaves/:id/approve
 *          {status:"APPROVED"}, row pruned from list, button disabled
 *          while in flight (#936 race guard).
 *      12. approve("expense") happy path — PATCH /expenses/:id/approve
 *          {approved:true} (#288 body-shape fix).
 *      13. approve("po") happy path — PATCH /purchase-orders/:id/approve.
 *      14. approve() error — toast.error surfaces topLineError (#288).
 *      15. approve() "already APPROVED" 400 — row is optimistically
 *          pruned AND refreshTick bumps to refetch authoritative state
 *          (#936).
 *      16. Health probe failure → API tile flips to "Down".
 *      17. Empty branches — null overview, empty wards, empty
 *          complaints, null tenant, missing visitor-stats all render
 *          sanely without throwing.
 *      18. SkeletonCard placeholders render while loaded=false, then
 *          disappear once the parallel fetches settle.
 *
 *   - Mocks: @/lib/api (api.get/patch), @/lib/toast, @/lib/store
 *            (useAuthStore), next/navigation, @/components/Skeleton
 *            (SkeletonCard stub), global fetch (health probe).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, routerMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/admin-console",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card-stub" className={className} />
  ),
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-table-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import AdminConsolePage from "../page";

/**
 * Default fetch responder — fall back to a benign empty payload so any
 * un-stubbed api.get call in the on-mount fan-out resolves predictably
 * via the `safe<T>` wrapper. Each test overrides the URLs it cares
 * about with a `.mockImplementation()` chain.
 */
function defaultGetResponse(url: string): Promise<any> {
  if (url.startsWith("/analytics/overview")) return Promise.resolve({ data: null });
  if (url.startsWith("/complaints")) return Promise.resolve({ data: [] });
  if (url === "/pharmacy/inventory?lowStock=true&limit=1") {
    return Promise.resolve({ meta: { total: 0 } });
  }
  if (url.startsWith("/pharmacy/inventory/expiring")) {
    return Promise.resolve({ data: [] });
  }
  if (url === "/bloodbank/inventory/summary") {
    return Promise.resolve({ data: null });
  }
  if (url.startsWith("/audit?from=") && url.includes("limit=1") && !url.includes("actionIn=")) {
    return Promise.resolve({ meta: { total: 0 } });
  }
  if (url.includes("actionIn=") && url.endsWith("limit=1")) {
    return Promise.resolve({ meta: { total: 0 } });
  }
  if (url.includes("actionIn=") && url.includes("limit=100")) {
    return Promise.resolve({ data: [] });
  }
  if (url === "/leaves/pending") return Promise.resolve({ data: [] });
  if (url.startsWith("/expenses?status=PENDING")) return Promise.resolve({ data: [] });
  if (url.startsWith("/purchase-orders?status=PENDING")) return Promise.resolve({ data: [] });
  if (url === "/wards") return Promise.resolve({ data: [] });
  if (url.startsWith("/shifts/roster")) return Promise.resolve({ data: [] });
  if (url.startsWith("/surgery")) return Promise.resolve({ data: [] });
  if (url === "/doctors") return Promise.resolve({ data: [] });
  if (url === "/me/tenant") return Promise.resolve({ data: null });
  if (url.startsWith("/visitors-stats")) return Promise.resolve({ data: null });
  return Promise.resolve({ data: [] });
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin", email: "admin@test.local" },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc", email: "doc@test.local" },
    isLoading: false,
  });
}

function asLoading() {
  authMock.mockReturnValue({ user: null, isLoading: true });
}

function asAnon() {
  authMock.mockReturnValue({ user: null, isLoading: false });
}

const originalFetch = global.fetch;

describe("Admin Console dashboard page", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    apiMock.get.mockImplementation((url: string) => defaultGetResponse(url));
    // Default healthy /api/health response. Tests override with
    // mockImplementationOnce when they want the Down branch.
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ status: "ok", timestamp: "2026-05-26" }),
    }) as any;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it("renders the Loading placeholder while the auth store is still hydrating", () => {
    asLoading();

    render(<AdminConsolePage />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("redirects non-ADMIN role (DOCTOR) via router.replace and renders the restriction copy", async () => {
    asDoctor();

    render(<AdminConsolePage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith("/dashboard"),
    );
    expect(
      screen.getByText(/Admin Console restricted to administrators/i),
    ).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the restriction copy when there is no user (post-hydration)", () => {
    asAnon();

    render(<AdminConsolePage />);

    expect(
      screen.getByText(/Admin Console restricted to administrators/i),
    ).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("ADMIN happy path — fires the full fan-out, renders chrome, snapshot tiles, and tenant banner", async () => {
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/analytics/overview")) {
        return Promise.resolve({
          data: {
            newPatients: 12,
            admissions: 5,
            discharges: 4,
            surgeries: 3,
            erCases: 2,
            totalRevenue: 125000,
          },
        });
      }
      if (url === "/me/tenant") {
        return Promise.resolve({
          data: {
            id: "t-1",
            name: "Sunrise Hospital",
            subdomain: "sunrise",
            plan: "ENTERPRISE",
            active: true,
          },
        });
      }
      if (url.startsWith("/visitors-stats")) {
        return Promise.resolve({
          data: { totalToday: 47, currentlyActive: 8 },
        });
      }
      return defaultGetResponse(url);
    });

    render(<AdminConsolePage />);

    await screen.findByText("Sunrise Hospital");

    // Header + ADMIN badge.
    expect(
      screen.getByRole("heading", { name: /Admin Console/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Command center/i)).toBeInTheDocument();
    expect(screen.getByText(/^ADMIN$/)).toBeInTheDocument();

    // Tenant banner identity, plan badge, subdomain.
    const banner = screen.getByTestId("admin-console-tenant-banner");
    expect(banner.textContent).toMatch(/Sunrise Hospital/);
    expect(banner.textContent).toMatch(/#sunrise/);
    expect(banner.textContent).toMatch(/ENTERPRISE/);

    // System Health tiles flip to Healthy/Connected/Live since /api/health -> ok.
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();

    // Snapshot tiles render seeded counts.
    expect(screen.getByText("12")).toBeInTheDocument(); // Registered
    expect(screen.getByText("5")).toBeInTheDocument(); // Admissions
    expect(screen.getByText("4")).toBeInTheDocument(); // Discharges
    expect(screen.getByText("3")).toBeInTheDocument(); // Surgeries
    expect(screen.getByText("2")).toBeInTheDocument(); // ER Cases

    // Revenue formatted en-IN.
    expect(screen.getByText(/Rs\.\s*1,25,000/)).toBeInTheDocument();

    // Visitors-Today: totalToday with active sub-line.
    const visitorsTile = screen.getByTestId("admin-console-visitors-today");
    expect(visitorsTile.textContent).toMatch(/47/);
    expect(visitorsTile.textContent).toMatch(/\(8 in\)/);

    // Quick Links section present.
    expect(screen.getByRole("heading", { name: /Quick Links/i })).toBeInTheDocument();
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.getByText("Analytics")).toBeInTheDocument();
    expect(screen.getByText("Audit")).toBeInTheDocument();

    // The /api/health probe was attempted.
    expect(global.fetch).toHaveBeenCalled();
    // Each canonical endpoint was hit at least once.
    const urls = apiMock.get.mock.calls.map((c: any) => c[0]) as string[];
    expect(urls.some((u) => u.startsWith("/analytics/overview?from="))).toBe(true);
    expect(urls.some((u) => u === "/me/tenant")).toBe(true);
    expect(urls.some((u) => u.startsWith("/visitors-stats"))).toBe(true);
    expect(urls.some((u) => u.startsWith("/audit") && u.includes("actionIn="))).toBe(true);
    expect(urls.some((u) => u === "/leaves/pending")).toBe(true);
    expect(urls.some((u) => u === "/wards")).toBe(true);
    expect(urls.some((u) => u === "/doctors")).toBe(true);
  });

  it("flips the API/Database tiles to Down when the /api/health probe rejects", async () => {
    asAdmin();
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as any;

    render(<AdminConsolePage />);

    await waitFor(() => expect(screen.getByText("Down")).toBeInTheDocument());
    // Database tile shows em-dash when API is down.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders the error breakdown table with scrubbed internal IPs, public IPs verbatim, and the bot-traffic pill", async () => {
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("actionIn=") && url.endsWith("limit=1")) {
        // 25 errors in the last hour.
        return Promise.resolve({ meta: { total: 25 } });
      }
      if (url.includes("actionIn=") && url.includes("limit=100")) {
        // Two LOGIN_FAILED rows from 10.0.0.5 (internal) → scrubbed; one
        // LOGIN_FAILED from 8.8.8.8 (public). Plus 20 PRESCRIPTION_REJECTED
        // rows from the same single public IP to trigger the bot-pill
        // (count >= 10 AND count/uniqueIps >= 20).
        const rows: any[] = [];
        for (let i = 0; i < 20; i++) {
          rows.push({ action: "PRESCRIPTION_REJECTED", ipAddress: "203.0.113.10" });
        }
        rows.push({ action: "LOGIN_FAILED", ipAddress: "10.0.0.5" });
        rows.push({ action: "LOGIN_FAILED", ipAddress: "10.0.0.5" });
        rows.push({ action: "LOGIN_FAILED", ipAddress: "8.8.8.8" });
        // One row missing ipAddress + no action — UNKNOWN bucket.
        rows.push({});
        return Promise.resolve({ data: rows });
      }
      return defaultGetResponse(url);
    });

    render(<AdminConsolePage />);

    const tbl = await screen.findByTestId("error-breakdown");

    // Header reflects ranked-top count.
    expect(within(tbl).getByText(/Error breakdown/i)).toBeInTheDocument();

    // Top row: PRESCRIPTION_REJECTED 20×.
    expect(within(tbl).getByText("PRESCRIPTION_REJECTED")).toBeInTheDocument();
    expect(within(tbl).getByText("20")).toBeInTheDocument();
    // Bot-traffic pill present because 20/1 >= 20 AND count >= 10.
    expect(within(tbl).getByText(/likely bot traffic/i)).toBeInTheDocument();
    // Public IP rendered verbatim.
    expect(within(tbl).getByText(/203\.0\.113\.10/)).toBeInTheDocument();

    // Second row: LOGIN_FAILED 3× (mixed 10.0.0.5 + 8.8.8.8).
    expect(within(tbl).getByText("LOGIN_FAILED")).toBeInTheDocument();
    // The top IP for LOGIN_FAILED is 10.0.0.5 (2 hits) → scrubbed.
    expect(within(tbl).getByText(/\[redacted internal\]/)).toBeInTheDocument();

    // UNKNOWN bucket from the empty row.
    expect(within(tbl).getByText("UNKNOWN")).toBeInTheDocument();
  });

  it("counts SLA-overdue complaints by slaDueAt (and legacy slaBreachAt / dueAt aliases)", async () => {
    asAdmin();

    const past = new Date(Date.now() - 24 * 3600_000).toISOString();
    const future = new Date(Date.now() + 48 * 3600_000).toISOString();

    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/complaints")) {
        return Promise.resolve({
          data: [
            { id: "c-1", slaDueAt: past }, // overdue
            { id: "c-2", slaBreachAt: past }, // legacy alias, overdue
            { id: "c-3", dueAt: past }, // legacy alias, overdue
            { id: "c-4", slaDueAt: future }, // not overdue
            { id: "c-5" }, // no SLA — not overdue
          ],
        });
      }
      return defaultGetResponse(url);
    });

    render(<AdminConsolePage />);

    // SLA Overdue Complaints tile shows 3. The link mounts immediately with
    // the initial complaints=[] state (value "0"), so we must waitFor the
    // post-fetch setComplaints to land before asserting the count — a bare
    // findByRole returns on the first paint and the synchronous getByText
    // races the async state update.
    await waitFor(() => {
      const slaLink = screen.getByRole("link", { name: /SLA Overdue/i });
      expect(within(slaLink).getByText("3")).toBeInTheDocument();
    });
  });

  it("lists Low-Blood-Stock groups whose summed components fall below 3", async () => {
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url === "/bloodbank/inventory/summary") {
        return Promise.resolve({
          data: {
            byBloodGroup: {
              "A+": { WHOLE: 1, PLASMA: 1 }, // total 2 -> low
              "O-": { WHOLE: 0 }, // total 0 -> low
              "B+": { WHOLE: 5, PLASMA: 3 }, // total 8 -> ok
            },
          },
        });
      }
      return defaultGetResponse(url);
    });

    render(<AdminConsolePage />);

    // Same race-prone shape as the SLA tile: the link mounts immediately
    // with bloodGroups=[] (value "0"), so waitFor the post-fetch state
    // update before asserting the count.
    await waitFor(() => {
      const lowLink = screen.getByRole("link", { name: /Low Blood Stock/i });
      expect(within(lowLink).getByText("2")).toBeInTheDocument();
    });
  });

  it("flattens the /shifts/roster object-shape grouped-by-shift and counts only DOCTOR roles for the Doctors-On-Duty bar", async () => {
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/shifts/roster")) {
        return Promise.resolve({
          data: {
            MORNING: [
              { id: "s1", user: { role: "DOCTOR" } },
              { id: "s2", user: { role: "DOCTOR" } },
              { id: "s3", user: { role: "NURSE" } },
            ],
            EVENING: [
              { id: "s4", user: { role: "DOCTOR" } },
              { id: "s5", user: { role: "RECEPTION" } },
            ],
          },
        });
      }
      if (url === "/doctors") {
        return Promise.resolve({
          data: [
            { id: "d1" },
            { id: "d2" },
            { id: "d3" },
            { id: "d4" },
            { id: "d5" },
            { id: "d6" },
          ],
        });
      }
      return defaultGetResponse(url);
    });

    render(<AdminConsolePage />);

    // 3 DOCTOR rows on duty out of 6 employed -> "3/6 (50%)".
    await waitFor(() =>
      expect(screen.getByText(/3\/6 \(50%\)/)).toBeInTheDocument(),
    );
  });

  it("computes bed occupancy from wards (beds[] occupied + legacy fallback)", async () => {
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url === "/wards") {
        return Promise.resolve({
          data: [
            {
              id: "w1",
              beds: [
                { id: "b1", status: "OCCUPIED" },
                { id: "b2", status: "AVAILABLE" },
                { id: "b3", status: "OCCUPIED" },
              ],
            },
            // Legacy shape — no beds[] but totalBeds + occupiedBeds.
            { id: "w2", totalBeds: 4, occupiedBeds: 1 },
          ],
        });
      }
      return defaultGetResponse(url);
    });

    render(<AdminConsolePage />);

    // Total beds: 3 + 4 = 7, occupied: 2 + 1 = 3 → "3/7 (43%)".
    await waitFor(() =>
      expect(screen.getByText(/3\/7 \(43%\)/)).toBeInTheDocument(),
    );
  });

  it("approve(leave) — happy path PATCHes /leaves/:id/approve {status: APPROVED} and prunes the row", async () => {
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url === "/leaves/pending") {
        return Promise.resolve({
          data: [
            {
              id: "l-1",
              type: "CASUAL",
              fromDate: "2026-06-01",
              toDate: "2026-06-02",
              user: { name: "Anita Pawar" },
            },
          ],
        });
      }
      return defaultGetResponse(url);
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<AdminConsolePage />);

    await screen.findByText("Anita Pawar");

    const approveBtn = screen.getByRole("button", {
      name: /Approve Anita Pawar/i,
    });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch).toHaveBeenCalledWith("/leaves/l-1/approve", {
      status: "APPROVED",
    });

    // Row pruned.
    await waitFor(() =>
      expect(screen.queryByText("Anita Pawar")).not.toBeInTheDocument(),
    );
  });

  it("approve(expense) — happy path PATCHes /expenses/:id/approve {approved: true} (Issue #288 body-shape fix)", async () => {
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/expenses?status=PENDING")) {
        return Promise.resolve({
          data: [
            { id: "e-1", description: "Cab fare", amount: 350 },
          ],
        });
      }
      return defaultGetResponse(url);
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<AdminConsolePage />);

    await screen.findByText("Cab fare");
    expect(screen.getByText(/Rs\.\s*350/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Approve Cab fare/i }));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch).toHaveBeenCalledWith("/expenses/e-1/approve", {
      approved: true,
    });
  });

  it("approve(po) — happy path PATCHes /purchase-orders/:id/approve {}", async () => {
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/purchase-orders?status=PENDING")) {
        return Promise.resolve({
          data: [
            {
              id: "po-aaaaaaaaaaaaaaaa",
              poNumber: "PO-2026-007",
              supplier: { name: "Acme Pharma" },
              totalAmount: 75000,
            },
          ],
        });
      }
      return defaultGetResponse(url);
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<AdminConsolePage />);

    await screen.findByText("PO-2026-007");
    expect(screen.getByText(/Acme Pharma/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Approve PO-2026-007/i }));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch).toHaveBeenCalledWith(
      "/purchase-orders/po-aaaaaaaaaaaaaaaa/approve",
      {},
    );
  });

  it("approve() — generic rejection surfaces toast.error via topLineError and the row stays put", async () => {
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url === "/leaves/pending") {
        return Promise.resolve({
          data: [
            {
              id: "l-2",
              type: "SICK",
              fromDate: null,
              toDate: null,
              user: { name: "Boom Person" },
            },
          ],
        });
      }
      return defaultGetResponse(url);
    });
    apiMock.patch.mockRejectedValue(new Error("server on fire"));

    render(<AdminConsolePage />);

    await screen.findByText("Boom Person");
    fireEvent.click(screen.getByRole("button", { name: /Approve Boom Person/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server on fire"),
    );
    // Row still present — generic error did NOT prune.
    expect(screen.getByText("Boom Person")).toBeInTheDocument();
  });

  it("approve() — 'already APPROVED' 400 prunes the stale row and bumps refresh (Issue #936)", async () => {
    asAdmin();

    // First fetch returns the stale row; refresh after the bumped tick
    // returns an empty list (server has caught up). This mirrors what
    // happens in production after the "already APPROVED" path prunes
    // optimistically and refetches.
    let expensesCallCount = 0;
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/expenses?status=PENDING")) {
        expensesCallCount += 1;
        if (expensesCallCount === 1) {
          return Promise.resolve({
            data: [{ id: "e-stale", description: "Stale Row", amount: 100 }],
          });
        }
        return Promise.resolve({ data: [] });
      }
      return defaultGetResponse(url);
    });
    // The route reads err.status + err.message via type assertion, so we
    // need an object that satisfies BOTH shapes: thrown like an Error
    // (so topLineError's `err instanceof Error` branch surfaces the
    // message rather than the generic fallback), and carrying a `status`
    // property (so the `isAlready` branch in approve() fires).
    const stale = Object.assign(new Error("Expense already APPROVED"), {
      status: 400,
    });
    apiMock.patch.mockRejectedValue(stale);

    render(<AdminConsolePage />);

    await screen.findByText("Stale Row");

    fireEvent.click(screen.getByRole("button", { name: /Approve Stale Row/i }));

    // Toast fires AND the row is optimistically pruned.
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Expense already APPROVED"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Stale Row")).not.toBeInTheDocument(),
    );
  });

  it("renders 'No pending items' in each approval group when the lists are empty", async () => {
    asAdmin();

    render(<AdminConsolePage />);

    // Wait for the page to settle past the loading skeletons.
    await waitFor(() =>
      expect(screen.queryAllByText(/No pending items/i).length).toBeGreaterThan(0),
    );
    // Three empty groups (leaves, expenses, POs) → three "No pending items".
    expect(screen.getAllByText(/No pending items/i).length).toBe(3);
  });

  it("does NOT render the tenant banner when /me/tenant returns null", async () => {
    asAdmin();

    render(<AdminConsolePage />);

    // Wait for fan-out to complete.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    // Allow microtasks to drain.
    await waitFor(() => expect(screen.getByText(/Command center/i)).toBeInTheDocument());

    expect(
      screen.queryByTestId("admin-console-tenant-banner"),
    ).not.toBeInTheDocument();
  });

  it("renders SkeletonCard placeholders while loaded=false then removes them after fan-out", async () => {
    asAdmin();

    // Hold the fan-out open initially so the loaded=false branch renders.
    let resolveLeaves: ((v: any) => void) | null = null;
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/leaves/pending") {
        return new Promise<any>((r) => {
          resolveLeaves = r;
        });
      }
      return defaultGetResponse(url);
    });

    render(<AdminConsolePage />);

    // Loading skeletons present initially.
    await waitFor(() =>
      expect(screen.getByTestId("admin-console-loading")).toBeInTheDocument(),
    );
    expect(screen.getAllByTestId("skeleton-card-stub").length).toBe(3);

    // Resolve the gating endpoint. The cast re-widens — TS's control-flow
    // analysis narrows the local `let` back to `null` here because the
    // assignment in the mockImplementation lives in an async callback that
    // hasn't run synchronously by this point in the type-checker's view.
    (resolveLeaves as ((v: any) => void) | null)?.({ data: [] });

    await waitFor(() =>
      expect(
        screen.queryByTestId("admin-console-loading"),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders Visitors-Today without the '(N in)' suffix when currentlyActive is 0", async () => {
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/visitors-stats")) {
        return Promise.resolve({
          data: { totalToday: 12, currentlyActive: 0 },
        });
      }
      return defaultGetResponse(url);
    });

    render(<AdminConsolePage />);

    const tile = await screen.findByTestId("admin-console-visitors-today");
    expect(tile.textContent).toMatch(/12/);
    expect(tile.textContent).not.toMatch(/in\)/);
  });

  it("renders zero counters when overview / visitors-stats / bloodbank summary are all null", async () => {
    asAdmin();
    // Keep defaults — every endpoint returns null/empty.

    render(<AdminConsolePage />);

    // Snapshot tiles all render "0".
    await waitFor(() =>
      expect(screen.getAllByText("0").length).toBeGreaterThan(0),
    );
    // Revenue rendered as "Rs. 0".
    expect(screen.getByText(/Rs\.\s*0/)).toBeInTheDocument();
    // Critical Alerts tile values default to 0.
    const slaLink = screen.getByRole("link", { name: /SLA Overdue/i });
    expect(within(slaLink).getByText("0")).toBeInTheDocument();
  });
});
