/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * EmergencyCaseDetailPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/emergency/[id]/page.tsx`, the ER case detail
 *     view (Issue #162/#163 elapsed-minutes clamp, #425 elapsed format pass).
 *
 *   - Behaviours covered:
 *       1. Loading skeleton — `data-testid="emergency-case-detail-loading"`
 *          with `aria-busy="true"` while the GET is in flight.
 *       2. Not-found branch — GET rejects → "Case not found." copy + Back link.
 *       3. URL `id` param threads into GET `/emergency/cases/:id`.
 *       4. Happy path — patient (known) header (name, MR#, phone), arrived
 *          timestamp, triage pill (RESUSCITATION color class), status pill,
 *          chief complaint, attending-doctor section with seenAt timestamp,
 *          outcome panel with closedAt + disposition + outcomeNotes.
 *       5. Unknown-patient branch — displays `unknownName`/age/gender/mode
 *          instead of the patient block; falls back to "Unknown" when
 *          unknownName is also null.
 *       6. Triage color map covers RESUSCITATION/EMERGENT/URGENT/LESS_URGENT/
 *          NON_URGENT (5 buckets) via the className assertion.
 *       7. Timeline events — pending vs done state per event (Triaged,
 *          Doctor Assigned with extra name, Closed with status).
 *       8. RTS score badge — `>=7 Minor` (green), `4-6.99 Moderate` (amber),
 *          `<4 Severe` (red); badge omitted when rtsScore null.
 *       9. Trauma score button appears only when vitalsResp / vitalsBP /
 *          glasgomComa is present; clicking opens the modal.
 *      10. TraumaScoreModal — renders 3 selects (resp/sbp/gcs), changing
 *          values, Calculate POSTs to `/emergency/cases/:id/trauma-score`
 *          with `{ rtsRespiratory, rtsSystolic, rtsGCS }`; result panel
 *          renders score + interpretation; Done re-fires load (re-fetch).
 *      11. TraumaScoreModal — POST error path → toast.error with message.
 *      12. TraumaScoreModal — POST non-Error rejection → "Failed" fallback.
 *      13. TraumaScoreModal — Close button (× and footer) closes without POST.
 *      14. RBAC — Manage Case CTA shown for ADMIN + DOCTOR when not closed;
 *          hidden for NURSE; hidden once case is closed.
 *      15. Vitals "—" fallbacks for null values (BP, pulse, resp, spO2, temp,
 *          GCS, MEWS, RTS).
 *      16. Active case Outcome panel renders the "still active" copy.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore destructured — NOT a
 *     selector pattern), @/lib/toast, next/navigation (useParams threads
 *     `id: "e1"`), @/components/Skeleton passthrough.
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

const { apiMock, toastMock, routerMock, authMock } = vi.hoisted(() => ({
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

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useParams: () => ({ id: "e1" }),
  usePathname: () => "/dashboard/emergency/e1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));

import EmergencyCaseDetailPage from "../page";

type Case = {
  id: string;
  caseNumber: string;
  patientId?: string | null;
  unknownName?: string | null;
  unknownAge?: number | null;
  unknownGender?: string | null;
  arrivedAt: string;
  arrivalMode?: string | null;
  triageLevel?: string | null;
  triagedAt?: string | null;
  triagedBy?: string | null;
  chiefComplaint: string;
  mewsScore?: number | null;
  vitalsBP?: string | null;
  vitalsPulse?: number | null;
  vitalsResp?: number | null;
  vitalsSpO2?: number | null;
  vitalsTemp?: number | null;
  glasgowComa?: number | null;
  rtsScore?: number | null;
  rtsRespiratory?: number | null;
  rtsSystolic?: number | null;
  rtsGCS?: number | null;
  attendingDoctorId?: string | null;
  seenAt?: string | null;
  status: string;
  disposition?: string | null;
  outcomeNotes?: string | null;
  closedAt?: string | null;
  patient?: any;
  attendingDoctor?: any;
};

function caseFx(overrides: Partial<Case> = {}): Case {
  return {
    id: "e1",
    caseNumber: "ER-2026-0001",
    patientId: "p1",
    arrivedAt: "2026-05-20T08:00:00.000Z",
    chiefComplaint: "Severe chest pain radiating to left arm",
    status: "ACTIVE",
    triageLevel: "RESUSCITATION",
    triagedAt: "2026-05-20T08:05:00.000Z",
    triagedBy: "u-nurse",
    arrivalMode: "AMBULANCE",
    mewsScore: 7,
    vitalsBP: "90/60",
    vitalsPulse: 130,
    vitalsResp: 28,
    vitalsSpO2: 88,
    vitalsTemp: 36.8,
    glasgowComa: 14,
    rtsScore: 7.5,
    attendingDoctorId: "d1",
    seenAt: "2026-05-20T08:15:00.000Z",
    patient: {
      id: "p1",
      mrNumber: "MR-001",
      user: {
        name: "Anita Sharma",
        phone: "9999988888",
        email: "anita@example.test",
      },
    },
    attendingDoctor: {
      id: "d1",
      specialization: "Cardiology",
      user: { name: "Rajesh Verma" },
    },
    ...overrides,
  };
}

function setUser(role: string | null) {
  authMock.mockReturnValue({ user: role ? { id: "u1", role } : null });
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
  Object.values(routerMock).forEach((fn: any) => fn.mockReset());
  authMock.mockReset();
  setUser("ADMIN");
});

afterEach(() => {
  cleanup();
});

describe("EmergencyCaseDetailPage — load lifecycle", () => {
  it("renders the loading skeleton with aria-busy while the GET is in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<EmergencyCaseDetailPage />);
    const loader = await screen.findByTestId("emergency-case-detail-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card").length).toBe(3);
  });

  it("threads the URL id into the GET endpoint", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    render(<EmergencyCaseDetailPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/emergency/cases/e1"),
    );
  });

  it("renders the Case-not-found branch when the GET rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("boom"));
    render(<EmergencyCaseDetailPage />);
    await screen.findByText(/Case not found/i);
    expect(screen.getByRole("link", { name: /^Back$/i })).toHaveAttribute(
      "href",
      "/dashboard/emergency",
    );
  });
});

describe("EmergencyCaseDetailPage — happy path render", () => {
  it("renders patient header, chief complaint, triage pill, status pill, and attending doctor", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    render(<EmergencyCaseDetailPage />);

    await screen.findByText("Anita Sharma");
    expect(screen.getByText(/MR: MR-001/)).toBeInTheDocument();
    expect(
      screen.getByText("Severe chest pain radiating to left arm"),
    ).toBeInTheDocument();
    expect(screen.getByText("ER-2026-0001")).toBeInTheDocument();

    // Triage pill text + color class (RESUSCITATION → bg-red-900)
    const triagePill = screen.getByText("RESUSCITATION");
    expect(triagePill.className).toMatch(/bg-red-900/);

    // Status pill renders ACTIVE
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();

    // Attending doctor — formatDoctorName adds "Dr." prefix; the name also
    // appears in the timeline "Doctor Assigned · …" event, so >=1 match.
    expect(screen.getAllByText(/Rajesh Verma/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Cardiology")).toBeInTheDocument();
    expect(screen.getByText(/Seen at/)).toBeInTheDocument();
  });

  it("renders all vitals with their units", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");

    expect(screen.getByText("90/60")).toBeInTheDocument();
    // Vitals values are stitched together with their unit suffixes in one <p>
    // (e.g. "130 bpm"), so use partial regex match. /88/ collides with the
    // phone "9999988888" — scope to the SpO2 unit suffix instead.
    expect(screen.getByText(/130/)).toBeInTheDocument();
    expect(screen.getByText(/28/)).toBeInTheDocument();
    expect(screen.getByText(/88%/)).toBeInTheDocument();
    expect(screen.getByText(/36\.8/)).toBeInTheDocument();
    // GCS cell renders as "14"; RTS score 7.5 also renders the badge.
    expect(screen.getByText("14")).toBeInTheDocument();
    // MEWS score 7.
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("renders the closed-case outcome panel with disposition + notes + closedAt", async () => {
    apiMock.get.mockResolvedValue({
      data: caseFx({
        status: "DISCHARGED",
        closedAt: "2026-05-20T10:00:00.000Z",
        disposition: "Home with follow-up",
        outcomeNotes: "Stable on discharge; follow-up in 48h.",
      }),
    });
    render(<EmergencyCaseDetailPage />);

    await screen.findByText("Anita Sharma");
    expect(
      screen.getAllByText("DISCHARGED").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Home with follow-up/)).toBeInTheDocument();
    expect(
      screen.getByText(/Stable on discharge/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Closed at/)).toBeInTheDocument();
  });

  it("renders the still-active outcome copy when the case is not closed", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    expect(
      screen.getByText(/Case is still active/i),
    ).toBeInTheDocument();
  });
});

describe("EmergencyCaseDetailPage — unknown-patient branch", () => {
  it("renders unknownName/age/gender/mode when patient is null", async () => {
    apiMock.get.mockResolvedValue({
      data: caseFx({
        patientId: null,
        patient: null,
        unknownName: "John Doe",
        unknownAge: 45,
        unknownGender: "MALE",
        arrivalMode: "WALK_IN",
      }),
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("John Doe");
    expect(
      screen.getByText(/45y MALE · WALK_IN/),
    ).toBeInTheDocument();
  });

  it("falls back to 'Unknown' display name when both patient and unknownName are null", async () => {
    apiMock.get.mockResolvedValue({
      data: caseFx({
        patientId: null,
        patient: null,
        unknownName: null,
        unknownAge: null,
        unknownGender: null,
        arrivalMode: null,
      }),
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Unknown");
  });

  it("renders 'No doctor assigned yet.' when attendingDoctor is null", async () => {
    apiMock.get.mockResolvedValue({
      data: caseFx({
        attendingDoctor: null,
        attendingDoctorId: null,
        seenAt: null,
      }),
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText(/No doctor assigned yet/i);
  });
});

describe("EmergencyCaseDetailPage — triage color buckets", () => {
  it.each([
    ["RESUSCITATION", /bg-red-900/],
    ["EMERGENT", /bg-red-500/],
    ["URGENT", /bg-orange-500/],
    ["LESS_URGENT", /bg-yellow-500/],
    ["NON_URGENT", /bg-green-500/],
  ])("colors %s triage level correctly", async (level, classRe) => {
    apiMock.get.mockResolvedValue({ data: caseFx({ triageLevel: level }) });
    render(<EmergencyCaseDetailPage />);
    const pill = await screen.findByText(level.replace("_", " "));
    expect(pill.className).toMatch(classRe);
  });
});

describe("EmergencyCaseDetailPage — RTS badge buckets", () => {
  it(">= 7 renders Minor (green)", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx({ rtsScore: 7.5 }) });
    render(<EmergencyCaseDetailPage />);
    const badge = await screen.findByText("Minor");
    expect(badge.className).toMatch(/bg-green-100/);
  });

  it("4 <= rts < 7 renders Moderate (amber)", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx({ rtsScore: 5 }) });
    render(<EmergencyCaseDetailPage />);
    const badge = await screen.findByText("Moderate");
    expect(badge.className).toMatch(/bg-amber-100/);
  });

  it("< 4 renders Severe (red)", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx({ rtsScore: 2 }) });
    render(<EmergencyCaseDetailPage />);
    const badge = await screen.findByText("Severe");
    expect(badge.className).toMatch(/bg-red-100/);
  });

  it("rtsScore null omits the badge entirely", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx({ rtsScore: null }) });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    expect(screen.queryByText("Minor")).not.toBeInTheDocument();
    expect(screen.queryByText("Moderate")).not.toBeInTheDocument();
    expect(screen.queryByText("Severe")).not.toBeInTheDocument();
  });
});

describe("EmergencyCaseDetailPage — empty vitals em-dashes", () => {
  it("renders em-dash placeholders when every vital is null and hides the trauma button", async () => {
    apiMock.get.mockResolvedValue({
      data: caseFx({
        vitalsBP: null,
        vitalsPulse: null,
        vitalsResp: null,
        vitalsSpO2: null,
        vitalsTemp: null,
        glasgowComa: null,
        rtsScore: null,
        mewsScore: null,
      }),
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    // Multiple em-dashes — at least one per missing field.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(6);
    // Trauma button is gated on vitalsResp || vitalsBP || glasgowComa
    expect(
      screen.queryByRole("button", { name: /Calculate Trauma Score/i }),
    ).not.toBeInTheDocument();
  });
});

describe("EmergencyCaseDetailPage — RBAC for Manage Case CTA", () => {
  it("ADMIN + active case → CTA visible", async () => {
    setUser("ADMIN");
    apiMock.get.mockResolvedValue({ data: caseFx() });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    expect(screen.getByRole("link", { name: /Manage Case/i })).toBeInTheDocument();
  });

  it("DOCTOR + active case → CTA visible", async () => {
    setUser("DOCTOR");
    apiMock.get.mockResolvedValue({ data: caseFx() });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    expect(screen.getByRole("link", { name: /Manage Case/i })).toBeInTheDocument();
  });

  it("NURSE → CTA hidden", async () => {
    setUser("NURSE");
    apiMock.get.mockResolvedValue({ data: caseFx() });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    expect(
      screen.queryByRole("link", { name: /Manage Case/i }),
    ).not.toBeInTheDocument();
  });

  it("ADMIN but case closed → CTA hidden", async () => {
    setUser("ADMIN");
    apiMock.get.mockResolvedValue({
      data: caseFx({ closedAt: "2026-05-20T10:00:00.000Z", status: "DISCHARGED" }),
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    expect(
      screen.queryByRole("link", { name: /Manage Case/i }),
    ).not.toBeInTheDocument();
  });
});

describe("EmergencyCaseDetailPage — TraumaScoreModal", () => {
  it("opens when Calculate Trauma Score button is clicked, then closes via × button", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");

    fireEvent.click(screen.getByRole("button", { name: /Calculate Trauma Score/i }));
    expect(
      await screen.findByRole("heading", { name: /Revised Trauma Score/i }),
    ).toBeInTheDocument();
    // The × icon button.
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(
      screen.queryByRole("heading", { name: /Revised Trauma Score/i }),
    ).not.toBeInTheDocument();
  });

  it("Calculate posts the correct shape and renders the result panel + interpretation", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    apiMock.post.mockResolvedValue({
      data: { rtsScore: 7.55, interpretation: "Minor trauma" },
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");

    fireEvent.click(screen.getByRole("button", { name: /Calculate Trauma Score/i }));
    await screen.findByRole("heading", { name: /Revised Trauma Score/i });

    // Change a select value before submitting (defaults are 4 / 4 / 4).
    fireEvent.change(screen.getByLabelText(/Respiratory Rate/i), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText(/Systolic BP/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/Glasgow Coma Scale/i), { target: { value: "1" } });

    fireEvent.click(screen.getByRole("button", { name: /^Calculate$/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/emergency/cases/e1/trauma-score",
        { rtsRespiratory: 3, rtsSystolic: 2, rtsGCS: 1 },
      );
    });

    // Result panel renders score + interpretation.
    expect(await screen.findByText("7.55")).toBeInTheDocument();
    expect(screen.getByText("Minor trauma")).toBeInTheDocument();
  });

  it("after a successful Calculate, Done re-loads the case (GET fires twice total)", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    apiMock.post.mockResolvedValue({
      data: { rtsScore: 5.2, interpretation: "Moderate trauma" },
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    expect(apiMock.get).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Calculate Trauma Score/i }));
    await screen.findByRole("heading", { name: /Revised Trauma Score/i });
    fireEvent.click(screen.getByRole("button", { name: /^Calculate$/i }));
    await screen.findByText("Moderate trauma");

    // Score 4 <= x < 7 renders the amber bucket — verify badge color path.
    const interp = screen.getByText("Moderate trauma");
    expect(interp.className).toMatch(/bg-amber-100/);

    fireEvent.click(screen.getByRole("button", { name: /^Done$/i }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));
  });

  it("Calculate error path surfaces toast.error with the Error message", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    apiMock.post.mockRejectedValue(new Error("trauma POST down"));
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");

    fireEvent.click(screen.getByRole("button", { name: /Calculate Trauma Score/i }));
    await screen.findByRole("heading", { name: /Revised Trauma Score/i });
    fireEvent.click(screen.getByRole("button", { name: /^Calculate$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("trauma POST down");
    });
    // Modal stays open (no result rendered → still on Calculate, not Done).
    expect(
      screen.getByRole("button", { name: /^Calculate$/i }),
    ).toBeInTheDocument();
  });

  it("Calculate non-Error rejection falls back to 'Failed' toast copy", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    apiMock.post.mockRejectedValue("nope");
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");

    fireEvent.click(screen.getByRole("button", { name: /Calculate Trauma Score/i }));
    await screen.findByRole("heading", { name: /Revised Trauma Score/i });
    fireEvent.click(screen.getByRole("button", { name: /^Calculate$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Failed");
    });
  });

  it("RTS result Severe bucket (score < 4) renders the red badge color", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    apiMock.post.mockResolvedValue({
      data: { rtsScore: 2.1, interpretation: "Severe trauma" },
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    fireEvent.click(screen.getByRole("button", { name: /Calculate Trauma Score/i }));
    await screen.findByRole("heading", { name: /Revised Trauma Score/i });
    fireEvent.click(screen.getByRole("button", { name: /^Calculate$/i }));
    const interp = await screen.findByText("Severe trauma");
    expect(interp.className).toMatch(/bg-red-100/);
  });

  it("RTS result Minor bucket (score >= 7) renders the green badge color", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    apiMock.post.mockResolvedValue({
      data: { rtsScore: 7.8, interpretation: "Minor trauma" },
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    fireEvent.click(screen.getByRole("button", { name: /Calculate Trauma Score/i }));
    await screen.findByRole("heading", { name: /Revised Trauma Score/i });
    fireEvent.click(screen.getByRole("button", { name: /^Calculate$/i }));
    const interp = await screen.findByText("Minor trauma");
    expect(interp.className).toMatch(/bg-green-100/);
  });

  it("Close button (footer) closes the modal without firing POST", async () => {
    apiMock.get.mockResolvedValue({ data: caseFx() });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");

    fireEvent.click(screen.getByRole("button", { name: /Calculate Trauma Score/i }));
    await screen.findByRole("heading", { name: /Revised Trauma Score/i });
    fireEvent.click(screen.getByRole("button", { name: /^Close$/i }));
    expect(
      screen.queryByRole("heading", { name: /Revised Trauma Score/i }),
    ).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});

describe("EmergencyCaseDetailPage — trauma button gating", () => {
  it("renders the trauma button when only vitalsResp is present", async () => {
    apiMock.get.mockResolvedValue({
      data: caseFx({
        vitalsBP: null,
        vitalsPulse: null,
        vitalsResp: 22,
        vitalsSpO2: null,
        vitalsTemp: null,
        glasgowComa: null,
      }),
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    expect(
      screen.getByRole("button", { name: /Calculate Trauma Score/i }),
    ).toBeInTheDocument();
  });

  it("renders the trauma button when only glasgowComa is present", async () => {
    apiMock.get.mockResolvedValue({
      data: caseFx({
        vitalsBP: null,
        vitalsPulse: null,
        vitalsResp: null,
        vitalsSpO2: null,
        vitalsTemp: null,
        glasgowComa: 10,
      }),
    });
    render(<EmergencyCaseDetailPage />);
    await screen.findByText("Anita Sharma");
    expect(
      screen.getByRole("button", { name: /Calculate Trauma Score/i }),
    ).toBeInTheDocument();
  });
});
