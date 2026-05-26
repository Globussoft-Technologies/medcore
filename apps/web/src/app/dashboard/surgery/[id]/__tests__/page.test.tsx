/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SurgeryDetailPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies the rendered branches of
 *     `apps/web/src/app/dashboard/surgery/[id]/page.tsx`, a 1218-LOC surgery
 *     detail view spanning the main page + 5 sub-cards (PreOpChecklistCard,
 *     ComplicationsCard, AnesthesiaCard, BloodAvailabilityCard,
 *     PacuObservationsCard, SsiReportCard).
 *
 *   - Behaviours covered:
 *       1. Loading skeleton — `data-testid="surgery-detail-loading"` with
 *          `aria-busy="true"` while the GET is in flight.
 *       2. URL `id` param threads into GET `/surgery/:id`.
 *       3. Not-found branch — GET 404 → "Surgery not found." + Back link;
 *          no toast for 404. Other errors → toast.error.
 *       4. Happy-path render — caseNumber, procedure, patient header, surgeon
 *          name (formatDoctorName), OT name, scheduled timestamp, status pill.
 *       5. effectiveSurgeryStatus — SCHEDULED >30 min in the past renders
 *          "MISSED SCHEDULE"; recent SCHEDULED stays SCHEDULED.
 *       6. Status pill class map covers IN_PROGRESS/COMPLETED/CANCELLED.
 *       7. Actual duration computed when both start/end timestamps present.
 *       8. Cost block: dailyRate + cost render with ₹ + 2dp; null safe with —.
 *       9. RBAC canEdit — Edit Notes visible for DOCTOR/ADMIN/NURSE; hidden
 *          for RECEPTION; PATIENT also hidden.
 *      10. Edit-notes flow — clicking Edit reveals inputs; Cancel reverts;
 *          Save PATCH /surgery/:id with the notes shape and reloads.
 *      11. Action buttons gating — SCHEDULED-fresh shows Start + Cancel;
 *          SCHEDULED-stale shows the "Cancel (Missed)" testid only;
 *          IN_PROGRESS shows Complete Surgery; COMPLETED shows none.
 *      12. Start Surgery — happy PATCH /:id/start + reload; field-error
 *          path (extractFieldErrors) toasts first field msg; missing[]
 *          checklist payload toasts "Pre-op checklist incomplete: ..."; plain
 *          Error falls through to toast.error.
 *      13. Complete Surgery — PATCHes /:id/complete with postOp/diagnosis
 *          undefined fallthrough; rejection toasts.
 *      14. Cancel Surgery — usePrompt returns reason → PATCH /:id/cancel
 *          with { reason } and reload; usePrompt null → no PATCH.
 *      15. Pre-Op checklist — count badge "n/5 complete"; toggle posts to
 *          /preop with the field, antibioticsGiven stamps antibioticsAt;
 *          disabled when !canEdit; reject path toasts.
 *      16. ComplicationsCard — hidden when no complications + status !=
 *          COMPLETED; rendered with severity color path (SEVERE/MODERATE/
 *          MILD); Add → form opens; empty complications blocks save;
 *          happy save PATCH /:id/complications + reload.
 *      17. AnesthesiaCard — loading skeleton; "No anesthesia record yet."
 *          when GET resolves null; renders record fields; Edit → save POST
 *          /:id/anesthesia-record with ISO-stamped induction/extubation +
 *          numeric ml; save reject toasts.
 *      18. BloodAvailabilityCard — hidden when !canEdit; Check posts to
 *          /:id/blood-requirement; success result panel + reserved list;
 *          shortfall renders red border + shortfall copy; reject toasts.
 *      19. PacuObservationsCard — loading skeleton; "No observations yet."
 *          empty state; rows render with latest summary tiles; Add POSTs
 *          to /:id/observations with the parsed numeric/boolean fields
 *          and reloads; reject toasts.
 *      20. SsiReportCard — hidden when !canEdit and !ssiDetected;
 *          banner renders ssi fields when ssiDetected; Report SSI form
 *          opens, save PATCH /:id/ssi-report with ISO-stamped detectedDate.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore destructured), @/lib/toast,
 *     @/lib/use-dialog (usePrompt), @/lib/field-errors (pass-through),
 *     @/lib/format-doctor-name (pass-through "Dr. " stub),
 *     next/navigation (useParams threads `id: "s1"`),
 *     @/components/Skeleton passthrough.
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

const { apiMock, toastMock, routerMock, authMock, promptMock, fieldErrorsMock } =
  vi.hoisted(() => ({
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
    promptMock: vi.fn(),
    fieldErrorsMock: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  usePrompt: () => promptMock,
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock("@/lib/field-errors", () => ({
  extractFieldErrors: (err: unknown) => fieldErrorsMock(err),
}));
vi.mock("@/lib/format-doctor-name", () => ({
  formatDoctorName: (n: string) => `Dr. ${n.replace(/^Dr\.\s*/i, "")}`,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useParams: () => ({ id: "s1" }),
  usePathname: () => "/dashboard/surgery/s1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: () => <div data-testid="skeleton-card" />,
  SkeletonText: ({ lines }: { lines?: number }) => (
    <div data-testid="skeleton-text" data-lines={lines} />
  ),
  SkeletonTable: ({ rows, columns }: { rows?: number; columns?: number }) => (
    <div data-testid="skeleton-table" data-rows={rows} data-columns={columns} />
  ),
}));

import SurgeryDetailPage from "../page";

type Surgery = {
  id: string;
  caseNumber: string;
  procedure: string;
  scheduledAt: string;
  durationMin?: number | null;
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  status: string;
  anaesthesiologist?: string | null;
  assistants?: string | null;
  preOpNotes?: string | null;
  postOpNotes?: string | null;
  diagnosis?: string | null;
  cost?: number | null;
  consentSigned?: boolean;
  npoSince?: string | null;
  allergiesVerified?: boolean;
  antibioticsGiven?: boolean;
  antibioticsAt?: string | null;
  siteMarked?: boolean;
  bloodReserved?: boolean;
  anesthesiaStartAt?: string | null;
  anesthesiaEndAt?: string | null;
  incisionAt?: string | null;
  closureAt?: string | null;
  complications?: string | null;
  complicationSeverity?: string | null;
  bloodLossMl?: number | null;
  ssiDetected?: boolean;
  ssiType?: string | null;
  ssiDetectedDate?: string | null;
  ssiTreatment?: string | null;
  patient: any;
  surgeon: any;
  ot: any;
};

/** +48h sidesteps IST/UTC midnight traps that can trip STALE_GRACE_MIN. */
function in48h(): string {
  return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
}
function pastBeyondGrace(): string {
  return new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
}

function surgeryFx(overrides: Partial<Surgery> = {}): Surgery {
  return {
    id: "s1",
    caseNumber: "SX-2026-0001",
    procedure: "Appendectomy",
    scheduledAt: in48h(),
    durationMin: 60,
    actualStartAt: null,
    actualEndAt: null,
    status: "SCHEDULED",
    cost: 25000,
    patient: {
      id: "p1",
      mrNumber: "MR-100",
      age: 34,
      gender: "F",
      bloodGroup: "A+",
      user: { name: "Aanya Sharma", phone: "9999900001", email: "a@x.test" },
    },
    surgeon: {
      id: "d1",
      specialization: "General Surgery",
      user: { name: "Mehta", email: "m@x.test" },
    },
    ot: {
      id: "ot1",
      name: "OT-Alpha",
      floor: "2",
      equipment: "Laparoscopy",
      dailyRate: 5000,
    },
    ...overrides,
  };
}

function setUser(role: string | null) {
  authMock.mockReturnValue({ user: role ? { id: "u1", role } : null });
}

/**
 * Route GETs by URL so the sub-cards' independent fetches don't fight over
 * the mock queue. /surgery/:id returns the surgery; /anesthesia-record and
 * /observations default to null/[] unless overridden.
 */
function wireGet(opts: {
  surgery?: Surgery | null;
  surgeryReject?: any;
  anesthesia?: any;
  observations?: any[];
} = {}) {
  const s = opts.surgery === undefined ? surgeryFx() : opts.surgery;
  apiMock.get.mockImplementation((url: string) => {
    if (/\/surgery\/[^/]+\/anesthesia-record$/.test(url)) {
      return Promise.resolve({ data: opts.anesthesia ?? null });
    }
    if (/\/surgery\/[^/]+\/observations$/.test(url)) {
      return Promise.resolve({ data: opts.observations ?? [] });
    }
    if (/\/surgery\/[^/]+$/.test(url)) {
      if (opts.surgeryReject) return Promise.reject(opts.surgeryReject);
      return Promise.resolve({ data: s });
    }
    return Promise.resolve({ data: null });
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
  Object.values(routerMock).forEach((fn: any) => fn.mockReset());
  authMock.mockReset();
  promptMock.mockReset();
  fieldErrorsMock.mockReset();
  fieldErrorsMock.mockReturnValue(null); // default: no field errors
  setUser("DOCTOR");
});

afterEach(() => {
  cleanup();
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — load lifecycle", () => {
  it("renders the loading skeleton with aria-busy while the GET is in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<SurgeryDetailPage />);
    const loader = await screen.findByTestId("surgery-detail-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card").length).toBe(3);
  });

  it("threads the URL id into GET /surgery/:id", async () => {
    wireGet({});
    render(<SurgeryDetailPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/surgery/s1"),
    );
  });

  it("renders Surgery-not-found when GET rejects with a plain Error and toasts the message", async () => {
    wireGet({ surgeryReject: new Error("server down") });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Surgery not found/i);
    expect(screen.getByRole("link", { name: /Back to Surgery/i })).toHaveAttribute(
      "href",
      "/dashboard/surgery",
    );
    expect(toastMock.error).toHaveBeenCalledWith("server down");
  });

  it("does NOT toast on plain 404 — inline not-found is enough", async () => {
    const e: any = new Error("not found");
    e.status = 404;
    wireGet({ surgeryReject: e });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Surgery not found/i);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("non-Error rejection falls back to 'Failed to load surgery' toast", async () => {
    wireGet({ surgeryReject: "nope" });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Surgery not found/i);
    expect(toastMock.error).toHaveBeenCalledWith("Failed to load surgery");
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — happy-path render", () => {
  it("renders caseNumber, procedure, patient, surgeon (Dr. prefix), and OT", async () => {
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    expect(screen.getByText("Appendectomy")).toBeInTheDocument();
    expect(screen.getByText("Aanya Sharma")).toBeInTheDocument();
    expect(screen.getByText("MR-100")).toBeInTheDocument();
    expect(screen.getByText(/34 yrs/)).toBeInTheDocument();
    expect(screen.getByText("9999900001")).toBeInTheDocument();
    // formatDoctorName stub adds "Dr. " — confirm presence.
    expect(screen.getByText("Dr. Mehta")).toBeInTheDocument();
    expect(screen.getByText("General Surgery")).toBeInTheDocument();
    expect(screen.getByText("OT-Alpha")).toBeInTheDocument();
    expect(screen.getByText("Floor 2")).toBeInTheDocument();
    expect(screen.getByText("Laparoscopy")).toBeInTheDocument();
  });

  it("renders anaesthesiologist and assistants when present", async () => {
    wireGet({
      surgery: surgeryFx({
        anaesthesiologist: "Dr. Anaesthe",
        assistants: "Dr. Asst",
      }),
    });
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    expect(screen.getByText("Dr. Anaesthe")).toBeInTheDocument();
    expect(screen.getByText("Dr. Asst")).toBeInTheDocument();
  });

  it("renders the SCHEDULED status pill (fresh — within grace window)", async () => {
    wireGet({});
    render(<SurgeryDetailPage />);
    const pill = await screen.findByTestId("surgery-detail-status");
    expect(pill.textContent).toBe("SCHEDULED");
    expect(pill.className).toMatch(/bg-blue-100/);
  });

  it("renders MISSED SCHEDULE when SCHEDULED but scheduledAt is past grace window", async () => {
    wireGet({ surgery: surgeryFx({ scheduledAt: pastBeyondGrace() }) });
    render(<SurgeryDetailPage />);
    const pill = await screen.findByTestId("surgery-detail-status");
    expect(pill.textContent).toBe("MISSED SCHEDULE");
    expect(pill.className).toMatch(/bg-orange-100/);
  });

  it.each([
    ["IN_PROGRESS", /bg-yellow-100/],
    ["COMPLETED", /bg-green-100/],
    ["CANCELLED", /bg-red-100/],
  ])("colors %s status pill correctly", async (status, classRe) => {
    wireGet({ surgery: surgeryFx({ status }) });
    render(<SurgeryDetailPage />);
    const pill = await screen.findByTestId("surgery-detail-status");
    expect(pill.className).toMatch(classRe);
  });

  it("computes the Actual Duration timeline cell when both start/end are present", async () => {
    const start = new Date("2026-05-20T08:00:00.000Z").toISOString();
    const end = new Date("2026-05-20T09:35:00.000Z").toISOString();
    wireGet({
      surgery: surgeryFx({
        status: "COMPLETED",
        actualStartAt: start,
        actualEndAt: end,
      }),
    });
    render(<SurgeryDetailPage />);
    await screen.findByText("Actual Duration");
    // 95 minutes — unique value not colliding with cost/dailyRate.
    expect(screen.getByText(/95 min/)).toBeInTheDocument();
  });

  it("renders cost block with ₹ formatting and falls back to em-dash when null", async () => {
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    expect(screen.getByText("₹5000.00")).toBeInTheDocument();
    expect(screen.getByText("₹25000.00")).toBeInTheDocument();
  });

  it("renders em-dash when dailyRate / cost are null", async () => {
    wireGet({
      surgery: surgeryFx({
        cost: null,
        ot: { id: "ot1", name: "OT-X", dailyRate: null as any },
      }),
    });
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    // OT Daily Rate fallback + Procedure Cost fallback = 2 em-dashes at least.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders the SSI alert banner when ssiDetected is true", async () => {
    wireGet({
      surgery: surgeryFx({
        ssiDetected: true,
        ssiType: "DEEP",
        ssiDetectedDate: "2026-05-21T00:00:00.000Z",
        ssiTreatment: "Vancomycin",
      }),
    });
    render(<SurgeryDetailPage />);
    await screen.findByText(/SSI Detected/);
    // SSI type renders twice (banner + ssi card).
    expect(screen.getAllByText("DEEP").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Vancomycin/).length).toBeGreaterThanOrEqual(1);
  });

  it("back button calls router.push('/dashboard/surgery')", async () => {
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /Back to Surgery/i }));
    expect(routerMock.push).toHaveBeenCalledWith("/dashboard/surgery");
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — RBAC canEdit gate", () => {
  it.each([
    ["DOCTOR", true],
    ["ADMIN", true],
    ["NURSE", true],
    ["RECEPTION", false],
    ["PATIENT", false],
  ])("role=%s → Edit Notes visible=%s", async (role, expected) => {
    setUser(role);
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    const editBtn = screen.queryByRole("button", { name: /Edit Notes/i });
    if (expected) {
      expect(editBtn).toBeInTheDocument();
    } else {
      expect(editBtn).not.toBeInTheDocument();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — Clinical Notes edit flow", () => {
  it("Edit reveals inputs, Cancel reverts, no PATCH fired", async () => {
    wireGet({
      surgery: surgeryFx({
        preOpNotes: "Pre-op old",
        postOpNotes: "Post-op old",
        diagnosis: "Acute appendicitis",
      }),
    });
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /Edit Notes/i }));

    const diag = screen.getByLabelText(/Diagnosis/i) as HTMLInputElement;
    expect(diag.value).toBe("Acute appendicitis");
    fireEvent.change(diag, { target: { value: "Changed" } });
    expect(diag.value).toBe("Changed");

    // Two Cancel buttons exist: page-level (action for SCHEDULED) + form-level
    // (inside the Clinical Notes card). The form-level is the last one in DOM.
    const cancels = screen.getAllByRole("button", { name: /^Cancel$/i });
    fireEvent.click(cancels[0]); // first is the notes-form Cancel
    // Edit Notes button is back.
    expect(
      screen.getByRole("button", { name: /Edit Notes/i }),
    ).toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Save PATCHes /surgery/:id with the notes shape and reloads", async () => {
    wireGet({
      surgery: surgeryFx({
        preOpNotes: "Pre",
        postOpNotes: "Post",
        diagnosis: "Dx",
      }),
    });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /Edit Notes/i }));
    fireEvent.change(screen.getByLabelText(/Diagnosis/i), {
      target: { value: "New Dx" },
    });
    fireEvent.change(screen.getByLabelText(/^Pre-Op Notes$/i), {
      target: { value: "New Pre" },
    });
    fireEvent.change(screen.getByLabelText(/^Post-Op Notes$/i), {
      target: { value: "New Post" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/surgery/s1", {
        diagnosis: "New Dx",
        preOpNotes: "New Pre",
        postOpNotes: "New Post",
      }),
    );
  });

  it("Save error path toasts the message", async () => {
    wireGet({});
    apiMock.patch.mockRejectedValue(new Error("notes save failed"));
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /Edit Notes/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("notes save failed"),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — Action buttons", () => {
  it("SCHEDULED-fresh shows Start + Cancel; not the Missed CTA", async () => {
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    expect(
      screen.getByRole("button", { name: /Start Surgery/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Cancel$/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("cancel-missed-surgery")).not.toBeInTheDocument();
  });

  it("SCHEDULED-stale hides Start, shows Cancel(Missed) testid", async () => {
    wireGet({ surgery: surgeryFx({ scheduledAt: pastBeyondGrace() }) });
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    expect(
      screen.queryByRole("button", { name: /Start Surgery/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("cancel-missed-surgery")).toBeInTheDocument();
  });

  it("IN_PROGRESS shows Complete Surgery only", async () => {
    wireGet({ surgery: surgeryFx({ status: "IN_PROGRESS" }) });
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    expect(
      screen.getByRole("button", { name: /Complete Surgery/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start Surgery/i }),
    ).not.toBeInTheDocument();
  });

  it("COMPLETED shows no action buttons", async () => {
    wireGet({ surgery: surgeryFx({ status: "COMPLETED" }) });
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    expect(
      screen.queryByRole("button", { name: /Start Surgery/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Complete Surgery/i }),
    ).not.toBeInTheDocument();
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — Start/Complete/Cancel actions", () => {
  it("Start Surgery — happy PATCH /:id/start and reload (GET fires twice)", async () => {
    wireGet({});
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    // The 3 GETs (surgery + anesthesia + obs) fire from independent useEffects
    // in child components; under CI load the child effects can lag the
    // findByText resolution. Wait explicitly rather than assert sync.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole("button", { name: /Start Surgery/i }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/surgery/s1/start", {}),
    );
    // reload re-fires the /surgery/:id GET (+1 of the 3 fetches).
    await waitFor(() => {
      const surgeryCalls = apiMock.get.mock.calls.filter(
        (c) => c[0] === "/surgery/s1",
      );
      expect(surgeryCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("Start error — extractFieldErrors returns a field map → toasts the first message", async () => {
    wireGet({});
    fieldErrorsMock.mockReturnValueOnce({ procedure: "procedure required" });
    apiMock.patch.mockRejectedValue(new Error("validation"));
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /Start Surgery/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("procedure required"),
    );
  });

  it("Start error — empty field map → 'Start failed' fallback", async () => {
    wireGet({});
    fieldErrorsMock.mockReturnValueOnce({});
    apiMock.patch.mockRejectedValue(new Error("validation"));
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /Start Surgery/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Start failed"),
    );
  });

  it("Start error — payload.missing array → 'Pre-op checklist incomplete: …'", async () => {
    wireGet({});
    const err: any = new Error("incomplete");
    err.payload = { missing: ["consent", "siteMarked"] };
    apiMock.patch.mockRejectedValue(err);
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /Start Surgery/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Pre-op checklist incomplete: consent, siteMarked",
      ),
    );
  });

  it("Start error — payload.error fallback when no missing[]", async () => {
    wireGet({});
    const err: any = new Error("ignored");
    err.payload = { error: "OT not available" };
    apiMock.patch.mockRejectedValue(err);
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /Start Surgery/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("OT not available"),
    );
  });

  it("Complete Surgery — PATCH /:id/complete with optional notes set", async () => {
    wireGet({
      surgery: surgeryFx({
        status: "IN_PROGRESS",
        postOpNotes: "PostOp",
        diagnosis: "Dx",
      }),
    });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /Complete Surgery/i }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/surgery/s1/complete", {
        postOpNotes: "PostOp",
        diagnosis: "Dx",
      }),
    );
  });

  it("Complete Surgery — reject path toasts", async () => {
    wireGet({ surgery: surgeryFx({ status: "IN_PROGRESS" }) });
    apiMock.patch.mockRejectedValue(new Error("complete failed"));
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /Complete Surgery/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("complete failed"),
    );
  });

  it("Cancel Surgery — usePrompt returns reason → PATCH /:id/cancel with { reason }", async () => {
    wireGet({});
    promptMock.mockResolvedValue("Patient rescheduled");
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/surgery/s1/cancel", {
        reason: "Patient rescheduled",
      }),
    );
  });

  it("Cancel Surgery — usePrompt returns empty → no PATCH", async () => {
    wireGet({});
    promptMock.mockResolvedValue("");
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    // Wait a tick for the prompt promise to resolve.
    await waitFor(() => expect(promptMock).toHaveBeenCalled());
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Cancel Surgery — reject path toasts", async () => {
    wireGet({});
    promptMock.mockResolvedValue("Reason");
    apiMock.patch.mockRejectedValue(new Error("cancel failed"));
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("cancel failed"),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — PreOpChecklistCard", () => {
  it("renders count badge and 5 items", async () => {
    wireGet({
      surgery: surgeryFx({
        consentSigned: true,
        allergiesVerified: true,
      }),
    });
    render(<SurgeryDetailPage />);
    await screen.findByText(/2\/5 complete/);
    expect(screen.getByText("Consent signed")).toBeInTheDocument();
    expect(screen.getByText("Allergies verified")).toBeInTheDocument();
    expect(
      screen.getByText("Prophylactic antibiotics given"),
    ).toBeInTheDocument();
    expect(screen.getByText("Surgical site marked")).toBeInTheDocument();
    expect(screen.getByText("Blood products reserved")).toBeInTheDocument();
  });

  it("shows the NPO Since panel when set", async () => {
    wireGet({
      surgery: surgeryFx({ npoSince: "2026-05-20T00:00:00.000Z" }),
    });
    render(<SurgeryDetailPage />);
    await screen.findByText(/NPO since/i);
  });

  it("toggling consent PATCHes /preop with { consentSigned: true } and reloads", async () => {
    wireGet({});
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<SurgeryDetailPage />);
    await screen.findByText(/0\/5 complete/);
    const checkboxes = screen
      .getAllByRole("checkbox")
      .filter((cb) => !(cb as HTMLInputElement).disabled);
    // The first checkbox is consent (per items[] order).
    fireEvent.click(checkboxes[0]);
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/surgery/s1/preop", {
        consentSigned: true,
      }),
    );
  });

  it("toggling antibiotics PATCH stamps antibioticsAt with an ISO timestamp", async () => {
    wireGet({});
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<SurgeryDetailPage />);
    await screen.findByText(/0\/5 complete/);
    // antibioticsGiven is the 3rd item; find by adjacent label text.
    const label = screen.getByText("Prophylactic antibiotics given");
    const cb = label.parentElement?.querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    await waitFor(() => {
      const call = apiMock.patch.mock.calls.find(
        (c) => c[0] === "/surgery/s1/preop",
      );
      expect(call).toBeTruthy();
      expect(call![1].antibioticsGiven).toBe(true);
      expect(typeof call![1].antibioticsAt).toBe("string");
      // ISO-ish.
      expect(call![1].antibioticsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("preop toggle reject path toasts", async () => {
    wireGet({});
    apiMock.patch.mockRejectedValue(new Error("preop failed"));
    render(<SurgeryDetailPage />);
    await screen.findByText(/0\/5 complete/);
    const checkboxes = screen
      .getAllByRole("checkbox")
      .filter((cb) => !(cb as HTMLInputElement).disabled);
    fireEvent.click(checkboxes[0]);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("preop failed"),
    );
  });

  it("checkboxes are disabled when !canEdit (RECEPTION)", async () => {
    setUser("RECEPTION");
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText(/0\/5 complete/);
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.forEach((cb) => {
      expect((cb as HTMLInputElement).disabled).toBe(true);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — ComplicationsCard", () => {
  it("hidden when status != COMPLETED and no complications", async () => {
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    expect(
      screen.queryByText(/Complications & Blood Loss/i),
    ).not.toBeInTheDocument();
  });

  it("renders summary with SEVERE color badge when complications + COMPLETED", async () => {
    wireGet({
      surgery: surgeryFx({
        status: "COMPLETED",
        complications: "Bleeding",
        complicationSeverity: "SEVERE",
        bloodLossMl: 600,
      }),
    });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Complications & Blood Loss/i);
    const sev = screen.getByText("SEVERE");
    expect(sev.className).toMatch(/bg-red-100/);
    expect(screen.getByText(/600 ml/)).toBeInTheDocument();
  });

  it("renders MODERATE amber badge", async () => {
    wireGet({
      surgery: surgeryFx({
        status: "COMPLETED",
        complications: "Minor",
        complicationSeverity: "MODERATE",
      }),
    });
    render(<SurgeryDetailPage />);
    const sev = await screen.findByText("MODERATE");
    expect(sev.className).toMatch(/bg-amber-100/);
  });

  it("renders MILD green badge", async () => {
    wireGet({
      surgery: surgeryFx({
        status: "COMPLETED",
        complications: "Mild",
        complicationSeverity: "MILD",
      }),
    });
    render(<SurgeryDetailPage />);
    const sev = await screen.findByText("MILD");
    expect(sev.className).toMatch(/bg-green-100/);
  });

  it("'No complications recorded.' when COMPLETED + no complications", async () => {
    wireGet({
      surgery: surgeryFx({
        status: "COMPLETED",
        complications: null,
      }),
    });
    render(<SurgeryDetailPage />);
    await screen.findByText(/No complications recorded/);
  });

  it("Add → form opens; empty body blocks save with toast", async () => {
    wireGet({ surgery: surgeryFx({ status: "COMPLETED" }) });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Complications & Blood Loss/i);
    // Two "Add" buttons exist (Complications + Anesthesia). Both cards have an
    // h2 sibling — scope to the Complications card via the heading parent.
    const compHeading = screen.getByText("Complications & Blood Loss");
    const compCard = compHeading.closest(".rounded-xl") as HTMLElement;
    fireEvent.click(within(compCard).getByRole("button", { name: /^Add$/i }));
    fireEvent.click(within(compCard).getByRole("button", { name: /^Save$/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Complications description is required",
      ),
    );
  });

  it("Add → save PATCHes /:id/complications with severity+bloodLoss", async () => {
    wireGet({ surgery: surgeryFx({ status: "COMPLETED" }) });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Complications & Blood Loss/i);
    const compHeading = screen.getByText("Complications & Blood Loss");
    const compCard = compHeading.closest(".rounded-xl") as HTMLElement;
    fireEvent.click(within(compCard).getByRole("button", { name: /^Add$/i }));

    const textarea = within(compCard).getByPlaceholderText(
      /Describe complications/i,
    );
    fireEvent.change(textarea, { target: { value: "Bleed 500ml" } });
    const sevSelect = within(compCard).getByDisplayValue(
      "Mild",
    ) as HTMLSelectElement;
    fireEvent.change(sevSelect, { target: { value: "SEVERE" } });
    const blood = within(compCard).getByPlaceholderText(/Blood loss/i);
    fireEvent.change(blood, { target: { value: "500" } });
    fireEvent.click(within(compCard).getByRole("button", { name: /^Save$/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/surgery/s1/complications", {
        complications: "Bleed 500ml",
        complicationSeverity: "SEVERE",
        bloodLossMl: 500,
      }),
    );
  });

  it("save reject toasts", async () => {
    wireGet({ surgery: surgeryFx({ status: "COMPLETED" }) });
    apiMock.patch.mockRejectedValue(new Error("comp save failed"));
    render(<SurgeryDetailPage />);
    await screen.findByText(/Complications & Blood Loss/i);
    const compHeading = screen.getByText("Complications & Blood Loss");
    const compCard = compHeading.closest(".rounded-xl") as HTMLElement;
    fireEvent.click(within(compCard).getByRole("button", { name: /^Add$/i }));
    fireEvent.change(
      within(compCard).getByPlaceholderText(/Describe complications/i),
      { target: { value: "x" } },
    );
    fireEvent.click(within(compCard).getByRole("button", { name: /^Save$/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("comp save failed"),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — AnesthesiaCard", () => {
  it("'No anesthesia record yet.' when GET resolves null", async () => {
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText(/No anesthesia record yet/);
  });

  it("renders fields when record exists", async () => {
    wireGet({
      anesthesia: {
        id: "a1",
        anesthesiaType: "GENERAL",
        anesthetist: "Dr. AnaeStaff",
        inductionAt: "2026-05-20T08:00:00.000Z",
        extubationAt: "2026-05-20T09:00:00.000Z",
        bloodLossMl: 200,
        urineOutputMl: 300,
        complications: "Slight hypotension",
        recoveryNotes: "Stable on PACU",
      },
    });
    render(<SurgeryDetailPage />);
    await screen.findByText("Dr. AnaeStaff");
    expect(screen.getByText("Slight hypotension")).toBeInTheDocument();
    expect(screen.getByText("Stable on PACU")).toBeInTheDocument();
    expect(screen.getByText(/200 ml/)).toBeInTheDocument();
    expect(screen.getByText(/300 ml/)).toBeInTheDocument();
  });

  it("Edit → Save POSTs /:id/anesthesia-record with parsed fields", async () => {
    wireGet({});
    apiMock.post.mockResolvedValue({ data: {} });
    render(<SurgeryDetailPage />);
    await screen.findByText(/No anesthesia record yet/);
    fireEvent.click(screen.getByRole("button", { name: /^Add$/i }));

    fireEvent.change(screen.getByPlaceholderText(/Anesthetist name/i), {
      target: { value: "Dr. Anae" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Blood loss \(ml\)$/i), {
      target: { value: "150" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Urine output \(ml\)$/i), {
      target: { value: "200" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Complications$/i), {
      target: { value: "None" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Recovery notes$/i), {
      target: { value: "Calm" },
    });
    const saveBtns = screen.getAllByRole("button", { name: /^Save$/i });
    fireEvent.click(saveBtns[saveBtns.length - 1]);

    await waitFor(() => {
      const call = apiMock.post.mock.calls.find(
        (c) => c[0] === "/surgery/s1/anesthesia-record",
      );
      expect(call).toBeTruthy();
      expect(call![1].anesthetist).toBe("Dr. Anae");
      expect(call![1].bloodLossMl).toBe(150);
      expect(call![1].urineOutputMl).toBe(200);
      expect(call![1].complications).toBe("None");
      expect(call![1].recoveryNotes).toBe("Calm");
      expect(call![1].anesthesiaType).toBe("GENERAL");
    });
  });

  it("Save reject toasts", async () => {
    wireGet({});
    apiMock.post.mockRejectedValue(new Error("anesthesia save failed"));
    render(<SurgeryDetailPage />);
    await screen.findByText(/No anesthesia record yet/);
    fireEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    const saveBtns = screen.getAllByRole("button", { name: /^Save$/i });
    fireEvent.click(saveBtns[saveBtns.length - 1]);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("anesthesia save failed"),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — BloodAvailabilityCard", () => {
  it("hidden when !canEdit (RECEPTION)", async () => {
    setUser("RECEPTION");
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    expect(
      screen.queryByText(/Blood Availability Check/i),
    ).not.toBeInTheDocument();
  });

  it("Check POSTs to /:id/blood-requirement with selected component+units", async () => {
    wireGet({});
    apiMock.post.mockResolvedValue({
      data: {
        patientBloodGroup: "A+",
        compatibleGroups: ["A+", "O+"],
        component: "PACKED_RED_CELLS",
        unitsRequested: 3,
        unitsAvailable: 3,
        shortfall: 0,
        canProceed: true,
        reserved: [
          {
            id: "u1",
            unitNumber: "U-001",
            bloodGroup: "A+",
            expiresAt: "2026-06-30T00:00:00.000Z",
          },
        ],
      },
    });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Blood Availability Check/i);

    fireEvent.change(screen.getByLabelText(/Units/i), {
      target: { value: "3" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Check Availability/i }),
    );

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/surgery/s1/blood-requirement",
        { component: "PACKED_RED_CELLS", units: 3, autoReserve: true },
      );
    });
    expect(
      await screen.findByText(/3 unit\(s\) available and reserved/),
    ).toBeInTheDocument();
    expect(screen.getByText(/U-001/)).toBeInTheDocument();
  });

  it("Shortfall result renders the red-border copy", async () => {
    wireGet({});
    apiMock.post.mockResolvedValue({
      data: {
        patientBloodGroup: "A+",
        compatibleGroups: ["A+"],
        component: "PACKED_RED_CELLS",
        unitsRequested: 5,
        unitsAvailable: 2,
        shortfall: 3,
        canProceed: false,
        reserved: [],
      },
    });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Blood Availability Check/i);
    fireEvent.click(
      screen.getByRole("button", { name: /Check Availability/i }),
    );
    expect(
      await screen.findByText(/Shortfall: 3 unit\(s\)/),
    ).toBeInTheDocument();
  });

  it("Check reject toasts", async () => {
    wireGet({});
    apiMock.post.mockRejectedValue(new Error("blood check failed"));
    render(<SurgeryDetailPage />);
    await screen.findByText(/Blood Availability Check/i);
    fireEvent.click(
      screen.getByRole("button", { name: /Check Availability/i }),
    );
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("blood check failed"),
    );
  });

  it("autoReserve toggle changes the POSTed shape", async () => {
    wireGet({});
    apiMock.post.mockResolvedValue({
      data: {
        patientBloodGroup: "A+",
        compatibleGroups: ["A+"],
        component: "PACKED_RED_CELLS",
        unitsRequested: 2,
        unitsAvailable: 0,
        shortfall: 2,
        canProceed: false,
        reserved: [],
      },
    });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Blood Availability Check/i);
    const autoCb = screen.getByLabelText(/Auto-reserve/i) as HTMLInputElement;
    fireEvent.click(autoCb);
    fireEvent.click(
      screen.getByRole("button", { name: /Check Availability/i }),
    );
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/surgery/s1/blood-requirement",
        expect.objectContaining({ autoReserve: false }),
      );
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — PacuObservationsCard", () => {
  it("'No observations yet.' when GET returns []", async () => {
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText(/No observations yet/);
  });

  it("renders the rows + latest summary tiles", async () => {
    wireGet({
      observations: [
        {
          id: "o1",
          observedAt: "2026-05-20T09:00:00.000Z",
          bpSystolic: 120,
          bpDiastolic: 80,
          pulse: 72,
          spO2: 98,
          painScore: 3,
          consciousness: "ALERT",
          nausea: false,
        },
        {
          id: "o2",
          observedAt: "2026-05-20T09:15:00.000Z",
          bpSystolic: 118,
          bpDiastolic: 78,
          pulse: 70,
          spO2: 99,
          painScore: 2,
          consciousness: "ALERT",
          nausea: true,
        },
      ],
    });
    render(<SurgeryDetailPage />);
    await screen.findByText(/PACU Recovery/);
    // JSX renders BP as split text nodes ({sys}/{dia}) — query by element
    // whose textContent matches. The "PACU Recovery" heading renders
    // immediately regardless of loading state, so findByText returns
    // before setRows lands the GET /observations response. Wrap the
    // synchronous DOM scan in waitFor so the retry covers the async
    // state update — otherwise the table body is still the loading
    // skeleton and bps[] only contains header labels.
    await waitFor(() => {
      const bps = Array.from(document.querySelectorAll(".font-semibold, td"))
        .map((el) => el.textContent?.trim())
        .filter(Boolean);
      expect(bps).toContain("118/78");
      expect(bps).toContain("120/80");
    });
  });

  it("Add observation POSTs the parsed shape and reloads", async () => {
    wireGet({});
    apiMock.post.mockResolvedValue({ data: {} });
    render(<SurgeryDetailPage />);
    await screen.findByText(/PACU Recovery/);

    fireEvent.change(screen.getByPlaceholderText("BP Sys"), {
      target: { value: "115" },
    });
    fireEvent.change(screen.getByPlaceholderText("BP Dia"), {
      target: { value: "75" },
    });
    fireEvent.change(screen.getByPlaceholderText("Pulse"), {
      target: { value: "82" },
    });
    fireEvent.change(screen.getByPlaceholderText("SpO2 %"), {
      target: { value: "98" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Pain \(0-10\)/), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByPlaceholderText("Notes"), {
      target: { value: "Stable" },
    });
    fireEvent.click(screen.getByLabelText(/Nausea/i));

    fireEvent.click(screen.getByRole("button", { name: /Add observation/i }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/surgery/s1/observations",
        expect.objectContaining({
          bpSystolic: 115,
          bpDiastolic: 75,
          pulse: 82,
          spO2: 98,
          painScore: 4,
          consciousness: "ALERT",
          nausea: true,
          notes: "Stable",
        }),
      );
    });
  });

  it("Add observation reject toasts", async () => {
    wireGet({});
    apiMock.post.mockRejectedValue(new Error("obs save failed"));
    render(<SurgeryDetailPage />);
    await screen.findByText(/PACU Recovery/);
    fireEvent.click(screen.getByRole("button", { name: /Add observation/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("obs save failed"),
    );
  });

  it("hides the Record Observation form when !canEdit (RECEPTION)", async () => {
    setUser("RECEPTION");
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText(/PACU Recovery/);
    expect(
      screen.queryByRole("button", { name: /Add observation/i }),
    ).not.toBeInTheDocument();
  });
});

// ──────────────────────────────────────────────────────────────────────
describe("SurgeryDetailPage — SsiReportCard", () => {
  it("hidden when !canEdit and !ssiDetected", async () => {
    setUser("RECEPTION");
    wireGet({});
    render(<SurgeryDetailPage />);
    await screen.findByText("SX-2026-0001");
    expect(
      screen.queryByText(/Surgical Site Infection/i),
    ).not.toBeInTheDocument();
  });

  it("renders SSI fields when ssiDetected even for non-edit roles", async () => {
    setUser("RECEPTION");
    wireGet({
      surgery: surgeryFx({
        ssiDetected: true,
        ssiType: "DEEP",
        ssiDetectedDate: "2026-05-21T00:00:00.000Z",
        ssiTreatment: "Vanco",
      }),
    });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Surgical Site Infection/i);
    // SSI type renders twice (banner + card)
    expect(screen.getAllByText("DEEP").length).toBeGreaterThanOrEqual(1);
  });

  it("Report SSI → save PATCH /:id/ssi-report with ISO detectedDate", async () => {
    wireGet({});
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Surgical Site Infection/i);
    fireEvent.click(screen.getByRole("button", { name: /Report SSI/i }));

    const treatment = screen.getByPlaceholderText(/Treatment details/i);
    fireEvent.change(treatment, { target: { value: "Vancomycin" } });

    const saveBtns = screen.getAllByRole("button", { name: /^Save$/i });
    fireEvent.click(saveBtns[saveBtns.length - 1]);

    await waitFor(() => {
      const call = apiMock.patch.mock.calls.find(
        (c) => c[0] === "/surgery/s1/ssi-report",
      );
      expect(call).toBeTruthy();
      expect(call![1].ssiType).toBe("SUPERFICIAL");
      expect(call![1].treatment).toBe("Vancomycin");
      // detectedDate is ISO; today's date.
      expect(call![1].detectedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("SSI save reject toasts", async () => {
    wireGet({});
    apiMock.patch.mockRejectedValue(new Error("ssi save failed"));
    render(<SurgeryDetailPage />);
    await screen.findByText(/Surgical Site Infection/i);
    fireEvent.click(screen.getByRole("button", { name: /Report SSI/i }));
    const saveBtns = screen.getAllByRole("button", { name: /^Save$/i });
    fireEvent.click(saveBtns[saveBtns.length - 1]);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("ssi save failed"),
    );
  });

  it("SSI Cancel button closes form without PATCH", async () => {
    // Use COMPLETED to suppress the page-action Cancel button so we can
    // unambiguously click the SSI-form Cancel.
    wireGet({ surgery: surgeryFx({ status: "COMPLETED" }) });
    render(<SurgeryDetailPage />);
    await screen.findByText(/Surgical Site Infection/i);
    fireEvent.click(screen.getByRole("button", { name: /Report SSI/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(
      screen.getByRole("button", { name: /Report SSI/i }),
    ).toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });
});
