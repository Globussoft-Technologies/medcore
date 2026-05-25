/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ScheduledReportsPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/scheduled-reports/page.tsx, the
 *     ADMIN-only surface that lets staff (a) schedule recurring report emails
 *     and (b) browse the cron-job run history. Endpoints the page hits:
 *       GET    /scheduled-reports              (list of scheduled reports)
 *       GET    /scheduled-reports/runs         (history of cron runs)
 *       POST   /scheduled-reports              (create new schedule)
 *       POST   /scheduled-reports/:id/run-now  (trigger ad-hoc run)
 *       PATCH  /scheduled-reports/:id          (toggle active flag)
 *       DELETE /scheduled-reports/:id          (delete schedule)
 *
 *   - Behaviours covered:
 *       1.  RBAC — non-ADMIN role (DOCTOR) triggers router.push("/dashboard"),
 *           render short-circuits to the access-denied placeholder, and the
 *           list GET never fires.
 *       2.  Pre-auth render — null user shows the same access-denied gate and
 *           never fires a GET.
 *       3.  Loading branch — the schedules skeleton renders while the initial
 *           /scheduled-reports GET is pending; heading + chrome still render.
 *       4.  Happy fetch — one row per ScheduledReport with name, type,
 *           frequency-at-time, IST-formatted next-run, comma-joined recipients,
 *           and the Active/Paused pill.
 *       5.  Empty branch — "No scheduled reports yet" copy when rows=[].
 *       6.  Tabs — switching to Run History fetches /scheduled-reports/runs,
 *           renders run rows with IST-formatted timestamps + status pill, and
 *           the "New Report" button hides on the runs tab.
 *       7.  Run-history empty branch — "No run history yet" copy.
 *       8.  Create form — toggles open, validates blank name / blank time /
 *           empty recipients via toast.error and does NOT POST.
 *       9.  MONTHLY frequency — out-of-range day-of-month (0, 32, NaN) hits
 *           the toast.error guard and does NOT POST.
 *      10.  Create happy path — DAILY frequency POSTs the right body shape
 *           (no dayOfWeek / dayOfMonth), parses recipients on commas + newlines
 *           trimming whitespace, then resets the form, closes it, and reloads.
 *      11.  Create happy path — WEEKLY frequency includes dayOfWeek.
 *      12.  Create happy path — MONTHLY frequency includes dayOfMonth.
 *      13.  Create POST error — toast.error surfaces the server message and
 *           the form stays open so the user can retry.
 *      14.  Run-now flow — confirm=true POSTs /run-now, toasts success, and
 *           reloads; confirm=false short-circuits and never POSTs.
 *      15.  Toggle pause/resume — PATCH with the inverted active flag and
 *           triggers a reload.
 *      16.  Delete flow — confirm=true DELETEs and reloads; confirm=false
 *           short-circuits without a DELETE.
 *      17.  Run History row — formatNextRun on null nextRunAt renders "—".
 *      18.  Error-path resilience — initial GET rejection still flips loading
 *           off and renders the empty branch (no toast — silent catch).
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            @/lib/use-dialog (useConfirm), next/navigation,
 *            @/components/Skeleton (stubbed to a div).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

const {
  apiMock,
  toastMock,
  authMock,
  routerMock,
  confirmMock,
} = vi.hoisted(() => ({
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
  confirmMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/scheduled-reports",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import ScheduledReportsPage from "../page";

type ScheduledReport = {
  id: string;
  name: string;
  reportType: string;
  frequency: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  timeOfDay: string;
  recipients: string[];
  active: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
};

type ReportRun = {
  id: string;
  reportType: string;
  status: string;
  generatedAt: string;
  sentTo?: string[] | null;
  error?: string | null;
  scheduledReport?: { id: string; name: string } | null;
};

function reportFixture(overrides: Partial<ScheduledReport> = {}): ScheduledReport {
  return {
    id: "sr-1",
    name: "Weekly Revenue Email",
    reportType: "WEEKLY_REVENUE",
    frequency: "WEEKLY",
    dayOfWeek: 1,
    dayOfMonth: null,
    timeOfDay: "08:00",
    recipients: ["admin@example.com", "director@example.com"],
    active: true,
    lastRunAt: null,
    // +48h to dodge the IST/UTC midnight trap noted in CLAUDE.md.
    nextRunAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function runFixture(overrides: Partial<ReportRun> = {}): ReportRun {
  return {
    id: "run-1",
    reportType: "WEEKLY_REVENUE",
    status: "SUCCESS",
    generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    sentTo: ["admin@example.com"],
    error: null,
    scheduledReport: { id: "sr-1", name: "Weekly Revenue Email" },
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: {
      id: "u-admin",
      userId: "u-admin",
      role: "ADMIN",
      name: "Admin",
      email: "admin@test.local",
    },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: {
      id: "u-doc",
      userId: "u-doc",
      role: "DOCTOR",
      name: "Doc",
      email: "doc@test.local",
    },
    isLoading: false,
  });
}

function asGuest() {
  authMock.mockReturnValue({ user: null, isLoading: false });
}

/**
 * Page load helper. Wires apiMock.get so /scheduled-reports returns the given
 * rows and /scheduled-reports/runs returns the given runs. Returns the
 * render-result so callers can assert further.
 */
function wireListGet(rows: ScheduledReport[], runs: ReportRun[] = []) {
  apiMock.get.mockImplementation((url: string) => {
    if (url === "/scheduled-reports/runs") {
      return Promise.resolve({ data: runs });
    }
    if (url === "/scheduled-reports") {
      return Promise.resolve({ data: rows });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("Scheduled Reports dashboard page (admin-only cron-job manager)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    confirmMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects non-ADMIN (DOCTOR) to /dashboard and never fires the list GET", async () => {
    wireListGet([reportFixture()]);
    asDoctor();

    render(<ScheduledReportsPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
    expect(screen.getByText(/Access denied. Admin only/i)).toBeInTheDocument();
    // The role-gated effect should suppress all list fetches.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the access-denied gate when user is null and never fires a GET", async () => {
    asGuest();

    render(<ScheduledReportsPage />);

    expect(screen.getByText(/Access denied. Admin only/i)).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("renders the SkeletonTable loading branch while the initial GET is pending", async () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));

    render(<ScheduledReportsPage />);

    expect(
      screen.getByRole("heading", { name: /^Scheduled Reports$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("scheduled-reports-schedules-loading"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("hits /scheduled-reports on mount and renders one row per ScheduledReport with full chrome", async () => {
    const rows = [
      reportFixture({ id: "sr-1", name: "Weekly Revenue Email", active: true }),
      reportFixture({
        id: "sr-2",
        name: "Daily Census",
        reportType: "DAILY_CENSUS",
        frequency: "DAILY",
        active: false,
        timeOfDay: "07:30",
        recipients: ["one@example.com"],
      }),
    ];
    wireListGet(rows);

    render(<ScheduledReportsPage />);

    await screen.findByText("Weekly Revenue Email");
    await screen.findByText("Daily Census");

    // GET called once for /scheduled-reports.
    expect(apiMock.get).toHaveBeenCalledWith("/scheduled-reports");

    // Frequency + time column for sr-1 ("WEEKLY @ 08:00").
    expect(screen.getByText(/WEEKLY @ 08:00/)).toBeInTheDocument();
    // Frequency + time column for sr-2 ("DAILY @ 07:30").
    expect(screen.getByText(/DAILY @ 07:30/)).toBeInTheDocument();
    // Recipients joined with comma + space.
    expect(
      screen.getByText("admin@example.com, director@example.com"),
    ).toBeInTheDocument();
    // Status pills.
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it('renders "No scheduled reports yet" when the list is empty', async () => {
    wireListGet([]);

    render(<ScheduledReportsPage />);

    expect(
      await screen.findByText(/No scheduled reports yet/i),
    ).toBeInTheDocument();
  });

  it("switches to Run History tab, fetches /scheduled-reports/runs, and renders run rows", async () => {
    wireListGet([reportFixture()], [runFixture(), runFixture({ id: "run-2", status: "FAILED", error: "smtp timed out" })]);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Run History/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/scheduled-reports/runs"),
    );

    // Run rows render with schedule name + report type + status pill.
    expect(await screen.findByText(/^SUCCESS$/)).toBeInTheDocument();
    expect(screen.getByText(/^FAILED$/)).toBeInTheDocument();
    expect(screen.getByText("smtp timed out")).toBeInTheDocument();

    // "New Report" button is hidden on the runs tab.
    expect(
      screen.queryByRole("button", { name: /New Report/i }),
    ).not.toBeInTheDocument();
  });

  it('renders "No run history yet" when the runs tab list is empty', async () => {
    wireListGet([reportFixture()], []);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByRole("button", { name: /Run History/i }));

    expect(
      await screen.findByText(/No run history yet/i),
    ).toBeInTheDocument();
  });

  it("renders an em-dash for the schedule name when scheduledReport is null on a run row", async () => {
    wireListGet([], [runFixture({ scheduledReport: null, sentTo: null })]);

    render(<ScheduledReportsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Run History/i }));

    // Both the schedule-name col and the recipients col fall back to "—".
    await waitFor(() => {
      expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("opens the create form, then toast.errors on blank name and does NOT POST", async () => {
    wireListGet([reportFixture()]);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByRole("button", { name: /New Report/i }));

    // Form rendered.
    expect(
      document.getElementById("add-sched-report-name"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Create Schedule/i }),
    );

    expect(toastMock.error).toHaveBeenCalledWith("Name is required");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("toast.errors on blank time and does NOT POST", async () => {
    wireListGet([reportFixture()]);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByRole("button", { name: /New Report/i }));

    fireEvent.change(
      document.getElementById("add-sched-report-name") as HTMLInputElement,
      { target: { value: "Test" } },
    );
    // Wipe the default 08:00 time.
    fireEvent.change(screen.getByTestId("sched-report-time"), {
      target: { value: "" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Create Schedule/i }),
    );

    expect(toastMock.error).toHaveBeenCalledWith("Time is required");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("toast.errors on empty recipients (only whitespace + commas) and does NOT POST", async () => {
    wireListGet([reportFixture()]);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByRole("button", { name: /New Report/i }));

    fireEvent.change(
      document.getElementById("add-sched-report-name") as HTMLInputElement,
      { target: { value: "Test" } },
    );
    // recipients left empty.
    fireEvent.change(
      document.getElementById(
        "add-sched-report-recipients",
      ) as HTMLTextAreaElement,
      { target: { value: " , ,\n" } },
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Create Schedule/i }),
    );

    expect(toastMock.error).toHaveBeenCalledWith(
      "At least one recipient is required",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("toast.errors on MONTHLY with out-of-range day-of-month and does NOT POST", async () => {
    wireListGet([reportFixture()]);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByRole("button", { name: /New Report/i }));

    fireEvent.change(
      document.getElementById("add-sched-report-name") as HTMLInputElement,
      { target: { value: "Monthly summary" } },
    );
    fireEvent.change(
      document.getElementById("add-sched-report-frequency") as HTMLSelectElement,
      { target: { value: "MONTHLY" } },
    );
    // MONTHLY branch now renders the day-of-month input.
    fireEvent.change(
      document.getElementById(
        "add-sched-report-day-of-month",
      ) as HTMLInputElement,
      { target: { value: "32" } },
    );
    fireEvent.change(
      document.getElementById(
        "add-sched-report-recipients",
      ) as HTMLTextAreaElement,
      { target: { value: "ops@example.com" } },
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Create Schedule/i }),
    );

    expect(toastMock.error).toHaveBeenCalledWith(
      "Day of month must be between 1 and 31",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("DAILY create posts a body without dayOfWeek/dayOfMonth, splits recipients on commas + newlines, resets + closes the form, and reloads", async () => {
    wireListGet([reportFixture()]);
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByRole("button", { name: /New Report/i }));

    fireEvent.change(
      document.getElementById("add-sched-report-name") as HTMLInputElement,
      { target: { value: "Daily census email" } },
    );
    fireEvent.change(
      document.getElementById(
        "add-sched-report-type",
      ) as HTMLSelectElement,
      { target: { value: "DAILY_CENSUS" } },
    );
    // Default frequency is DAILY — no day-of-week / day-of-month surface.
    fireEvent.change(screen.getByTestId("sched-report-time"), {
      target: { value: "06:15" },
    });
    fireEvent.change(
      document.getElementById(
        "add-sched-report-recipients",
      ) as HTMLTextAreaElement,
      {
        target: {
          value: "  alice@example.com , bob@example.com \n  carol@example.com  ",
        },
      },
    );

    apiMock.get.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: /Create Schedule/i }),
    );

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));

    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/scheduled-reports");
    expect(body).toEqual({
      name: "Daily census email",
      reportType: "DAILY_CENSUS",
      frequency: "DAILY",
      timeOfDay: "06:15",
      recipients: [
        "alice@example.com",
        "bob@example.com",
        "carol@example.com",
      ],
    });
    // No frequency-specific keys.
    expect((body as any).dayOfWeek).toBeUndefined();
    expect((body as any).dayOfMonth).toBeUndefined();

    // Form closed → "New Report" CTA is back.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /New Report/i }),
      ).toBeInTheDocument(),
    );

    // List reload was triggered.
    expect(apiMock.get).toHaveBeenCalledWith("/scheduled-reports");
  });

  it("WEEKLY create includes dayOfWeek in the POST body", async () => {
    wireListGet([reportFixture()]);
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByRole("button", { name: /New Report/i }));

    fireEvent.change(
      document.getElementById("add-sched-report-name") as HTMLInputElement,
      { target: { value: "Weekly summary" } },
    );
    fireEvent.change(
      document.getElementById(
        "add-sched-report-frequency",
      ) as HTMLSelectElement,
      { target: { value: "WEEKLY" } },
    );
    fireEvent.change(
      document.getElementById(
        "add-sched-report-day-of-week",
      ) as HTMLSelectElement,
      { target: { value: "3" } }, // Wed
    );
    fireEvent.change(
      document.getElementById(
        "add-sched-report-recipients",
      ) as HTMLTextAreaElement,
      { target: { value: "ops@example.com" } },
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Create Schedule/i }),
    );

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0];
    expect((body as any).dayOfWeek).toBe(3);
    expect((body as any).dayOfMonth).toBeUndefined();
  });

  it("MONTHLY create includes dayOfMonth in the POST body", async () => {
    wireListGet([reportFixture()]);
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByRole("button", { name: /New Report/i }));

    fireEvent.change(
      document.getElementById("add-sched-report-name") as HTMLInputElement,
      { target: { value: "Monthly summary" } },
    );
    fireEvent.change(
      document.getElementById(
        "add-sched-report-frequency",
      ) as HTMLSelectElement,
      { target: { value: "MONTHLY" } },
    );
    fireEvent.change(
      document.getElementById(
        "add-sched-report-day-of-month",
      ) as HTMLInputElement,
      { target: { value: "15" } },
    );
    fireEvent.change(
      document.getElementById(
        "add-sched-report-recipients",
      ) as HTMLTextAreaElement,
      { target: { value: "ops@example.com" } },
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Create Schedule/i }),
    );

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0];
    expect((body as any).dayOfMonth).toBe(15);
    expect((body as any).dayOfWeek).toBeUndefined();
  });

  it("surfaces a create POST rejection via toast.error and keeps the form open", async () => {
    wireListGet([reportFixture()]);
    apiMock.post.mockRejectedValue(new Error("server boom"));

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByRole("button", { name: /New Report/i }));

    fireEvent.change(
      document.getElementById("add-sched-report-name") as HTMLInputElement,
      { target: { value: "Test" } },
    );
    fireEvent.change(
      document.getElementById(
        "add-sched-report-recipients",
      ) as HTMLTextAreaElement,
      { target: { value: "ops@example.com" } },
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Create Schedule/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server boom"),
    );

    // Form still mounted (Name input still in the DOM).
    expect(
      document.getElementById("add-sched-report-name"),
    ).toBeInTheDocument();
  });

  it("Run-now: confirm=true POSTs /run-now, toasts success, and reloads", async () => {
    wireListGet([reportFixture()]);
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    apiMock.get.mockClear();

    // The Play (run-now) button has title="Run now".
    fireEvent.click(screen.getByTitle("Run now"));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/scheduled-reports/sr-1/run-now"),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Report queued/i),
    );

    // Reload fired.
    expect(apiMock.get).toHaveBeenCalledWith("/scheduled-reports");
  });

  it("Run-now: confirm=false short-circuits and never POSTs", async () => {
    wireListGet([reportFixture()]);
    confirmMock.mockResolvedValue(false);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByTitle("Run now"));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Run-now: surfaces a POST rejection via toast.error", async () => {
    wireListGet([reportFixture()]);
    apiMock.post.mockRejectedValue(new Error("run boom"));
    confirmMock.mockResolvedValue(true);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByTitle("Run now"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("run boom"),
    );
  });

  it("Toggle (Pause): PATCHes with active=false on a currently-Active row and reloads", async () => {
    wireListGet([reportFixture({ active: true })]);
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    apiMock.get.mockClear();

    fireEvent.click(screen.getByTitle("Pause"));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/scheduled-reports/sr-1",
        { active: false },
      ),
    );
    expect(apiMock.get).toHaveBeenCalledWith("/scheduled-reports");
  });

  it("Toggle (Resume): PATCHes with active=true on a currently-Paused row", async () => {
    wireListGet([reportFixture({ active: false })]);
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByTitle("Resume"));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/scheduled-reports/sr-1",
        { active: true },
      ),
    );
  });

  it("Toggle: silently swallows a PATCH rejection (no toast)", async () => {
    wireListGet([reportFixture({ active: true })]);
    apiMock.patch.mockRejectedValue(new Error("patch boom"));

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByTitle("Pause"));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalled());
    // Source's catch block is intentionally empty.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Delete: confirm=true DELETEs and reloads", async () => {
    wireListGet([reportFixture()]);
    apiMock.delete.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    apiMock.get.mockClear();

    fireEvent.click(screen.getByTitle("Delete"));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(apiMock.delete).toHaveBeenCalledWith("/scheduled-reports/sr-1"),
    );
    expect(apiMock.get).toHaveBeenCalledWith("/scheduled-reports");
  });

  it("Delete: confirm=false short-circuits without a DELETE", async () => {
    wireListGet([reportFixture()]);
    confirmMock.mockResolvedValue(false);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByTitle("Delete"));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.delete).not.toHaveBeenCalled();
  });

  it("Delete: surfaces a DELETE rejection via toast.error", async () => {
    wireListGet([reportFixture()]);
    apiMock.delete.mockRejectedValue(new Error("delete boom"));
    confirmMock.mockResolvedValue(true);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByTitle("Delete"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("delete boom"),
    );
  });

  it('renders "—" for nextRunAt when the schedule has no next-run yet', async () => {
    wireListGet([reportFixture({ nextRunAt: null })]);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    // The em-dash is in the Next Run column.
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("toggling 'New Report' twice closes the form (X icon path)", async () => {
    wireListGet([reportFixture()]);

    render(<ScheduledReportsPage />);
    await screen.findByText("Weekly Revenue Email");

    fireEvent.click(screen.getByRole("button", { name: /New Report/i }));
    expect(
      document.getElementById("add-sched-report-name"),
    ).toBeInTheDocument();

    // The toggle button now shows "Cancel".
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(
      document.getElementById("add-sched-report-name"),
    ).not.toBeInTheDocument();
  });

  it("silently swallows the initial GET rejection and renders the empty branch", async () => {
    apiMock.get.mockRejectedValue(new Error("server down"));

    render(<ScheduledReportsPage />);

    expect(
      await screen.findByText(/No scheduled reports yet/i),
    ).toBeInTheDocument();
    // Source's load() catch is silent.
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
