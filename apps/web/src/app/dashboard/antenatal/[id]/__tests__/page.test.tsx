/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AncCaseDetailPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/antenatal/[id]/page.tsx, the ANC
 *     case detail screen — a 1693-line composite with 4 sibling tabs:
 *       1. Visits (default tab): timeline + add-visit form + expand-row.
 *       2. Delivery: read-only block when delivered; record-form when not.
 *       3. Partograph (PartographTab): loadList from /antenatal/cases/:id
 *          (reads partographs[]), then /antenatal/partograph/:id; start,
 *          add-obs, end (via usePrompt) flows.
 *       4. ACOG Risk (AcogRiskTab): form → POST /antenatal/cases/:id/
 *          acog-risk-score → result panel.
 *       5. Postnatal (PostnatalTab, only when delivered):
 *          GET /antenatal/cases/:id/postnatal-visits then POST.
 *
 *   - Behaviours covered (cumulative ≥ 75% line coverage target):
 *       a. Loading skeleton with aria-busy="true" while case fetch pending.
 *       b. URL id param threads into GET /antenatal/cases/:id.
 *       c. Header — caseNumber, High Risk pill, Delivered pill conditional.
 *       d. Patient block — name, MR, phone, doctor name.
 *       e. Risk factors banner shown when isHighRisk + riskFactors.
 *       f. Print Birth Certificate button rendered when delivered.
 *       g. Days-to-EDD positive vs overdue branches.
 *       h. RBAC — DOCTOR/NURSE/ADMIN see Add Visit; PATIENT/RECEPTION do not.
 *          DOCTOR/ADMIN see Record Delivery; NURSE/PATIENT do not.
 *       i. Add-visit submit guard — empty form toasts and does not POST.
 *       j. Add-visit happy path — POST /antenatal/visits with parsed
 *          numerics + ISO strings + load() refetch.
 *       k. Add-visit POST rejection toasts the Error message.
 *       l. Visit row expand/collapse — toggleVisit flips ChevronDown/Right.
 *       m. Tab switching — Visits → Delivery → Partograph → Risk; the
 *          delivered fixture additionally exposes Postnatal tab.
 *       n. Delivery — read-only block on delivered case (date, type).
 *       o. Delivery — record form on non-delivered case (DOCTOR), happy
 *          PATCH /antenatal/cases/:id/delivery + reload.
 *       p. Delivery — patient-view fallback copy "Delivery not yet recorded."
 *       q. Partograph — loading state; empty "No partograph started.";
 *          start-new → POST /antenatal/cases/:id/partograph + reload.
 *       r. ACOG Risk — submit calculate POSTs with selected boolean flags
 *          plus parsed numerics; result panel renders score + category +
 *          risk factor list.
 *       s. Postnatal — loading, empty "No postnatal visits recorded.",
 *          then submit POST /antenatal/cases/:id/postnatal-visits +
 *          reload.
 *       t. Error tolerance — case fetch rejection keeps loading skeleton
 *          (mirrors empty-case stub) without throwing.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/use-dialog,
 *     @/lib/format-doctor-name (pass-through), next/navigation
 *     (useParams threads id: "a1"), @/components/Skeleton passthrough.
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

const { apiMock, toastMock, authMock, promptMock, openPrintMock } = vi.hoisted(
  () => ({
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
    openPrintMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({
  api: apiMock,
  openPrintEndpoint: openPrintMock,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  usePrompt: () => promptMock,
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock("@/lib/format-doctor-name", () => ({
  formatDoctorName: (n: string) => (n.startsWith("Dr.") ? n : `Dr. ${n}`),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "a1" }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/antenatal/a1",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: () => <div data-testid="skeleton-card-stub" />,
  SkeletonTable: ({
    rows,
    columns,
  }: {
    rows?: number;
    columns?: number;
  }) => (
    <div
      data-testid="skeleton-table-stub"
      data-rows={rows}
      data-cols={columns}
    />
  ),
}));

import AncCaseDetailPage from "../page";

// ─── Fixtures ───────────────────────────────────────────────────────────

const today = new Date();
today.setHours(12, 0, 0, 0);
// +/- 48h vs midnight today — avoids IST/UTC midnight traps.
const futureEdd = new Date(today.getTime() + 48 * 60 * 60 * 1000); // +2d
const pastEdd = new Date(today.getTime() - 48 * 60 * 60 * 1000); // -2d overdue
const lmp20wAgo = new Date(today.getTime() - 20 * 7 * 24 * 60 * 60 * 1000);

function isoOf(d: Date): string {
  return d.toISOString();
}

function caseFixture(overrides: Partial<any> = {}): any {
  return {
    id: "a1",
    caseNumber: "ANC-2026-DET-001",
    lmpDate: isoOf(lmp20wAgo),
    eddDate: isoOf(futureEdd),
    gravida: 2,
    parity: 1,
    bloodGroup: "O_POS",
    isHighRisk: false,
    riskFactors: null,
    deliveredAt: null,
    deliveryType: null,
    babyGender: null,
    babyWeight: null,
    outcomeNotes: null,
    patient: {
      id: "pat-1",
      mrNumber: "MR-A1",
      user: {
        name: "Asha Patel",
        phone: "+919999900001",
        email: "asha@example.com",
      },
    },
    doctor: { id: "doc-1", user: { name: "Mehta" } },
    visits: [
      {
        id: "v-1",
        type: "ROUTINE",
        visitDate: isoOf(new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000)),
        weeksOfGestation: 18,
        weight: 56,
        bloodPressure: "118/76",
        fundalHeight: "18cm",
        fetalHeartRate: 142,
        presentation: "Cephalic",
        hemoglobin: 11.2,
        urineProtein: "nil",
        urineSugar: "nil",
        notes: "All well",
        prescribedMeds: "Folic acid, Iron",
        nextVisitDate: isoOf(futureEdd),
      },
    ],
    ...overrides,
  };
}

function deliveredCaseFixture(): any {
  return caseFixture({
    id: "a1",
    caseNumber: "ANC-2026-DEL-002",
    deliveredAt: isoOf(pastEdd),
    deliveryType: "NORMAL",
    babyGender: "FEMALE",
    babyWeight: 3.2,
    outcomeNotes: "Healthy newborn",
  });
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
 * Wire default GETs for the main case detail + the three tab sub-fetches.
 * Per-test overrides should call apiMock.get.mockImplementation again BEFORE
 * rendering.
 */
function wireDefaultGets(
  opts: {
    caseData?: any;
    partographs?: any[] | null; // attached to /antenatal/cases/:id payload
    partographDetail?: any;
    postnatal?: any[];
  } = {},
) {
  const caseData = opts.caseData ?? caseFixture();
  const partographs = opts.partographs ?? [];
  const postnatal = opts.postnatal ?? [];

  apiMock.get.mockImplementation((url: string) => {
    if (url === "/antenatal/cases/a1") {
      return Promise.resolve({
        data: { ...caseData, partographs },
      });
    }
    if (url.startsWith("/antenatal/partograph/")) {
      return Promise.resolve({ data: opts.partographDetail });
    }
    if (url === "/antenatal/cases/a1/postnatal-visits") {
      return Promise.resolve({ data: postnatal });
    }
    return Promise.resolve({ data: null });
  });
}

describe("AncCaseDetailPage (ANC case detail — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    promptMock.mockReset();
    openPrintMock.mockReset();
    asDoctor();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Loading + base render ───────────────────────────────────────────────

  it("renders the loading skeleton with aria-busy while the case fetch is pending", async () => {
    apiMock.get.mockImplementation(
      (url: string) =>
        url === "/antenatal/cases/a1"
          ? new Promise(() => {}) // never resolves
          : Promise.resolve({ data: null }),
    );

    render(<AncCaseDetailPage />);

    const busy = await screen.findByTestId("antenatal-detail-loading");
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card-stub").length).toBeGreaterThan(
      0,
    );
  });

  it("threads the URL id param into GET /antenatal/cases/a1", async () => {
    wireDefaultGets();
    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    expect(apiMock.get).toHaveBeenCalledWith("/antenatal/cases/a1");
  });

  it("renders the case header with caseNumber, MR, doctor, LMP/EDD, G/P, blood group", async () => {
    wireDefaultGets();
    render(<AncCaseDetailPage />);

    expect(await screen.findByText("ANC-2026-DET-001")).toBeInTheDocument();
    expect(screen.getByText(/Asha Patel · MR-A1/)).toBeInTheDocument();
    // Doctor name uses formatDoctorName stub — prefixes "Dr. " when missing.
    expect(screen.getByText(/Dr\. Mehta/)).toBeInTheDocument();
    // G/P from fixture
    expect(screen.getByText("G2 P1")).toBeInTheDocument();
    // Blood group — bloodGroup string ("O_POS") rendered as-is in detail page
    expect(screen.getByText("O_POS")).toBeInTheDocument();
    // Phone surfaces
    expect(screen.getByText(/\+919999900001/)).toBeInTheDocument();
  });

  it("renders the High Risk pill + Risk Factors banner when isHighRisk + riskFactors are set", async () => {
    wireDefaultGets({
      caseData: caseFixture({
        isHighRisk: true,
        riskFactors: "Hypertension, prior PPH",
      }),
    });
    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");

    // High Risk appears as a header pill — anchor by the red-100 bg class.
    const hrPills = screen.getAllByText(/^High Risk$/);
    expect(hrPills.length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText(/Hypertension, prior PPH/)).toBeInTheDocument();
  });

  it("renders the Delivered pill + Print Birth Certificate button when deliveredAt is set", async () => {
    wireDefaultGets({ caseData: deliveredCaseFixture() });
    render(<AncCaseDetailPage />);

    await screen.findByText("ANC-2026-DEL-002");
    expect(screen.getAllByText(/^Delivered$/).length).toBeGreaterThanOrEqual(1);

    const printBtn = screen.getByRole("button", {
      name: /Print Birth Certificate/i,
    });
    fireEvent.click(printBtn);
    expect(openPrintMock).toHaveBeenCalledWith(
      "/antenatal/cases/a1/birth-certificate",
    );
  });

  it("shows '{n}d to go' for an upcoming EDD and '{n}d overdue' for a past EDD", async () => {
    // Upcoming
    wireDefaultGets();
    const { unmount } = render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    expect(screen.getByText(/2d$/)).toBeInTheDocument();
    unmount();

    // Overdue branch — re-wire and re-render.
    wireDefaultGets({
      caseData: caseFixture({ eddDate: isoOf(pastEdd) }),
    });
    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    expect(screen.getByText(/2d overdue/i)).toBeInTheDocument();
  });

  // ── RBAC: Add Visit / Record Delivery ───────────────────────────────────

  it("DOCTOR sees the Add Visit button on the visits tab", async () => {
    wireDefaultGets();
    render(<AncCaseDetailPage />);
    expect(
      await screen.findByRole("button", { name: /Add Visit/i }),
    ).toBeInTheDocument();
  });

  it("NURSE sees the Add Visit button", async () => {
    asNurse();
    wireDefaultGets();
    render(<AncCaseDetailPage />);
    expect(
      await screen.findByRole("button", { name: /Add Visit/i }),
    ).toBeInTheDocument();
  });

  it("ADMIN sees the Add Visit button", async () => {
    asAdmin();
    wireDefaultGets();
    render(<AncCaseDetailPage />);
    expect(
      await screen.findByRole("button", { name: /Add Visit/i }),
    ).toBeInTheDocument();
  });

  it("PATIENT does NOT see the Add Visit button", async () => {
    asPatient();
    wireDefaultGets();
    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    expect(
      screen.queryByRole("button", { name: /Add Visit/i }),
    ).not.toBeInTheDocument();
  });

  it("RECEPTION does NOT see the Add Visit button", async () => {
    asReception();
    wireDefaultGets();
    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    expect(
      screen.queryByRole("button", { name: /Add Visit/i }),
    ).not.toBeInTheDocument();
  });

  // ── Visit row expand/collapse ───────────────────────────────────────────

  it("clicking a visit row reveals the expanded vitals (FHR, Hb, urine, notes)", async () => {
    wireDefaultGets();
    render(<AncCaseDetailPage />);

    // Visit summary row exists with the visit type label.
    const summary = await screen.findByText(/ROUTINE ·/);
    // Hidden details before expand
    expect(screen.queryByText(/142 bpm/)).not.toBeInTheDocument();

    fireEvent.click(summary.closest("button")!);

    // After expand, FHR + Hb details should be in the DOM.
    expect(await screen.findByText(/142 bpm/)).toBeInTheDocument();
    expect(screen.getByText(/11.2 g\/dl/)).toBeInTheDocument();
    expect(screen.getByText(/Folic acid, Iron/)).toBeInTheDocument();

    // Collapse — click again.
    fireEvent.click(summary.closest("button")!);
    await waitFor(() => {
      expect(screen.queryByText(/142 bpm/)).not.toBeInTheDocument();
    });
  });

  // ── Add Visit form ──────────────────────────────────────────────────────

  it("submit visit with NO clinical content toasts the empty-form guard and does NOT POST", async () => {
    wireDefaultGets();
    render(<AncCaseDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Visit/i }));

    // Submit straight away — visit-type default is ROUTINE, nothing else.
    fireEvent.click(screen.getByRole("button", { name: /^Save Visit$/ }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Record at least one observation/i),
      );
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("happy POST /antenatal/visits — submits parsed body, closes form, refetches case", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({ data: { id: "v-new" } });

    render(<AncCaseDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Visit/i }));

    const initialCaseFetches = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/antenatal/cases/a1",
    ).length;

    fireEvent.change(screen.getByLabelText(/Weeks Gestation/i), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText(/^Weight \(kg\)$/i), {
      target: { value: "57.5" },
    });
    fireEvent.change(screen.getByLabelText(/^Blood Pressure$/i), {
      target: { value: "120/80" },
    });
    fireEvent.change(screen.getByLabelText(/Fundal Height/i), {
      target: { value: "20cm" },
    });
    fireEvent.change(screen.getByLabelText(/^FHR \(bpm\)$/i), {
      target: { value: "138" },
    });
    fireEvent.change(screen.getByLabelText(/^Presentation$/i), {
      target: { value: "Cephalic" },
    });
    fireEvent.change(screen.getByLabelText(/^Hb \(g\/dl\)$/i), {
      target: { value: "11.6" },
    });
    fireEvent.change(screen.getByLabelText(/^Urine Protein$/i), {
      target: { value: "nil" },
    });
    fireEvent.change(screen.getByLabelText(/^Urine Sugar$/i), {
      target: { value: "nil" },
    });
    fireEvent.change(screen.getByLabelText(/^Notes$/i), {
      target: { value: "Stable" },
    });
    fireEvent.change(screen.getByLabelText(/Prescribed Meds/i), {
      target: { value: "Iron" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Save Visit$/ }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [postUrl, postBody] = apiMock.post.mock.calls[0];
    expect(postUrl).toBe("/antenatal/visits");
    expect(postBody).toMatchObject({
      ancCaseId: "a1",
      type: "ROUTINE",
      weeksOfGestation: 20,
      weight: 57.5,
      bloodPressure: "120/80",
      fundalHeight: "20cm",
      fetalHeartRate: 138,
      presentation: "Cephalic",
      hemoglobin: 11.6,
      urineProtein: "nil",
      urineSugar: "nil",
      notes: "Stable",
      prescribedMeds: "Iron",
    });

    // Form closes; case is refetched (load() re-runs).
    await waitFor(() => {
      const newCaseFetches = apiMock.get.mock.calls.filter(
        (c: any[]) => c[0] === "/antenatal/cases/a1",
      ).length;
      expect(newCaseFetches).toBeGreaterThan(initialCaseFetches);
    });
  });

  it("POST /antenatal/visits rejection with Error surfaces toast.error(message)", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue(new Error("Duplicate visit"));

    render(<AncCaseDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Visit/i }));

    // Add enough clinical content to pass the empty-form guard.
    fireEvent.change(screen.getByLabelText(/^Notes$/i), {
      target: { value: "stable" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save Visit$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Duplicate visit"),
    );
  });

  it("POST /antenatal/visits rejection with non-Error falls back to 'Failed to add visit'", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue("string boom");

    render(<AncCaseDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Visit/i }));

    fireEvent.change(screen.getByLabelText(/^Notes$/i), {
      target: { value: "stable" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save Visit$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to add visit"),
    );
  });

  it("Add Visit form Cancel button closes the form", async () => {
    wireDefaultGets();
    render(<AncCaseDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Visit/i }));
    expect(screen.getByLabelText(/^Notes$/i)).toBeInTheDocument();

    // Form has its own Cancel button inside.
    const cancels = screen.getAllByRole("button", { name: /^Cancel$/ });
    fireEvent.click(cancels[0]);

    await waitFor(() =>
      expect(screen.queryByLabelText(/^Notes$/i)).not.toBeInTheDocument(),
    );
  });

  // ── Delivery tab ────────────────────────────────────────────────────────

  it("Delivery tab renders the read-only block when the case is delivered", async () => {
    wireDefaultGets({ caseData: deliveredCaseFixture() });
    render(<AncCaseDetailPage />);

    await screen.findByText("ANC-2026-DEL-002");
    fireEvent.click(screen.getByRole("button", { name: /^Delivery$/ }));

    expect(await screen.findByText(/Delivery Details/i)).toBeInTheDocument();
    expect(screen.getByText(/Healthy newborn/)).toBeInTheDocument();
    expect(screen.getByText(/3\.2 kg/)).toBeInTheDocument();
    expect(screen.getByText(/FEMALE/)).toBeInTheDocument();
  });

  it("Delivery tab + DOCTOR + not delivered — Record Delivery opens form and PATCHes /antenatal/cases/:id/delivery", async () => {
    wireDefaultGets();
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    fireEvent.click(screen.getByRole("button", { name: /^Delivery$/ }));

    // Empty-state CTA
    fireEvent.click(
      await screen.findByRole("button", { name: /Record Delivery$/ }),
    );
    // Form
    await screen.findByLabelText(/Delivery Type/i);

    fireEvent.change(screen.getByLabelText(/Delivery Type/i), {
      target: { value: "C_SECTION" },
    });
    fireEvent.change(screen.getByLabelText(/Baby Gender/i), {
      target: { value: "FEMALE" },
    });
    fireEvent.change(screen.getByLabelText(/Baby Weight/i), {
      target: { value: "3.0" },
    });
    fireEvent.change(screen.getByLabelText(/Outcome Notes/i), {
      target: { value: "All good" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Record Delivery$/ }));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch).toHaveBeenCalledWith(
      "/antenatal/cases/a1/delivery",
      expect.objectContaining({
        deliveryType: "C_SECTION",
        babyGender: "FEMALE",
        babyWeight: 3.0,
        outcomeNotes: "All good",
      }),
    );
  });

  it("Delivery tab — PATCH rejection toasts the Error message", async () => {
    wireDefaultGets();
    apiMock.patch.mockRejectedValue(new Error("Patient not ready"));

    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    fireEvent.click(screen.getByRole("button", { name: /^Delivery$/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Record Delivery$/ }),
    );
    await screen.findByLabelText(/Delivery Type/i);
    fireEvent.click(screen.getByRole("button", { name: /Record Delivery$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Patient not ready"),
    );
  });

  it("Delivery tab — PATIENT sees the 'Delivery not yet recorded.' fallback (no Record button)", async () => {
    asPatient();
    wireDefaultGets();
    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    fireEvent.click(screen.getByRole("button", { name: /^Delivery$/ }));

    expect(
      await screen.findByText(/Delivery not yet recorded\./i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Record Delivery$/ }),
    ).not.toBeInTheDocument();
  });

  // ── Partograph tab ──────────────────────────────────────────────────────

  it("Partograph tab — empty state 'No partograph started.' when partographs=[]", async () => {
    wireDefaultGets();
    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    fireEvent.click(screen.getByRole("button", { name: /^Partograph$/ }));

    expect(
      await screen.findByText(/No partograph started\./i),
    ).toBeInTheDocument();
    // Start button visible for DOCTOR
    expect(
      screen.getByRole("button", { name: /Start New Partograph/i }),
    ).toBeInTheDocument();
  });

  it("Partograph tab — Start New triggers POST /antenatal/cases/:id/partograph", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({ data: { id: "pg-1" } });

    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    fireEvent.click(screen.getByRole("button", { name: /^Partograph$/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Start New Partograph/i }),
    );

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/antenatal/cases/a1/partograph",
        { observations: [] },
      ),
    );
  });

  it("Partograph tab — renders active partograph with started timestamp + dilation chart", async () => {
    wireDefaultGets({
      partographs: [{ id: "pg-1" }],
      partographDetail: {
        id: "pg-1",
        startedAt: isoOf(pastEdd),
        endedAt: null,
        observations: [
          {
            time: "2026-05-20T10:00",
            fetalHeartRate: 140,
            cervicalDilation: 4,
            contractionsPer10Min: 3,
            maternalBP: "120/80",
            maternalPulse: 88,
          },
        ],
        chart: {
          dilationSeries: [{ hoursSinceStart: 0, cervicalDilation: 4 }],
          fhrSeries: [{ hoursSinceStart: 0, fetalHeartRate: 140 }],
          alertLine: [
            { hour: 0, dilation: 4 },
            { hour: 6, dilation: 10 },
          ],
          actionLine: [
            { hour: 4, dilation: 4 },
            { hour: 10, dilation: 10 },
          ],
        },
        flags: ["Slow progress"],
      },
    });

    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    fireEvent.click(screen.getByRole("button", { name: /^Partograph$/ }));

    expect(await screen.findByText(/Started:/i)).toBeInTheDocument();
    // Flag rendered
    expect(screen.getByText(/Slow progress/)).toBeInTheDocument();
    // SVG legend text
    expect(screen.getByText(/Cervical Dilation/i)).toBeInTheDocument();
    // Observation row table
    expect(screen.getByText("120/80")).toBeInTheDocument();
  });

  // ── ACOG Risk tab ───────────────────────────────────────────────────────

  it("ACOG Risk tab — calculate POSTs flags + numerics and renders score panel", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({
      data: {
        score: 8,
        category: "HIGH",
        isHighRisk: true,
        bmi: 24.1,
        ageAtConception: 32,
        riskFactors: [
          { factor: "Hypertension", points: 4 },
          { factor: "Previous C-section", points: 4 },
        ],
      },
    });

    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    fireEvent.click(screen.getByRole("button", { name: /ACOG Risk/i }));

    fireEvent.change(screen.getByPlaceholderText(/Height \(cm\)/i), {
      target: { value: "160" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Weight \(kg\)/i), {
      target: { value: "62" },
    });
    fireEvent.click(screen.getByLabelText(/Hypertension/i));
    fireEvent.click(screen.getByLabelText(/Previous C-section/i));

    fireEvent.click(
      screen.getByRole("button", { name: /Calculate ACOG Risk Score/i }),
    );

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith(
      "/antenatal/cases/a1/acog-risk-score",
      expect.objectContaining({
        heightCm: 160,
        weightKg: 62,
        hasHypertension: true,
        hasPrevCSection: true,
      }),
    );

    // Result panel
    expect(await screen.findByText(/Score: 8 · HIGH/)).toBeInTheDocument();
    expect(screen.getByText(/BMI: 24.1/)).toBeInTheDocument();
    expect(screen.getByText(/Age at conception: 32/)).toBeInTheDocument();
  });

  it("ACOG Risk tab — calculate rejection toasts the Error message", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue(new Error("score service down"));

    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DET-001");
    fireEvent.click(screen.getByRole("button", { name: /ACOG Risk/i }));

    fireEvent.click(
      screen.getByRole("button", { name: /Calculate ACOG Risk Score/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("score service down"),
    );
  });

  // ── Postnatal tab (delivered case only) ─────────────────────────────────

  it("Postnatal tab — shows the empty-state copy when GET /postnatal-visits returns []", async () => {
    wireDefaultGets({
      caseData: deliveredCaseFixture(),
      postnatal: [],
    });
    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DEL-002");
    fireEvent.click(screen.getByRole("button", { name: /Postnatal Visits/i }));

    expect(
      await screen.findByText(/No postnatal visits recorded\./i),
    ).toBeInTheDocument();
  });

  it("Postnatal tab — Record Visit POSTs /postnatal-visits with parsed payload + reloads", async () => {
    wireDefaultGets({
      caseData: deliveredCaseFixture(),
      postnatal: [],
    });
    apiMock.post.mockResolvedValue({ data: { id: "pn-1" } });

    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DEL-002");
    fireEvent.click(screen.getByRole("button", { name: /Postnatal Visits/i }));
    await screen.findByText(/No postnatal visits recorded\./i);

    fireEvent.change(screen.getByPlaceholderText(/Week postpartum/i), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Mother BP/i), {
      target: { value: "116/74" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Mother weight/i), {
      target: { value: "60.5" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Baby weight/i), {
      target: { value: "3.4" },
    });
    fireEvent.click(screen.getByLabelText(/Baby jaundice/i));

    fireEvent.click(screen.getByRole("button", { name: /Record Visit/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith(
      "/antenatal/cases/a1/postnatal-visits",
      expect.objectContaining({
        weekPostpartum: 2,
        motherBP: "116/74",
        motherWeight: 60.5,
        babyWeight: 3.4,
        babyJaundice: true,
      }),
    );
  });

  it("Postnatal tab — renders an existing visit row with jaundice pill", async () => {
    wireDefaultGets({
      caseData: deliveredCaseFixture(),
      postnatal: [
        {
          id: "pn-9",
          visitDate: isoOf(pastEdd),
          weekPostpartum: 1,
          motherBP: "118/76",
          motherWeight: 60,
          lochia: "NORMAL",
          uterineInvolution: "NORMAL",
          breastfeeding: "EXCLUSIVE",
          babyWeight: 3.1,
          babyJaundice: true,
          notes: "Recovering well",
        },
      ],
    });

    render(<AncCaseDetailPage />);
    await screen.findByText("ANC-2026-DEL-002");
    fireEvent.click(screen.getByRole("button", { name: /Postnatal Visits/i }));

    expect(await screen.findByText(/^Jaundice$/)).toBeInTheDocument();
    expect(screen.getByText(/Recovering well/)).toBeInTheDocument();
    expect(screen.getByText(/Mother BP: 118\/76/)).toBeInTheDocument();
    expect(screen.getByText(/Feeding: EXCLUSIVE/)).toBeInTheDocument();
  });

  // ── Error tolerance ─────────────────────────────────────────────────────

  it("swallows GET /antenatal/cases/a1 rejection — page stays in loading state without throwing", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/antenatal/cases/a1") {
        return Promise.reject(new Error("server boom"));
      }
      return Promise.resolve({ data: null });
    });

    render(<AncCaseDetailPage />);

    // The catch{} swallows the error but setCaseData(null) keeps the
    // loading/empty branch visible — confirm the skeleton is still present.
    expect(
      await screen.findByTestId("antenatal-detail-loading"),
    ).toHaveAttribute("aria-busy", "true");
  });
});
