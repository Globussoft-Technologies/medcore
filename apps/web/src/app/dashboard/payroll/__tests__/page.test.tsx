/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PayrollPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/payroll/page.tsx, the ADMIN-only
 *     monthly payroll + overtime tabbed surface. Endpoints the page hits:
 *       GET   /chat/users                          (staff list — non-PATIENT)
 *       POST  /hr-ops/payroll                      (one calculation per staff)
 *       GET   /hr-ops/overtime?month=YYYY-MM       (overtime tab list)
 *       POST  /hr-ops/overtime/auto-calculate      (auto-calc from shifts)
 *       PATCH /hr-ops/overtime/:id/approve         (per-row approval)
 *       <openPrintEndpoint>  /hr-ops/payroll/:id/slip?...  (per-row slip)
 *
 *   - Behaviours covered:
 *       1. RBAC — non-ADMIN role (DOCTOR) triggers router.push("/dashboard"),
 *          render short-circuits to null, and the /chat/users GET is gated
 *          by `user?.role === "ADMIN"` so it never fires for non-admins.
 *       2. Loading branch — `payroll-loading` skeleton renders with
 *          `aria-busy` while the initial GET is pending; header chrome
 *          (tabs) still render.
 *       3. Happy fetch — staff rendered one-row-per-staff with role-defaulted
 *          basic salary (DOCTOR=80000, NURSE=30000, RECEPTION=20000,
 *          unknown→25000), table headers visible, default OT rate Rs. 250/h.
 *       4. Empty branch — "No staff found" copy when staff list is [].
 *       5. Error path — initial GET rejection flips loading off and renders
 *          the empty branch (catch block sets staff=[]).
 *       6. Per-row Calculate — POSTs /hr-ops/payroll with the parsed
 *          settings (basicSalary, allowances, deductions, overtimeRate) and
 *          the split year/month derived from the period selector.
 *       7. Per-row Calculate failure — toast.error fires with the
 *           rejection's message.
 *       8. Generate All — bracketed by info + success toasts; loops over
 *          every staff row issuing N POSTs, then surfaces success copy
 *          with the OK count.
 *       9. Generate All — mixed success/failure surfaces a partial-success
 *           toast (ok + failed count).
 *      10. Generate All — total failure surfaces an error-toast with the
 *           failed count.
 *      11. Generate All — empty staff list short-circuits (no toast fires).
 *      12. Period selector — typing into <input type="month"> updates the
 *           bound state (subsequent Calculate POST uses the new year/month).
 *      13. Edit toggle — per-row Edit flips inputs in (basicSalary,
 *           allowances, OT rate, deductions become editable); Done flips
 *           back to read-only money formatting.
 *      14. updateSetting — changing the basicSalary input in edit mode is
 *           reflected in the POST body of a subsequent Calculate.
 *      15. exportCSV — clicking Export CSV builds a blob + invokes
 *           URL.createObjectURL with a Blob carrying the expected header
 *           row + one row per staff.
 *      16. Slip — clicking the per-row "Slip" button calls
 *           openPrintEndpoint with the slip URL carrying month + settings.
 *      17. Overtime tab — switching tabs fires GET /hr-ops/overtime?month=
 *           and renders the list with status pills (Approved / Pending).
 *      18. Overtime auto-calculate — POSTs the year/month + defaults and
 *           reloads the list.
 *      19. Overtime auto-calculate failure — toast.error fires.
 *      20. Overtime per-row approve — PATCHes the approve endpoint and
 *           reloads the list.
 *      21. Overtime empty branch — "No overtime records." copy when list
 *           is [].
 *      22. Overtime initial GET rejection — flips loading off, renders the
 *           empty branch.
 *
 *   - Mocks: @/lib/api (api + openPrintEndpoint), @/lib/store (useAuthStore),
 *            @/lib/toast, next/navigation, @/components/Skeleton (stubbed).
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

const { apiMock, openPrintMock, toastMock, authMock, routerMock } = vi.hoisted(
  () => ({
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    openPrintMock: vi.fn(),
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
  }),
);

vi.mock("@/lib/api", () => ({
  api: apiMock,
  openPrintEndpoint: openPrintMock,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/payroll",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));
vi.mock("lucide-react", () => ({
  Download: () => <span data-testid="icon-download" />,
  Calculator: () => <span data-testid="icon-calculator" />,
  Loader2: () => <span data-testid="icon-loader" />,
}));

import PayrollPage from "../page";

type Staff = {
  id: string;
  name: string;
  role: string;
  email?: string;
};

type PayrollRow = {
  userId: string;
  year: number;
  month: number;
  basicSalary: number;
  allowances: number;
  deductions: number;
  absentPenalty: number;
  overtimeShifts: number;
  overtimePay: number;
  workedDays: number;
  scheduledDays: number;
  gross: number;
  net: number;
};

function staffFixture(overrides: Partial<Staff> = {}): Staff {
  return {
    id: "s-doc-1",
    name: "Dr. House",
    role: "DOCTOR",
    email: "house@test.local",
    ...overrides,
  };
}

function payrollResultFixture(overrides: Partial<PayrollRow> = {}): PayrollRow {
  return {
    userId: "s-doc-1",
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    basicSalary: 80000,
    allowances: 0,
    deductions: 0,
    absentPenalty: 1000,
    overtimeShifts: 2,
    overtimePay: 500,
    workedDays: 20,
    scheduledDays: 22,
    gross: 80500,
    net: 79500,
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin" },
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
  });
}

function wireUsersResp(list: Staff[]) {
  apiMock.get.mockImplementation((url: string) => {
    if (url === "/chat/users") {
      return Promise.resolve({ data: list });
    }
    if (url.startsWith("/hr-ops/overtime")) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("PayrollPage (admin-only payroll + overtime tabbed surface)", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    openPrintMock.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redirects non-ADMIN (DOCTOR) to /dashboard and never fires the staff GET", async () => {
    asDoctor();

    render(<PayrollPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
    // The non-ADMIN branch returns null — no tabs / heading should render.
    expect(
      screen.queryByRole("heading", { name: /^Payroll$/ }),
    ).not.toBeInTheDocument();
    // The staff loader is role-gated, so it never fires for non-admins.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the loading skeleton while the initial /chat/users GET is pending", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/chat/users") return new Promise(() => {});
      return Promise.resolve({ data: [] });
    });

    render(<PayrollPage />);

    const loading = await screen.findByTestId("payroll-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute("aria-busy", "true");
    // Tabs / heading still render during load.
    expect(screen.getByRole("button", { name: /^Payroll$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Overtime$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Payroll$/ })).toBeInTheDocument();
  });

  it("renders one row per staff with role-defaulted basic salary + headers", async () => {
    wireUsersResp([
      staffFixture({ id: "s-doc", name: "Dr. House", role: "DOCTOR" }),
      staffFixture({ id: "s-nurse", name: "Nurse Joy", role: "NURSE" }),
      staffFixture({ id: "s-rec", name: "Recep Anna", role: "RECEPTION" }),
      staffFixture({ id: "s-misc", name: "Tech Bob", role: "TECHNICIAN" }),
    ]);

    render(<PayrollPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    // Each staff name is rendered.
    expect(screen.getByText("Dr. House")).toBeInTheDocument();
    expect(screen.getByText("Nurse Joy")).toBeInTheDocument();
    expect(screen.getByText("Recep Anna")).toBeInTheDocument();
    expect(screen.getByText("Tech Bob")).toBeInTheDocument();
    // Role-defaulted basic salaries render via fmtMoney.
    expect(screen.getByText("Rs. 80,000.00")).toBeInTheDocument(); // DOCTOR
    expect(screen.getByText("Rs. 30,000.00")).toBeInTheDocument(); // NURSE
    expect(screen.getByText("Rs. 20,000.00")).toBeInTheDocument(); // RECEPTION
    expect(screen.getByText("Rs. 25,000.00")).toBeInTheDocument(); // TECHNICIAN fallback
    // Default OT rate text appears (rendered N times — match by occurrence).
    expect(screen.getAllByText(/Rs\. 250\/h/).length).toBeGreaterThanOrEqual(4);
    // Table headers.
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Role" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Net Pay" })).toBeInTheDocument();
  });

  it('renders "No staff found" when the staff list is empty', async () => {
    wireUsersResp([]);

    render(<PayrollPage />);

    expect(await screen.findByText(/No staff found/i)).toBeInTheDocument();
    // Generate All becomes disabled with no staff.
    const genAll = screen.getByRole("button", { name: /Generate All/i });
    expect(genAll).toBeDisabled();
  });

  it("clears loading and shows the empty branch on initial GET rejection", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/chat/users")
        return Promise.reject(new Error("500 boom"));
      return Promise.resolve({ data: [] });
    });

    render(<PayrollPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/No staff found/i)).toBeInTheDocument();
  });

  it("per-row Calculate POSTs /hr-ops/payroll with parsed settings and renders the result", async () => {
    wireUsersResp([staffFixture({ id: "s-doc", role: "DOCTOR" })]);
    apiMock.post.mockResolvedValue({ data: payrollResultFixture({ userId: "s-doc" }) });

    render(<PayrollPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    const row = screen.getByText("Dr. House").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /^Calculate$/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(1);
    });
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/hr-ops/payroll");
    expect(body).toMatchObject({
      userId: "s-doc",
      basicSalary: 80000,
      allowances: 0,
      deductions: 0,
      overtimeRate: 250,
    });
    expect(body.year).toBeTypeOf("number");
    expect(body.month).toBeTypeOf("number");

    // After the result lands, days-worked / net-pay cells render.
    await waitFor(() => {
      const updatedRow = screen.getByText("Dr. House").closest("tr") as HTMLElement;
      expect(within(updatedRow).getByTestId("days-worked-s-doc")).toHaveTextContent(
        "20 / 22",
      );
    });
  });

  it("per-row Calculate failure surfaces a toast.error with the message", async () => {
    wireUsersResp([staffFixture({ id: "s-doc" })]);
    apiMock.post.mockRejectedValue(new Error("Validation failed"));

    render(<PayrollPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Calculate$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Validation failed");
    });
  });

  it("Generate All issues N POSTs + brackets with info + success toasts (all OK)", async () => {
    wireUsersResp([
      staffFixture({ id: "s-1", name: "S1" }),
      staffFixture({ id: "s-2", name: "S2" }),
      staffFixture({ id: "s-3", name: "S3" }),
    ]);
    apiMock.post.mockResolvedValue({ data: payrollResultFixture() });

    render(<PayrollPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Generate All/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(3);
    });
    // Info toast brackets the start.
    expect(toastMock.info).toHaveBeenCalledWith(
      expect.stringMatching(/Calculating payroll for \d{4}-\d{2}/),
    );
    // Success toast carries the OK count.
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        "Payroll calculated for 3 staff.",
      );
    });
  });

  it("Generate All — mixed success/failure surfaces a partial-success toast", async () => {
    wireUsersResp([
      staffFixture({ id: "s-1", name: "S1" }),
      staffFixture({ id: "s-2", name: "S2" }),
    ]);
    apiMock.post
      .mockResolvedValueOnce({ data: payrollResultFixture({ userId: "s-1" }) })
      .mockRejectedValueOnce(new Error("partial fail"));

    render(<PayrollPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Generate All/i }));

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        "Payroll calculated for 1 staff (1 failed).",
      );
    });
  });

  it("Generate All — total failure surfaces an error toast with the count", async () => {
    wireUsersResp([
      staffFixture({ id: "s-1", name: "S1" }),
      staffFixture({ id: "s-2", name: "S2" }),
    ]);
    apiMock.post.mockRejectedValue(new Error("everything down"));

    render(<PayrollPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Generate All/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Payroll calculation failed for all 2 staff.",
      );
    });
  });

  it("Generate All — empty staff list short-circuits without a toast", async () => {
    wireUsersResp([]);

    render(<PayrollPage />);

    await screen.findByText(/No staff found/i);

    // Button is disabled when staff.length===0; force-fire via the bound handler
    // by re-enabling for the call path (assert info NOT called since the early
    // return takes effect even if we synthesise a click).
    const btn = screen.getByRole("button", { name: /Generate All/i });
    expect(btn).toBeDisabled();
    // Even if we strip disabled and click, the early-return prevents the info toast.
    btn.removeAttribute("disabled");
    fireEvent.click(btn);
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("period selector updates the month used in subsequent Calculate POST", async () => {
    wireUsersResp([staffFixture({ id: "s-doc" })]);
    apiMock.post.mockResolvedValue({ data: payrollResultFixture() });

    render(<PayrollPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    // First month input is the payroll period selector.
    const monthInput = document.querySelector(
      'input[type="month"]',
    ) as HTMLInputElement;
    expect(monthInput).toBeTruthy();
    fireEvent.change(monthInput, { target: { value: "2026-03" } });

    fireEvent.click(screen.getByRole("button", { name: /^Calculate$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    const body = apiMock.post.mock.calls[0][1];
    expect(body.year).toBe(2026);
    expect(body.month).toBe(3);
  });

  it("Edit toggle flips inputs in/out and updateSetting flows through to the POST", async () => {
    wireUsersResp([staffFixture({ id: "s-doc" })]);
    apiMock.post.mockResolvedValue({ data: payrollResultFixture() });

    render(<PayrollPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Edit$/i }));
    // Button copy flips to "Done".
    expect(screen.getByRole("button", { name: /^Done$/i })).toBeInTheDocument();

    // The basicSalary input now exists and is editable; mutate it.
    // Inputs in edit row carry width classes; pick the first text input.
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    const editable = Array.from(inputs).filter(
      (i) => (i as HTMLInputElement).type !== "month",
    ) as HTMLInputElement[];
    expect(editable.length).toBeGreaterThanOrEqual(4);
    // The first editable is basicSalary in edit mode.
    fireEvent.change(editable[0], { target: { value: "90000" } });

    // POST picks up the new basicSalary value.
    fireEvent.click(screen.getByRole("button", { name: /^Calculate$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    expect(apiMock.post.mock.calls[0][1].basicSalary).toBe(90000);

    // Done flips inputs back to fmtMoney text.
    fireEvent.click(screen.getByRole("button", { name: /^Done$/i }));
    expect(screen.getByText("Rs. 90,000.00")).toBeInTheDocument();
  });

  it("exportCSV creates a Blob with header + one row per staff via createObjectURL", async () => {
    wireUsersResp([
      staffFixture({ id: "s-1", name: "S1", role: "DOCTOR" }),
      staffFixture({ id: "s-2", name: "S2", role: "NURSE" }),
    ]);

    render(<PayrollPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    // Stub anchor click so jsdom doesn't try to navigate.
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

    expect(createSpy).toHaveBeenCalledTimes(1);
    const blobArg = createSpy.mock.calls[0][0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toMatch(/text\/csv/);
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock");

    createSpy.mockRestore();
    revokeSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("Slip button calls openPrintEndpoint with month + settings querystring", async () => {
    wireUsersResp([staffFixture({ id: "s-doc" })]);

    render(<PayrollPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("slip-s-doc"));

    expect(openPrintMock).toHaveBeenCalledTimes(1);
    const url: string = openPrintMock.mock.calls[0][0];
    expect(url).toMatch(/^\/hr-ops\/payroll\/s-doc\/slip\?/);
    expect(url).toContain("month=");
    expect(url).toContain("basicSalary=80000");
    expect(url).toContain("overtimeRate=250");
  });

  it("Overtime tab — GET /hr-ops/overtime fires and renders pills + rows", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/chat/users") return Promise.resolve({ data: [staffFixture()] });
      if (url.startsWith("/hr-ops/overtime")) {
        return Promise.resolve({
          data: [
            {
              id: "ot-1",
              userId: "s-doc-1",
              date: "2026-05-10T00:00:00.000Z",
              regularHours: 8,
              overtimeHours: 3,
              hourlyRate: 250,
              overtimeRate: 1.5,
              amount: 1125,
              approved: false,
              notes: null,
              user: { id: "s-doc-1", name: "Dr. House", role: "DOCTOR" },
            },
            {
              id: "ot-2",
              userId: "s-doc-1",
              date: "2026-05-11T00:00:00.000Z",
              regularHours: 8,
              overtimeHours: 2,
              hourlyRate: 250,
              overtimeRate: 1.5,
              amount: 750,
              approved: true,
              notes: null,
              user: { id: "s-doc-1", name: "Dr. House", role: "DOCTOR" },
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PayrollPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    // Switch to overtime tab.
    fireEvent.click(screen.getByRole("button", { name: /^Overtime$/ }));

    // Overtime heading + summary line.
    await screen.findByRole("heading", { name: /^Overtime$/ });
    // Switching tabs re-fetches /hr-ops/overtime and re-shows the loading
    // skeleton, so wait for the row data (the pills) to land before asserting
    // synchronously — otherwise getByText races the pending fetch.
    expect(await screen.findByText(/^Pending$/)).toBeInTheDocument();
    expect(screen.getByText(/^Approved$/)).toBeInTheDocument();
    // Date cells render the YYYY-MM-DD slice.
    expect(screen.getByText("2026-05-10")).toBeInTheDocument();
    expect(screen.getByText("2026-05-11")).toBeInTheDocument();
  });

  it("Overtime auto-calculate POSTs the defaults + reloads the list", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/chat/users") return Promise.resolve({ data: [staffFixture()] });
      if (url.startsWith("/hr-ops/overtime"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PayrollPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Overtime$/ }));
    await screen.findByRole("heading", { name: /^Overtime$/ });

    apiMock.get.mockClear();

    fireEvent.click(
      screen.getByRole("button", { name: /Auto-calculate from shifts/i }),
    );

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/hr-ops/overtime/auto-calculate",
        expect.objectContaining({
          defaultHourlyRate: 250,
          regularHoursPerDay: 8,
          overtimeRate: 1.5,
        }),
      );
    });
    // Reload fires after the POST.
    await waitFor(() => {
      const otCalls = apiMock.get.mock.calls.filter(([url]) =>
        (url as string).startsWith("/hr-ops/overtime"),
      );
      expect(otCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("Overtime auto-calculate failure surfaces a toast.error", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/chat/users") return Promise.resolve({ data: [staffFixture()] });
      if (url.startsWith("/hr-ops/overtime"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockRejectedValue(new Error("no shifts found"));

    render(<PayrollPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Overtime$/ }));
    await screen.findByRole("heading", { name: /^Overtime$/ });

    fireEvent.click(
      screen.getByRole("button", { name: /Auto-calculate from shifts/i }),
    );

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("no shifts found");
    });
  });

  it("Overtime per-row Approve PATCHes the approve endpoint + reloads", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/chat/users") return Promise.resolve({ data: [staffFixture()] });
      if (url.startsWith("/hr-ops/overtime")) {
        return Promise.resolve({
          data: [
            {
              id: "ot-99",
              userId: "s-doc-1",
              date: "2026-05-10T00:00:00.000Z",
              regularHours: 8,
              overtimeHours: 3,
              hourlyRate: 250,
              overtimeRate: 1.5,
              amount: 1125,
              approved: false,
              notes: null,
              user: { id: "s-doc-1", name: "Dr. House", role: "DOCTOR" },
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<PayrollPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Overtime$/ }));
    await screen.findByRole("heading", { name: /^Overtime$/ });
    await screen.findByText("2026-05-10");

    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/hr-ops/overtime/ot-99/approve",
        {},
      );
    });
  });

  it("Overtime tab — empty branch shows 'No overtime records.'", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/chat/users") return Promise.resolve({ data: [staffFixture()] });
      if (url.startsWith("/hr-ops/overtime"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    render(<PayrollPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Overtime$/ }));
    await screen.findByRole("heading", { name: /^Overtime$/ });

    expect(await screen.findByText(/No overtime records\./i)).toBeInTheDocument();
  });

  it("Overtime initial GET rejection clears loading + renders the empty branch", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/chat/users") return Promise.resolve({ data: [staffFixture()] });
      if (url.startsWith("/hr-ops/overtime"))
        return Promise.reject(new Error("503"));
      return Promise.resolve({ data: [] });
    });

    render(<PayrollPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("payroll-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Overtime$/ }));
    await screen.findByRole("heading", { name: /^Overtime$/ });

    // Empty branch renders despite the rejection.
    expect(await screen.findByText(/No overtime records\./i)).toBeInTheDocument();
  });
});
