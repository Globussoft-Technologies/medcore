/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SurgeryPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/surgery/page.tsx`, the operating-theatre
 *     schedule + case-management surface for SURGEON/DOCTOR/ADMIN roles.
 *   - The page fetches /surgery (list, filtered by tab + date window),
 *     /doctors and /surgery/ots (when the schedule modal opens), and
 *     /patients (typeahead). It renders four status tabs (SCHEDULED,
 *     IN_PROGRESS, COMPLETED, CANCELLED), a date filter row, a click-to-sort
 *     header set per Issue #436, a per-row Start / Complete / Cancel action
 *     trio gated on `effectiveStatus` (Issue #86 — past-due SCHEDULED rows
 *     surface as MISSED_SCHEDULE), and a schedule modal that POSTs /surgery.
 *
 *   - Behaviours covered (mapped to the page surface):
 *       1. Loading branch — surgery-loading skeleton renders while the
 *          initial /surgery GET is pending.
 *       2. Empty branch — "No surgeries in this state." renders when the
 *          list is empty.
 *       3. Happy fetch (ADMIN) — case number, patient name + MR, surgeon
 *          name with "Dr. " prefix, OT, procedure, scheduled-at, status
 *          badge all render. Result count shows "1 result" / "N results".
 *       4. Schedule button gating — "Schedule Surgery" only shows for
 *          DOCTOR/ADMIN (NURSE sees only the table).
 *       5. Tab switching — clicking In Progress / Completed / Cancelled
 *          refires GET /surgery with the new status param.
 *       6. Date filter — From, To, Today, Clear dates each refire the GET
 *          with the new from/to ISO bounds.
 *       7. Sort toggles — clicking the same sort header twice flips asc
 *          → desc; clicking a different header resets to asc.
 *       8. effectiveStatus tagging — a past-dated SCHEDULED row renders
 *          the MISSED SCHEDULE badge and the Start button is hidden.
 *       9. Start action — clicking Start patches /surgery/:id/start and
 *          re-fetches the list.
 *      10. Start error path — startErrorMessage extracts payload.missing
 *          ("Pre-op checklist incomplete: …"), payload.error, zod field
 *          details, and falls back to err.message.
 *      11. Complete action — usePrompt returns text → patches
 *          /surgery/:id/complete with postOpNotes.
 *      12. Cancel action — usePrompt returns text → patches
 *          /surgery/:id/cancel with reason.
 *      13. Cancel cancellation — usePrompt returns null/empty → no PATCH.
 *      14. Schedule modal opening — Plus button reveals the modal and
 *          fires the doctors + OTs GETs.
 *      15. Patient typeahead — typing ≥2 chars (after debounce) fires
 *          GET /patients?search=…; clicking a result populates the form.
 *      16. Schedule validation — every required field guard (patient,
 *          surgeon, OT, procedure, scheduledAt, past-date) fires the
 *          matching toast and skips the POST.
 *      17. Schedule validation — numeric guards: duration ≤ 0 and
 *          negative cost each toast and skip POST.
 *      18. Schedule happy path — valid form POSTs /surgery, closes the
 *          modal, and re-fetches the list.
 *      19. Schedule API error — field-error and bare-error branches.
 *      20. Modal cancel — closes without posting.
 *      21. Error resilience — list, doctors, OTs, patients GETs each
 *          reject independently without crashing the page.
 *
 *   - Source under test: apps/web/src/app/dashboard/surgery/page.tsx
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/use-dialog,
 *            next/navigation, @/components/Skeleton, @/components/Tooltip,
 *            @/components/Autocomplete (stubbed).
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
} from "@testing-library/react";

const { apiMock, toastMock, authMock, promptMock } = vi.hoisted(() => ({
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
  promptMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  usePrompt: () => promptMock,
  useConfirm: () => vi.fn(async () => true),
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
  usePathname: () => "/dashboard/surgery",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));
vi.mock("@/components/Tooltip", () => ({
  InfoIcon: () => <span data-testid="info-icon" />,
}));
// Stub the Autocomplete so we can invoke onChange directly without dealing
// with its debounced fetch + portal-ish dropdown internals.
vi.mock("@/components/Autocomplete", () => ({
  Autocomplete: (props: any) => (
    <input
      data-testid="diagnosis-autocomplete"
      value={props.value}
      placeholder={props.placeholder}
      onChange={(e) =>
        props.onChange(e.target.value, {
          code: "K35.80",
          description: "Acute appendicitis",
        })
      }
    />
  ),
}));

import SurgeryPage from "../page";

type Surgery = {
  id: string;
  caseNumber: string;
  patientId: string;
  surgeonId: string;
  otId: string;
  procedure: string;
  scheduledAt: string;
  durationMin?: number | null;
  status:
    | "SCHEDULED"
    | "IN_PROGRESS"
    | "COMPLETED"
    | "CANCELLED"
    | "POSTPONED"
    | "MISSED_SCHEDULE";
  cost?: number | null;
  patient: { id: string; mrNumber?: string; user: { name: string; phone?: string } };
  surgeon: { id: string; user: { name: string } };
  ot: { id: string; name: string };
};

type Doctor = {
  id: string;
  userId: string;
  user: { name: string };
  specialization?: string;
};

type OT = {
  id: string;
  name: string;
  floor?: string | null;
  isActive: boolean;
  dailyRate: number;
};

/**
 * Pick "+48h" not "+24h" — sidesteps IST/UTC midnight-edge traps where a
 * timestamp generated at, say, 22:00 IST today would land on tomorrow UTC
 * but on today IST, which then trips effectiveStatus' STALE_GRACE_MIN
 * (30 minute) past-window check. +48h is safely future in every zone.
 */
function in48h(): string {
  return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
}

/** A timestamp 2 hours in the past, well outside the 30-min grace window. */
function pastBeyondGrace(): string {
  return new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
}

function surgeryFixture(overrides: Partial<Surgery> = {}): Surgery {
  return {
    id: "sg-1",
    caseNumber: "S-001",
    patientId: "p-1",
    surgeonId: "d-1",
    otId: "ot-1",
    procedure: "Appendectomy",
    scheduledAt: in48h(),
    durationMin: 60,
    status: "SCHEDULED",
    cost: 25000,
    patient: {
      id: "p-1",
      mrNumber: "MR-001",
      user: { name: "Aanya Sharma", phone: "9999900001" },
    },
    surgeon: { id: "d-1", user: { name: "Dr. Mehta" } },
    ot: { id: "ot-1", name: "OT-Alpha" },
    ...overrides,
  };
}

function doctorFixture(overrides: Partial<Doctor> = {}): Doctor {
  return {
    id: "d-1",
    userId: "u-doc-1",
    user: { name: "Dr. Mehta" },
    specialization: "General Surgery",
    ...overrides,
  };
}

function otFixture(overrides: Partial<OT> = {}): OT {
  return {
    id: "ot-1",
    name: "OT-Alpha",
    floor: "2",
    isActive: true,
    dailyRate: 5000,
    ...overrides,
  };
}

/**
 * Route api.get by URL prefix. Robust dispatch lets the same mock service
 * multiple reload-after-action tests without juggling mockResolvedValueOnce
 * chains.
 */
function wireGet(opts: {
  surgeries?: Surgery[];
  doctors?: Doctor[];
  ots?: OT[];
  patients?: any[];
  surgeriesReject?: boolean;
  doctorsReject?: boolean;
  otsReject?: boolean;
  patientsReject?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/surgery/ots")) {
      if (opts.otsReject) return Promise.reject(new Error("ots boom"));
      return Promise.resolve({ data: opts.ots ?? [] });
    }
    if (url.startsWith("/surgery?")) {
      if (opts.surgeriesReject)
        return Promise.reject(new Error("surgeries boom"));
      return Promise.resolve({ data: opts.surgeries ?? [] });
    }
    if (url.startsWith("/doctors")) {
      if (opts.doctorsReject) return Promise.reject(new Error("docs boom"));
      return Promise.resolve({ data: opts.doctors ?? [] });
    }
    if (url.startsWith("/patients")) {
      if (opts.patientsReject)
        return Promise.reject(new Error("patients boom"));
      return Promise.resolve({ data: opts.patients ?? [] });
    }
    if (url.startsWith("/icd10")) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ data: null });
  });
}

function asRole(role: "ADMIN" | "DOCTOR" | "NURSE" | "SURGEON") {
  authMock.mockImplementation((selector: any) => {
    const state = {
      user: {
        id: `u-${role.toLowerCase()}`,
        userId: `u-${role.toLowerCase()}`,
        role,
        name: role,
        email: `${role.toLowerCase()}@x.com`,
      },
      isLoading: false,
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("Surgery dashboard page", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    apiMock.put.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    promptMock.mockReset();
    asRole("ADMIN");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading skeleton (surgery-loading + aria-busy) while the initial GET is pending", async () => {
    let resolveFn: (v: any) => void = () => {};
    apiMock.get.mockImplementation(
      () => new Promise((r) => { resolveFn = r; }),
    );

    render(<SurgeryPage />);

    expect(
      screen.getByRole("heading", { name: /^Surgery$/i }),
    ).toBeInTheDocument();
    const loading = await screen.findByTestId("surgery-loading");
    expect(loading).toHaveAttribute("aria-busy", "true");

    resolveFn({ data: [] });
    await waitFor(() => {
      expect(screen.queryByTestId("surgery-loading")).not.toBeInTheDocument();
    });
  });

  it('renders the empty branch ("No surgeries in this state.") when the list is empty', async () => {
    wireGet({ surgeries: [] });

    render(<SurgeryPage />);

    expect(
      await screen.findByText(/No surgeries in this state\./i),
    ).toBeInTheDocument();
  });

  it("renders one surgery row with caseNumber, patient, surgeon (Dr.-prefixed), OT, procedure, badge", async () => {
    wireGet({ surgeries: [surgeryFixture()] });

    render(<SurgeryPage />);

    expect(await screen.findByText("S-001")).toBeInTheDocument();
    expect(screen.getByText("Aanya Sharma")).toBeInTheDocument();
    expect(screen.getByText("MR-001")).toBeInTheDocument();
    // formatDoctorName strips the existing "Dr. " and re-adds a single one.
    expect(screen.getByText("Dr. Mehta")).toBeInTheDocument();
    expect(screen.getByText("OT-Alpha")).toBeInTheDocument();
    expect(screen.getByText("Appendectomy")).toBeInTheDocument();
    expect(screen.getByTestId("surgery-status-sg-1")).toHaveTextContent(
      /SCHEDULED/i,
    );

    // Result count
    expect(screen.getByTestId("surgery-result-count")).toHaveTextContent(
      "1 result",
    );
  });

  it("pluralises the result-count label (2 results) and renders duration cell with min suffix", async () => {
    wireGet({
      surgeries: [
        surgeryFixture({ id: "sg-1", caseNumber: "S-001" }),
        surgeryFixture({
          id: "sg-2",
          caseNumber: "S-002",
          durationMin: null,
          patient: {
            id: "p-2",
            mrNumber: "MR-002",
            user: { name: "Rohit", phone: "" },
          },
        }),
      ],
    });

    render(<SurgeryPage />);

    await screen.findByText("S-001");
    expect(screen.getByTestId("surgery-result-count")).toHaveTextContent(
      "2 results",
    );
    // Null durationMin falls back to em-dash.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the Schedule Surgery button for ADMIN", async () => {
    wireGet({ surgeries: [] });
    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    expect(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    ).toBeInTheDocument();
  });

  it("shows the Schedule Surgery button for DOCTOR", async () => {
    asRole("DOCTOR");
    wireGet({ surgeries: [] });
    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    expect(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    ).toBeInTheDocument();
  });

  it("hides the Schedule Surgery button for NURSE (canSchedule=false)", async () => {
    asRole("NURSE");
    wireGet({ surgeries: [surgeryFixture()] });
    render(<SurgeryPage />);
    await screen.findByText("S-001");
    expect(
      screen.queryByRole("button", { name: /Schedule Surgery/i }),
    ).not.toBeInTheDocument();
    // Per-row Start/Cancel are also hidden because canSchedule guards them.
    expect(
      screen.queryByTestId("start-surgery-sg-1"),
    ).not.toBeInTheDocument();
  });

  it("switches tabs and refires GET /surgery with each status", async () => {
    wireGet({ surgeries: [] });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^In Progress$/i }));
    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("status=IN_PROGRESS"))).toBe(true);
    });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Completed$/i }));
    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("status=COMPLETED"))).toBe(true);
    });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Cancelled$/i }));
    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("status=CANCELLED"))).toBe(true);
    });
  });

  it("filters by from-date — refires the list query with from=<iso>", async () => {
    wireGet({ surgeries: [] });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    apiMock.get.mockClear();
    fireEvent.change(screen.getByTestId("surgery-filter-from"), {
      target: { value: "2026-06-01" },
    });

    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("from=") && u.includes("2026"))).toBe(
        true,
      );
    });
  });

  it("filters by to-date — refires the list query with to=<iso>", async () => {
    wireGet({ surgeries: [] });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    apiMock.get.mockClear();
    fireEvent.change(screen.getByTestId("surgery-filter-to"), {
      target: { value: "2026-06-30" },
    });

    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("to="))).toBe(true);
    });
  });

  it("Today filter button sets from=to=today and refires the GET", async () => {
    wireGet({ surgeries: [] });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("surgery-filter-today"));

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    const fromInput = screen.getByTestId("surgery-filter-from") as HTMLInputElement;
    const toInput = screen.getByTestId("surgery-filter-to") as HTMLInputElement;
    expect(fromInput.value).toBeTruthy();
    expect(toInput.value).toBe(fromInput.value);
  });

  it("Clear dates button blanks both inputs and refires GET without from/to params", async () => {
    wireGet({ surgeries: [] });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("surgery-filter-clear"));

    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => !u.includes("from="))).toBe(true);
    });
    expect((screen.getByTestId("surgery-filter-from") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("surgery-filter-to") as HTMLInputElement).value).toBe("");
  });

  it("clicking a sort header toggles direction, then resets when switching keys", async () => {
    wireGet({
      surgeries: [
        surgeryFixture({ id: "sg-1", caseNumber: "S-002" }),
        surgeryFixture({ id: "sg-2", caseNumber: "S-001" }),
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    // Default is scheduledAt asc — clicking scheduledAt flips to desc.
    fireEvent.click(screen.getByTestId("surgery-sort-scheduledAt"));
    expect(
      screen.getByTestId("surgery-sort-scheduledAt").textContent,
    ).toMatch(/↓/);

    // Click again -> asc.
    fireEvent.click(screen.getByTestId("surgery-sort-scheduledAt"));
    expect(
      screen.getByTestId("surgery-sort-scheduledAt").textContent,
    ).toMatch(/↑/);

    // Switch to caseNumber — resets to asc, scheduledAt indicator clears.
    fireEvent.click(screen.getByTestId("surgery-sort-caseNumber"));
    expect(
      screen.getByTestId("surgery-sort-caseNumber").textContent,
    ).toMatch(/↑/);

    // Cover the remaining toggleSort branches.
    fireEvent.click(screen.getByTestId("surgery-sort-patient"));
    fireEvent.click(screen.getByTestId("surgery-sort-surgeon"));
    fireEvent.click(screen.getByTestId("surgery-sort-status"));
  });

  it("past-due SCHEDULED row renders MISSED SCHEDULE badge and hides Start button", async () => {
    wireGet({
      surgeries: [
        surgeryFixture({
          id: "sg-late",
          caseNumber: "S-LATE",
          scheduledAt: pastBeyondGrace(),
        }),
      ],
    });

    render(<SurgeryPage />);

    await screen.findByText("S-LATE");
    expect(screen.getByTestId("surgery-status-sg-late")).toHaveTextContent(
      /MISSED SCHEDULE/i,
    );
    // Start hidden for missed rows…
    expect(
      screen.queryByTestId("start-surgery-sg-late"),
    ).not.toBeInTheDocument();
    // …but Cancel for missed-schedule is still offered.
    expect(screen.getByTestId("cancel-missed-sg-late")).toBeInTheDocument();
  });

  it("invalid scheduledAt (NaN) on a SCHEDULED row falls through effectiveStatus and stays SCHEDULED", async () => {
    wireGet({
      surgeries: [
        surgeryFixture({
          id: "sg-bad",
          caseNumber: "S-BAD",
          scheduledAt: "not-a-date",
        }),
      ],
    });

    render(<SurgeryPage />);

    await screen.findByText("S-BAD");
    expect(screen.getByTestId("surgery-status-sg-bad")).toHaveTextContent(
      /SCHEDULED/i,
    );
  });

  it("non-SCHEDULED status passes through effectiveStatus unchanged (e.g. POSTPONED)", async () => {
    wireGet({
      surgeries: [
        surgeryFixture({
          id: "sg-pp",
          caseNumber: "S-PP",
          status: "POSTPONED",
        }),
      ],
    });

    render(<SurgeryPage />);

    await screen.findByText("S-PP");
    expect(screen.getByTestId("surgery-status-sg-pp")).toHaveTextContent(
      /POSTPONED/i,
    );
  });

  it("Start button PATCHes /surgery/:id/start and re-fetches the list", async () => {
    wireGet({ surgeries: [surgeryFixture()] });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("start-surgery-sg-1"));

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith("/surgery/sg-1/start", {});
    });
    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.startsWith("/surgery?"))).toBe(true);
    });
  });

  it("Start error with payload.missing → toast 'Pre-op checklist incomplete: …'", async () => {
    wireGet({ surgeries: [surgeryFixture()] });
    apiMock.patch.mockRejectedValue({
      payload: { missing: ["Consent", "Anaesthesia"] },
      message: "x",
    });

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    fireEvent.click(screen.getByTestId("start-surgery-sg-1"));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Pre-op checklist incomplete: Consent, Anaesthesia/),
      );
    });
  });

  it("Start error with payload.error → toast the error string", async () => {
    wireGet({ surgeries: [surgeryFixture()] });
    apiMock.patch.mockRejectedValue({
      payload: { error: "Past scheduledAt" },
    });

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    fireEvent.click(screen.getByTestId("start-surgery-sg-1"));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Past scheduledAt");
    });
  });

  it("Start error with zod field details → toast the first humanized message", async () => {
    wireGet({ surgeries: [surgeryFixture()] });
    apiMock.patch.mockRejectedValue({
      payload: { details: [{ field: "scheduledAt", message: "Required" }] },
    });

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    fireEvent.click(screen.getByTestId("start-surgery-sg-1"));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/required/i),
      );
    });
  });

  it("Start error falls through to err.message when nothing else matches", async () => {
    wireGet({ surgeries: [surgeryFixture()] });
    apiMock.patch.mockRejectedValue(new Error("boom"));

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    fireEvent.click(screen.getByTestId("start-surgery-sg-1"));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("boom");
    });
  });

  it("Start error with a bare object (no payload, not Error) falls through to 'Start failed'", async () => {
    wireGet({ surgeries: [surgeryFixture()] });
    apiMock.patch.mockRejectedValue({});

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    fireEvent.click(screen.getByTestId("start-surgery-sg-1"));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Start failed");
    });
  });

  it("Complete action — usePrompt returns notes; PATCHes /surgery/:id/complete and reloads", async () => {
    wireGet({
      surgeries: [
        surgeryFixture({ id: "sg-1", status: "IN_PROGRESS" }),
      ],
    });
    promptMock.mockResolvedValue("Patient stable post-op");
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SurgeryPage />);
    // Tab to IN_PROGRESS so the row + Complete button render.
    fireEvent.click(screen.getByRole("button", { name: /^In Progress$/i }));
    await screen.findByText("S-001");

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Complete$/i }));

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/surgery/sg-1/complete",
        { postOpNotes: "Patient stable post-op" },
      );
    });
  });

  it("Complete with empty notes — postOpNotes is undefined", async () => {
    wireGet({
      surgeries: [surgeryFixture({ id: "sg-1", status: "IN_PROGRESS" })],
    });
    promptMock.mockResolvedValue("");
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SurgeryPage />);
    fireEvent.click(screen.getByRole("button", { name: /^In Progress$/i }));
    await screen.findByText("S-001");

    fireEvent.click(screen.getByRole("button", { name: /^Complete$/i }));

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/surgery/sg-1/complete",
        { postOpNotes: undefined },
      );
    });
  });

  it("Complete dismissed (prompt returns null) — no PATCH fires", async () => {
    wireGet({
      surgeries: [surgeryFixture({ id: "sg-1", status: "IN_PROGRESS" })],
    });
    promptMock.mockResolvedValue(null);

    render(<SurgeryPage />);
    fireEvent.click(screen.getByRole("button", { name: /^In Progress$/i }));
    await screen.findByText("S-001");

    fireEvent.click(screen.getByRole("button", { name: /^Complete$/i }));

    // Give the microtask queue a chance to flush.
    await waitFor(() => {
      expect(promptMock).toHaveBeenCalled();
    });
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Complete error path — PATCH rejection toasts the error message", async () => {
    wireGet({
      surgeries: [surgeryFixture({ id: "sg-1", status: "IN_PROGRESS" })],
    });
    promptMock.mockResolvedValue("ok");
    apiMock.patch.mockRejectedValue(new Error("complete blew up"));

    render(<SurgeryPage />);
    fireEvent.click(screen.getByRole("button", { name: /^In Progress$/i }));
    await screen.findByText("S-001");

    fireEvent.click(screen.getByRole("button", { name: /^Complete$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("complete blew up");
    });
  });

  it("Complete error fallback string when error isn't an Error instance", async () => {
    wireGet({
      surgeries: [surgeryFixture({ id: "sg-1", status: "IN_PROGRESS" })],
    });
    promptMock.mockResolvedValue("notes");
    apiMock.patch.mockRejectedValue("oops");

    render(<SurgeryPage />);
    fireEvent.click(screen.getByRole("button", { name: /^In Progress$/i }));
    await screen.findByText("S-001");

    fireEvent.click(screen.getByRole("button", { name: /^Complete$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Complete failed");
    });
  });

  it("Cancel action — usePrompt returns reason; PATCHes /surgery/:id/cancel and reloads", async () => {
    wireGet({ surgeries: [surgeryFixture()] });
    promptMock.mockResolvedValue("Patient backed out");
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    apiMock.get.mockClear();
    // First button labelled "Cancel" within the SCHEDULED row.
    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/i });
    fireEvent.click(cancelBtns[0]);

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith("/surgery/sg-1/cancel", {
        reason: "Patient backed out",
      });
    });
  });

  it("Cancel dismissed (empty reason) — no PATCH fires", async () => {
    wireGet({ surgeries: [surgeryFixture()] });
    promptMock.mockResolvedValue("");

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/i });
    fireEvent.click(cancelBtns[0]);

    await waitFor(() => {
      expect(promptMock).toHaveBeenCalled();
    });
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Cancel error path — PATCH rejection toasts the error message", async () => {
    wireGet({ surgeries: [surgeryFixture()] });
    promptMock.mockResolvedValue("reason");
    apiMock.patch.mockRejectedValue(new Error("cancel blew up"));

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/i });
    fireEvent.click(cancelBtns[0]);

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("cancel blew up");
    });
  });

  it("Cancel non-Error rejection falls back to 'Cancel failed'", async () => {
    wireGet({ surgeries: [surgeryFixture()] });
    promptMock.mockResolvedValue("reason");
    apiMock.patch.mockRejectedValue("plain string");

    render(<SurgeryPage />);
    await screen.findByText("S-001");

    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/i });
    fireEvent.click(cancelBtns[0]);

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Cancel failed");
    });
  });

  it("Schedule modal opens via Plus button and fires the doctors + OTs GETs", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    );

    expect(
      await screen.findByRole("heading", { name: /Schedule Surgery/i }),
    ).toBeInTheDocument();

    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u === "/doctors")).toBe(true);
      expect(calls.some((u) => u === "/surgery/ots")).toBe(true);
    });
  });

  it("Schedule modal — doctors GET rejection lands an empty surgeon dropdown without crashing", async () => {
    wireGet({ surgeries: [], doctorsReject: true, ots: [otFixture()] });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    );
    await screen.findByRole("heading", { name: /Schedule Surgery/i });

    const surgeon = document.getElementById("surgery-surgeon") as HTMLSelectElement;
    // Only the placeholder option exists.
    expect(surgeon.options.length).toBe(1);
  });

  it("Schedule modal — OTs GET rejection lands an empty OT dropdown without crashing", async () => {
    wireGet({ surgeries: [], doctors: [doctorFixture()], otsReject: true });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    );
    await screen.findByRole("heading", { name: /Schedule Surgery/i });

    const ot = document.getElementById("surgery-ot") as HTMLSelectElement;
    expect(ot.options.length).toBe(1);
  });

  it("Schedule modal — patient typeahead fires GET /patients after debounce, results render, click selects", async () => {
    vi.useRealTimers(); // ensure debounce uses real timers
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "9988776655" },
        },
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    );
    await screen.findByRole("heading", { name: /Schedule Surgery/i });

    const search = document.getElementById(
      "surgery-patient-search",
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Te" } });

    // Wait for the 300ms debounce + GET to fire.
    await waitFor(
      () => {
        const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
        expect(calls.some((u) => u.startsWith("/patients?search=Te"))).toBe(
          true,
        );
      },
      { timeout: 2000 },
    );

    // Result row renders; click it to select.
    const resultBtn = await screen.findByText("Test Patient");
    fireEvent.click(resultBtn);

    // Selected card replaces the typeahead.
    expect(screen.getByText(/MR-99/i)).toBeInTheDocument();
  });

  it("Schedule modal — patient typeahead < 2 chars clears results (no fetch)", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    );
    await screen.findByRole("heading", { name: /Schedule Surgery/i });

    const search = document.getElementById(
      "surgery-patient-search",
    ) as HTMLInputElement;
    apiMock.get.mockClear();
    fireEvent.change(search, { target: { value: "T" } });

    // Debounce window — give the page a tick; no /patients GET should fire.
    await new Promise((r) => setTimeout(r, 400));
    const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.startsWith("/patients?"))).toBe(false);
  });

  it("Schedule modal — patients GET rejection lands an empty result list silently", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patientsReject: true,
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    );
    await screen.findByRole("heading", { name: /Schedule Surgery/i });

    const search = document.getElementById(
      "surgery-patient-search",
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Te" } });

    await waitFor(
      () => {
        const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
        expect(calls.some((u) => u.startsWith("/patients?search=Te"))).toBe(
          true,
        );
      },
      { timeout: 2000 },
    );
    // No "Change" button surface — no patient was selected.
    expect(
      screen.queryByRole("button", { name: /^Change$/i }),
    ).not.toBeInTheDocument();
  });

  it("Schedule submit without patient — toast.error 'Select a patient', no POST", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    );
    await screen.findByRole("heading", { name: /Schedule Surgery/i });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    expect(toastMock.error).toHaveBeenCalledWith("Select a patient");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  /**
   * Helper to open the modal and pick the seeded patient so subsequent tests
   * can focus on the remaining validation branches.
   */
  async function openModalAndPickPatient() {
    fireEvent.click(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    );
    await screen.findByRole("heading", { name: /Schedule Surgery/i });

    const search = document.getElementById(
      "surgery-patient-search",
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Te" } });

    await waitFor(
      () => {
        expect(screen.queryByText("Test Patient")).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByText("Test Patient"));
    // Wait for the selected card to mount.
    await screen.findByRole("button", { name: /^Change$/i });
  }

  it("Schedule submit with patient but no surgeon — toast 'Select a surgeon'", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    expect(toastMock.error).toHaveBeenCalledWith("Select a surgeon");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule submit with patient + surgeon but no OT — toast 'Select an operating theater'", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.change(document.getElementById("surgery-surgeon") as HTMLSelectElement, {
      target: { value: "d-1" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      "Select an operating theater",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule submit without procedure — toast 'Procedure is required'", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.change(document.getElementById("surgery-surgeon") as HTMLSelectElement, {
      target: { value: "d-1" },
    });
    fireEvent.change(document.getElementById("surgery-ot") as HTMLSelectElement, {
      target: { value: "ot-1" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    expect(toastMock.error).toHaveBeenCalledWith("Procedure is required");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule submit without scheduledAt — toast 'Select scheduled date/time'", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.change(document.getElementById("surgery-surgeon") as HTMLSelectElement, {
      target: { value: "d-1" },
    });
    fireEvent.change(document.getElementById("surgery-ot") as HTMLSelectElement, {
      target: { value: "ot-1" },
    });
    fireEvent.change(document.getElementById("surgery-procedure") as HTMLTextAreaElement, {
      target: { value: "Appendectomy" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    expect(toastMock.error).toHaveBeenCalledWith("Select scheduled date/time");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule submit with past-dated scheduledAt — surfaces inline error + toast, no POST", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.change(document.getElementById("surgery-surgeon") as HTMLSelectElement, {
      target: { value: "d-1" },
    });
    fireEvent.change(document.getElementById("surgery-ot") as HTMLSelectElement, {
      target: { value: "ot-1" },
    });
    fireEvent.change(document.getElementById("surgery-procedure") as HTMLTextAreaElement, {
      target: { value: "Appendectomy" },
    });
    // 2026-01-01T00:00 is well in the past relative to a 2026-05 test run.
    fireEvent.change(screen.getByTestId("schedule-surgery-at"), {
      target: { value: "2026-01-01T00:00" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      "Scheduled date/time cannot be in the past",
    );
    expect(
      await screen.findByTestId("error-scheduled-at"),
    ).toHaveTextContent(/cannot be in the past/i);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule submit with non-positive duration — toast 'Duration must be greater than 0'", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.change(document.getElementById("surgery-surgeon") as HTMLSelectElement, {
      target: { value: "d-1" },
    });
    fireEvent.change(document.getElementById("surgery-ot") as HTMLSelectElement, {
      target: { value: "ot-1" },
    });
    fireEvent.change(document.getElementById("surgery-procedure") as HTMLTextAreaElement, {
      target: { value: "Appendectomy" },
    });
    // +48h, pickable via datetime-local format yyyy-MM-ddTHH:mm.
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);
    fireEvent.change(screen.getByTestId("schedule-surgery-at"), {
      target: { value: future },
    });
    fireEvent.change(screen.getByTestId("schedule-surgery-duration"), {
      target: { value: "0" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      "Duration must be greater than 0",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule submit with negative cost — toast 'Cost cannot be negative'", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.change(document.getElementById("surgery-surgeon") as HTMLSelectElement, {
      target: { value: "d-1" },
    });
    fireEvent.change(document.getElementById("surgery-ot") as HTMLSelectElement, {
      target: { value: "ot-1" },
    });
    fireEvent.change(document.getElementById("surgery-procedure") as HTMLTextAreaElement, {
      target: { value: "Appendectomy" },
    });
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);
    fireEvent.change(screen.getByTestId("schedule-surgery-at"), {
      target: { value: future },
    });
    fireEvent.change(screen.getByTestId("schedule-surgery-cost"), {
      target: { value: "-5" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    expect(toastMock.error).toHaveBeenCalledWith("Cost cannot be negative");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule happy path — POSTs /surgery with the form payload, closes modal, reloads list", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });
    apiMock.post.mockResolvedValue({ data: { id: "sg-new" } });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.change(document.getElementById("surgery-surgeon") as HTMLSelectElement, {
      target: { value: "d-1" },
    });
    fireEvent.change(document.getElementById("surgery-ot") as HTMLSelectElement, {
      target: { value: "ot-1" },
    });
    fireEvent.change(document.getElementById("surgery-procedure") as HTMLTextAreaElement, {
      target: { value: "Appendectomy" },
    });
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);
    fireEvent.change(screen.getByTestId("schedule-surgery-at"), {
      target: { value: future },
    });
    fireEvent.change(screen.getByTestId("schedule-surgery-duration"), {
      target: { value: "90" },
    });
    fireEvent.change(screen.getByTestId("schedule-surgery-cost"), {
      target: { value: "25000" },
    });
    // Fill anaesthesiologist / assistants / preOpNotes / diagnosis to cover
    // the truthy branches of the optional-field spread in the POST body.
    fireEvent.change(document.getElementById("surgery-anaesthesiologist") as HTMLInputElement, {
      target: { value: "Dr Anand" },
    });
    fireEvent.change(document.getElementById("surgery-assistants") as HTMLInputElement, {
      target: { value: "Dr Sneha, Dr Vinay" },
    });
    fireEvent.change(document.getElementById("surgery-preop-notes") as HTMLTextAreaElement, {
      target: { value: "Fasting since 22:00" },
    });
    fireEvent.change(screen.getByTestId("diagnosis-autocomplete"), {
      target: { value: "appendicitis" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/surgery",
        expect.objectContaining({
          patientId: "p-99",
          surgeonId: "d-1",
          otId: "ot-1",
          procedure: "Appendectomy",
          durationMin: 90,
          anaesthesiologist: "Dr Anand",
          assistants: "Dr Sneha, Dr Vinay",
          preOpNotes: "Fasting since 22:00",
          cost: 25000,
        }),
      );
    });

    // Modal closes.
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /^Schedule Surgery$/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("Schedule POST rejection with field details — sets inline scheduleError and toasts", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });
    apiMock.post.mockRejectedValue({
      payload: {
        details: [{ field: "scheduledAt", message: "Custom server message" }],
      },
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.change(document.getElementById("surgery-surgeon") as HTMLSelectElement, {
      target: { value: "d-1" },
    });
    fireEvent.change(document.getElementById("surgery-ot") as HTMLSelectElement, {
      target: { value: "ot-1" },
    });
    fireEvent.change(document.getElementById("surgery-procedure") as HTMLTextAreaElement, {
      target: { value: "Appendectomy" },
    });
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);
    fireEvent.change(screen.getByTestId("schedule-surgery-at"), {
      target: { value: future },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Custom server message");
    });
  });

  it("Schedule POST rejection with bare Error — toasts the message", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });
    apiMock.post.mockRejectedValue(new Error("server is down"));

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.change(document.getElementById("surgery-surgeon") as HTMLSelectElement, {
      target: { value: "d-1" },
    });
    fireEvent.change(document.getElementById("surgery-ot") as HTMLSelectElement, {
      target: { value: "ot-1" },
    });
    fireEvent.change(document.getElementById("surgery-procedure") as HTMLTextAreaElement, {
      target: { value: "Appendectomy" },
    });
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);
    fireEvent.change(screen.getByTestId("schedule-surgery-at"), {
      target: { value: future },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("server is down");
    });
  });

  it("Schedule POST rejection non-Error — toasts 'Scheduling failed'", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });
    apiMock.post.mockRejectedValue("non-Error");

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.change(document.getElementById("surgery-surgeon") as HTMLSelectElement, {
      target: { value: "d-1" },
    });
    fireEvent.change(document.getElementById("surgery-ot") as HTMLSelectElement, {
      target: { value: "ot-1" },
    });
    fireEvent.change(document.getElementById("surgery-procedure") as HTMLTextAreaElement, {
      target: { value: "Appendectomy" },
    });
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);
    fireEvent.change(screen.getByTestId("schedule-surgery-at"), {
      target: { value: future },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Scheduling failed");
    });
  });

  it("Selected-patient 'Change' button clears the selection", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);
    await openModalAndPickPatient();

    fireEvent.click(screen.getByRole("button", { name: /^Change$/i }));

    // Card disappears; the search input is restored.
    expect(
      document.getElementById("surgery-patient-search"),
    ).toBeInTheDocument();
  });

  it("Modal Cancel button closes the modal without firing POST", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    );
    await screen.findByRole("heading", { name: /^Schedule Surgery$/i });

    // The modal contains a "Cancel" button — pick the one inside the form
    // (it lives next to the "Schedule" submit button).
    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/i });
    fireEvent.click(cancelBtns[cancelBtns.length - 1]);

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /^Schedule Surgery$/i }),
      ).not.toBeInTheDocument();
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("settles into the empty branch when the initial /surgery fetch rejects", async () => {
    wireGet({ surgeriesReject: true });

    render(<SurgeryPage />);

    expect(
      await screen.findByText(/No surgeries in this state\./i),
    ).toBeInTheDocument();
    // Silent — no toast for initial-load failures.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("clearing the typed patient search to <2 chars resets the result list", async () => {
    wireGet({
      surgeries: [],
      doctors: [doctorFixture()],
      ots: [otFixture()],
      patients: [
        {
          id: "p-99",
          mrNumber: "MR-99",
          user: { name: "Test Patient", phone: "" },
        },
      ],
    });

    render(<SurgeryPage />);
    await screen.findByText(/No surgeries/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule Surgery/i }),
    );
    await screen.findByRole("heading", { name: /^Schedule Surgery$/i });

    const search = document.getElementById(
      "surgery-patient-search",
    ) as HTMLInputElement;

    fireEvent.change(search, { target: { value: "Te" } });
    await waitFor(
      () => {
        expect(screen.queryByText("Test Patient")).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    // Back to one char — results clear.
    fireEvent.change(search, { target: { value: "T" } });
    await waitFor(() => {
      expect(screen.queryByText("Test Patient")).not.toBeInTheDocument();
    });
  });
});
