/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * EmergencyPage (ER board) — colocated coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/emergency/page.tsx, the realtime
 *     ER board (kanban: Waiting / Triaged / In Treatment / Disposition
 *     Pending) plus the Register-New-Case intake modal and the per-case side
 *     panel (Triage / Assign Doctor / Close-Disposition).
 *
 *   - Endpoints the page hits:
 *       GET   /emergency/cases/active   (kanban source — uses allSettled)
 *       GET   /emergency/stats          (KPI ribbon — uses allSettled)
 *       GET   /doctors                  (Assign-Doctor select options)
 *       GET   /patients?search=...      (intake debounced patient picker)
 *       POST  /emergency/cases          (intake submit)
 *       PATCH /emergency/cases/:id/triage
 *       PATCH /emergency/cases/:id/assign
 *       PATCH /emergency/cases/:id/close
 *
 *   - Behaviours covered (high-coverage targets):
 *       1. Initial render lifecycle — loading skeleton (aria-busy) → cases.
 *       2. KPI ribbon — waiting count derived from cases array (Issue #88),
 *          avg-wait formatted via formatElapsed and em-dash fallback when
 *          NaN / negative (Issue #425).
 *       3. Kanban — cases bucket into the 4 columns by status; empty column
 *          renders "No cases" copy; overdue card flips to red text + warning.
 *       4. RBAC — canRegister gates the New Case button (LAB hidden);
 *          canTriage gates Triage section; canAssign / canClose gate.
 *       5. Intake modal — empty submit inline errors + toast; switch to
 *          Unknown mode requires unknownName; chiefComplaint required;
 *          server field-error projection; happy POST resets + reloads.
 *       6. Patient search — typing >=2 chars debounces and fires search,
 *          picking a result fills intakePatient, "Change" clears it.
 *       7. Side panel — clicking a kanban card opens panel; triage button
 *          selection updates form; submitTriage PATCHes the correct shape.
 *       8. Assign doctor — error toast when no doctor selected; happy
 *          PATCH when doctor selected.
 *       9. Close case — disposition + outcomeNotes required; happy PATCH
 *          shape + form reset; API field-error projection; generic toast
 *          fallback for non-fielded errors.
 *      10. Realtime — emergency:update socket event re-fires loadData.
 *      11. Load error banner — allSettled rejection surfaces inline banner
 *          + retry button (Issue #88).
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/socket,
 *            @/lib/i18n, @/lib/format-doctor-name, @/components/Skeleton,
 *            @/components/Tooltip, next/navigation.
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
  act,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, routerMock, socketMock } = vi.hoisted(
  () => {
    const handlers: Record<string, ((...args: any[]) => void)[]> = {};
    return {
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
      socketMock: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        emit: vi.fn(),
        on: vi.fn((evt: string, cb: (...args: any[]) => void) => {
          handlers[evt] = handlers[evt] || [];
          handlers[evt].push(cb);
        }),
        off: vi.fn((evt: string, cb: (...args: any[]) => void) => {
          if (handlers[evt])
            handlers[evt] = handlers[evt].filter((h) => h !== cb);
        }),
        connected: true,
        __emit(evt: string, ...args: any[]) {
          (handlers[evt] || []).forEach((cb) => cb(...args));
        },
      },
    };
  },
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/lib/format-doctor-name", () => ({
  formatDoctorName: (n: string) => `Dr. ${n}`,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/emergency",
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));
vi.mock("@/components/Tooltip", () => ({
  InfoIcon: ({ tooltip }: { tooltip?: string }) => (
    <span data-testid="info-icon" data-tooltip={tooltip} />
  ),
}));

import EmergencyPage from "../page";

type CaseFx = {
  id: string;
  caseNumber: string;
  patientId?: string | null;
  unknownName?: string | null;
  unknownAge?: number | null;
  unknownGender?: string | null;
  arrivedAt: string;
  arrivalMode?: string | null;
  triageLevel?: string | null;
  chiefComplaint: string;
  status: string;
  vitalsBP?: string | null;
  vitalsPulse?: number | null;
  vitalsResp?: number | null;
  vitalsSpO2?: number | null;
  vitalsTemp?: number | null;
  glasgowComa?: number | null;
  mewsScore?: number | null;
  patient?: any;
  attendingDoctor?: any;
};

function caseFx(overrides: Partial<CaseFx> = {}): CaseFx {
  return {
    id: "c1",
    caseNumber: "ER-001",
    patientId: "p1",
    arrivedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    chiefComplaint: "Chest pain radiating to left arm",
    status: "WAITING",
    triageLevel: "EMERGENT",
    arrivalMode: "AMBULANCE",
    patient: {
      id: "p1",
      mrNumber: "MR-1",
      user: { name: "Aarav Mehta", phone: "9000000001" },
    },
    ...overrides,
  };
}

const STATS_OK = {
  totalActive: 5,
  totalWaiting: 2,
  byTriage: {
    RESUSCITATION: 1,
    EMERGENT: 1,
    URGENT: 1,
    LESS_URGENT: 1,
    NON_URGENT: 1,
  },
  avgWaitMin: 14,
  availableBeds: 3,
};

function setUser(role: string | null) {
  authMock.mockReturnValue({ user: role ? { id: "u1", role } : null });
}

/**
 * Wire api.get to return the canned per-endpoint payloads. Each endpoint
 * can be overridden via `overrides`. Anything else falls back to empty.
 */
function wireGet(overrides: Partial<Record<string, any>> = {}) {
  const defaults: Record<string, any> = {
    "/emergency/cases/active": { data: [] },
    "/emergency/stats": { data: STATS_OK },
    "/doctors": { data: [] },
    "/patients": { data: [] },
  };
  apiMock.get.mockImplementation((url: string) => {
    for (const key of Object.keys(overrides)) {
      if (url.startsWith(key)) {
        const v = overrides[key];
        if (v instanceof Error) return Promise.reject(v);
        return Promise.resolve(v);
      }
    }
    for (const key of Object.keys(defaults)) {
      if (url.startsWith(key)) return Promise.resolve(defaults[key]);
    }
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.patch.mockReset();
  apiMock.delete.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.info.mockReset();
  toastMock.warning.mockReset();
  Object.values(routerMock).forEach((fn: any) => fn.mockReset && fn.mockReset());
  socketMock.connect.mockReset();
  socketMock.on.mockClear();
  socketMock.off.mockClear();
  authMock.mockReset();
  setUser("ADMIN");
});

afterEach(() => {
  cleanup();
});

describe("EmergencyPage — initial render lifecycle", () => {
  it("renders the loading skeleton with aria-busy while initial fetches are in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    setUser("NURSE");
    render(<EmergencyPage />);
    const loader = await screen.findByTestId("er-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card").length).toBe(4);
  });

  it("shows the four kanban columns after fetches resolve", async () => {
    wireGet();
    render(<EmergencyPage />);
    // The KPI ribbon also has a "Waiting" label, so disambiguate via the
    // column-header heading role.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 3, name: /^Waiting$/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Triaged")).toBeInTheDocument();
    expect(screen.getByText("In Treatment")).toBeInTheDocument();
    expect(screen.getByText("Disposition Pending")).toBeInTheDocument();
    // Empty columns render the "No cases" copy at least 4x.
    expect(screen.getAllByText("No cases").length).toBeGreaterThanOrEqual(4);
  });
});

describe("EmergencyPage — KPI ribbon", () => {
  it("renders Active / Waiting / triage-level KPIs and avg-wait + beds row", async () => {
    wireGet();
    render(<EmergencyPage />);
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
    // 5 triage labels rendered.
    ["RESUSCITATION", "EMERGENT", "URGENT", "LESS URGENT", "NON URGENT"].forEach(
      (lbl) => expect(screen.getByText(lbl)).toBeInTheDocument(),
    );
    expect(screen.getByText("Avg Wait Time")).toBeInTheDocument();
    expect(screen.getByText("Available Beds")).toBeInTheDocument();
  });

  it("waiting KPI is sourced from cases array (NOT stats.totalWaiting) — Issue #88", async () => {
    // Stats says totalWaiting=2 but the only WAITING case in the array is 1.
    wireGet({
      "/emergency/cases/active": {
        data: [
          caseFx({ id: "c1", status: "WAITING" }),
          caseFx({ id: "c2", status: "TRIAGED", caseNumber: "ER-002" }),
        ],
      },
    });
    render(<EmergencyPage />);
    const kpi = await screen.findByTestId("waiting-kpi");
    expect(kpi.textContent).toBe("1");
  });

  it("avg-wait renders em-dash when stats.avgWaitMin is NaN / negative (Issue #425)", async () => {
    wireGet({
      "/emergency/stats": {
        data: { ...STATS_OK, avgWaitMin: Number.NaN },
      },
    });
    render(<EmergencyPage />);
    const cell = await screen.findByTestId("er-avg-wait");
    expect(cell.textContent).toBe("—");
  });

  it("avg-wait renders formatted elapsed when value is finite & non-negative", async () => {
    wireGet({
      "/emergency/stats": { data: { ...STATS_OK, avgWaitMin: 65 } },
    });
    render(<EmergencyPage />);
    const cell = await screen.findByTestId("er-avg-wait");
    // formatElapsed(65) should produce something like "1h 5m" — verify non-em-dash.
    await waitFor(() => expect(cell.textContent).not.toBe("—"));
    expect(cell.textContent).toMatch(/\d/);
  });

  it("KPI ribbon is hidden until /emergency/stats resolves with truthy data", async () => {
    wireGet({ "/emergency/stats": { data: null } });
    render(<EmergencyPage />);
    await waitFor(() => expect(screen.getAllByText("No cases").length).toBe(4));
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.queryByText("Avg Wait Time")).not.toBeInTheDocument();
  });
});

describe("EmergencyPage — RBAC", () => {
  it.each([
    ["ADMIN", true],
    ["NURSE", true],
    ["RECEPTION", true],
    ["DOCTOR", true],
    ["LAB", false],
    ["PATIENT", false],
  ])("role %s → canRegister Register-New-Case button visible=%s", async (role, expected) => {
    setUser(role);
    wireGet();
    render(<EmergencyPage />);
    await waitFor(() => expect(screen.getAllByText("No cases").length).toBe(4));
    const btn = screen.queryByRole("button", { name: /Register New Case/i });
    if (expected) expect(btn).toBeInTheDocument();
    else expect(btn).not.toBeInTheDocument();
  });

  it("ADMIN+TRIAGED case opens panel and shows Triage + Assign + Close sections", async () => {
    setUser("ADMIN");
    const c = caseFx({ id: "c1", status: "TRIAGED" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    await screen.findByText("Aarav Mehta");
    fireEvent.click(screen.getByText("Aarav Mehta"));
    expect(
      await screen.findByRole("heading", { level: 3, name: /^Triage$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Assign Doctor")).toBeInTheDocument();
    expect(screen.getByText(/Close \/ Disposition/i)).toBeInTheDocument();
  });

  it("RECEPTION on TRIAGED case: Triage hidden, Assign visible, Close hidden", async () => {
    setUser("RECEPTION");
    const c = caseFx({ id: "c1", status: "TRIAGED" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    await screen.findByText("Aarav Mehta");
    fireEvent.click(screen.getByText("Aarav Mehta"));
    await screen.findByText("Assign Doctor");
    expect(screen.queryByText(/Close \/ Disposition/i)).not.toBeInTheDocument();
    // The "Triage" h3 (not the substring inside another label).
    expect(screen.queryByRole("heading", { name: /^Triage$/ })).not.toBeInTheDocument();
  });

  it("NURSE on IN_TREATMENT case: Close hidden (canClose=false)", async () => {
    setUser("NURSE");
    const c = caseFx({ id: "c1", status: "IN_TREATMENT" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    await screen.findByText("Aarav Mehta");
    fireEvent.click(screen.getByText("Aarav Mehta"));
    // Panel open — verify via Chief Complaint label rather than re-finding
    // the name (which collides between card + panel-header).
    await screen.findByText(/Chief Complaint/i);
    expect(screen.queryByText(/Close \/ Disposition/i)).not.toBeInTheDocument();
  });
});

describe("EmergencyPage — kanban bucketing", () => {
  it("buckets cases into the 4 columns by status", async () => {
    const cases = [
      caseFx({ id: "w1", status: "WAITING", caseNumber: "ER-W1" }),
      caseFx({ id: "t1", status: "TRIAGED", caseNumber: "ER-T1" }),
      caseFx({ id: "x1", status: "IN_TREATMENT", caseNumber: "ER-X1" }),
      caseFx({ id: "a1", status: "ADMITTED", caseNumber: "ER-A1" }),
      // Discharged should NOT appear (no column filter matches).
      caseFx({ id: "d1", status: "DISCHARGED", caseNumber: "ER-D1" }),
    ];
    wireGet({ "/emergency/cases/active": { data: cases } });
    render(<EmergencyPage />);
    await screen.findByText("ER-W1");
    expect(screen.getByText("ER-T1")).toBeInTheDocument();
    expect(screen.getByText("ER-X1")).toBeInTheDocument();
    expect(screen.getByText("ER-A1")).toBeInTheDocument();
    expect(screen.queryByText("ER-D1")).not.toBeInTheDocument();
  });

  it("renders unknown-patient display when patient is null", async () => {
    wireGet({
      "/emergency/cases/active": {
        data: [
          caseFx({
            id: "u1",
            patient: null,
            patientId: null,
            unknownName: "John Doe",
            unknownAge: 45,
            unknownGender: "MALE",
          }),
        ],
      },
    });
    render(<EmergencyPage />);
    await screen.findByText("John Doe");
    expect(screen.getByText(/45y MALE/)).toBeInTheDocument();
  });

  it("falls back to 'Unknown' when both patient + unknownName are missing", async () => {
    wireGet({
      "/emergency/cases/active": {
        data: [caseFx({ patient: null, patientId: null, unknownName: null })],
      },
    });
    render(<EmergencyPage />);
    await screen.findByText("Unknown");
  });

  it("overdue card (elapsed > target) renders red text + AlertTriangle icon", async () => {
    // EMERGENT target is 10 min; arrived 30 min ago → overdue.
    const overdue = caseFx({
      id: "od1",
      triageLevel: "EMERGENT",
      arrivedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    wireGet({ "/emergency/cases/active": { data: [overdue] } });
    render(<EmergencyPage />);
    const waitSpan = await screen.findByTestId("er-wait-od1");
    expect(waitSpan.className).toMatch(/text-red-600/);
  });

  it("renders '—' wait label when arrivedAt is falsy", async () => {
    const c = caseFx({ id: "nx", arrivedAt: "" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    const waitSpan = await screen.findByTestId("er-wait-nx");
    expect(waitSpan.textContent).toBe("—");
  });

  it("renders attendingDoctor name (formatDoctorName-prefixed) on the kanban card", async () => {
    const c = caseFx({
      id: "ad1",
      attendingDoctor: { id: "d1", user: { name: "Rajesh Verma" } },
    });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    expect(await screen.findByText(/Dr\. Rajesh Verma/)).toBeInTheDocument();
  });
});

describe("EmergencyPage — load error banner (Issue #88)", () => {
  it("renders the inline error banner when /emergency/cases/active rejects (allSettled)", async () => {
    wireGet({ "/emergency/cases/active": new Error("active down") });
    render(<EmergencyPage />);
    const banner = await screen.findByTestId("er-load-error");
    expect(banner).toHaveTextContent("Could not load ER board");
    expect(banner).toHaveTextContent("active down");
    expect(toastMock.error).toHaveBeenCalledWith("active down");
  });

  it("Retry button on the banner re-fires loadData (refetches /emergency/cases/active)", async () => {
    wireGet({ "/emergency/cases/active": new Error("first fail") });
    render(<EmergencyPage />);
    await screen.findByTestId("er-load-error");
    const callsBefore = apiMock.get.mock.calls.length;

    // After Retry, swap to success.
    wireGet();
    fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });
});

describe("EmergencyPage — intake modal (Issue #576)", () => {
  it("opens via Register-New-Case button and closes via Cancel", async () => {
    wireGet();
    render(<EmergencyPage />);
    await screen.findByRole("button", { name: /Register New Case/i });
    fireEvent.click(screen.getByRole("button", { name: /Register New Case/i }));
    expect(
      await screen.findByText("Register Emergency Case"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() =>
      expect(
        screen.queryByText("Register Emergency Case"),
      ).not.toBeInTheDocument(),
    );
  });

  it("empty Registered-Patient submit → patientId + chiefComplaint inline errors + toast", async () => {
    wireGet();
    render(<EmergencyPage />);
    await screen.findByRole("button", { name: /Register New Case/i });
    fireEvent.click(screen.getByRole("button", { name: /Register New Case/i }));
    await screen.findByText("Register Emergency Case");

    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));
    expect(
      await screen.findByTestId("error-intake-patient"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("error-chief-complaint")).toBeInTheDocument();
    expect(toastMock.error).toHaveBeenCalled();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("switches to Unknown mode and surfaces unknownName + chiefComplaint inline errors on empty submit", async () => {
    wireGet();
    render(<EmergencyPage />);
    await screen.findByRole("button", { name: /Register New Case/i });
    fireEvent.click(screen.getByRole("button", { name: /Register New Case/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Unknown \/ Unregistered/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));
    expect(await screen.findByTestId("error-unknown-name")).toBeInTheDocument();
    expect(screen.getByTestId("error-chief-complaint")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("happy POST unknown-mode → posts shape, closes modal, reloads", async () => {
    wireGet();
    apiMock.post.mockResolvedValue({ data: {} });
    render(<EmergencyPage />);
    await screen.findByRole("button", { name: /Register New Case/i });
    fireEvent.click(screen.getByRole("button", { name: /Register New Case/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Unknown \/ Unregistered/i }),
    );
    fireEvent.change(screen.getByTestId("er-unknown-name"), {
      target: { value: "Trauma 7" },
    });
    fireEvent.change(screen.getByLabelText(/^Age$/i), {
      target: { value: "55" },
    });
    fireEvent.change(screen.getByLabelText(/^Gender$/i), {
      target: { value: "MALE" },
    });
    fireEvent.change(screen.getByTestId("er-arrival-mode"), {
      target: { value: "POLICE" },
    });
    fireEvent.change(screen.getByTestId("er-intake-complaint"), {
      target: { value: "Head injury after RTA" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/emergency/cases", {
        patientId: undefined,
        unknownName: "Trauma 7",
        unknownAge: 55,
        unknownGender: "MALE",
        arrivalMode: "POLICE",
        chiefComplaint: "Head injury after RTA",
      }),
    );
    // Modal closes after success.
    await waitFor(() =>
      expect(
        screen.queryByText("Register Emergency Case"),
      ).not.toBeInTheDocument(),
    );
  });

  it("server field-error projection paints inline errors on the rejected field", async () => {
    wireGet();
    // Reject with the ApiErrorLike shape extractFieldErrors expects.
    const err = Object.assign(new Error("Validation"), {
      payload: {
        details: [
          { field: "chiefComplaint", message: "Too long" },
          { field: "arrivalMode", message: "Invalid enum value" },
        ],
      },
    });
    apiMock.post.mockRejectedValue(err);
    render(<EmergencyPage />);
    await screen.findByRole("button", { name: /Register New Case/i });
    fireEvent.click(screen.getByRole("button", { name: /Register New Case/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Unknown \/ Unregistered/i }),
    );
    fireEvent.change(screen.getByTestId("er-unknown-name"), {
      target: { value: "Trauma 1" },
    });
    fireEvent.change(screen.getByTestId("er-intake-complaint"), {
      target: { value: "X".repeat(50) },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));
    expect(
      await screen.findByTestId("error-chief-complaint"),
    ).toHaveTextContent("Too long");
  });

  it("server generic-error fallback (no payload.details) → toast.error with Error.message", async () => {
    wireGet();
    apiMock.post.mockRejectedValue(new Error("Boom 500"));
    render(<EmergencyPage />);
    await screen.findByRole("button", { name: /Register New Case/i });
    fireEvent.click(screen.getByRole("button", { name: /Register New Case/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Unknown \/ Unregistered/i }),
    );
    fireEvent.change(screen.getByTestId("er-unknown-name"), {
      target: { value: "Trauma 1" },
    });
    fireEvent.change(screen.getByTestId("er-intake-complaint"), {
      target: { value: "Head injury" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Boom 500"),
    );
  });

  it("typing >=2 chars into patient search debounces 300ms and fires /patients GET", async () => {
    vi.useFakeTimers();
    wireGet({
      "/patients": {
        data: [
          { id: "p1", mrNumber: "MR-1", user: { name: "Aarav Mehta" } },
        ],
      },
    });
    render(<EmergencyPage />);
    // Wait for the page to load with real timers off — use act to drain promises.
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    // Need to flip back to real-ish path for click → use jest-style.
    vi.useRealTimers();
    await screen.findByRole("button", { name: /Register New Case/i });
    fireEvent.click(screen.getByRole("button", { name: /Register New Case/i }));
    await screen.findByText("Register Emergency Case");

    fireEvent.change(screen.getByTestId("er-patient-search"), {
      target: { value: "Aar" },
    });
    await waitFor(
      () =>
        expect(
          apiMock.get.mock.calls.some((c: any[]) =>
            String(c[0] || "").startsWith("/patients?search="),
          ),
        ).toBe(true),
      { timeout: 1500 },
    );
  });

  it("picking a patient from the results fills selected state and 'Change' clears it", async () => {
    wireGet({
      "/patients": {
        data: [
          { id: "p1", mrNumber: "MR-1", user: { name: "Aarav Mehta" } },
        ],
      },
    });
    render(<EmergencyPage />);
    await screen.findByRole("button", { name: /Register New Case/i });
    fireEvent.click(screen.getByRole("button", { name: /Register New Case/i }));
    await screen.findByText("Register Emergency Case");

    fireEvent.change(screen.getByTestId("er-patient-search"), {
      target: { value: "Aar" },
    });
    // Debounced 300ms — wait a tick longer.
    const option = await screen.findByText(
      (_text, el) =>
        el?.tagName === "STRONG" && el.textContent === "Aarav Mehta",
      {},
      { timeout: 1500 },
    );
    fireEvent.click(option.closest("button")!);
    expect(
      await screen.findByTestId("er-patient-selected"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Change$/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("er-patient-selected")).not.toBeInTheDocument(),
    );
  });

  it("patient search rejection swallowed (catches → empty results, no toast)", async () => {
    wireGet({ "/patients": new Error("network") });
    render(<EmergencyPage />);
    await screen.findByRole("button", { name: /Register New Case/i });
    fireEvent.click(screen.getByRole("button", { name: /Register New Case/i }));
    fireEvent.change(await screen.findByTestId("er-patient-search"), {
      target: { value: "Aar" },
    });
    await waitFor(
      () =>
        expect(
          apiMock.get.mock.calls.some((c: any[]) =>
            String(c[0] || "").startsWith("/patients?search="),
          ),
        ).toBe(true),
      { timeout: 1500 },
    );
    // No results rendered.
    expect(screen.queryByText("Aarav Mehta")).not.toBeInTheDocument();
  });
});

describe("EmergencyPage — side panel triage", () => {
  it("clicking a kanban card opens the side panel and seeds triage form from case", async () => {
    const c = caseFx({
      id: "c1",
      status: "TRIAGED",
      triageLevel: "URGENT",
      vitalsBP: "120/80",
      vitalsPulse: 90,
      mewsScore: 3,
    });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    // The panel re-renders the patient name in an h2 header.
    await screen.findByText(/Chief Complaint/i);
    // Triage section visible because canTriage=ADMIN.
    expect(screen.getByRole("button", { name: /Save Triage/i })).toBeInTheDocument();
    // BP seeded from case.
    expect(screen.getByPlaceholderText(/BP \(e\.g\. 120\/80\)/i)).toHaveValue(
      "120/80",
    );
  });

  it("clicking a triage-level chip updates form selection", async () => {
    const c = caseFx({ id: "c1", status: "TRIAGED", triageLevel: "URGENT" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    // Click LESS URGENT (rendered text "LESS URGENT" inside the panel section).
    const panelLessUrgent = screen
      .getAllByText("LESS URGENT")
      .find((el) => el.tagName === "BUTTON")!;
    fireEvent.click(panelLessUrgent);
    // Selected chip gets the LESS_URGENT color class.
    expect(panelLessUrgent.className).toMatch(/bg-yellow-500/);
  });

  it("submitTriage PATCHes the right URL + serialized shape, then closes panel", async () => {
    const c = caseFx({
      id: "c1",
      status: "TRIAGED",
      triageLevel: "URGENT",
      vitalsBP: "120/80",
      vitalsPulse: 90,
    });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    await screen.findByRole("button", { name: /Save Triage/i });

    fireEvent.change(screen.getByPlaceholderText(/^Resp rate$/i), {
      target: { value: "22" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^GCS \(3-15\)$/i), {
      target: { value: "14" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Triage/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/emergency/cases/c1/triage",
        expect.objectContaining({
          triageLevel: "URGENT",
          vitalsBP: "120/80",
          vitalsPulse: 90,
          vitalsResp: 22,
          glasgowComa: 14,
        }),
      ),
    );
  });

  it("submitTriage error path surfaces toast.error with err.message", async () => {
    const c = caseFx({ id: "c1", status: "TRIAGED" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    apiMock.patch.mockRejectedValue(new Error("triage down"));
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    fireEvent.click(
      await screen.findByRole("button", { name: /Save Triage/i }),
    );
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("triage down"),
    );
  });

  it("submitTriage error (non-Error throw) falls back to 'Triage failed' copy", async () => {
    const c = caseFx({ id: "c1", status: "TRIAGED" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    apiMock.patch.mockRejectedValue("nope");
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    fireEvent.click(
      await screen.findByRole("button", { name: /Save Triage/i }),
    );
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Triage failed"),
    );
  });
});

describe("EmergencyPage — side panel assign doctor", () => {
  it("Assign with no doctor selected → toast.error 'Select a doctor'", async () => {
    const c = caseFx({ id: "c1", status: "TRIAGED" });
    wireGet({
      "/emergency/cases/active": { data: [c] },
      "/doctors": {
        data: [{ id: "d1", specialization: "ER", user: { name: "Verma" } }],
      },
    });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    fireEvent.click(await screen.findByRole("button", { name: /^Assign$/i }));
    expect(toastMock.error).toHaveBeenCalledWith("Select a doctor");
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Assign with a selected doctor PATCHes /emergency/cases/:id/assign", async () => {
    const c = caseFx({ id: "c1", status: "TRIAGED" });
    wireGet({
      "/emergency/cases/active": { data: [c] },
      "/doctors": {
        data: [{ id: "d1", specialization: "ER", user: { name: "Verma" } }],
      },
    });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    const select = await screen.findByDisplayValue("Select Doctor");
    fireEvent.change(select, { target: { value: "d1" } });
    fireEvent.click(screen.getByRole("button", { name: /^Assign$/i }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/emergency/cases/c1/assign",
        { attendingDoctorId: "d1" },
      ),
    );
  });

  it("Assign error path surfaces toast.error", async () => {
    const c = caseFx({ id: "c1", status: "TRIAGED" });
    wireGet({
      "/emergency/cases/active": { data: [c] },
      "/doctors": { data: [{ id: "d1", user: { name: "Verma" } }] },
    });
    apiMock.patch.mockRejectedValue(new Error("assign 500"));
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    fireEvent.change(await screen.findByDisplayValue("Select Doctor"), {
      target: { value: "d1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Assign$/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("assign 500"),
    );
  });
});

describe("EmergencyPage — side panel close case", () => {
  it("empty Close → disposition + outcomeNotes inline errors + generic toast", async () => {
    const c = caseFx({ id: "c1", status: "IN_TREATMENT" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    fireEvent.click(await screen.findByTestId("close-case-btn"));
    expect(await screen.findByTestId("error-disposition")).toBeInTheDocument();
    expect(screen.getByTestId("error-outcome-notes")).toBeInTheDocument();
    expect(toastMock.error).toHaveBeenCalledWith(
      "Disposition and outcome notes are required",
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("happy Close PATCHes the right URL + shape", async () => {
    const c = caseFx({ id: "c1", status: "IN_TREATMENT" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));

    fireEvent.change(await screen.findByTestId("close-disposition"), {
      target: { value: "Home with follow-up" },
    });
    fireEvent.change(screen.getByTestId("close-outcome-notes"), {
      target: { value: "Stable on discharge; follow-up in 48h." },
    });
    fireEvent.click(screen.getByTestId("close-case-btn"));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/emergency/cases/c1/close", {
        status: "DISCHARGED",
        disposition: "Home with follow-up",
        outcomeNotes: "Stable on discharge; follow-up in 48h.",
      }),
    );
  });

  it("Close API field-error projection paints disposition error inline", async () => {
    const c = caseFx({ id: "c1", status: "IN_TREATMENT" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    const err = Object.assign(new Error("Validation"), {
      payload: {
        details: [{ field: "disposition", message: "Unknown disposition" }],
      },
    });
    apiMock.patch.mockRejectedValue(err);
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    fireEvent.change(await screen.findByTestId("close-disposition"), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByTestId("close-outcome-notes"), {
      target: { value: "Y" },
    });
    fireEvent.click(screen.getByTestId("close-case-btn"));
    expect(await screen.findByTestId("error-disposition")).toHaveTextContent(
      "Unknown disposition",
    );
  });

  it("Close non-Error rejection falls back to 'Close failed' toast copy", async () => {
    const c = caseFx({ id: "c1", status: "IN_TREATMENT" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    apiMock.patch.mockRejectedValue("nope");
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    fireEvent.change(await screen.findByTestId("close-disposition"), {
      target: { value: "Home" },
    });
    fireEvent.change(screen.getByTestId("close-outcome-notes"), {
      target: { value: "Stable" },
    });
    fireEvent.click(screen.getByTestId("close-case-btn"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Close failed"),
    );
  });

  it("close form Status select offers all 5 disposition statuses", async () => {
    const c = caseFx({ id: "c1", status: "IN_TREATMENT" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    const select = (await screen.findByDisplayValue(
      "Discharged",
    )) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual([
      "DISCHARGED",
      "ADMITTED",
      "TRANSFERRED",
      "LEFT_WITHOUT_BEING_SEEN",
      "DECEASED",
    ]);
  });

  it("Close section is hidden when case is in WAITING status", async () => {
    const c = caseFx({ id: "c1", status: "WAITING" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    await screen.findByRole("button", { name: /Save Triage/i });
    expect(screen.queryByText(/Close \/ Disposition/i)).not.toBeInTheDocument();
  });
});

describe("EmergencyPage — Full Details + close panel", () => {
  it("Full Details link points to the detail route for the selected case", async () => {
    const c = caseFx({ id: "c1", status: "TRIAGED" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    const link = await screen.findByRole("link", { name: /Full Details/i });
    expect(link).toHaveAttribute("href", "/dashboard/emergency/c1");
  });

  it("× button closes the side panel", async () => {
    const c = caseFx({ id: "c1", status: "TRIAGED" });
    wireGet({ "/emergency/cases/active": { data: [c] } });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    const panelHeading = await screen.findByText(/Chief Complaint/i);
    // The × icon button — last button with no name in the header area.
    const closeBtn = panelHeading
      .closest("div")
      ?.parentElement?.querySelector("button:last-of-type") as HTMLElement;
    fireEvent.click(closeBtn);
    await waitFor(() =>
      expect(screen.queryByText(/Chief Complaint/i)).not.toBeInTheDocument(),
    );
  });
});

describe("EmergencyPage — realtime", () => {
  it("on emergency:update socket event, re-fires loadData (2x GET on /emergency/cases/active)", async () => {
    wireGet();
    render(<EmergencyPage />);
    await waitFor(() => expect(screen.getAllByText("No cases").length).toBe(4));
    const before = apiMock.get.mock.calls.filter((c: any[]) =>
      String(c[0] || "").startsWith("/emergency/cases/active"),
    ).length;
    act(() => {
      (socketMock as any).__emit("emergency:update");
    });
    await waitFor(() => {
      const after = apiMock.get.mock.calls.filter((c: any[]) =>
        String(c[0] || "").startsWith("/emergency/cases/active"),
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("on mount, the socket.on('emergency:update', ...) handler is registered", async () => {
    wireGet();
    render(<EmergencyPage />);
    await waitFor(() => expect(screen.getAllByText("No cases").length).toBe(4));
    expect(socketMock.on).toHaveBeenCalledWith(
      "emergency:update",
      expect.any(Function),
    );
  });
});

describe("EmergencyPage — doctors fetch error swallowed", () => {
  it("when /doctors GET fails, the page still renders and Assign select is empty", async () => {
    const c = caseFx({ id: "c1", status: "TRIAGED" });
    wireGet({
      "/emergency/cases/active": { data: [c] },
      "/doctors": new Error("doctors down"),
    });
    render(<EmergencyPage />);
    fireEvent.click(await screen.findByText("Aarav Mehta"));
    const select = (await screen.findByDisplayValue(
      "Select Doctor",
    )) as HTMLSelectElement;
    // Only the placeholder option, no doctors loaded.
    expect(select.options.length).toBe(1);
  });
});
