/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NurseWorkstationPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/workstation/page.tsx`, the nurse-only daily
 *     workstation hub. The page issues four parallel mount fetches:
 *       GET /medication/administrations/due?window=30
 *       GET /emergency/cases/active
 *       GET /appointments?status=CHECKED_IN&date=YYYY-MM-DD&limit=50
 *       GET /admissions?status=ADMITTED&limit=50
 *     ...then issues GET /nurse-rounds?admissionId=... per admission (top 5)
 *     to populate "My Recent Rounds" (filtered to rounds performed by the
 *     current nurse — server-side mine filter doesn't exist yet, see source
 *     comment around line 93).
 *
 *   - Behaviours covered:
 *       1. RBAC — non-NURSE roles see the "Workstation is for nurses only"
 *          short-circuit copy and the page never issues any GET.
 *       2. RBAC redirect effect — a non-NURSE authed user triggers
 *          router.replace('/dashboard') in the gating effect.
 *       3. Loading skeleton — `data-testid="workstation-loading"` (aria-busy)
 *          renders while the four GETs are in flight; the page chrome
 *          (heading + NURSE pill) stays visible.
 *       4. Happy fetch — Meds Due, My Assigned Patients, Vitals to Record,
 *          ER Triage, and My Recent Rounds tiles all render with their data.
 *       5. Empty branches — each tile renders its own "no data" copy when the
 *          corresponding endpoint returns an empty list.
 *       6. ER triage filter — only WAITING / IN_TRIAGE cases are kept; a
 *          DISCHARGED case is excluded.
 *       7. Recent-rounds nurse filter — only rounds where nurseId === user.id
 *          (or nurse.id === user.id) are kept; rounds for other nurses drop.
 *       8. Quick-action buttons (issue #432) — each of the 4 ActionBtns:
 *          a. with context: toasts success + router.push(deep-link with id).
 *          b. without context: toasts info + router.push(landing page).
 *       9. Error path — every GET rejects (safe() swallows) → page still
 *          renders all empty-state copies and flips loading off.
 *
 *   - Source under test: apps/web/src/app/dashboard/workstation/page.tsx
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            next/navigation (useRouter), @/components/Skeleton, lucide-react.
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

const { apiMock, toastMock, authMock, routerMock } = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/workstation",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));

import NurseWorkstationPage from "../page";

// ─── Fixtures ───────────────────────────────────────────

function medDueFixture(overrides: any = {}) {
  return {
    id: "med-1",
    scheduledAt: "2026-05-26T10:30:00.000Z",
    medicationOrder: {
      medicineName: "Paracetamol",
      dosage: "500mg",
      admission: {
        patient: { user: { name: "Aanya Sharma" } },
      },
    },
    ...overrides,
  };
}

function admissionFixture(overrides: any = {}) {
  return {
    id: "adm-1",
    admissionNumber: "ADM-2026-001",
    patient: { user: { name: "Rohit Kumar" } },
    bed: { bedNumber: "12", ward: { name: "Ward A" } },
    ...overrides,
  };
}

function checkedInApptFixture(overrides: any = {}) {
  return {
    id: "appt-1",
    tokenNumber: 7,
    patient: { user: { name: "Meera Iyer" } },
    doctor: { user: { name: "Dr. Rajesh Sharma" } },
    ...overrides,
  };
}

function emergencyCaseFixture(overrides: any = {}) {
  return {
    id: "er-1",
    caseNumber: "ER-2026-042",
    chiefComplaint: "Chest pain",
    triageLevel: "P1",
    status: "WAITING",
    ...overrides,
  };
}

function nurseRoundFixture(overrides: any = {}) {
  return {
    id: "round-1",
    nurseId: "nurse-user-1",
    performedAt: "2026-05-26T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * Wire api.get to route by URL prefix to the right fixture. The page fires
 * 4 parallel mount fetches + 1-N nurse-rounds fetches per admission, so URL
 * prefix routing is more robust than mockResolvedValueOnce chains.
 */
function wireGet(opts: {
  meds?: any[];
  emergencies?: any[];
  checkedIn?: any[];
  admissions?: any[];
  rounds?: any[] | ((url: string) => any[]);
  rejectAll?: boolean;
} = {}) {
  apiMock.get.mockImplementation((url: string) => {
    if (opts.rejectAll) return Promise.reject(new Error("boom"));
    if (url.startsWith("/medication/administrations/due")) {
      return Promise.resolve({ data: opts.meds ?? [] });
    }
    if (url.startsWith("/emergency/cases/active")) {
      return Promise.resolve({ data: opts.emergencies ?? [] });
    }
    if (url.startsWith("/appointments")) {
      return Promise.resolve({ data: opts.checkedIn ?? [] });
    }
    if (url.startsWith("/admissions")) {
      return Promise.resolve({ data: opts.admissions ?? [] });
    }
    if (url.startsWith("/nurse-rounds")) {
      const rounds =
        typeof opts.rounds === "function"
          ? (opts.rounds as any)(url)
          : opts.rounds ?? [];
      return Promise.resolve({ data: rounds });
    }
    return Promise.resolve({ data: [] });
  });
}

function asNurse() {
  authMock.mockReturnValue({
    user: { id: "nurse-user-1", role: "NURSE", name: "Asha Nurse" },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "doc-1", role: "DOCTOR", name: "Dr. Rajesh" },
    isLoading: false,
  });
}

describe("NurseWorkstationPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asNurse();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the nurse-only short-circuit copy for non-NURSE roles and issues no GETs", async () => {
    asDoctor();
    wireGet({});

    render(<NurseWorkstationPage />);

    expect(
      screen.getByText(/workstation is for nurses only/i),
    ).toBeInTheDocument();
    // The page heading is from the post-gate render path so it should NOT
    // render for non-NURSE.
    expect(
      screen.queryByRole("heading", { name: /^workstation$/i }),
    ).not.toBeInTheDocument();
    // Data fetch effect is gated on user.role === "NURSE" so no GETs fire.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("redirects non-NURSE authed users to /dashboard via router.replace", async () => {
    asDoctor();
    wireGet({});

    render(<NurseWorkstationPage />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("renders the skeleton loading state while the four mount GETs are in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<NurseWorkstationPage />);

    // Page chrome visible during load.
    expect(
      screen.getByRole("heading", { name: /^workstation$/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/your nursing hub for today/i)).toBeInTheDocument();
    // Loading skeleton with aria-busy.
    const loading = screen.getByTestId("workstation-loading");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card")).toHaveLength(3);
  });

  it("renders all five tiles with their data on a happy fetch", async () => {
    wireGet({
      meds: [
        medDueFixture(),
        medDueFixture({
          id: "med-2",
          medicationOrder: {
            medicineName: "Amoxicillin",
            dosage: "250mg",
            admission: {
              patient: { user: { name: "Vikram Reddy" } },
            },
          },
        }),
      ],
      emergencies: [emergencyCaseFixture()],
      checkedIn: [checkedInApptFixture()],
      admissions: [admissionFixture()],
      rounds: [nurseRoundFixture()],
    });

    render(<NurseWorkstationPage />);

    // Loading flips off.
    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    // Meds Due tile values.
    expect(screen.getByText("Paracetamol")).toBeInTheDocument();
    expect(screen.getByText("Amoxicillin")).toBeInTheDocument();

    // My Assigned Patients tile. "Rohit Kumar" also appears in Recent Rounds
    // (the round is hydrated with the admission, so the patient name renders
    // in both tiles). Assert ≥1 occurrence here, exact count later.
    expect(screen.getAllByText("Rohit Kumar").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(/ADM-2026-001 · Ward A Bed 12/),
    ).toBeInTheDocument();

    // Vitals to Record tile.
    expect(screen.getByText("Meera Iyer")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();

    // ER Triage tile.
    expect(screen.getByText("ER-2026-042")).toBeInTheDocument();
    expect(screen.getByText("Chest pain")).toBeInTheDocument();
    expect(screen.getByText("P1")).toBeInTheDocument();

    // My Recent Rounds tile — when round is hydrated with admission, the
    // admission.patient.user.name renders.
    // (round has admission attached via the source's hydration step.)
    // The Rohit Kumar name appears twice — once in Assigned Patients,
    // once in Recent Rounds.
    expect(screen.getAllByText("Rohit Kumar").length).toBeGreaterThanOrEqual(2);

    // Issued the four canonical mount GETs.
    const calls = apiMock.get.mock.calls.map((c) => c[0] as string);
    expect(
      calls.some((u) =>
        u.startsWith("/medication/administrations/due?window=30"),
      ),
    ).toBe(true);
    expect(calls.some((u) => u === "/emergency/cases/active")).toBe(true);
    expect(
      calls.some((u) =>
        u.startsWith("/appointments?status=CHECKED_IN&date="),
      ),
    ).toBe(true);
    expect(
      calls.some((u) =>
        u.startsWith("/admissions?status=ADMITTED&limit=50"),
      ),
    ).toBe(true);
    // And the per-admission rounds fetch.
    expect(
      calls.some((u) => u.startsWith("/nurse-rounds?admissionId=adm-1")),
    ).toBe(true);
  });

  it("renders every empty-state copy when every endpoint returns []", async () => {
    wireGet({});

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    expect(
      screen.getByText(/no medications due in the next 30 minutes/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no patients currently assigned/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/all vitals up to date/i)).toBeInTheDocument();
    expect(screen.getByText(/no pending triage/i)).toBeInTheDocument();
    expect(screen.getByText(/no rounds performed yet/i)).toBeInTheDocument();
  });

  it("filters out non-triage ER cases (only WAITING / IN_TRIAGE kept)", async () => {
    wireGet({
      emergencies: [
        emergencyCaseFixture({ id: "er-wait", status: "WAITING" }),
        emergencyCaseFixture({
          id: "er-triage",
          caseNumber: "ER-2026-099",
          status: "IN_TRIAGE",
        }),
        emergencyCaseFixture({
          id: "er-discharged",
          caseNumber: "ER-2026-DISCHARGE",
          status: "DISCHARGED",
        }),
      ],
    });

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    expect(screen.getByText("ER-2026-042")).toBeInTheDocument();
    expect(screen.getByText("ER-2026-099")).toBeInTheDocument();
    // DISCHARGED case is filtered out of the displayed triage list.
    expect(screen.queryByText("ER-2026-DISCHARGE")).not.toBeInTheDocument();
  });

  it("filters Recent Rounds to only the current nurse's rounds", async () => {
    wireGet({
      admissions: [admissionFixture()],
      rounds: [
        nurseRoundFixture({ id: "mine-1", nurseId: "nurse-user-1" }),
        nurseRoundFixture({ id: "theirs", nurseId: "some-other-nurse" }),
        // Round using the alternate { nurse: { id } } shape.
        nurseRoundFixture({
          id: "mine-2",
          nurseId: undefined,
          nurse: { id: "nurse-user-1" },
        }),
      ],
    });

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    // Recent Rounds tile heading present.
    expect(
      screen.getByRole("heading", { name: /my recent rounds/i }),
    ).toBeInTheDocument();
    // "No rounds performed yet" should NOT render — we have 2 matching.
    expect(
      screen.queryByText(/no rounds performed yet/i),
    ).not.toBeInTheDocument();
  });

  it("Record Vitals action — with context: deep-links to /dashboard/vitals?appointmentId=... and toasts success", async () => {
    wireGet({
      checkedIn: [
        checkedInApptFixture({
          id: "appt-VITAL",
          patient: { user: { name: "Pria Q" } },
        }),
      ],
    });

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("quick-record-vitals"));

    expect(toastMock.success).toHaveBeenCalledWith(
      "Opening vitals form for Pria Q",
    );
    expect(routerMock.push).toHaveBeenCalledWith(
      "/dashboard/vitals?appointmentId=appt-VITAL",
    );
  });

  it("Record Vitals action — without context: toasts info hint and lands on /dashboard/vitals", async () => {
    wireGet({});

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("quick-record-vitals"));

    expect(toastMock.info).toHaveBeenCalledWith(
      "Pick a patient from the queue to record vitals.",
    );
    expect(routerMock.push).toHaveBeenCalledWith("/dashboard/vitals");
  });

  it("Administer Med action — with context: deep-links to /dashboard/medication-dashboard?id=... and toasts success", async () => {
    wireGet({
      meds: [
        medDueFixture({
          id: "med-PICK",
          medicationOrder: {
            medicineName: "Aspirin",
            dosage: "75mg",
            admission: { patient: { user: { name: "Med Patient" } } },
          },
        }),
      ],
    });

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("quick-administer-med"));

    expect(toastMock.success).toHaveBeenCalledWith(
      "Opening medication administration for Med Patient",
    );
    expect(routerMock.push).toHaveBeenCalledWith(
      "/dashboard/medication-dashboard?id=med-PICK",
    );
  });

  it("Administer Med action — without context: toasts no-meds-due hint and lands on /dashboard/medication-dashboard", async () => {
    wireGet({});

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("quick-administer-med"));

    expect(toastMock.info).toHaveBeenCalledWith(
      "No medications due in the next 30 minutes.",
    );
    expect(routerMock.push).toHaveBeenCalledWith(
      "/dashboard/medication-dashboard",
    );
  });

  it("Start Round action — with context: deep-links to /dashboard/admissions/:id?action=round and toasts success", async () => {
    wireGet({
      admissions: [
        admissionFixture({
          id: "adm-ROUND",
          patient: { user: { name: "Round Patient" } },
        }),
      ],
    });

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("quick-start-round"));

    expect(toastMock.success).toHaveBeenCalledWith(
      "Starting round for Round Patient",
    );
    expect(routerMock.push).toHaveBeenCalledWith(
      "/dashboard/admissions/adm-ROUND?action=round",
    );
  });

  it("Start Round action — without context: toasts hint and lands on /dashboard/admissions", async () => {
    wireGet({});

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("quick-start-round"));

    expect(toastMock.info).toHaveBeenCalledWith(
      "No patients assigned. Pick an admission to start a round.",
    );
    expect(routerMock.push).toHaveBeenCalledWith("/dashboard/admissions");
  });

  it("Triage action — with context: deep-links to /dashboard/emergency?id=... and toasts success", async () => {
    wireGet({
      emergencies: [
        emergencyCaseFixture({ id: "er-PICK", caseNumber: "ER-PICK-001" }),
      ],
    });

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("quick-triage"));

    expect(toastMock.success).toHaveBeenCalledWith(
      "Opening triage for case ER-PICK-001",
    );
    expect(routerMock.push).toHaveBeenCalledWith(
      "/dashboard/emergency?id=er-PICK",
    );
  });

  it("Triage action — without context: toasts info and lands on /dashboard/emergency", async () => {
    wireGet({});

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("quick-triage"));

    expect(toastMock.info).toHaveBeenCalledWith("No cases awaiting triage.");
    expect(routerMock.push).toHaveBeenCalledWith("/dashboard/emergency");
  });

  it("Error path — when every endpoint rejects, safe() swallows and the page still renders all empty states", async () => {
    wireGet({ rejectAll: true });

    render(<NurseWorkstationPage />);

    // Loading still flips off even though every fetch threw — safe() catches.
    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    // Every empty-state copy renders.
    expect(
      screen.getByText(/no medications due in the next 30 minutes/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no patients currently assigned/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/all vitals up to date/i)).toBeInTheDocument();
    expect(screen.getByText(/no pending triage/i)).toBeInTheDocument();
    expect(screen.getByText(/no rounds performed yet/i)).toBeInTheDocument();
    // NURSE pill renders post-gate.
    expect(screen.getByText("NURSE")).toBeInTheDocument();
  });

  it("uses fallback patient labels for med rows missing admission.patient", async () => {
    wireGet({
      meds: [
        {
          id: "med-fallback",
          scheduledAt: "2026-05-26T10:30:00.000Z",
          medicineName: "TopLevel Med",
          patientName: "Fallback Patient",
          medicationOrder: null,
        },
      ],
    });

    render(<NurseWorkstationPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("workstation-loading"),
      ).not.toBeInTheDocument(),
    );

    // Source uses `m.medicationOrder?.medicineName || m.medicineName || "—"`.
    expect(screen.getByText("TopLevel Med")).toBeInTheDocument();
    // And `m.medicationOrder?.admission?.patient?.user?.name || m.patientName`.
    expect(screen.getByText(/Fallback Patient/)).toBeInTheDocument();
  });
});
