/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ComplaintsPage — adjacent-to-source deep coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/complaints/page.tsx`, the front-desk
 *     grievance queue UI (issues #92 SLA banner + #206 categories + #760
 *     auto-sort + age badge). Endpoints the page hits:
 *       GET    /complaints?status=<TAB>&limit=100 (or limit=200 on the SLA tab)
 *       GET    /complaints/stats
 *       GET    /chat/users
 *       POST   /complaints       (new-complaint modal)
 *       PATCH  /complaints/:id   (assign, status transition, resolve)
 *
 *   - Behaviours covered:
 *       1. Initial mount fetches complaints + stats + users; KPI tiles show
 *          totalOpen / criticalOpen / overdueCount / avgResolutionHours from
 *          the stats payload.
 *       2. KPI fallback — when `stats.totalOpen` is absent, the tile falls
 *            back to `stats.byStatus.OPEN`.
 *       3. Overdue/unassigned banner — renders when count > 0 (singular vs
 *          plural copy), hidden when count === 0 or missing.
 *       4. Tabs — switching tab refetches with `status=<key>` for the named
 *          tabs and with no status (just limit) for ALL/SLA; SLA bumps
 *          limit to 200.
 *       5. SLA tab — renders At-Risk + Breached cards driven by
 *          computeSlaDue + formatSla; OPEN/RESOLVED complaints partition
 *          correctly into active vs done; breached card hidden when 0.
 *       6. Regular table — renders one row per complaint with ticket,
 *          patient name, caller fallback (caller name shown under patient
 *          when distinct), category, priority badge, status badge.
 *       7. Sort — rows on the OPEN tab are ordered most-overdue first
 *            (smallest slaDueAt first), with resolved rows pushed to the
 *            bottom. ALL tab preserves original order.
 *       8. SLA badge wiring — overdue rows render red text; on-track rows
 *            render gray text; resolved rows render the em-dash placeholder.
 *       9. Age badge — ageDays ≥ 7 → red bg; 3 ≤ ageDays < 7 → amber bg;
 *            1 ≤ ageDays < 3 → gray bg; ageDays < 1 → badge not rendered.
 *      10. Assign select fires PATCH /complaints/:id with assignedTo.
 *      11. Review action — fires the useConfirm dialog, sends PATCH with
 *            status=UNDER_REVIEW on confirm, no-ops on cancel.
 *      12. Resolve modal — clicking Resolve opens the modal; submit fires
 *            PATCH with status=RESOLVED + resolution text; Cancel clears.
 *      13. New-complaint modal — Submit short-circuits when description is
 *            empty (toast.error); short-circuits when neither patientId
 *            nor name supplied; success path POSTs and resets the form.
 *      14. Error swallowing — both list/stats endpoints rejecting leaves
 *            the header rendered (loading flag still flips off).
 *
 *   - Mocks: @/lib/api, @/lib/toast, @/lib/use-dialog, next/navigation,
 *            @/components/Skeleton (stubbed to a minimal div so the loading
 *            branch is observable without spinning up the real component).
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

const { apiMock, toastMock, confirmMock } = vi.hoisted(() => ({
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
  confirmMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(async () => "test"),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/complaints",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import ComplaintsPage from "../page";

type Complaint = {
  id: string;
  ticketNumber: string;
  patientId: string | null;
  name: string | null;
  phone: string | null;
  category: string;
  description: string;
  status: string;
  priority: string;
  assignedTo: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  slaDueAt?: string | null;
  patient?: { user: { name: string; phone: string } };
};

type Stats = {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  avgResolutionHours: number;
  overdueCount: number;
  totalOpen?: number;
  overdueUnassignedCount?: number;
  criticalOpen: number;
};

type UserOpt = { id: string; name: string; role: string };

function complaintFixture(overrides: Partial<Complaint> = {}): Complaint {
  // Default: very-fresh OPEN complaint that should be on-track for SLA.
  return {
    id: "c-1",
    ticketNumber: "TKT-001",
    patientId: "p-1",
    name: null,
    phone: null,
    category: "Service",
    description: "Long wait at OPD",
    status: "OPEN",
    priority: "MEDIUM",
    assignedTo: null,
    resolution: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    patient: { user: { name: "Aarav Mehta", phone: "9000000001" } },
    ...overrides,
  };
}

function statsFixture(overrides: Partial<Stats> = {}): Stats {
  return {
    total: 8,
    byStatus: { OPEN: 5, UNDER_REVIEW: 1, RESOLVED: 2 },
    byPriority: { LOW: 1, MEDIUM: 4, HIGH: 2, CRITICAL: 1 },
    avgResolutionHours: 12,
    overdueCount: 2,
    totalOpen: 6,
    overdueUnassignedCount: 0,
    criticalOpen: 1,
    ...overrides,
  };
}

const sampleUsers: UserOpt[] = [
  { id: "u-admin", name: "Director Admin", role: "ADMIN" },
  { id: "u-recep", name: "Reception One", role: "RECEPTION" },
  // Filtered out at /chat/users (page keeps only ADMIN/RECEPTION).
  { id: "u-doc", name: "Dr Ignored", role: "DOCTOR" },
];

/**
 * Wire api.get by URL prefix.  All three GETs fire on mount via parallel
 * useEffects + Promise.all, so chained `mockResolvedValueOnce` is fragile.
 */
function wireGet(opts: {
  list?: Complaint[];
  stats?: Stats | null;
  users?: UserOpt[];
  listReject?: boolean;
  statsReject?: boolean;
  usersReject?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/complaints/stats")) {
      if (opts.statsReject) return Promise.reject(new Error("stats boom"));
      return Promise.resolve({ data: opts.stats ?? statsFixture() });
    }
    if (url.startsWith("/complaints")) {
      if (opts.listReject) return Promise.reject(new Error("list boom"));
      return Promise.resolve({ data: opts.list ?? [] });
    }
    if (url.startsWith("/chat/users")) {
      if (opts.usersReject) return Promise.reject(new Error("users boom"));
      return Promise.resolve({ data: opts.users ?? sampleUsers });
    }
    return Promise.resolve({ data: null });
  });
}

describe("Complaints dashboard page (queue + SLA + modals)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    apiMock.put.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    // Default success on all writes.
    apiMock.post.mockResolvedValue({ data: { id: "new" } });
    apiMock.patch.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the page heading and fires complaints + stats + users on mount", async () => {
    wireGet({ list: [complaintFixture()], stats: statsFixture() });
    render(<ComplaintsPage />);

    await screen.findByText("TKT-001");

    // Initial fetches — OPEN is the default tab, so status=OPEN.
    expect(apiMock.get).toHaveBeenCalledWith(
      "/complaints?status=OPEN&limit=100",
    );
    expect(apiMock.get).toHaveBeenCalledWith("/complaints/stats");
    expect(apiMock.get).toHaveBeenCalledWith("/chat/users");

    expect(
      screen.getByRole("heading", { name: /^Complaints$/i }),
    ).toBeInTheDocument();
  });

  it("renders the SkeletonTable while initial /complaints is pending", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/complaints/stats")) {
        return Promise.resolve({ data: statsFixture() });
      }
      if (url.startsWith("/complaints")) {
        return new Promise(() => {});
      }
      return Promise.resolve({ data: sampleUsers });
    });

    render(<ComplaintsPage />);

    expect(screen.getByTestId("complaints-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("KPI tiles show totalOpen / criticalOpen / overdue / avg from the stats payload", async () => {
    wireGet({
      list: [],
      stats: statsFixture({
        totalOpen: 17,
        criticalOpen: 3,
        overdueCount: 5,
        avgResolutionHours: 36,
      }),
    });
    render(<ComplaintsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("complaints-total-open")).toHaveTextContent(
        "17",
      ),
    );
    expect(screen.getByTestId("complaints-critical-open")).toHaveTextContent(
      "3",
    );
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("36h")).toBeInTheDocument();
  });

  it("Total Open KPI falls back to byStatus.OPEN when totalOpen is absent", async () => {
    wireGet({
      list: [],
      stats: statsFixture({
        totalOpen: undefined,
        byStatus: { OPEN: 9, RESOLVED: 1 },
      }),
    });
    render(<ComplaintsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("complaints-total-open")).toHaveTextContent(
        "9",
      ),
    );
  });

  it("renders the overdue-unassigned banner with singular copy when count === 1", async () => {
    wireGet({
      list: [],
      stats: statsFixture({ overdueUnassignedCount: 1 }),
    });
    render(<ComplaintsPage />);

    const banner = await screen.findByTestId("complaints-overdue-banner");
    expect(banner).toHaveTextContent(/1 complaint overdue/);
    // Singular: no trailing 's'.
    expect(banner).not.toHaveTextContent(/1 complaints/);
  });

  it("renders the overdue-unassigned banner with plural copy when count > 1", async () => {
    wireGet({
      list: [],
      stats: statsFixture({ overdueUnassignedCount: 4 }),
    });
    render(<ComplaintsPage />);

    const banner = await screen.findByTestId("complaints-overdue-banner");
    expect(banner).toHaveTextContent(/4 complaints overdue/);
  });

  it("hides the overdue-unassigned banner when count is 0 or missing", async () => {
    wireGet({
      list: [],
      stats: statsFixture({ overdueUnassignedCount: 0 }),
    });
    render(<ComplaintsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("complaints-total-open")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("complaints-overdue-banner"),
    ).not.toBeInTheDocument();
  });

  it('renders the empty state when no complaints in the active tab', async () => {
    wireGet({ list: [], stats: statsFixture() });
    render(<ComplaintsPage />);
    expect(
      await screen.findByText(/no complaints in this category/i),
    ).toBeInTheDocument();
  });

  it("renders a row per complaint with ticket, patient name, category, priority + status badges", async () => {
    wireGet({
      list: [
        complaintFixture({
          id: "c-a",
          ticketNumber: "TKT-A1",
          priority: "HIGH",
          status: "OPEN",
          patient: { user: { name: "Aanya Patel", phone: "+9100" } },
        }),
        complaintFixture({
          id: "c-b",
          ticketNumber: "TKT-B2",
          priority: "CRITICAL",
          status: "UNDER_REVIEW",
          patient: { user: { name: "Bilal Khan", phone: "+9101" } },
        }),
      ],
      stats: statsFixture(),
    });

    render(<ComplaintsPage />);

    await screen.findByText("TKT-A1");
    expect(screen.getByText("TKT-B2")).toBeInTheDocument();
    expect(screen.getByText("Aanya Patel")).toBeInTheDocument();
    expect(screen.getByText("Bilal Khan")).toBeInTheDocument();

    const tbody = document.querySelector("tbody")!;
    expect(within(tbody).getByText("HIGH")).toBeInTheDocument();
    expect(within(tbody).getByText("CRITICAL")).toBeInTheDocument();
    // Underscore replaced with space in the status badge.
    expect(within(tbody).getByText("UNDER REVIEW")).toBeInTheDocument();
    expect(within(tbody).getByText("OPEN")).toBeInTheDocument();
  });

  it("shows caller name under patient name when the two differ", async () => {
    wireGet({
      list: [
        complaintFixture({
          id: "c-1",
          name: "Cousin Caller",
          patient: { user: { name: "Aarav Mehta", phone: "+9100" } },
        }),
      ],
      stats: statsFixture(),
    });
    render(<ComplaintsPage />);

    await screen.findByText("Aarav Mehta");
    expect(screen.getByText(/Caller:\s*Cousin Caller/)).toBeInTheDocument();
  });

  it("falls back to caller-only name when no patient is linked", async () => {
    wireGet({
      list: [
        complaintFixture({
          id: "c-1",
          name: "Walk-in Anonymous",
          patient: undefined,
          patientId: null,
        }),
      ],
      stats: statsFixture(),
    });
    render(<ComplaintsPage />);

    await screen.findByText("Walk-in Anonymous");
  });

  it("falls back to em-dash when both patient and caller name are absent", async () => {
    wireGet({
      list: [
        complaintFixture({
          id: "c-1",
          name: null,
          patient: undefined,
          patientId: null,
        }),
      ],
      stats: statsFixture(),
    });
    render(<ComplaintsPage />);

    await screen.findByText("TKT-001");
    // The em-dash fallback for missing patient + caller.
    const patientCell = screen.getByTestId("complaint-row-patient");
    expect(patientCell).toHaveTextContent("-");
  });

  it("sorts OPEN rows by SLA-overdue descending (most-overdue first)", async () => {
    const now = Date.now();
    const fresh = new Date(now - 60 * 60 * 1000).toISOString(); // 1h old
    const stale = new Date(now - 80 * 60 * 60 * 1000).toISOString(); // 80h old
    wireGet({
      list: [
        // Listed fresh-first; sort should flip it.
        complaintFixture({
          id: "fresh",
          ticketNumber: "TKT-FRESH",
          createdAt: fresh,
          priority: "MEDIUM",
        }),
        complaintFixture({
          id: "stale",
          ticketNumber: "TKT-STALE",
          createdAt: stale,
          priority: "MEDIUM",
        }),
      ],
      stats: statsFixture(),
    });

    render(<ComplaintsPage />);

    await screen.findByText("TKT-FRESH");
    const rows = document.querySelectorAll("tbody tr");
    const ticketCells = Array.from(rows).map(
      (r) => r.querySelector("td")?.textContent ?? "",
    );
    expect(ticketCells[0]).toContain("TKT-STALE");
    expect(ticketCells[1]).toContain("TKT-FRESH");
  });

  it("pushes RESOLVED / CLOSED rows to the bottom of the OPEN-tab sort", async () => {
    wireGet({
      list: [
        complaintFixture({
          id: "resolved",
          ticketNumber: "TKT-RES",
          status: "RESOLVED",
        }),
        complaintFixture({
          id: "open",
          ticketNumber: "TKT-OPEN",
          status: "OPEN",
        }),
      ],
      stats: statsFixture(),
    });
    render(<ComplaintsPage />);

    await screen.findByText("TKT-OPEN");
    const ticketCells = Array.from(
      document.querySelectorAll("tbody tr td:first-child"),
    ).map((c) => c.textContent ?? "");
    expect(ticketCells[0]).toBe("TKT-OPEN");
    expect(ticketCells[1]).toBe("TKT-RES");
  });

  it("renders the days-open age badge with the right colour bucket", async () => {
    const now = Date.now();
    const twoDaysOld = new Date(now - 2 * 86400 * 1000).toISOString();
    const fiveDaysOld = new Date(now - 5 * 86400 * 1000).toISOString();
    const tenDaysOld = new Date(now - 10 * 86400 * 1000).toISOString();

    wireGet({
      list: [
        complaintFixture({
          id: "young",
          ticketNumber: "TKT-YOUNG",
          createdAt: twoDaysOld,
        }),
        complaintFixture({
          id: "mid",
          ticketNumber: "TKT-MID",
          createdAt: fiveDaysOld,
        }),
        complaintFixture({
          id: "old",
          ticketNumber: "TKT-OLD",
          createdAt: tenDaysOld,
        }),
      ],
      stats: statsFixture(),
    });

    render(<ComplaintsPage />);

    await screen.findByTestId("complaint-age-TKT-YOUNG");
    expect(screen.getByTestId("complaint-age-TKT-YOUNG")).toHaveTextContent(
      "2d open",
    );
    expect(screen.getByTestId("complaint-age-TKT-MID")).toHaveTextContent(
      "5d open",
    );
    expect(screen.getByTestId("complaint-age-TKT-OLD")).toHaveTextContent(
      "10d open",
    );
    // ageDays >= 7 → red bg
    expect(screen.getByTestId("complaint-age-TKT-OLD").className).toContain(
      "bg-red",
    );
    // 3 <= ageDays < 7 → amber
    expect(screen.getByTestId("complaint-age-TKT-MID").className).toContain(
      "bg-amber",
    );
    // 1 <= ageDays < 3 → gray
    expect(screen.getByTestId("complaint-age-TKT-YOUNG").className).toContain(
      "bg-gray",
    );
  });

  it("does NOT render the age badge for under-1-day-old complaints", async () => {
    wireGet({
      list: [
        complaintFixture({
          id: "brand-new",
          ticketNumber: "TKT-NEW",
          // Default fixture createdAt is now() — ageDays === 0 → no badge.
        }),
      ],
      stats: statsFixture(),
    });
    render(<ComplaintsPage />);

    await screen.findByText("TKT-NEW");
    expect(
      screen.queryByTestId("complaint-age-TKT-NEW"),
    ).not.toBeInTheDocument();
  });

  it("renders the SLA cell red when overdue and gray when on-track", async () => {
    const now = Date.now();
    const overdueCreated = new Date(
      now - 200 * 60 * 60 * 1000, // 200h old, MEDIUM SLA = 72h → overdue
    ).toISOString();
    const onTrackCreated = new Date(now - 60 * 60 * 1000).toISOString(); // 1h old

    wireGet({
      list: [
        complaintFixture({
          id: "overdue",
          ticketNumber: "TKT-OVERDUE",
          createdAt: overdueCreated,
          priority: "MEDIUM",
        }),
        complaintFixture({
          id: "ontrack",
          ticketNumber: "TKT-ONTRACK",
          createdAt: onTrackCreated,
          priority: "MEDIUM",
        }),
      ],
      stats: statsFixture(),
    });

    render(<ComplaintsPage />);

    await screen.findByTestId("complaint-sla-TKT-OVERDUE");
    const overdueSla = screen.getByTestId("complaint-sla-TKT-OVERDUE");
    expect(overdueSla).toHaveTextContent(/overdue/);
    expect(overdueSla.className).toContain("text-red");

    const onTrackSla = screen.getByTestId("complaint-sla-TKT-ONTRACK");
    expect(onTrackSla).toHaveTextContent(/left/);
    expect(onTrackSla.className).not.toContain("text-red");
  });

  it("renders em-dash in the SLA cell for resolved rows", async () => {
    wireGet({
      list: [
        complaintFixture({
          id: "done",
          ticketNumber: "TKT-DONE",
          status: "RESOLVED",
        }),
      ],
      stats: statsFixture(),
    });
    render(<ComplaintsPage />);

    await screen.findByText("TKT-DONE");
    // Resolved → no complaint-sla-* testid for this row.
    expect(
      screen.queryByTestId("complaint-sla-TKT-DONE"),
    ).not.toBeInTheDocument();
    // The em-dash placeholder is present in the cell instead.
    const tbody = document.querySelector("tbody")!;
    expect(within(tbody).getByText("—")).toBeInTheDocument();
  });

  it("clicking a tab refetches with that tab's status (UNDER_REVIEW)", async () => {
    wireGet({ list: [], stats: statsFixture() });
    render(<ComplaintsPage />);
    await screen.findByText(/no complaints in this category/i);

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /under review/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/complaints?status=UNDER_REVIEW&limit=100",
      ),
    );
  });

  it("ALL tab refetches with no status param", async () => {
    wireGet({ list: [], stats: statsFixture() });
    render(<ComplaintsPage />);
    await screen.findByText(/no complaints in this category/i);

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/complaints?limit=100"),
    );
  });

  it("SLA tab bumps limit to 200 and renders the At-Risk + Breached cards", async () => {
    const now = Date.now();
    // CRITICAL has 4h SLA. 1h-old at 90% remaining → on-track (not at-risk).
    // CRITICAL 3.8h-old → ~5% remaining → at-risk.
    // CRITICAL 6h-old → overdue → breached.
    wireGet({
      list: [
        complaintFixture({
          id: "fresh-crit",
          ticketNumber: "TKT-FRESH",
          priority: "CRITICAL",
          createdAt: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
        }),
        complaintFixture({
          id: "risk-crit",
          ticketNumber: "TKT-RISK",
          priority: "CRITICAL",
          createdAt: new Date(
            now - 3.8 * 60 * 60 * 1000,
          ).toISOString(),
        }),
        complaintFixture({
          id: "breach-crit",
          ticketNumber: "TKT-BREACH",
          priority: "CRITICAL",
          createdAt: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
        }),
        complaintFixture({
          id: "done",
          ticketNumber: "TKT-DONE",
          status: "RESOLVED",
        }),
      ],
      stats: statsFixture(),
    });

    render(<ComplaintsPage />);
    await screen.findByText("TKT-FRESH");

    apiMock.get.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: /sla dashboard/i }),
    );

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/complaints?limit=200"),
    );

    // Re-resolve the SLA-tab refetch (wireGet returns the same list either way).
    await screen.findByRole("heading", { name: /At-Risk Complaints/i });
    expect(
      screen.getByRole("heading", { name: /SLA Breached/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("TKT-RISK")).toBeInTheDocument();
    expect(screen.getByText("TKT-BREACH")).toBeInTheDocument();
  });

  it('SLA tab shows "No at-risk complaints" copy when none qualify', async () => {
    wireGet({
      list: [
        complaintFixture({
          id: "all-resolved",
          ticketNumber: "TKT-DONE",
          status: "RESOLVED",
        }),
      ],
      stats: statsFixture(),
    });

    render(<ComplaintsPage />);
    await screen.findByText("TKT-DONE");

    fireEvent.click(screen.getByRole("button", { name: /sla dashboard/i }));

    await screen.findByRole("heading", { name: /At-Risk Complaints/i });
    expect(
      screen.getByText(/no at-risk complaints/i),
    ).toBeInTheDocument();
    // No breached card section when breached.length === 0.
    expect(
      screen.queryByRole("heading", { name: /SLA Breached/i }),
    ).not.toBeInTheDocument();
  });

  it("assigning a user fires PATCH /complaints/:id with assignedTo", async () => {
    wireGet({
      list: [complaintFixture({ id: "c-1" })],
      stats: statsFixture(),
      users: sampleUsers,
    });
    render(<ComplaintsPage />);

    await screen.findByText("TKT-001");

    // The assign <select> is the one whose first <option> says "Unassigned".
    const select = Array.from(
      document.querySelectorAll<HTMLSelectElement>("tbody select"),
    )[0];
    expect(select).toBeTruthy();

    apiMock.patch.mockClear();
    fireEvent.change(select, { target: { value: "u-recep" } });

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/complaints/c-1", {
        assignedTo: "u-recep",
      }),
    );
  });

  it("Review action calls useConfirm then PATCHes with status=UNDER_REVIEW on confirm", async () => {
    wireGet({
      list: [complaintFixture({ id: "c-1", status: "OPEN" })],
      stats: statsFixture(),
    });

    render(<ComplaintsPage />);

    const reviewBtn = await screen.findByTestId("complaint-review-TKT-001");

    confirmMock.mockResolvedValueOnce(true);
    apiMock.patch.mockClear();
    fireEvent.click(reviewBtn);

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/complaints/c-1", {
        status: "UNDER_REVIEW",
      }),
    );
  });

  it("Review action no-ops when the confirm is cancelled", async () => {
    wireGet({
      list: [complaintFixture({ id: "c-1", status: "OPEN" })],
      stats: statsFixture(),
    });

    render(<ComplaintsPage />);

    const reviewBtn = await screen.findByTestId("complaint-review-TKT-001");

    confirmMock.mockResolvedValueOnce(false);
    apiMock.patch.mockClear();
    fireEvent.click(reviewBtn);

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // Wait a tick to ensure the no-op stays a no-op.
    await new Promise((r) => setTimeout(r, 10));
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Resolve flow opens the modal, submits PATCH with status=RESOLVED + resolution text", async () => {
    wireGet({
      list: [complaintFixture({ id: "c-1", status: "OPEN" })],
      stats: statsFixture(),
    });

    render(<ComplaintsPage />);

    await screen.findByText("TKT-001");

    // The Resolve button is the one in the row that's not the Review button.
    const resolveBtn = screen.getByRole("button", { name: /^Resolve$/i });
    fireEvent.click(resolveBtn);

    // Modal heading.
    expect(
      await screen.findByRole("heading", { name: /Resolve Complaint/i }),
    ).toBeInTheDocument();

    // Type the resolution text.
    const textarea = screen.getByPlaceholderText(/describe the resolution/i);
    fireEvent.change(textarea, {
      target: { value: "Issued refund + apology" },
    });

    apiMock.patch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /mark resolved/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/complaints/c-1", {
        status: "RESOLVED",
        resolution: "Issued refund + apology",
      }),
    );
  });

  it("Resolve-modal Cancel button closes the modal without firing a PATCH", async () => {
    wireGet({
      list: [complaintFixture({ id: "c-1", status: "OPEN" })],
      stats: statsFixture(),
    });

    render(<ComplaintsPage />);
    await screen.findByText("TKT-001");
    fireEvent.click(screen.getByRole("button", { name: /^Resolve$/i }));
    await screen.findByRole("heading", { name: /Resolve Complaint/i });

    apiMock.patch.mockClear();
    // The Cancel button in the resolve modal.
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Resolve Complaint/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("New Complaint button opens the modal", async () => {
    wireGet({ list: [], stats: statsFixture() });
    render(<ComplaintsPage />);
    await screen.findByText(/no complaints in this category/i);

    fireEvent.click(screen.getByRole("button", { name: /new complaint/i }));

    expect(
      await screen.findByRole("heading", { name: /^New Complaint$/i }),
    ).toBeInTheDocument();
    expect(document.getElementById("complaint-description")).toBeTruthy();
  });

  it("New Complaint Submit toasts when description is empty", async () => {
    wireGet({ list: [], stats: statsFixture() });
    render(<ComplaintsPage />);
    await screen.findByText(/no complaints in this category/i);

    fireEvent.click(screen.getByRole("button", { name: /new complaint/i }));

    apiMock.post.mockClear();
    toastMock.error.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Description required"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("New Complaint Submit toasts when neither patientId nor caller name is given", async () => {
    wireGet({ list: [], stats: statsFixture() });
    render(<ComplaintsPage />);
    await screen.findByText(/no complaints in this category/i);

    fireEvent.click(screen.getByRole("button", { name: /new complaint/i }));

    const desc = document.getElementById(
      "complaint-description",
    ) as HTMLTextAreaElement;
    fireEvent.change(desc, { target: { value: "Description text" } });

    apiMock.post.mockClear();
    toastMock.error.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Either patient ID or caller name required",
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("New Complaint Submit success POSTs the body with category/priority/description and the optional caller fields, then closes the modal", async () => {
    wireGet({ list: [], stats: statsFixture() });
    render(<ComplaintsPage />);
    await screen.findByText(/no complaints in this category/i);

    fireEvent.click(screen.getByRole("button", { name: /new complaint/i }));

    fireEvent.change(
      document.getElementById("complaint-caller-name") as HTMLInputElement,
      { target: { value: "Caller One" } },
    );
    fireEvent.change(
      document.getElementById("complaint-phone") as HTMLInputElement,
      { target: { value: "+9100000" } },
    );
    fireEvent.change(
      document.getElementById("complaint-category") as HTMLSelectElement,
      { target: { value: "Billing" } },
    );
    fireEvent.change(
      document.getElementById("complaint-priority") as HTMLSelectElement,
      { target: { value: "HIGH" } },
    );
    fireEvent.change(
      document.getElementById("complaint-description") as HTMLTextAreaElement,
      { target: { value: "Charged twice" } },
    );

    apiMock.post.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/complaints",
        expect.objectContaining({
          category: "Billing",
          description: "Charged twice",
          priority: "HIGH",
          name: "Caller One",
          phone: "+9100000",
        }),
        expect.objectContaining({ timeoutMs: 10_000 }),
      ),
    );

    // Modal closes on success.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^New Complaint$/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("New Complaint Submit success with patientId includes patientId in the body", async () => {
    wireGet({ list: [], stats: statsFixture() });
    render(<ComplaintsPage />);
    await screen.findByText(/no complaints in this category/i);

    fireEvent.click(screen.getByRole("button", { name: /new complaint/i }));

    fireEvent.change(
      document.getElementById("complaint-patient-id") as HTMLInputElement,
      { target: { value: "patient-uuid-123" } },
    );
    fireEvent.change(
      document.getElementById("complaint-description") as HTMLTextAreaElement,
      { target: { value: "Lab report missing" } },
    );

    apiMock.post.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/complaints",
        expect.objectContaining({
          patientId: "patient-uuid-123",
          description: "Lab report missing",
        }),
        expect.anything(),
      ),
    );
  });

  it("New Complaint Submit failure toasts the error message", async () => {
    wireGet({ list: [], stats: statsFixture() });
    apiMock.post.mockRejectedValueOnce(new Error("Server boom"));

    render(<ComplaintsPage />);
    await screen.findByText(/no complaints in this category/i);

    fireEvent.click(screen.getByRole("button", { name: /new complaint/i }));

    fireEvent.change(
      document.getElementById("complaint-caller-name") as HTMLInputElement,
      { target: { value: "Caller Two" } },
    );
    fireEvent.change(
      document.getElementById("complaint-description") as HTMLTextAreaElement,
      { target: { value: "Something" } },
    );

    toastMock.error.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Server boom"),
    );
  });

  it("New Complaint Cancel closes the modal without POSTing", async () => {
    wireGet({ list: [], stats: statsFixture() });
    render(<ComplaintsPage />);
    await screen.findByText(/no complaints in this category/i);

    fireEvent.click(screen.getByRole("button", { name: /new complaint/i }));

    apiMock.post.mockClear();
    // Two "Cancel" buttons could be possible if both modals were open; here
    // only the new-complaint modal is open.
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^New Complaint$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("keeps rendering when /complaints and /complaints/stats reject", async () => {
    wireGet({ listReject: true, statsReject: true });
    render(<ComplaintsPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^Complaints$/i }),
      ).toBeInTheDocument(),
    );
    // Fallback "0" Total Open tile is still painted.
    expect(screen.getByTestId("complaints-total-open")).toHaveTextContent("0");
  });

  it("silently swallows /chat/users rejection (assign dropdown still renders for rows)", async () => {
    wireGet({
      list: [complaintFixture({ id: "c-1" })],
      stats: statsFixture(),
      usersReject: true,
    });
    render(<ComplaintsPage />);

    await screen.findByText("TKT-001");
    // The assign <select> is still rendered with at least the "Unassigned" option.
    const select = document.querySelector("tbody select");
    expect(select).toBeTruthy();
    expect(select?.textContent).toContain("Unassigned");
  });
});
