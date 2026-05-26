/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DoctorWorkspacePage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/workspace/page.tsx`, the doctor-only daily
 *     workspace hub. The page issues eight parallel mount GETs:
 *       GET /queue/me
 *       GET /appointments?date=YYYY-MM-DD&mine=true&limit=50
 *       GET /admissions?status=ADMITTED&mine=true&limit=50
 *       GET /prescriptions?mine=true&limit=5
 *       GET /lab/orders?status=COMPLETED&mine=true&unreviewed=true&limit=1
 *       GET /referrals?direction=incoming&status=PENDING&limit=1
 *       GET /appointments?status=IN_CONSULTATION&mine=true&hasPrescription=false&limit=1
 *       GET /admissions?status=DISCHARGE_PENDING&mine=true&limit=1
 *     ...via `safe()` (catch → fallback) so even total failure renders the page.
 *
 *   - Behaviours covered:
 *       1. RBAC — non-DOCTOR roles see the "Workspace is for doctors only"
 *          short-circuit copy and the page issues NO GETs.
 *       2. RBAC redirect effect — a non-DOCTOR authed user triggers
 *          router.replace('/dashboard').
 *       3. Loading skeleton — `data-testid="workspace-loading"` (aria-busy)
 *          renders while the eight GETs are in flight; page chrome stays.
 *       4. Happy fetch — Current Token, queue rows, today's appointments,
 *          admitted patients, recent prescriptions tiles all hydrate.
 *       5. Empty branches — each tile renders its own "no data" copy when
 *          the corresponding endpoint returns an empty list.
 *       6. Current-token selection — IN_CONSULTATION preferred over CHECKED_IN
 *          and excluded from "Next in line".
 *       7. Current-token CHECKED_IN fallback — when no IN_CONSULTATION row
 *          exists, the first CHECKED_IN is promoted to current token.
 *       8. Pending-task counts — render the four numeric badges and pluralize
 *          the prescription item count ("1 item" vs "N items").
 *       9. Error path — every GET rejects (safe() swallows) → page still
 *          renders all empty-state copies and flips loading off.
 *
 *   - Source under test: apps/web/src/app/dashboard/workspace/page.tsx
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/format-doctor-name,
 *            next/navigation (useRouter), @/components/Skeleton.
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
  cleanup,
} from "@testing-library/react";

const { apiMock, authMock, routerMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
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
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/format-doctor-name", () => ({
  formatDoctorName: (n: string) => `Dr. ${n}`,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/workspace",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));

import DoctorWorkspacePage from "../page";

// ─── Fixtures ───────────────────────────────────────────

function queueRow(overrides: any = {}) {
  return {
    id: "q-1",
    tokenNumber: 12,
    status: "WAITING",
    type: "WALK_IN",
    patient: { user: { name: "Aanya Sharma" } },
    ...overrides,
  };
}

function apptRow(overrides: any = {}) {
  return {
    id: "appt-1",
    slotStart: "10:30",
    status: "SCHEDULED",
    patient: { user: { name: "Meera Iyer" } },
    ...overrides,
  };
}

function admissionRow(overrides: any = {}) {
  return {
    id: "adm-1",
    admissionNumber: "ADM-2026-001",
    reason: "Pneumonia",
    patient: { user: { name: "Rohit Kumar" } },
    bed: { bedNumber: "12", ward: { name: "Ward A" } },
    ...overrides,
  };
}

function rxRow(overrides: any = {}) {
  return {
    id: "rx-1",
    diagnosis: "Acute bronchitis",
    createdAt: "2026-05-26T09:00:00.000Z",
    patient: { user: { name: "Vikram Reddy" } },
    items: [{ id: "i-1" }, { id: "i-2" }],
    ...overrides,
  };
}

/**
 * Wire api.get to route by URL prefix to the right fixture. The page fires
 * 8 parallel mount fetches, so URL prefix routing is more robust than
 * mockResolvedValueOnce chains (order is sometimes interleaved).
 */
function wireGet(opts: {
  queue?: any[];
  appts?: any[];
  admissions?: any[];
  rx?: any[];
  labReviewTotal?: number;
  referralsTotal?: number;
  rxToWriteTotal?: number;
  dischargePendingTotal?: number;
  rejectAll?: boolean;
} = {}) {
  apiMock.get.mockImplementation((url: string) => {
    if (opts.rejectAll) return Promise.reject(new Error("boom"));
    if (url.startsWith("/queue/me")) {
      return Promise.resolve({ data: opts.queue ?? [] });
    }
    if (url.startsWith("/appointments?status=IN_CONSULTATION")) {
      return Promise.resolve({ meta: { total: opts.rxToWriteTotal ?? 0 } });
    }
    if (url.startsWith("/appointments")) {
      return Promise.resolve({ data: opts.appts ?? [] });
    }
    if (url.startsWith("/admissions?status=ADMITTED")) {
      return Promise.resolve({ data: opts.admissions ?? [] });
    }
    if (url.startsWith("/admissions?status=DISCHARGE_PENDING")) {
      return Promise.resolve({
        meta: { total: opts.dischargePendingTotal ?? 0 },
      });
    }
    if (url.startsWith("/prescriptions")) {
      return Promise.resolve({ data: opts.rx ?? [] });
    }
    if (url.startsWith("/lab/orders")) {
      return Promise.resolve({ meta: { total: opts.labReviewTotal ?? 0 } });
    }
    if (url.startsWith("/referrals")) {
      return Promise.resolve({ meta: { total: opts.referralsTotal ?? 0 } });
    }
    return Promise.resolve({ data: [] });
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "doc-1", role: "DOCTOR", name: "Rajesh Sharma" },
    isLoading: false,
  });
}

function asNurse() {
  authMock.mockReturnValue({
    user: { id: "nurse-1", role: "NURSE", name: "Asha Nurse" },
    isLoading: false,
  });
}

describe("DoctorWorkspacePage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asDoctor();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the doctor-only short-circuit copy for non-DOCTOR roles and issues no GETs", async () => {
    asNurse();
    wireGet({});

    render(<DoctorWorkspacePage />);

    expect(
      screen.getByText(/workspace is for doctors only/i),
    ).toBeInTheDocument();
    // Page heading is from the post-gate render path, so it should NOT render.
    expect(
      screen.queryByRole("heading", { name: /^workspace$/i }),
    ).not.toBeInTheDocument();
    // Data-fetch effect is gated on user.role === "DOCTOR" so no GETs fire.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("redirects non-DOCTOR authed users to /dashboard via router.replace", async () => {
    asNurse();
    wireGet({});

    render(<DoctorWorkspacePage />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("renders the skeleton loading state while the eight mount GETs are in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<DoctorWorkspacePage />);

    // Page chrome visible during load.
    expect(
      screen.getByRole("heading", { name: /^workspace$/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/everything you need for today/i)).toBeInTheDocument();
    expect(screen.getByText("DOCTOR")).toBeInTheDocument();
    // Loading skeleton with aria-busy + three skeleton cards.
    const loading = screen.getByTestId("workspace-loading");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card")).toHaveLength(3);
  });

  it("formats the doctor's name in the subheading via formatDoctorName", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<DoctorWorkspacePage />);

    // The mocked formatDoctorName prepends "Dr. " — so we see "Dr. Rajesh Sharma".
    expect(
      screen.getByText(/everything you need for today, Dr\. Rajesh Sharma/i),
    ).toBeInTheDocument();
  });

  it("renders all five tiles with their data on a happy fetch", async () => {
    wireGet({
      queue: [
        queueRow({
          id: "q-current",
          tokenNumber: 5,
          status: "IN_CONSULTATION",
          patient: { user: { name: "Current Patient" } },
        }),
        queueRow({ id: "q-2", tokenNumber: 13, status: "WAITING" }),
        queueRow({
          id: "q-3",
          tokenNumber: 14,
          status: "WAITING",
          patient: { user: { name: "Other Waiter" } },
        }),
      ],
      appts: [
        apptRow(),
        apptRow({
          id: "appt-2",
          slotStart: "11:00",
          patient: { user: { name: "Second Patient" } },
        }),
      ],
      admissions: [admissionRow()],
      rx: [rxRow(), rxRow({ id: "rx-2", diagnosis: "Migraine", items: [{ id: "x" }] })],
      labReviewTotal: 3,
      referralsTotal: 1,
      rxToWriteTotal: 2,
      dischargePendingTotal: 4,
    });

    render(<DoctorWorkspacePage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workspace-loading"),
      ).not.toBeInTheDocument(),
    );

    // Current Token block.
    expect(screen.getByText(/Current Token #5/)).toBeInTheDocument();
    expect(screen.getByText("Current Patient")).toBeInTheDocument();
    // Type · status (underscore replaced with space).
    expect(screen.getByText(/WALK_IN · IN CONSULTATION/)).toBeInTheDocument();

    // Next in line — the two waiters (current excluded by id filter).
    expect(screen.getByText("Aanya Sharma")).toBeInTheDocument();
    expect(screen.getByText("Other Waiter")).toBeInTheDocument();
    expect(screen.getByText("#13")).toBeInTheDocument();
    expect(screen.getByText("#14")).toBeInTheDocument();

    // Today's appointments tile.
    expect(screen.getByText("Meera Iyer")).toBeInTheDocument();
    expect(screen.getByText("10:30")).toBeInTheDocument();
    expect(screen.getByText("11:00")).toBeInTheDocument();
    // Appointments count badge — 2 in our fixture. Use getAllByText since the
    // digit "2" also appears as the rxToWrite pending-task count, so multiple
    // matches are expected; we just assert ≥1 numeric "2" lands in the DOM.
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);

    // Admitted tile.
    expect(screen.getByText("Rohit Kumar")).toBeInTheDocument();
    expect(screen.getByText(/ADM-2026-001 · Pneumonia/)).toBeInTheDocument();
    expect(screen.getByText("Ward A/12")).toBeInTheDocument();

    // Recent prescriptions tile — diagnoses + pluralization ("2 items" vs "1 item").
    expect(screen.getByText("Acute bronchitis")).toBeInTheDocument();
    expect(screen.getByText("Migraine")).toBeInTheDocument();
    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.getByText("1 item")).toBeInTheDocument();

    // Pending-task counts: rxToWrite=2, lab=3, discharge=4, referrals=1.
    expect(screen.getByText(/Prescriptions to write/)).toBeInTheDocument();
    expect(screen.getByText(/Lab results to review/)).toBeInTheDocument();
    expect(screen.getByText(/Discharge summaries pending/)).toBeInTheDocument();
    expect(screen.getByText(/Referrals awaiting response/)).toBeInTheDocument();
    // The "3" / "4" digits inside task rows.
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();

    // Issued the canonical mount GETs.
    const calls = apiMock.get.mock.calls.map((c) => c[0] as string);
    expect(calls.some((u) => u.startsWith("/queue/me"))).toBe(true);
    expect(
      calls.some((u) => u.startsWith("/appointments?date=")),
    ).toBe(true);
    expect(
      calls.some((u) => u.startsWith("/admissions?status=ADMITTED&mine=true")),
    ).toBe(true);
    expect(
      calls.some((u) => u.startsWith("/prescriptions?mine=true&limit=5")),
    ).toBe(true);
    expect(
      calls.some((u) =>
        u.startsWith("/lab/orders?status=COMPLETED&mine=true&unreviewed=true"),
      ),
    ).toBe(true);
    expect(
      calls.some((u) =>
        u.startsWith("/referrals?direction=incoming&status=PENDING"),
      ),
    ).toBe(true);
    expect(
      calls.some((u) =>
        u.startsWith(
          "/appointments?status=IN_CONSULTATION&mine=true&hasPrescription=false",
        ),
      ),
    ).toBe(true);
    expect(
      calls.some((u) =>
        u.startsWith("/admissions?status=DISCHARGE_PENDING&mine=true"),
      ),
    ).toBe(true);
  });

  it("renders every empty-state copy when every endpoint returns []", async () => {
    wireGet({});

    render(<DoctorWorkspacePage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workspace-loading"),
      ).not.toBeInTheDocument(),
    );

    expect(
      screen.getByText(/no patient currently in consultation/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/queue is empty/i)).toBeInTheDocument();
    expect(screen.getByText(/no appointments today/i)).toBeInTheDocument();
    expect(screen.getByText(/no active admissions/i)).toBeInTheDocument();
    expect(
      screen.getByText(/no prescriptions written yet/i),
    ).toBeInTheDocument();
  });

  it("promotes the first CHECKED_IN token to current when no IN_CONSULTATION row exists", async () => {
    wireGet({
      queue: [
        queueRow({
          id: "q-checked",
          tokenNumber: 9,
          status: "CHECKED_IN",
          patient: { user: { name: "Checked Patient" } },
        }),
        queueRow({ id: "q-other", tokenNumber: 10, status: "WAITING" }),
      ],
    });

    render(<DoctorWorkspacePage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workspace-loading"),
      ).not.toBeInTheDocument(),
    );

    // CHECKED_IN promoted into Current Token block.
    expect(screen.getByText(/Current Token #9/)).toBeInTheDocument();
    expect(screen.getByText("Checked Patient")).toBeInTheDocument();
    expect(screen.getByText(/WALK_IN · CHECKED IN/)).toBeInTheDocument();

    // Other waiter shows in "Next in line".
    expect(screen.getByText("#10")).toBeInTheDocument();
  });

  it("renders fallback dashes when patient names are missing on each row type", async () => {
    wireGet({
      queue: [
        queueRow({
          id: "q-current",
          status: "IN_CONSULTATION",
          patient: null,
        }),
        queueRow({ id: "q-waiter", status: "WAITING", patient: null }),
      ],
      appts: [apptRow({ patient: null, slotStart: null })],
      admissions: [
        admissionRow({ patient: null, bed: null }),
      ],
      rx: [rxRow({ patient: null })],
    });

    render(<DoctorWorkspacePage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workspace-loading"),
      ).not.toBeInTheDocument(),
    );

    // Multiple "—" fallbacks render across tiles (current name, queue name,
    // appointment slotStart, admitted name, admitted ward, rx patient).
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(3);
    // Appointment fallback name is the literal "Patient" string in source.
    expect(screen.getByText("Patient")).toBeInTheDocument();
  });

  it("renders four shortcut buttons that link to the documented destinations", async () => {
    wireGet({});

    render(<DoctorWorkspacePage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workspace-loading"),
      ).not.toBeInTheDocument(),
    );

    // The four shortcut buttons are rendered as <a> tags (Next Link) with
    // their label text. Verify the labels + hrefs.
    const startConsult = screen.getByRole("link", { name: /start consultation/i });
    expect(startConsult).toHaveAttribute("href", "/dashboard/queue");

    const writeRx = screen.getByRole("link", { name: /write rx/i });
    expect(writeRx).toHaveAttribute("href", "/dashboard/prescriptions?new=1");

    const orderLabs = screen.getByRole("link", { name: /order labs/i });
    expect(orderLabs).toHaveAttribute("href", "/dashboard/lab?new=1");

    const findPatient = screen.getByRole("link", { name: /find patient/i });
    expect(findPatient).toHaveAttribute("href", "/dashboard/patients");
  });

  it("Error path — when every endpoint rejects, safe() swallows and the page still renders all empty states", async () => {
    wireGet({ rejectAll: true });

    render(<DoctorWorkspacePage />);

    // Loading still flips off even though every fetch threw — safe() catches.
    await waitFor(() =>
      expect(
        screen.queryByTestId("workspace-loading"),
      ).not.toBeInTheDocument(),
    );

    expect(
      screen.getByText(/no patient currently in consultation/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/queue is empty/i)).toBeInTheDocument();
    expect(screen.getByText(/no appointments today/i)).toBeInTheDocument();
    expect(screen.getByText(/no active admissions/i)).toBeInTheDocument();
    expect(
      screen.getByText(/no prescriptions written yet/i),
    ).toBeInTheDocument();
    // DOCTOR pill renders post-gate.
    expect(screen.getByText("DOCTOR")).toBeInTheDocument();
  });
});
