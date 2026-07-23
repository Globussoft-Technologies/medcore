/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AdmissionDetailPage — colocated coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises `apps/web/src/app/dashboard/admissions/[id]/page.tsx`, the
 *     IPD admission-detail page (3379 lines). 7 sub-tabs (Overview / Vitals
 *     / Medications / Rounds / Labs / MAR / I/O) plus several side-panel
 *     widgets (Isolation, LOS prediction, Med-reconciliation, Belongings,
 *     Reconciliation timeline) plus the discharge / readiness / transfer
 *     modal trio. Top-level wiring uses React 19 `use(params)` so the
 *     Promise has to carry the `{status:"fulfilled", value:...}` marker the
 *     `lab/[orderId]` suite codified (otherwise the microtask never resolves
 *     inside the synchronous test window and the loading skeleton blocks
 *     the test forever).
 *
 *   - Endpoints touched (a superset, gated by which tab/modal is open):
 *       GET   /admissions/:id                                (root + Isolation)
 *       GET   /admissions/:id/bill                           (Overview side card)
 *       GET   /admissions/:id/los-prediction                 (LosPredictionCard)
 *       GET   /admissions/:id/belongings                     (BelongingsCard)
 *       GET   /med-reconciliation?patientId=&admissionId=    (Timeline)
 *       PATCH /admissions/:id/discharge                      (Discharge modal)
 *       PATCH /admissions/:id/transfer                       (Transfer modal)
 *       PATCH /admissions/:id/isolation                      (IsolationPanel)
 *       GET   /admissions/:id/discharge-readiness            (Readiness modal)
 *       GET   /admissions/:id/vitals      | POST same        (VitalsTab)
 *       GET   /medication/orders?admissionId=                (MedicationsTab)
 *       GET   /medicines?search=                             (Med picker)
 *       POST  /medication/orders                             (Create order)
 *       PATCH /medication/orders/:id                         (Toggle active)
 *       GET   /nurse-rounds?admissionId=                     (RoundsTab)
 *       POST  /nurse-rounds                                  (Add round)
 *       GET   /lab/orders?admissionId=                       (LabsTab)
 *       GET   /lab/tests                                     (Lab order picker)
 *       POST  /lab/orders                                    (Lab order)
 *       GET   /admissions/:id/mar?date=                      (MarTab)
 *       PATCH /medication/administrations/:id                (MAR administer)
 *       GET   /admissions/:id/intake-output?date=            (IntakeOutputTab)
 *       POST  /admissions/:id/intake-output                  (IO record)
 *       GET   /wards                                         (Transfer modal)
 *
 *   - Behaviours covered (alphabetical by surface):
 *       loading             — `admissions-detail-loading` aria-busy=true
 *       not-found           — root GET rejects → "Admission not found." copy
 *       admissionNumber URL — when the resolved row has a different UUID id,
 *                             router.replace swaps to the canonical UUID URL
 *       header              — patient name, MR, admission#, status pill,
 *                             print discharge-summary fires openPrintEndpoint
 *       tab switching       — clicking each of the 7 tab buttons swaps the
 *                             active body. We assert by content, not class.
 *       Overview details    — admission detail Field grid, Patient sidebar
 *       Overview Running Bill— breakdown rows + grand-total totalisation
 *       Discharge readiness — readiness GET wires the checklist; Cancel closes
 *       Discharge full flow — full readiness "all green" → Proceed opens the
 *                             discharge modal → PATCH with form payload
 *       Discharge error     — PATCH rejection toasts the message
 *       Transfer            — wards GET wires options; PATCH on submit
 *       Transfer error      — PATCH rejection toasts
 *       Isolation set       — type/reason/dates flow → PATCH /isolation
 *       Isolation clear     — Active row → Clear button PATCHes {clear:true}
 *       LOS low confidence  — `los-prediction-low-confidence` tile rendering
 *       Belongings add      — empty name toast guard; happy POST
 *       Belongings empty    — null GET → no items + add input visible
 *       Reconciliation row  — timeline list renders one item with counts
 *       Vitals empty        — "No vitals recorded yet." copy
 *       Vitals row render   — sys/dia/temp/pulse columns
 *       Vitals range error  — Temp=999 surfaces inline error + Save disabled
 *       Vitals BP coherence — diastolic ≥ systolic surfaces the order error
 *       Vitals happy POST   — keys remapped to canonical schema names
 *       Medications search  — < 2 chars → no /medicines call; >= 2 chars fires
 *       Medications create  — selected med + dosage/freq/start → POST body
 *       Medications guards  — missing med / dosage / frequency each toast
 *       Medications toggle  — checkbox PATCHes isActive
 *       Rounds add          — empty notes toast; happy POST
 *       Labs add            — no tests selected → toast; happy POST
 *       MAR cell click      — cell button opens the modal; PATCH on save
 *       MAR finalized cell  — ADMINISTERED cell is disabled
 *       I/O record          — happy POST + form reset
 *       I/O range error     — > 10000 → inline error + Save disabled
 *
 *   - Mocks:
 *       @/lib/api               api + openPrintEndpoint hoisted
 *       @/lib/store             useAuthStore (destructured)
 *       @/lib/toast             toast.{success,error,info,warning}
 *       next/navigation         useRouter (replace/back), useParams returns id
 *       @/components/Skeleton   passthrough stub
 *       @/components/ErrorBoundary  passthrough — render children directly
 *       @/lib/format            deterministic returns
 *       @/lib/format-doctor-name passthrough
 *       @/lib/field-errors      passthrough (extractFieldErrors/topLineError)
 *
 *   - Notes per CLAUDE.md:
 *       • Uses +48h offsets to dodge IST/UTC midnight traps.
 *       • Does NOT exploit cross-patient access (BOLA history #511).
 *       • All sub-resource GETs are matched by URL prefix so per-test
 *         overrides can stub one endpoint without breaking the rest.
 *       • React 19 `use(params)` Promise must carry `status:"fulfilled"` +
 *         `value` markers so React unwraps synchronously (lab/[orderId]
 *         pattern — see CLAUDE.md note 4).
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

const {
  apiMock,
  openPrintEndpointMock,
  toastMock,
  routerMock,
  authMock,
} = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  openPrintEndpointMock: vi.fn(),
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  },
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  openPrintEndpoint: openPrintEndpointMock,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useParams: () => ({ id: "ad1" }),
  usePathname: () => "/dashboard/admissions/ad1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
  SkeletonTable: ({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) => (
    <div data-testid="skeleton-table" data-rows={rows} data-columns={columns} />
  ),
}));
vi.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: any }) => <>{children}</>,
}));
vi.mock("@/lib/format", () => ({
  formatDate: (iso: string) => `date(${iso})`,
  formatDateTime: (iso: any) => (iso ? `dt(${String(iso)})` : "—"),
  formatTime: (iso: any) => (iso ? `time(${String(iso)})` : "—"),
}));
vi.mock("@/lib/format-doctor-name", () => ({
  formatDoctorName: (name: string) => `Dr. ${name}`,
}));
vi.mock("@/lib/field-errors", () => ({
  extractFieldErrors: (err: any) => err?.fieldErrors ?? null,
  topLineError: (err: any, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

import AdmissionDetailPage from "../page";

// ─── Helpers ─────────────────────────────────────────────

/**
 * `use(params)` reads from a Promise. React's `use()` short-circuits when
 * the Promise carries the internal `{status:"fulfilled", value}` markers —
 * no Suspense round-trip. This is how RSC plumbing pre-tags its `use()`
 * payloads. Without this the microtask resolution never lands inside the
 * synchronous test window (the same gotcha codified in lab/[orderId] tests).
 */
function renderPage(id = "ad1") {
  const params: any = Promise.resolve({ id });
  params.status = "fulfilled";
  params.value = { id };
  return render(<AdmissionDetailPage params={params} />);
}

const today = new Date();
today.setHours(12, 0, 0, 0);
const past48h = new Date(today.getTime() - 48 * 60 * 60 * 1000);

type Admission = any;
type Vital = any;
type MedicationOrder = any;
type NurseRound = any;

function admissionFixture(overrides: Partial<Admission> = {}): Admission {
  return {
    id: "ad1",
    admissionNumber: "ADM-IPD-001",
    admittedAt: past48h.toISOString(),
    dischargedAt: null,
    status: "ADMITTED",
    reason: "Acute appendicitis",
    diagnosis: null,
    dischargeSummary: null,
    isolationType: "STANDARD",
    isolationReason: null,
    isolationStartDate: null,
    isolationEndDate: null,
    patient: {
      id: "pat-1",
      mrNumber: "MR-7777",
      age: 34,
      gender: "F",
      bloodGroup: "O+",
      user: { name: "Anita Sharma", phone: "+919999900001", email: "a@x.test" },
    },
    doctor: { id: "doc-1", user: { name: "Mehta" } },
    bed: {
      id: "bed-1",
      bedNumber: "B-101",
      ward: { id: "ward-1", name: "General Ward" },
    },
    ...overrides,
  };
}

function billFixture() {
  return {
    days: 2,
    grandTotal: 5400,
    breakdown: [
      { label: "Bed", days: 2, ratePerDay: 1500, amount: 3000 },
      { label: "Nursing", days: 2, ratePerDay: 1200, amount: 2400 },
    ],
  };
}

/**
 * Default GET wiring. Per-test overrides may either:
 *   (a) replace `apiMock.get.mockImplementation` with their own, or
 *   (b) call `wireDefaults(...)` again with extra overrides.
 */
function wireDefaults(opts: {
  admission?: Admission | null;
  bill?: any;
  vitals?: Vital[];
  medOrders?: MedicationOrder[];
  rounds?: NurseRound[];
  labOrders?: any[];
  marOrders?: any[];
  ioRows?: any[];
  ioTotals?: { totalIntake: number; totalOutput: number };
  belongings?: any;
  readiness?: any;
  los?: any;
  reconciliations?: any[];
  medicines?: any[];
  labTests?: any[];
  wards?: any[];
} = {}) {
  const admission = opts.admission === undefined ? admissionFixture() : opts.admission;
  apiMock.get.mockImplementation((url: string) => {
    if (url.endsWith("/bill")) {
      return Promise.resolve({ data: opts.bill ?? billFixture() });
    }
    if (url.endsWith("/los-prediction")) {
      return Promise.resolve({
        data: opts.los ?? {
          expectedDays: 4,
          confidence: "low",
          similar_cases_count: 2,
        },
      });
    }
    if (url.endsWith("/belongings")) {
      return Promise.resolve({ data: opts.belongings ?? { items: [], notes: null } });
    }
    if (url.endsWith("/discharge-readiness")) {
      return Promise.resolve({
        data:
          opts.readiness ?? {
            ready: true,
            outstandingBillsCount: 0,
            outstandingAmount: 0,
            pendingLabOrders: 0,
            pendingMedications: 0,
            dischargeSummaryWritten: true,
            followUpGiven: true,
            medsOnDischargeSpecified: true,
          },
      });
    }
    if (url.startsWith("/med-reconciliation?")) {
      return Promise.resolve({ data: opts.reconciliations ?? [] });
    }
    // Order matters — vitals/mar/intake-output before the generic /admissions/:id catch-all.
    if (url.includes("/vitals")) {
      return Promise.resolve({ data: opts.vitals ?? [] });
    }
    if (url.includes("/mar")) {
      return Promise.resolve({ data: { orders: opts.marOrders ?? [] } });
    }
    if (url.includes("/intake-output")) {
      return Promise.resolve({
        data: {
          rows: opts.ioRows ?? [],
          totalIntake: opts.ioTotals?.totalIntake ?? 0,
          totalOutput: opts.ioTotals?.totalOutput ?? 0,
        },
      });
    }
    if (url.startsWith("/medication/orders")) {
      return Promise.resolve({ data: opts.medOrders ?? [] });
    }
    if (url.startsWith("/nurse-rounds")) {
      return Promise.resolve({ data: opts.rounds ?? [] });
    }
    if (url.startsWith("/lab/orders")) {
      return Promise.resolve({ data: opts.labOrders ?? [] });
    }
    if (url === "/lab/tests") {
      return Promise.resolve({ data: opts.labTests ?? [] });
    }
    if (url.startsWith("/medicines?")) {
      return Promise.resolve({ data: opts.medicines ?? [] });
    }
    if (url === "/wards") {
      return Promise.resolve({ data: opts.wards ?? [] });
    }
    if (url.startsWith("/admissions/")) {
      // Catch-all root admission GET (IsolationPanel re-loads this too).
      if (admission === null) return Promise.reject(new Error("not found"));
      return Promise.resolve({ data: admission });
    }
    return Promise.resolve({ data: null });
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
    isLoading: false,
  });
}
function asNurse() {
  authMock.mockReturnValue({
    user: { id: "u-nurse", role: "NURSE", name: "Nurse" },
    isLoading: false,
  });
}
function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Adm" },
    isLoading: false,
  });
}

// ─── Tests ───────────────────────────────────────────────

describe("AdmissionDetailPage (IPD admission detail — top-level wiring + tabs)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    openPrintEndpointMock.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asDoctor();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Top-level wiring ──────────────────────────────────────────────────

  it("renders the loading skeleton with aria-busy while the root GET is in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    renderPage();
    const loader = await screen.findByTestId("admissions-detail-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card").length).toBeGreaterThanOrEqual(3);
  });

  it("shows 'Admission not found.' when the root GET rejects", async () => {
    wireDefaults({ admission: null });
    renderPage();
    await screen.findByText(/Admission not found\./i);
  });

  it("renders header + tabs + Overview default tab", async () => {
    wireDefaults();
    renderPage();
    // Patient header
    expect(
      await screen.findByRole("heading", { level: 1, name: /Anita Sharma/i }),
    ).toBeInTheDocument();
    // MR-7777 + ADM-IPD-001 each appear in multiple places (header + sidebar
    // + admission-detail grid); assert presence non-uniquely.
    expect(screen.getAllByText(/MR-7777/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/ADM-IPD-001/).length).toBeGreaterThanOrEqual(1);
    // Status pill
    expect(screen.getByText(/^ADMITTED$/)).toBeInTheDocument();
    // Tab buttons
    expect(screen.getByRole("button", { name: /Overview/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Vitals/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Medications$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Nurse Rounds/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Lab Orders/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /MAR/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /I\/O/ })).toBeInTheDocument();
  });

  it("Print Discharge Summary fires openPrintEndpoint with the canonical path", async () => {
    wireDefaults();
    renderPage();
    const btn = await screen.findByRole("button", {
      name: /Print discharge summary/i,
    });
    fireEvent.click(btn);
    expect(openPrintEndpointMock).toHaveBeenCalledWith(
      "/admissions/ad1/discharge-summary-pdf",
    );
  });

  it("swaps the URL to the canonical UUID when landed via admissionNumber slug", async () => {
    // Render with a slug-shaped id; the loaded admission has a different UUID.
    const canonical = "11111111-2222-4333-8444-555555555555";
    wireDefaults({ admission: admissionFixture({ id: canonical }) });
    const params: any = Promise.resolve({ id: "IPD000010" });
    params.status = "fulfilled";
    params.value = { id: "IPD000010" };
    render(<AdmissionDetailPage params={params} />);
    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        `/dashboard/admissions/${canonical}`,
      ),
    );
  });

  // ── Tab switching ─────────────────────────────────────────────────────

  it("clicking each tab swaps the active body", async () => {
    wireDefaults();
    renderPage();
    await screen.findByRole("heading", { level: 1, name: /Anita Sharma/i });

    // Overview (default) → patient sidebar reveals "Blood Group"
    expect(screen.getByText(/Blood Group/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Vitals/ }));
    await screen.findByText(/Record Vitals/i);

    fireEvent.click(screen.getByRole("button", { name: /^Medications$/ }));
    await screen.findByText(/No medication orders\./i);

    fireEvent.click(screen.getByRole("button", { name: /Nurse Rounds/ }));
    await screen.findByText(/No rounds recorded\./i);

    fireEvent.click(screen.getByRole("button", { name: /Lab Orders/ }));
    await screen.findByText(/No lab orders\./i);

    fireEvent.click(screen.getByRole("button", { name: /MAR/ }));
    await screen.findByText(/No medication orders for this admission\./i);

    fireEvent.click(screen.getByRole("button", { name: /I\/O/ }));
    await screen.findByText(/I\/O Events/i);
  });

  // ── Overview side cards ────────────────────────────────────────────────

  it("renders the Running Bill breakdown + grand total", async () => {
    wireDefaults();
    renderPage();
    await screen.findByRole("heading", { name: /Running Bill/i });
    // breakdown labels
    expect(screen.getByText(/Bed × 2 days @ ₹1500/)).toBeInTheDocument();
    expect(screen.getByText(/Nursing × 2 days @ ₹1200/)).toBeInTheDocument();
    expect(screen.getByText(/Total \(2 days\)/)).toBeInTheDocument();
    expect(screen.getByText("₹5,400")).toBeInTheDocument();
  });

  it("renders the LOS low-confidence advisory when the prediction is weak", async () => {
    wireDefaults({
      los: { expectedDays: 3, confidence: "low", similar_cases_count: 2 },
    });
    renderPage();
    const tile = await screen.findByTestId("los-prediction-low-confidence");
    expect(tile).toHaveTextContent(/Low confidence/i);
    expect(tile).toHaveTextContent(/~3d/);
    expect(tile).toHaveTextContent(/2 similar cases/);
  });

  it("renders the LOS high-confidence bold banner when sample size is sufficient", async () => {
    wireDefaults({
      los: { expectedDays: 5, confidence: "medium", similar_cases_count: 25 },
    });
    renderPage();
    await screen.findByText(/Expected discharge:/i);
    expect(screen.getByText(/confidence medium/i)).toBeInTheDocument();
  });

  it("Belongings card: empty-name Add fires toast and skips POST", async () => {
    wireDefaults();
    renderPage();
    // Find the Belongings card's Add button (last Add in the Overview).
    const addBtns = await screen.findAllByRole("button", { name: /^Add$/ });
    fireEvent.click(addBtns[addBtns.length - 1]);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Item name is required."),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Belongings card: happy Add POSTs the new item with checkedIn:true", async () => {
    wireDefaults();
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    renderPage();
    // Wait for the belongings card to mount (empty state).
    await screen.findByText(/No belongings recorded\./i);
    const nameInput = screen.getByPlaceholderText("Item name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Phone" } });
    fireEvent.change(screen.getByPlaceholderText("Description"), {
      target: { value: "Black" },
    });
    fireEvent.change(screen.getByPlaceholderText("Value"), {
      target: { value: "200" },
    });
    const addBtns = screen.getAllByRole("button", { name: /^Add$/ });
    fireEvent.click(addBtns[addBtns.length - 1]);
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/admissions/ad1/belongings",
        expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              name: "Phone",
              description: "Black",
              value: 200,
              checkedIn: true,
            }),
          ]),
        }),
      ),
    );
  });

  it("Reconciliation timeline renders one row with home/hospital/discharge counts", async () => {
    wireDefaults({
      reconciliations: [
        {
          id: "rec-1",
          reconciliationType: "ADMISSION",
          performedAt: today.toISOString(),
          notes: "Initial reconciliation",
          homeMedications: [{ name: "X" }, { name: "Y" }],
          hospitalMedications: [{ name: "Z" }],
          dischargeMedications: [],
        },
      ],
    });
    renderPage();
    await screen.findByText(/Medication Reconciliation History/i);
    expect(screen.getByText("ADMISSION")).toBeInTheDocument();
    expect(screen.getByText(/Home 2 · Hospital 1 · Discharge 0/)).toBeInTheDocument();
    expect(screen.getByText("Initial reconciliation")).toBeInTheDocument();
  });

  // ── Isolation panel ────────────────────────────────────────────────────

  it("IsolationPanel: Set + Save PATCHes /isolation with type+reason and reloads", async () => {
    wireDefaults();
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    renderPage();
    // Wait for Isolation panel "Standard" baseline.
    await screen.findByText(/Isolation Status: Standard/i);

    fireEvent.click(screen.getByRole("button", { name: /^Set$/ }));
    // Reason
    fireEvent.change(screen.getByPlaceholderText("Reason"), {
      target: { value: "Suspected MRSA" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/admissions/ad1/isolation",
        expect.objectContaining({
          isolationType: "STANDARD",
          isolationReason: "Suspected MRSA",
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Isolation updated");
  });

  it("IsolationPanel: active isolation shows Clear button → PATCH {clear:true}", async () => {
    wireDefaults({
      admission: admissionFixture({
        isolationType: "CONTACT",
        isolationReason: "C. diff",
        isolationStartDate: today.toISOString(),
      }),
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    renderPage();
    await screen.findByText(/Isolation Active: CONTACT/i);
    fireEvent.click(screen.getByRole("button", { name: /^Clear$/ }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/admissions/ad1/isolation",
        { clear: true },
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Isolation cleared");
  });

  // ── Discharge / Readiness / Transfer modals ───────────────────────────

  it("Discharge: clicking Discharge → readiness modal renders rows; Cancel closes", async () => {
    wireDefaults();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Discharge$/ }));
    expect(
      await screen.findByRole("heading", { name: /Discharge Readiness/i }),
    ).toBeInTheDocument();
    // All-green rows present
    expect(screen.getByText(/Outstanding bills/i)).toBeInTheDocument();
    expect(screen.getByText(/Pending labs/i)).toBeInTheDocument();
    // Cancel closes
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Discharge Readiness/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("Discharge: readiness 'all green' → Proceed opens discharge modal → PATCH happy path", async () => {
    wireDefaults();
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Discharge$/ }));
    await screen.findByRole("heading", { name: /Discharge Readiness/i });
    fireEvent.click(
      await screen.findByRole("button", { name: /Proceed to Discharge/i }),
    );
    // Discharge modal opens.
    expect(
      await screen.findByRole("heading", { name: /^Discharge Patient$/ }),
    ).toBeInTheDocument();
    // Fill the 3 required-or-disabled fields. Use explicit ids — the
    // "Discharge Summary" label collides with the header Print-CTA label.
    const conditionSelect = document.getElementById("discharge-condition")!;
    expect(conditionSelect).toHaveClass("dark:bg-gray-900", "dark:text-gray-100");
    expect(conditionSelect.querySelector('option[value="STABLE"]')).toHaveClass("dark:bg-gray-900", "dark:text-gray-100");
    fireEvent.change(document.getElementById("discharge-summary")!, {
      target: { value: "Patient improved, stable for home." },
    });
    fireEvent.change(document.getElementById("discharge-medications")!, {
      target: { value: "Amoxicillin 500mg TID x 5d" },
    });
    fireEvent.change(document.getElementById("discharge-followup")!, {
      target: { value: "Review OPD in 1 week" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm Discharge/i }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/admissions/ad1/discharge",
        expect.objectContaining({
          dischargeSummary: "Patient improved, stable for home.",
          dischargeMedications: "Amoxicillin 500mg TID x 5d",
          followUpInstructions: "Review OPD in 1 week",
          forceDischarge: false,
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Patient discharged");
  });

  it("Discharge: PATCH rejection surfaces toast.error with the message", async () => {
    wireDefaults();
    apiMock.patch.mockRejectedValue(new Error("bed unavailable"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Discharge$/ }));
    await screen.findByRole("heading", { name: /Discharge Readiness/i });
    fireEvent.click(
      await screen.findByRole("button", { name: /Proceed to Discharge/i }),
    );
    await screen.findByRole("heading", { name: /^Discharge Patient$/ });
    fireEvent.change(document.getElementById("discharge-summary")!, {
      target: { value: "S" },
    });
    fireEvent.change(document.getElementById("discharge-medications")!, {
      target: { value: "M" },
    });
    fireEvent.change(document.getElementById("discharge-followup")!, {
      target: { value: "F" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm Discharge/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("bed unavailable"),
    );
  });

  it("Transfer: open modal → wards GET fires → select bed → PATCH /transfer", async () => {
    wireDefaults({
      wards: [
        {
          id: "w-1",
          name: "ICU",
          beds: [
            { id: "b-icu-1", bedNumber: "ICU-1", status: "AVAILABLE", ward: { id: "w-1", name: "ICU" } },
            { id: "b-icu-2", bedNumber: "ICU-2", status: "OCCUPIED", ward: { id: "w-1", name: "ICU" } },
          ],
        },
      ],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Transfer Bed/i }));
    expect(
      await screen.findByRole("heading", { name: /Transfer to New Bed/i }),
    ).toBeInTheDocument();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/wards"));
    // Pick ICU-1 (AVAILABLE).
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "b-icu-1" } });
    fireEvent.click(screen.getByRole("button", { name: /^Transfer$/ }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/admissions/ad1/transfer",
        { bedId: "b-icu-1" },
      ),
    );
  });

  it("Transfer: PATCH rejection toasts the message", async () => {
    wireDefaults({
      wards: [
        {
          id: "w-1",
          name: "ICU",
          beds: [
            { id: "b-icu-1", bedNumber: "ICU-1", status: "AVAILABLE", ward: { id: "w-1", name: "ICU" } },
          ],
        },
      ],
    });
    apiMock.patch.mockRejectedValue(new Error("not allowed"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Transfer Bed/i }));
    await screen.findByRole("heading", { name: /Transfer to New Bed/i });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "b-icu-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Transfer$/ }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("not allowed"),
    );
  });

  // ── Vitals tab ─────────────────────────────────────────────────────────

  it("Vitals tab (empty): shows 'No vitals recorded yet.' and the form is rendered for DOCTOR", async () => {
    wireDefaults();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Vitals/ }));
    await screen.findByText(/No vitals recorded yet\./i);
    expect(screen.getByText(/Record Vitals/)).toBeInTheDocument();
    expect(screen.getByTestId("vitals-bpSystolic")).toBeInTheDocument();
  });

  it("Vitals tab: out-of-range temperature surfaces inline error and disables Save", async () => {
    wireDefaults();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Vitals/ }));
    await screen.findByText(/Record Vitals/);
    fireEvent.change(screen.getByTestId("vitals-temperature"), {
      target: { value: "999" },
    });
    expect(
      await screen.findByTestId("vitals-temperature-error"),
    ).toHaveTextContent(/out of physiological range/i);
    expect(screen.getByTestId("vitals-save")).toBeDisabled();
  });

  it("Vitals tab: diastolic >= systolic surfaces 'must be lower than systolic'", async () => {
    wireDefaults();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Vitals/ }));
    await screen.findByText(/Record Vitals/);
    fireEvent.change(screen.getByTestId("vitals-bpSystolic"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByTestId("vitals-bpDiastolic"), {
      target: { value: "110" },
    });
    expect(
      await screen.findByTestId("vitals-bpDiastolic-error"),
    ).toHaveTextContent(/lower than systolic/i);
  });

  it("Vitals tab: happy POST remaps form keys to canonical schema names", async () => {
    wireDefaults();
    apiMock.post.mockResolvedValue({ data: { id: "v-new" } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Vitals/ }));
    await screen.findByText(/Record Vitals/);
    fireEvent.change(screen.getByTestId("vitals-bpSystolic"), {
      target: { value: "120" },
    });
    fireEvent.change(screen.getByTestId("vitals-bpDiastolic"), {
      target: { value: "80" },
    });
    fireEvent.change(screen.getByTestId("vitals-temperature"), {
      target: { value: "37" },
    });
    fireEvent.change(screen.getByTestId("vitals-pulse"), {
      target: { value: "76" },
    });
    fireEvent.click(screen.getByTestId("vitals-save"));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/admissions/ad1/vitals",
        expect.objectContaining({
          admissionId: "ad1",
          temperatureUnit: "C",
          bloodPressureSystolic: 120,
          bloodPressureDiastolic: 80,
          temperature: 37,
          pulseRate: 76,
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Vitals saved");
  });

  it("Vitals tab: row rendering with schema-canonical and legacy field names", async () => {
    wireDefaults({
      vitals: [
        {
          id: "v-1",
          recordedAt: today.toISOString(),
          bloodPressureSystolic: 120,
          bloodPressureDiastolic: 80,
          temperature: 37.1,
          pulseRate: 78,
          respiratoryRate: 16,
          spO2: 98,
          painScore: 2,
          bloodSugar: 110,
          notes: "Stable",
        },
        {
          // Legacy short names — should still render.
          id: "v-2",
          recordedAt: today.toISOString(),
          bpSystolic: 110,
          bpDiastolic: 70,
          pulse: 72,
          notes: null,
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Vitals/ }));
    await screen.findByText(/120\/80/);
    expect(screen.getByText(/110\/70/)).toBeInTheDocument();
    expect(screen.getByText("Stable")).toBeInTheDocument();
  });

  it("Vitals tab: wraps long notes inside the table", async () => {
    const longNote = "followup".repeat(40);
    wireDefaults({
      vitals: [
        {
          id: "v-long-note",
          recordedAt: today.toISOString(),
          bloodPressureSystolic: 120,
          bloodPressureDiastolic: 80,
          notes: longNote,
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Vitals/ }));
    const note = await screen.findByText(longNote);
    expect(note.closest("table")).toHaveClass("table-fixed");
    expect(note.closest("td")?.className).toContain("[overflow-wrap:anywhere]");
    expect(note.closest("td")).toHaveClass("whitespace-pre-wrap", "break-words");
  });

  it("Vitals tab: NURSE sees the form (canRecord = true)", async () => {
    asNurse();
    wireDefaults();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Vitals/ }));
    expect(await screen.findByText(/Record Vitals/)).toBeInTheDocument();
  });

  // ── Medications tab ───────────────────────────────────────────────────

  it("Medications tab: search < 2 chars does NOT fire /medicines; >= 2 chars does", async () => {
    wireDefaults({ medicines: [{ id: "med-x", name: "Paracetamol" }] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Medications$/ }));
    await screen.findByText(/No medication orders\./i);
    fireEvent.click(screen.getByRole("button", { name: /\+ Add Order/i }));
    // 1-char — no call.
    fireEvent.change(screen.getByLabelText(/^Medicine$/), { target: { value: "P" } });
    await new Promise((r) => setTimeout(r, 350));
    let calls = apiMock.get.mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith("/medicines?"),
    );
    expect(calls.length).toBe(0);
    // 2+ chars — call fires.
    fireEvent.change(screen.getByLabelText(/^Medicine$/), {
      target: { value: "Para" },
    });
    await waitFor(
      () => {
        calls = apiMock.get.mock.calls.filter((c: any[]) =>
          String(c[0]).startsWith("/medicines?"),
        );
        expect(calls.length).toBeGreaterThan(0);
      },
      { timeout: 1500 },
    );
    expect(await screen.findByText(/Paracetamol/)).toBeInTheDocument();
  });

  it("Medications tab: submit without medicine → toast and no POST", async () => {
    wireDefaults();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Medications$/ }));
    await screen.findByText(/No medication orders\./i);
    fireEvent.click(screen.getByRole("button", { name: /\+ Add Order/i }));
    const form = screen.getByRole("heading", { name: /New Medication Order/i })
      .closest("form")!;
    fireEvent.submit(form);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Select a medicine"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Medications tab: missing dosage / frequency toast in order", async () => {
    wireDefaults({ medicines: [{ id: "med-x", name: "Paracetamol" }] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Medications$/ }));
    await screen.findByText(/No medication orders\./i);
    fireEvent.click(screen.getByRole("button", { name: /\+ Add Order/i }));
    fireEvent.change(screen.getByLabelText(/^Medicine$/), {
      target: { value: "Para" },
    });
    const pickRow = await screen.findByText(/Paracetamol/);
    fireEvent.click(pickRow.closest("button")!);
    const form = screen.getByRole("heading", { name: /New Medication Order/i })
      .closest("form")!;
    // No dosage.
    fireEvent.submit(form);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Dosage is required"),
    );
    // Dosage but no frequency.
    fireEvent.change(screen.getByLabelText(/^Dosage$/), {
      target: { value: "500mg" },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Frequency is required"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Medications tab: happy POST sends the canonical body", async () => {
    wireDefaults({ medicines: [{ id: "med-x", name: "Paracetamol" }] });
    apiMock.post.mockResolvedValue({ data: { id: "mo-new" } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Medications$/ }));
    await screen.findByText(/No medication orders\./i);
    fireEvent.click(screen.getByRole("button", { name: /\+ Add Order/i }));
    fireEvent.change(screen.getByLabelText(/^Medicine$/), {
      target: { value: "Para" },
    });
    const pickRow = await screen.findByText(/Paracetamol/);
    fireEvent.click(pickRow.closest("button")!);
    fireEvent.change(screen.getByLabelText(/^Dosage$/), {
      target: { value: "500mg" },
    });
    fireEvent.change(screen.getByLabelText(/^Frequency$/), {
      target: { value: "TID" },
    });
    fireEvent.change(screen.getByLabelText(/^Route$/), {
      target: { value: "IV" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Order/ }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/medication/orders",
        expect.objectContaining({
          admissionId: "ad1",
          medicineId: "med-x",
          dosage: "500mg",
          frequency: "TID",
          route: "IV",
        }),
      ),
    );
  });

  it("Medications tab: renders order rows and toggles isActive via PATCH", async () => {
    wireDefaults({
      medOrders: [
        {
          id: "mo-1",
          medicineName: "Paracetamol",
          dosage: "500mg",
          frequency: "TID",
          route: "ORAL",
          startDate: "2026-05-24",
          endDate: null,
          isActive: true,
          administrations: [
            {
              id: "a-1",
              scheduledAt: today.toISOString(),
              status: "ADMINISTERED",
            },
            {
              id: "a-2",
              scheduledAt: today.toISOString(),
              status: "MISSED",
            },
          ],
        },
      ],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Medications$/ }));
    expect(
      await screen.findByTestId("medication-orders-list"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("medication-order-name")).toHaveTextContent(
      "Paracetamol",
    );
    expect(screen.getByText(/Recent Administrations/i)).toBeInTheDocument();
    // Toggle Active off
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/medication/orders/mo-1",
        { isActive: false },
      ),
    );
  });

  // ── Rounds tab ─────────────────────────────────────────────────────────

  it("Rounds tab: NURSE can add a round; empty notes → toast guard", async () => {
    asNurse();
    wireDefaults();
    apiMock.post.mockResolvedValue({ data: { id: "nr-new" } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Nurse Rounds/ }));
    await screen.findByText(/No rounds recorded\./i);
    fireEvent.click(screen.getByRole("button", { name: /\+ Add Round/i }));
    const form = screen.getByRole("heading", { name: /New Nurse Round/i })
      .closest("form")!;
    // Empty submit → toast.
    fireEvent.submit(form);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Round notes are required"),
    );
    // Real submit
    fireEvent.change(screen.getByPlaceholderText(/Round notes/i), {
      target: { value: "Patient resting comfortably." },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/nurse-rounds", {
        admissionId: "ad1",
        notes: "Patient resting comfortably.",
      }),
    );
  });

  it("Rounds tab: renders nurse-round row with formatted timestamp + nurse name shapes", async () => {
    wireDefaults({
      rounds: [
        {
          id: "nr-1",
          performedAt: today.toISOString(),
          notes: "Round 1 notes",
          nurse: { id: "u-1", name: "Sister Mary" },
        },
        {
          id: "nr-2",
          roundedAt: today.toISOString(), // legacy key
          notes: "Round 2",
          nurse: { user: { name: "Sister Joan" } },
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Nurse Rounds/ }));
    expect(
      await screen.findByTestId("nurse-rounds-list"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Round 1 notes/)).toBeInTheDocument();
    expect(screen.getByText(/By: Sister Mary/)).toBeInTheDocument();
    expect(screen.getByText(/By: Sister Joan/)).toBeInTheDocument();
  });

  // ── Labs tab ───────────────────────────────────────────────────────────

  it("Labs tab: DOCTOR can order; empty selection → toast guard", async () => {
    wireDefaults({
      labTests: [
        { id: "t-1", name: "CBC", category: "Hematology" },
        { id: "t-2", name: "Glucose", category: "Biochemistry" },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Lab Orders/ }));
    await screen.findByText(/No lab orders\./i);
    fireEvent.click(screen.getByRole("button", { name: /\+ Order Labs/i }));
    // No selection → submit toasts.
    const form = screen.getByRole("heading", { name: /New Lab Order/i })
      .closest("form")!;
    fireEvent.submit(form);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Select at least one test"),
    );
    // Happy submit
    apiMock.post.mockResolvedValue({ data: { id: "lo-new" } });
    // The test picker is lazy-loaded (/lab/tests fetch fires when the form
    // opens), so await the checkbox rather than querying synchronously — the
    // empty-selection toast above can resolve before that fetch settles.
    fireEvent.click(await screen.findByLabelText("CBC"));
    fireEvent.click(screen.getByRole("button", { name: /Create Order/ }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/lab/orders",
        expect.objectContaining({
          patientId: "pat-1",
          admissionId: "ad1",
          testIds: ["t-1"],
        }),
      ),
    );
  });

  it("Labs tab: renders lab order row with status pill", async () => {
    wireDefaults({
      labOrders: [
        {
          id: "lo-1",
          orderNumber: "LAB-2026-001",
          orderedAt: today.toISOString(),
          status: "COMPLETED",
          notes: null,
          items: [{ test: { name: "CBC" }, status: "COMPLETED" }],
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Lab Orders/ }));
    expect(await screen.findByText(/LAB-2026-001/)).toBeInTheDocument();
    expect(screen.getByText("COMPLETED")).toBeInTheDocument();
    expect(screen.getByText("CBC")).toBeInTheDocument();
  });

  // ── MAR tab ────────────────────────────────────────────────────────────

  it("MAR tab: cell click opens the administer modal → PATCH on save", async () => {
    const sched = new Date(today);
    sched.setHours(8, 0, 0, 0);
    wireDefaults({
      marOrders: [
        {
          id: "mo-1",
          medicineName: "Paracetamol",
          dosage: "500mg",
          frequency: "TID",
          route: "ORAL",
          isActive: true,
          administrations: [
            {
              id: "ma-1",
              scheduledAt: sched.toISOString(),
              administeredAt: null,
              status: "SCHEDULED",
              notes: null,
              nurse: null,
            },
          ],
        },
      ],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /MAR/ }));
    // The cell testid is `mar-cell-<orderId>-<HH:MM>`. We compute that slot from
    // the same scheduledAt the source code uses (UTC slice 11..16).
    const slot = sched.toISOString().slice(11, 16);
    const cell = await screen.findByTestId(`mar-cell-mo-1-${slot}`);
    fireEvent.click(cell);
    expect(
      await screen.findByRole("heading", { name: /Record Administration/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mar-administer-save"));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/medication/administrations/ma-1",
        expect.objectContaining({ status: "ADMINISTERED" }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Administration recorded");
  });

  it("MAR tab: ADMINISTERED cell is disabled and does not open the modal", async () => {
    const sched = new Date(today);
    sched.setHours(8, 0, 0, 0);
    wireDefaults({
      marOrders: [
        {
          id: "mo-1",
          medicineName: "Paracetamol",
          dosage: "500mg",
          frequency: "TID",
          route: "ORAL",
          isActive: true,
          administrations: [
            {
              id: "ma-1",
              scheduledAt: sched.toISOString(),
              administeredAt: sched.toISOString(),
              status: "ADMINISTERED",
              notes: null,
              nurse: null,
            },
          ],
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /MAR/ }));
    const slot = sched.toISOString().slice(11, 16);
    const cell = await screen.findByTestId(`mar-cell-mo-1-${slot}`);
    expect(cell).toBeDisabled();
    fireEvent.click(cell);
    // Modal must not open.
    expect(
      screen.queryByRole("heading", { name: /Record Administration/i }),
    ).not.toBeInTheDocument();
  });

  // ── I/O tab ────────────────────────────────────────────────────────────

  it("I/O tab: happy POST sends the canonical body and the form resets", async () => {
    wireDefaults();
    apiMock.post.mockResolvedValue({ data: { id: "io-new" } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /I\/O/ }));
    await screen.findByText(/I\/O Events/i);
    fireEvent.change(screen.getByTestId("io-amount"), {
      target: { value: "250" },
    });
    fireEvent.change(screen.getByLabelText(/Description/i), {
      target: { value: "Water" },
    });
    fireEvent.click(screen.getByTestId("io-save"));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/admissions/ad1/intake-output",
        expect.objectContaining({
          type: "INTAKE_ORAL",
          amountMl: 250,
          description: "Water",
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Recorded");
  });

  it("I/O tab: > 10000 mL surfaces inline error and disables Save", async () => {
    wireDefaults();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /I\/O/ }));
    await screen.findByText(/I\/O Events/i);
    fireEvent.change(screen.getByTestId("io-amount"), {
      target: { value: "12000" },
    });
    expect(
      await screen.findByTestId("io-amount-error"),
    ).toHaveTextContent(/≤ 10000 mL/);
    expect(screen.getByTestId("io-save")).toBeDisabled();
  });

  it("I/O tab: shows totals + balance and renders event rows", async () => {
    wireDefaults({
      ioRows: [
        {
          id: "io-1",
          type: "INTAKE_ORAL",
          amountMl: 250,
          description: "Water",
          notes: null,
          recordedAt: today.toISOString(),
        },
        {
          id: "io-2",
          type: "OUTPUT_URINE",
          amountMl: 100,
          description: null,
          notes: null,
          recordedAt: today.toISOString(),
        },
      ],
      ioTotals: { totalIntake: 250, totalOutput: 100 },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /I\/O/ }));
    // Both the totals card and the event row render "250 ml" — assert both.
    const intakes = await screen.findAllByText("250 ml");
    expect(intakes.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("100 ml").length).toBeGreaterThanOrEqual(2);
    // Balance = +150 ml — note literal "+" prefix.
    expect(screen.getByText(/\+150 ml/)).toBeInTheDocument();
    expect(screen.getByText(/INTAKE ORAL/)).toBeInTheDocument();
    expect(screen.getByText(/OUTPUT URINE/)).toBeInTheDocument();
  });

  it("I/O tab: ADMIN canRecord true; PATIENT canRecord false (no form)", async () => {
    authMock.mockReturnValue({
      user: { id: "u-pat", role: "PATIENT", name: "Pat" },
      isLoading: false,
    });
    wireDefaults();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /I\/O/ }));
    await screen.findByText(/I\/O Events/i);
    expect(screen.queryByTestId("io-amount")).not.toBeInTheDocument();
  });
});
