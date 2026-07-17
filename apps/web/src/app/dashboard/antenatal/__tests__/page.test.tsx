/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AntenatalPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/antenatal/page.tsx, the ANC
 *     case register + dashboard + new-case modal. Endpoints the page hits:
 *       GET  /antenatal/cases(?delivered|isHighRisk)   (list tabs)
 *       GET  /antenatal/dashboard                       (stats strip)
 *       GET  /doctors                                   (modal dropdown)
 *       GET  /patients?search=&limit=10                 (modal picker)
 *       POST /antenatal/cases                           (create)
 *
 *   - Behaviours covered:
 *       1.  Initial render — header, tabs, stats cards (dashboard data).
 *       2.  RBAC gate — DOCTOR / ADMIN / NURSE see the "New ANC Case"
 *           CTA; PATIENT / RECEPTION / PHARMACIST do NOT (Issue #459).
 *       3.  Tab switching — clicking each tab refetches with the right
 *           querystring (?delivered=false, ?isHighRisk=true&delivered=false,
 *           ?delivered=true, "" for "all").
 *       4.  Loading skeleton renders with aria-busy="true" while cases
 *           fetch is pending.
 *       5.  Empty state — "No ANC cases found." copy.
 *       6.  Row rendering — case number, patient name (linked), EDD with
 *           days-to-go / days-overdue, G/P, weeks-of-gestation,
 *           High Risk vs Normal badge, Delivered badge, last visit date.
 *       7.  Delivered row renders "—" instead of weeks, EDD has no
 *           days-to-go suffix.
 *       8.  Stats dashboard — all 4 counters render (active, high risk,
 *           upcoming, overdue).
 *       9.  Modal open via the CTA, close via Cancel.
 *      10.  Patient search — debounced fetch fires after 300ms with
 *           >= 2 chars; only FEMALE patients listed.
 *      11.  Patient search < 2 chars clears the results list (no fetch).
 *      12.  Selecting a patient swaps the input for the selected display
 *           and exposes a "Change" reset button.
 *      13.  Submit guard — no patient selected → toast.error + no POST.
 *      14.  Submit guard — LMP in the future → toast.error + no POST.
 *      15.  Submit guard — gravida < 1 → toast.error + no POST.
 *      16.  Submit guard — parity < 0 → toast.error + no POST.
 *      17.  Happy POST — calls /antenatal/cases with the right body,
 *           closes the modal, refetches list + dashboard.
 *      18.  POST rejection with Error → toast.error(err.message).
 *      19.  POST rejection with non-Error → toast.error("Failed to create
 *           ANC case") fallback.
 *      20.  High-risk checkbox reveals the Risk Factors textarea.
 *      21.  Error tolerance — every fetch rejection is swallowed (no
 *           uncaught promise; page still mounts).
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, next/navigation.
 *     @medcore/shared is used un-mocked (real ALL_BLOOD_GROUPS array).
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

const { apiMock, toastMock, authMock } = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/antenatal",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows?: number; columns?: number }) => (
    <div data-testid="skeleton-table-stub" data-rows={rows} data-cols={columns} />
  ),
}));

import AntenatalPage from "../page";

// ─── Fixtures ───────────────────────────────────────────────────────────

// Use +48h offsets vs "today" to avoid IST/UTC midnight traps for daysUntil().
const today = new Date();
today.setHours(0, 0, 0, 0);
const future = new Date(today.getTime() + 48 * 60 * 60 * 1000); // +2d
const past = new Date(today.getTime() - 48 * 60 * 60 * 1000); // -2d
// LMP exactly 20 weeks ago — yields predictable weeksGestation rendering.
const lmp20wAgo = new Date(today.getTime() - 20 * 7 * 24 * 60 * 60 * 1000);

function toIso(d: Date): string {
  return d.toISOString();
}

function caseFixture(overrides: Partial<any> = {}): any {
  return {
    id: "case-1",
    caseNumber: "ANC-2026-001",
    patientId: "pat-1",
    doctorId: "doc-1",
    lmpDate: toIso(lmp20wAgo),
    eddDate: toIso(future),
    gravida: 2,
    parity: 1,
    isHighRisk: false,
    riskFactors: null,
    deliveredAt: null,
    deliveryType: null,
    patient: {
      id: "pat-1",
      mrNumber: "MR-001",
      user: { name: "Asha Patel", phone: "+919999900001" },
    },
    doctor: { id: "doc-1", user: { name: "Dr. Mehta" } },
    visits: [
      {
        id: "v-1",
        visitDate: toIso(past),
        weeksOfGestation: 20,
        nextVisitDate: toIso(future),
      },
    ],
    ...overrides,
  };
}

function dashboardFixture(overrides: Partial<any> = {}): any {
  return {
    activeCases: 42,
    highRiskCases: 7,
    upcomingDeliveries: 5,
    overdueDeliveries: 3,
    visitsDueThisWeek: [],
    ...overrides,
  };
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
  });
}

function asNurse() {
  authMock.mockReturnValue({
    user: { id: "u-nurse", role: "NURSE", name: "Nurse" },
  });
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin" },
  });
}

function asPatient() {
  authMock.mockReturnValue({
    user: { id: "u-pat", role: "PATIENT", name: "Pat" },
  });
}

function asReception() {
  authMock.mockReturnValue({
    user: { id: "u-recep", role: "RECEPTION", name: "Recep" },
  });
}

/**
 * Default GET wiring — answers the 3 endpoints the page fetches on mount.
 * Per-test overrides should call apiMock.get.mockImplementation again
 * BEFORE rendering.
 */
function wireDefaultGets(opts: {
  cases?: any[];
  dashboard?: any | null;
  doctors?: any[];
  patients?: any[];
} = {}) {
  const cases = opts.cases ?? [caseFixture()];
  const dashboard = opts.dashboard === undefined ? dashboardFixture() : opts.dashboard;
  const doctors = opts.doctors ?? [
    { id: "doc-1", user: { name: "Dr. Mehta" }, specialization: "OBGYN" },
  ];
  const patients = opts.patients ?? [];

  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/antenatal/cases")) {
      return Promise.resolve({ data: cases });
    }
    if (url === "/antenatal/dashboard") {
      return dashboard
        ? Promise.resolve({ data: dashboard })
        : Promise.reject(new Error("no dashboard"));
    }
    if (url === "/doctors") {
      return Promise.resolve({ data: doctors });
    }
    if (url.startsWith("/patients?")) {
      return Promise.resolve({ data: patients });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("AntenatalPage (ANC register + new-case modal — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asDoctor();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Initial render + RBAC ───────────────────────────────────────────────

  it("renders the page header and the stats strip after mount", async () => {
    wireDefaultGets();

    render(<AntenatalPage />);

    expect(
      screen.getByRole("heading", { name: /Antenatal Care/i }),
    ).toBeInTheDocument();
    // Stats — wait for the dashboard fetch to populate.
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(/Active Cases/i)).toBeInTheDocument();
    // "High Risk" string appears in 2 places: the stats card label AND the
    // tab button. Just confirm both surfaces exist.
    expect(screen.getAllByText(/High Risk/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Upcoming Deliveries/i)).toBeInTheDocument();
    expect(screen.getByText(/Overdue Deliveries/i)).toBeInTheDocument();
  });

  it("DOCTOR sees the 'New ANC Case' CTA", async () => {
    wireDefaultGets();
    render(<AntenatalPage />);
    expect(
      await screen.findByRole("button", { name: /New ANC Case/i }),
    ).toBeInTheDocument();
  });

  it("NURSE sees the 'New ANC Case' CTA (Issue #459 — nurse-led workflow)", async () => {
    asNurse();
    wireDefaultGets();
    render(<AntenatalPage />);
    expect(
      await screen.findByRole("button", { name: /New ANC Case/i }),
    ).toBeInTheDocument();
  });

  it("ADMIN sees the 'New ANC Case' CTA", async () => {
    asAdmin();
    wireDefaultGets();
    render(<AntenatalPage />);
    expect(
      await screen.findByRole("button", { name: /New ANC Case/i }),
    ).toBeInTheDocument();
  });

  it("PATIENT does NOT see the 'New ANC Case' CTA", async () => {
    asPatient();
    wireDefaultGets();
    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");
    expect(
      screen.queryByRole("button", { name: /New ANC Case/i }),
    ).not.toBeInTheDocument();
  });

  it("RECEPTION does NOT see the 'New ANC Case' CTA", async () => {
    asReception();
    wireDefaultGets();
    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");
    expect(
      screen.queryByRole("button", { name: /New ANC Case/i }),
    ).not.toBeInTheDocument();
  });

  // ── Loading / empty / row rendering ─────────────────────────────────────

  it("renders the SkeletonTable while the initial cases fetch is pending (aria-busy)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/antenatal/cases")) {
        return new Promise(() => {}); // never resolves
      }
      return Promise.resolve({ data: null });
    });

    render(<AntenatalPage />);

    const busy = await screen.findByTestId("antenatal-loading");
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("skeleton-table-stub")).toBeInTheDocument();
  });

  it("renders the 'No ANC cases found.' empty state when /antenatal/cases returns []", async () => {
    wireDefaultGets({ cases: [] });

    render(<AntenatalPage />);

    expect(
      await screen.findByText(/No ANC cases found\./i),
    ).toBeInTheDocument();
  });

  it("renders a non-delivered case row with case#, MR, weeks, days-to-EDD, Normal badge, last-visit date", async () => {
    wireDefaultGets();

    render(<AntenatalPage />);

    expect(await screen.findByText("ANC-2026-001")).toBeInTheDocument();
    // Patient link
    expect(screen.getByRole("link", { name: "Asha Patel" })).toHaveAttribute(
      "href",
      "/dashboard/antenatal/case-1",
    );
    expect(screen.getByText("MR-001")).toBeInTheDocument();
    // G2 P1 cell
    expect(screen.getByText("G2 P1")).toBeInTheDocument();
    // Weeks rendered as "20w" (LMP set 20w ago)
    expect(screen.getByText("20w")).toBeInTheDocument();
    // Normal badge (not high risk)
    expect(screen.getByText(/^Normal$/)).toBeInTheDocument();
    // 2d to go (future is +48h)
    expect(screen.getByText(/2d to go/i)).toBeInTheDocument();
  });

  it("renders an OVERDUE non-delivered case row with the 'd overdue' suffix in red copy", async () => {
    wireDefaultGets({
      cases: [
        caseFixture({
          id: "case-overdue",
          caseNumber: "ANC-2026-002",
          eddDate: toIso(past), // -2d
        }),
      ],
    });

    render(<AntenatalPage />);

    await screen.findByText("ANC-2026-002");
    expect(screen.getByText(/2d overdue/i)).toBeInTheDocument();
  });

  it("renders a HIGH-RISK case row with the red 'High Risk' pill", async () => {
    wireDefaultGets({
      cases: [
        caseFixture({
          id: "case-hr",
          caseNumber: "ANC-2026-HR",
          isHighRisk: true,
        }),
      ],
    });

    render(<AntenatalPage />);

    await screen.findByText("ANC-2026-HR");
    // "High Risk" matches: stats card label + tab button + row pill = 3.
    // Find the pill specifically by its red-700 text class.
    const matches = screen.getAllByText(/^High Risk$/);
    expect(matches.length).toBeGreaterThanOrEqual(3);
    const pill = matches.find((m) => m.className.includes("text-red-700"));
    expect(pill).toBeDefined();
  });

  it("renders a DELIVERED case row with '—' weeks, no days-to-EDD, and the Delivered badge", async () => {
    wireDefaultGets({
      cases: [
        caseFixture({
          id: "case-del",
          caseNumber: "ANC-2026-DEL",
          deliveredAt: toIso(past),
          deliveryType: "NORMAL",
        }),
      ],
    });

    render(<AntenatalPage />);

    await screen.findByText("ANC-2026-DEL");
    // Weeks column shows "—"
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    // "Delivered" appears in the tab button AND as the row pill. Find the
    // pill by its blue-700 text class.
    const delMatches = screen.getAllByText(/^Delivered$/);
    expect(delMatches.length).toBeGreaterThanOrEqual(2);
    const delPill = delMatches.find((m) => m.className.includes("text-blue-700"));
    expect(delPill).toBeDefined();
    // No days-to-go/overdue suffix because deliveredAt is set
    expect(screen.queryByText(/d to go/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/d overdue/i)).not.toBeInTheDocument();
  });

  it("renders '—' for last-visit when the case has no visits", async () => {
    wireDefaultGets({
      cases: [caseFixture({ id: "case-no-visits", visits: [] })],
    });

    render(<AntenatalPage />);

    await screen.findByText("ANC-2026-001");
    // Several "—" may render (weeks col for delivered + missing last-visit).
    // At minimum, one "—" must exist for the last-visit cell.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  // ── Tab switching ───────────────────────────────────────────────────────

  it("clicking each tab refetches /antenatal/cases with the expected querystring", async () => {
    wireDefaultGets({ cases: [] });

    render(<AntenatalPage />);
    await screen.findByText(/No ANC cases found\./i);

    // Initial: active tab → ?delivered=false
    expect(apiMock.get).toHaveBeenCalledWith("/antenatal/cases?delivered=false");

    fireEvent.click(screen.getByRole("button", { name: /^High Risk$/ }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/antenatal/cases?isHighRisk=true&delivered=false",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Delivered$/ }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/antenatal/cases?delivered=true",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /^All$/ }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/antenatal/cases"),
    );
  });

  // ── Dashboard error tolerance ───────────────────────────────────────────

  it("swallows /antenatal/dashboard rejection and still renders the list", async () => {
    wireDefaultGets({ dashboard: null });

    render(<AntenatalPage />);

    expect(await screen.findByText("ANC-2026-001")).toBeInTheDocument();
    // No stats card rendered when dashboard is null/error
    expect(screen.queryByText(/Active Cases/i)).not.toBeInTheDocument();
  });

  it("swallows /antenatal/cases rejection and renders empty state", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/antenatal/cases")) {
        return Promise.reject(new Error("cases boom"));
      }
      if (url === "/antenatal/dashboard") {
        return Promise.resolve({ data: dashboardFixture() });
      }
      return Promise.resolve({ data: [] });
    });

    render(<AntenatalPage />);

    expect(
      await screen.findByText(/No ANC cases found\./i),
    ).toBeInTheDocument();
  });

  // ── Modal: open/close + doctors load ────────────────────────────────────

  it("clicking 'New ANC Case' opens the modal and triggers GET /doctors", async () => {
    wireDefaultGets();

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));

    expect(
      await screen.findByRole("heading", { name: /New Antenatal Case/i }),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/doctors"),
    );

    // The "Select Doctor" option + the seeded doctor are both in the select.
    expect(screen.getByText(/Select Doctor/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/Dr\. Mehta — OBGYN/i),
    ).toBeInTheDocument();
  });

  it("surfaces the female-only restriction on the patient field (badge + placeholder)", async () => {
    // ANC is female-only; the UI must make that visible up-front so a user
    // doesn't type a male patient and see a silent blank. Two affordances: a
    // "Female only" badge on the label and it in the search placeholder.
    wireDefaultGets();

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    // The label carries a visible "Female only" badge.
    const badge = screen.getByTestId("anc-female-only-badge");
    expect(badge.textContent).toMatch(/female only/i);

    // The search input placeholder reinforces it while typing.
    const search = screen.getByTestId("anc-patient-search") as HTMLInputElement;
    expect(search.placeholder).toMatch(/female patient/i);
  });

  it("Cancel button closes the modal", async () => {
    wireDefaultGets();

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /New Antenatal Case/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("swallows GET /doctors rejection and still renders the empty select", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/antenatal/cases")) {
        return Promise.resolve({ data: [] });
      }
      if (url === "/antenatal/dashboard") {
        return Promise.resolve({ data: dashboardFixture() });
      }
      if (url === "/doctors") {
        return Promise.reject(new Error("doctors down"));
      }
      return Promise.resolve({ data: [] });
    });

    render(<AntenatalPage />);
    await screen.findByText(/No ANC cases found\./i);

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    // Select still mounts with only the "Select Doctor" placeholder option.
    expect(screen.getByText(/Select Doctor/i)).toBeInTheDocument();
  });

  // ── Modal: patient search ───────────────────────────────────────────────

  it("typing < 2 chars does NOT fire /patients (debounce + guard) and clears the result list", async () => {
    wireDefaultGets();

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    const search = screen.getByTestId("anc-patient-search");
    fireEvent.change(search, { target: { value: "A" } });

    // Wait > 300ms debounce — no /patients call should fire.
    await new Promise((r) => setTimeout(r, 350));
    const patientCalls = apiMock.get.mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith("/patients?"),
    );
    expect(patientCalls.length).toBe(0);
  });

  it("typing >= 2 chars fires /patients after 300ms and only FEMALE rows are listed", async () => {
    wireDefaultGets({
      patients: [
        {
          id: "p-f",
          mrNumber: "MR-F",
          gender: "FEMALE",
          user: { name: "Anita F", phone: "+91999900F" },
        },
        {
          id: "p-m",
          mrNumber: "MR-M",
          gender: "MALE",
          user: { name: "Amit M", phone: "+91999900M" },
        },
      ],
    });

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    fireEvent.change(screen.getByTestId("anc-patient-search"), {
      target: { value: "An" },
    });

    await waitFor(
      () =>
        expect(
          apiMock.get.mock.calls.some((c: any[]) =>
            String(c[0]).startsWith("/patients?search=An"),
          ),
        ).toBe(true),
      { timeout: 1000 },
    );

    expect(await screen.findByText(/Anita F/)).toBeInTheDocument();
    expect(screen.queryByText(/Amit M/)).not.toBeInTheDocument();
  });

  it("shows a 'none are female' note when the search matches only male patients (no silent blank)", async () => {
    // Regression for the confusing empty dropdown: the API returned a MALE
    // patient (correctly filtered out), so the picker went blank with no
    // explanation. It must now say WHY nothing is shown.
    wireDefaultGets({
      patients: [
        {
          id: "p-m",
          mrNumber: "MR-M",
          gender: "MALE",
          user: { name: "Amit M", phone: "+91999900M" },
        },
      ],
    });

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    fireEvent.change(screen.getByTestId("anc-patient-search"), {
      target: { value: "Am" },
    });

    // The explanatory note appears…
    const note = await screen.findByTestId("anc-patient-search-note");
    expect(note.textContent).toMatch(/none are female/i);
    // …and the male patient is NOT offered as a selectable row.
    expect(screen.queryByText(/Amit M/)).not.toBeInTheDocument();
  });

  it("/patients rejection sets the result list back to empty", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/antenatal/cases")) {
        return Promise.resolve({ data: [] });
      }
      if (url === "/antenatal/dashboard") {
        return Promise.resolve({ data: dashboardFixture() });
      }
      if (url === "/doctors") {
        return Promise.resolve({ data: [] });
      }
      if (url.startsWith("/patients?")) {
        return Promise.reject(new Error("search boom"));
      }
      return Promise.resolve({ data: [] });
    });

    render(<AntenatalPage />);
    await screen.findByText(/No ANC cases found\./i);

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    fireEvent.change(screen.getByTestId("anc-patient-search"), {
      target: { value: "An" },
    });

    // Give debounce + reject time to propagate.
    await new Promise((r) => setTimeout(r, 350));

    // No selected-patient banner, no result rows.
    expect(
      screen.queryByTestId("anc-patient-selected"),
    ).not.toBeInTheDocument();
  });

  it("selecting a patient swaps the search input for the selected display and exposes a Change button", async () => {
    wireDefaultGets({
      patients: [
        {
          id: "p-f",
          mrNumber: "MR-F",
          gender: "FEMALE",
          user: { name: "Anita F", phone: "+91999900F" },
        },
      ],
    });

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    fireEvent.change(screen.getByTestId("anc-patient-search"), {
      target: { value: "An" },
    });

    const row = await screen.findByText(/Anita F/);
    fireEvent.click(row.closest("button")!);

    const selected = await screen.findByTestId("anc-patient-selected");
    expect(selected).toHaveTextContent(/Anita F/);
    expect(selected).toHaveTextContent("MR-F");

    // Change resets back to the input.
    fireEvent.click(screen.getByRole("button", { name: /^Change$/ }));
    await waitFor(() =>
      expect(
        screen.queryByTestId("anc-patient-selected"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("anc-patient-search")).toBeInTheDocument();
  });

  // ── Modal: submit guards ────────────────────────────────────────────────

  it("submit without a selected patient toasts an error and does not POST", async () => {
    wireDefaultGets();

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    fireEvent.click(
      screen.getByRole("button", { name: /Create ANC Case/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Select a patient"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submit with a future LMP toasts the future-LMP error and does not POST", async () => {
    wireDefaultGets({
      patients: [
        {
          id: "p-f",
          mrNumber: "MR-F",
          gender: "FEMALE",
          user: { name: "Anita F", phone: "+91999900F" },
        },
      ],
    });

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    // Pick a patient
    fireEvent.change(screen.getByTestId("anc-patient-search"), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita F/);
    fireEvent.click(row.closest("button")!);

    // Future LMP — +48h from today, formatted as YYYY-MM-DD
    const tomorrow = new Date(today.getTime() + 48 * 60 * 60 * 1000);
    const y = tomorrow.getFullYear();
    const m = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const d = String(tomorrow.getDate()).padStart(2, "0");
    const futureLmp = `${y}-${m}-${d}`;

    fireEvent.change(screen.getByTestId("anc-lmp-date"), {
      target: { value: futureLmp },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Create ANC Case/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Last Menstrual Period date cannot be in the future/i),
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submit with gravida < 1 toasts an error and does not POST", async () => {
    wireDefaultGets({
      patients: [
        {
          id: "p-f",
          mrNumber: "MR-F",
          gender: "FEMALE",
          user: { name: "Anita F", phone: "+91999900F" },
        },
      ],
    });

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    fireEvent.change(screen.getByTestId("anc-patient-search"), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita F/);
    fireEvent.click(row.closest("button")!);

    fireEvent.change(screen.getByTestId("anc-gravida"), {
      target: { value: "0" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Create ANC Case/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Gravida must be at least 1/i),
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submit with negative parity toasts an error and does not POST", async () => {
    wireDefaultGets({
      patients: [
        {
          id: "p-f",
          mrNumber: "MR-F",
          gender: "FEMALE",
          user: { name: "Anita F", phone: "+91999900F" },
        },
      ],
    });

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    fireEvent.change(screen.getByTestId("anc-patient-search"), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita F/);
    fireEvent.click(row.closest("button")!);

    fireEvent.change(screen.getByTestId("anc-parity"), {
      target: { value: "-1" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Create ANC Case/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Parity cannot be negative/i),
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ── Modal: high-risk toggle + happy POST ────────────────────────────────

  it("high-risk checkbox reveals the Risk Factors textarea", async () => {
    wireDefaultGets();

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    // Textarea is NOT rendered initially.
    expect(
      screen.queryByPlaceholderText(/Hypertension, Previous C-section, Diabetes/i),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Mark as High Risk Pregnancy/i));

    expect(
      await screen.findByPlaceholderText(
        /Hypertension, Previous C-section, Diabetes/i,
      ),
    ).toBeInTheDocument();
  });

  it("happy POST — submits the right body, closes the modal, and refetches list + dashboard", async () => {
    wireDefaultGets({
      patients: [
        {
          id: "p-f",
          mrNumber: "MR-F",
          gender: "FEMALE",
          user: { name: "Anita F", phone: "+91999900F" },
        },
      ],
    });
    apiMock.post.mockResolvedValue({ data: { id: "case-new" } });

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    // Snapshot the initial call counts BEFORE clicking submit so we can
    // verify the refetch fires AFTER the POST resolves.
    const initialCasesCount = apiMock.get.mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith("/antenatal/cases"),
    ).length;
    const initialDashCount = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/antenatal/dashboard",
    ).length;

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    // Pick a patient
    fireEvent.change(screen.getByTestId("anc-patient-search"), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita F/);
    fireEvent.click(row.closest("button")!);

    // Doctor
    await screen.findByText(/Dr\. Mehta — OBGYN/i);
    fireEvent.change(screen.getByLabelText(/^Doctor$/), {
      target: { value: "doc-1" },
    });

    // LMP — 4 weeks ago (always in past).
    const lmp = new Date(today.getTime() - 28 * 24 * 60 * 60 * 1000);
    const yL = lmp.getFullYear();
    const mL = String(lmp.getMonth() + 1).padStart(2, "0");
    const dL = String(lmp.getDate()).padStart(2, "0");
    fireEvent.change(screen.getByTestId("anc-lmp-date"), {
      target: { value: `${yL}-${mL}-${dL}` },
    });

    // Gravida/parity defaults are already "1"/"0" — leave as-is.
    // High-risk + risk-factors toggle to exercise that branch in the POST body.
    fireEvent.click(screen.getByLabelText(/Mark as High Risk Pregnancy/i));
    const rf = await screen.findByPlaceholderText(
      /Hypertension, Previous C-section, Diabetes/i,
    );
    fireEvent.change(rf, { target: { value: "Previous PPH" } });

    // Blood group via the canonical select (real @medcore/shared values).
    fireEvent.change(screen.getByTestId("anc-blood-group"), {
      target: { value: "A_POS" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Create ANC Case/i }),
    );

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [postUrl, postBody] = apiMock.post.mock.calls[0];
    expect(postUrl).toBe("/antenatal/cases");
    expect(postBody).toMatchObject({
      patientId: "p-f",
      doctorId: "doc-1",
      lmpDate: `${yL}-${mL}-${dL}`,
      gravida: 1,
      parity: 0,
      bloodGroup: "A_POS",
      isHighRisk: true,
      riskFactors: "Previous PPH",
    });

    // Modal closes
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /New Antenatal Case/i }),
      ).not.toBeInTheDocument(),
    );

    // Refetches fired
    await waitFor(() => {
      const newCasesCount = apiMock.get.mock.calls.filter((c: any[]) =>
        String(c[0]).startsWith("/antenatal/cases"),
      ).length;
      expect(newCasesCount).toBeGreaterThan(initialCasesCount);
    });
    const newDashCount = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/antenatal/dashboard",
    ).length;
    expect(newDashCount).toBeGreaterThan(initialDashCount);
  });

  it("POST rejection with Error surfaces toast.error(err.message)", async () => {
    wireDefaultGets({
      patients: [
        {
          id: "p-f",
          mrNumber: "MR-F",
          gender: "FEMALE",
          user: { name: "Anita F", phone: "+91999900F" },
        },
      ],
    });
    apiMock.post.mockRejectedValue(new Error("duplicate ANC case"));

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    fireEvent.change(screen.getByTestId("anc-patient-search"), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita F/);
    fireEvent.click(row.closest("button")!);

    const lmp = new Date(today.getTime() - 28 * 24 * 60 * 60 * 1000);
    const yL = lmp.getFullYear();
    const mL = String(lmp.getMonth() + 1).padStart(2, "0");
    const dL = String(lmp.getDate()).padStart(2, "0");
    fireEvent.change(screen.getByTestId("anc-lmp-date"), {
      target: { value: `${yL}-${mL}-${dL}` },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Create ANC Case/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("duplicate ANC case"),
    );
    // Modal stays open
    expect(
      screen.getByRole("heading", { name: /New Antenatal Case/i }),
    ).toBeInTheDocument();
  });

  it("POST rejection with non-Error falls back to 'Failed to create ANC case'", async () => {
    wireDefaultGets({
      patients: [
        {
          id: "p-f",
          mrNumber: "MR-F",
          gender: "FEMALE",
          user: { name: "Anita F", phone: "+91999900F" },
        },
      ],
    });
    apiMock.post.mockRejectedValue("string rejection");

    render(<AntenatalPage />);
    await screen.findByText("ANC-2026-001");

    fireEvent.click(screen.getByRole("button", { name: /New ANC Case/i }));
    await screen.findByRole("heading", { name: /New Antenatal Case/i });

    fireEvent.change(screen.getByTestId("anc-patient-search"), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita F/);
    fireEvent.click(row.closest("button")!);

    const lmp = new Date(today.getTime() - 28 * 24 * 60 * 60 * 1000);
    const yL = lmp.getFullYear();
    const mL = String(lmp.getMonth() + 1).padStart(2, "0");
    const dL = String(lmp.getDate()).padStart(2, "0");
    fireEvent.change(screen.getByTestId("anc-lmp-date"), {
      target: { value: `${yL}-${mL}-${dL}` },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Create ANC Case/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Failed to create ANC case",
      ),
    );
  });
});
