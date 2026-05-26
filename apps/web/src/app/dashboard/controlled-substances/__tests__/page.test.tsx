/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ControlledSubstancesPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/controlled-substances/page.tsx`, the
 *     D&C Act §65 Schedule H/H1/X register. Endpoints the page hits:
 *       GET /medicines?limit=100              (requiresRegister filter, client-side)
 *       GET /controlled-substances?...        (entries tab; medicineId/from/to)
 *       GET /controlled-substances/register/:medicineId   (register tab)
 *       GET /controlled-substances/audit-report?...       (audit tab)
 *   - Behaviours covered:
 *       1. RBAC — non-clinical role (RECEPTION) triggers toast.error + router
 *          redirect to /dashboard/not-authorized with ?from=... and renders the
 *          "Access denied" fallback; NO /controlled-substances fetch fires.
 *       2. Loading branch — the skeleton (testid controlled-substances-loading)
 *          renders while the initial fetch is pending.
 *       3. Happy fetch (entries tab) — multiple entry rows render with entry
 *          number, medicine + strength + schedule badge, quantity, balance,
 *          patient name + MR number, doctor name (formatDoctorName prefix),
 *          dispenser name. Em-dash fallback for missing patient / doctor.
 *       4. Empty fetch (entries tab) — "No entries match the filter." copy.
 *       5. Error fetch — console.error called; the empty branch still renders.
 *       6. Medicine filter <select> — changing it refetches with
 *          medicineId=<id> in the query string.
 *       7. From / To date filters — changing them refetches with from=/to= in
 *          the query string.
 *       8. Export CSV button — renders only on entries tab; clicking it
 *          invokes URL.createObjectURL (download wiring).
 *       9. Tab switching — clicking "Register by Medicine" with no medicine
 *          selected shows the "Choose a medicine above…" placeholder; selecting
 *          a medicine then fetches /controlled-substances/register/:id and
 *          renders the on-hand panel.
 *      10. Audit tab — clicking "Audit Report" fetches the audit endpoint and
 *          renders one row per medicine with discrepancy highlighting (and the
 *          empty-window copy when no rows).
 *      11. ADMIN + DOCTOR + PHARMACIST roles all pass the canView gate.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, next/navigation, lucide-react,
 *            @/components/Skeleton, @/lib/format-doctor-name.
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

const { apiMock, toastMock, authMock, routerMock, pathnameMock } = vi.hoisted(
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
    routerMock: {
      replace: vi.fn(),
      push: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    },
    pathnameMock: vi.fn(() => "/dashboard/controlled-substances"),
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => pathnameMock(),
}));
vi.mock("lucide-react", () => ({
  ShieldAlert: () => <span data-testid="icon-shield-alert" />,
  Download: () => <span data-testid="icon-download" />,
  FileWarning: () => <span data-testid="icon-file-warning" />,
  ListTree: () => <span data-testid="icon-list-tree" />,
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-table" data-rows={rows} data-columns={columns} />
  ),
}));

import ControlledSubstancesPage from "../page";

type CsEntry = {
  id: string;
  entryNumber: string;
  dispensedAt: string;
  quantity: number;
  balance: number;
  notes?: string | null;
  medicine: {
    id: string;
    name: string;
    scheduleClass?: string | null;
    strength?: string | null;
    form?: string | null;
  };
  patient?: { id: string; mrNumber: string; user: { name: string } } | null;
  doctor?: { id: string; user: { name: string } } | null;
  user: { id: string; name: string; role: string };
};

type MedicineSummary = {
  id: string;
  name: string;
  scheduleClass?: string | null;
  strength?: string | null;
  form?: string | null;
  requiresRegister?: boolean;
};

type AuditRow = {
  medicineId: string;
  medicineName?: string;
  scheduleClass?: string | null;
  totalDispensed: number;
  entryCount: number;
  currentOnHand: number;
  registerBalance: number | null;
  discrepancy: number | null;
};

function entryFixture(overrides: Partial<CsEntry> = {}): CsEntry {
  return {
    id: "e-1",
    entryNumber: "CS-2026-0001",
    dispensedAt: "2026-04-01T10:00:00.000Z",
    quantity: 10,
    balance: 90,
    medicine: {
      id: "m-1",
      name: "Morphine",
      scheduleClass: "X",
      strength: "10mg",
      form: "TAB",
    },
    patient: { id: "p-1", mrNumber: "MR-001", user: { name: "Ravi Kumar" } },
    doctor: { id: "d-1", user: { name: "Rajesh Sharma" } },
    user: { id: "u-1", name: "Pharma Tech", role: "PHARMACIST" },
    ...overrides,
  };
}

function medicineFixture(
  overrides: Partial<MedicineSummary> = {},
): MedicineSummary {
  return {
    id: "m-1",
    name: "Morphine",
    scheduleClass: "X",
    strength: "10mg",
    form: "TAB",
    requiresRegister: true,
    ...overrides,
  };
}

function auditFixture(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    medicineId: "m-1",
    medicineName: "Morphine",
    scheduleClass: "X",
    totalDispensed: 30,
    entryCount: 3,
    currentOnHand: 70,
    registerBalance: 70,
    discrepancy: 0,
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin User" },
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doctor User" },
  });
}

function asPharmacist() {
  authMock.mockReturnValue({
    user: { id: "u-pharm", role: "PHARMACIST", name: "Pharma User" },
  });
}

function asReception() {
  authMock.mockReturnValue({
    user: { id: "u-recep", role: "RECEPTION", name: "Front Desk" },
  });
}

// Wire api.get to respond per-URL prefix so the dual-fetch on mount
// (medicines + entries) resolves deterministically.
function wireApi(opts: {
  medicines?: MedicineSummary[];
  entries?: CsEntry[];
  register?: {
    medicine: MedicineSummary;
    currentOnHand: number;
    entries: CsEntry[];
  } | null;
  audit?: { rows: AuditRow[]; discrepancies: AuditRow[] } | null;
  rejectOn?: "entries" | "medicines" | "register" | "audit";
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/medicines")) {
      if (opts.rejectOn === "medicines") return Promise.reject(new Error("med fail"));
      return Promise.resolve({ data: opts.medicines ?? [] });
    }
    if (url.startsWith("/controlled-substances/register/")) {
      if (opts.rejectOn === "register") return Promise.reject(new Error("reg fail"));
      return Promise.resolve({ data: opts.register ?? null });
    }
    if (url.startsWith("/controlled-substances/audit-report")) {
      if (opts.rejectOn === "audit") return Promise.reject(new Error("audit fail"));
      return Promise.resolve({
        data: opts.audit ?? { rows: [], discrepancies: [] },
      });
    }
    if (url.startsWith("/controlled-substances")) {
      if (opts.rejectOn === "entries") return Promise.reject(new Error("ent fail"));
      return Promise.resolve({ data: opts.entries ?? [] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("Controlled-substances dashboard page (D&C Act register)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    routerMock.replace.mockReset();
    pathnameMock.mockReset();
    pathnameMock.mockReturnValue("/dashboard/controlled-substances");
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("blocks RECEPTION with the Access-denied fallback, toasts an error, and redirects to /dashboard/not-authorized with the ?from= breadcrumb", async () => {
    asReception();
    wireApi({});

    render(<ControlledSubstancesPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/restricted to clinical and pharmacy roles/i),
      ),
    );

    expect(routerMock.replace).toHaveBeenCalledWith(
      `/dashboard/not-authorized?from=${encodeURIComponent(
        "/dashboard/controlled-substances",
      )}`,
    );

    // Access-denied fallback renders, real chrome does not.
    expect(screen.getByText(/Access denied\./i)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Controlled Substance Register/i }),
    ).not.toBeInTheDocument();

    // No data fetch fires — gated behind canView.
    expect(
      apiMock.get.mock.calls.find(([u]) =>
        String(u).startsWith("/controlled-substances"),
      ),
    ).toBeUndefined();
    expect(
      apiMock.get.mock.calls.find(([u]) => String(u).startsWith("/medicines")),
    ).toBeUndefined();
  });

  it("renders the skeleton-table loading branch while the initial entries fetch is pending", async () => {
    // Medicines resolves empty; entries fetch hangs.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medicines")) return Promise.resolve({ data: [] });
      return new Promise(() => {}); // never resolves
    });

    render(<ControlledSubstancesPage />);

    expect(
      screen.getByRole("heading", { name: /Controlled Substance Register/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByTestId("controlled-substances-loading"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("skeleton-table")).toBeInTheDocument();
  });

  it("fetches /controlled-substances on mount (no filters in querystring) and renders one row per entry with medicine + patient + doctor + dispenser fields", async () => {
    wireApi({
      medicines: [medicineFixture()],
      entries: [
        entryFixture({ id: "e-1", entryNumber: "CS-2026-0001" }),
        entryFixture({
          id: "e-2",
          entryNumber: "CS-2026-0002",
          quantity: 5,
          balance: 85,
          patient: null,
          doctor: null,
          user: { id: "u-2", name: "Other Tech", role: "PHARMACIST" },
        }),
      ],
    });

    render(<ControlledSubstancesPage />);

    await screen.findByText("CS-2026-0001");
    await screen.findByText("CS-2026-0002");

    // Querystring contract — no filters set → trailing "?" with no params.
    expect(apiMock.get).toHaveBeenCalledWith("/controlled-substances?");

    // Row 1: patient + doctor present.
    expect(screen.getByText("Ravi Kumar")).toBeInTheDocument();
    expect(screen.getByText("MR-001")).toBeInTheDocument();
    expect(screen.getByText("Dr. Rajesh Sharma")).toBeInTheDocument();

    // Schedule-class badge renders in the row.
    const tbody = document.querySelector("tbody")!;
    expect(within(tbody).getAllByText("X").length).toBeGreaterThan(0);

    // Row 2: patient + doctor null → em-dash fallback. Two cells render "—".
    const emDashes = within(tbody).getAllByText("—");
    expect(emDashes.length).toBeGreaterThanOrEqual(2);

    // Dispenser names render.
    expect(screen.getByText("Pharma Tech")).toBeInTheDocument();
    expect(screen.getByText("Other Tech")).toBeInTheDocument();
  });

  it('renders "No entries match the filter." when the entries API returns zero rows', async () => {
    wireApi({});
    render(<ControlledSubstancesPage />);

    expect(
      await screen.findByText(/No entries match the filter\./i),
    ).toBeInTheDocument();
  });

  it("swallows the error and settles into the empty branch when the entries fetch rejects", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    wireApi({ rejectOn: "entries" });

    render(<ControlledSubstancesPage />);

    expect(
      await screen.findByText(/No entries match the filter\./i),
    ).toBeInTheDocument();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("refetches /controlled-substances with medicineId=<id> when the medicine <select> changes", async () => {
    wireApi({
      medicines: [
        medicineFixture({ id: "m-1", name: "Morphine" }),
        medicineFixture({ id: "m-2", name: "Fentanyl", scheduleClass: "H1" }),
      ],
      entries: [entryFixture()],
    });

    render(<ControlledSubstancesPage />);
    await screen.findByText("CS-2026-0001");

    // Lock onto the medicine filter <select> by its unique id.
    const medicineSelect = document.getElementById(
      "cs-filter-medicine",
    ) as HTMLSelectElement;
    expect(medicineSelect).toBeTruthy();

    fireEvent.change(medicineSelect, { target: { value: "m-2" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/controlled-substances?medicineId=m-2",
      ),
    );
  });

  it("refetches with from=/to= when the date filters change", async () => {
    wireApi({ entries: [entryFixture()] });

    render(<ControlledSubstancesPage />);
    await screen.findByText("CS-2026-0001");

    const fromInput = document.getElementById(
      "cs-filter-from",
    ) as HTMLInputElement;
    const toInput = document.getElementById(
      "cs-filter-to",
    ) as HTMLInputElement;

    fireEvent.change(fromInput, { target: { value: "2026-04-01" } });
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/controlled-substances?from=2026-04-01",
      ),
    );

    fireEvent.change(toInput, { target: { value: "2026-04-30" } });
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/controlled-substances?from=2026-04-01&to=2026-04-30",
      ),
    );
  });

  it("invokes URL.createObjectURL when Export CSV is clicked on the entries tab", async () => {
    const createSpy = vi.spyOn(URL, "createObjectURL");
    wireApi({ entries: [entryFixture()] });

    render(<ControlledSubstancesPage />);
    await screen.findByText("CS-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

    expect(createSpy).toHaveBeenCalled();
    createSpy.mockRestore();
  });

  it('shows the "Choose a medicine above" placeholder on the register tab when no medicine is selected', async () => {
    wireApi({ medicines: [medicineFixture()], entries: [entryFixture()] });

    render(<ControlledSubstancesPage />);
    await screen.findByText("CS-2026-0001");

    fireEvent.click(
      screen.getByRole("button", { name: /Register by Medicine/i }),
    );

    expect(
      await screen.findByText(/Choose a medicine above to view its register\./i),
    ).toBeInTheDocument();
    // Export CSV is gated to the entries tab only.
    expect(
      screen.queryByRole("button", { name: /Export CSV/i }),
    ).not.toBeInTheDocument();
  });

  it("fetches /controlled-substances/register/:medicineId on the register tab when a medicine is selected and renders the on-hand summary", async () => {
    wireApi({
      medicines: [medicineFixture({ id: "m-1" })],
      entries: [entryFixture()],
      register: {
        medicine: medicineFixture({ id: "m-1", name: "Morphine" }),
        currentOnHand: 42,
        entries: [entryFixture({ id: "re-1", entryNumber: "CS-REG-0001" })],
      },
    });

    render(<ControlledSubstancesPage />);
    await screen.findByText("CS-2026-0001");

    // Pick the medicine first (entries tab still active).
    const medicineSelect = document.getElementById(
      "cs-filter-medicine",
    ) as HTMLSelectElement;
    fireEvent.change(medicineSelect, { target: { value: "m-1" } });

    // Switch to register tab — triggers loadRegister().
    fireEvent.click(
      screen.getByRole("button", { name: /Register by Medicine/i }),
    );

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/controlled-substances/register/m-1",
      ),
    );

    await screen.findByText(/Current on-hand:/i);
    expect(screen.getByText("42")).toBeInTheDocument();
    await screen.findByText("CS-REG-0001");
  });

  it("renders the audit-tab rows with discrepancy highlighting (and the empty-window copy when no rows)", async () => {
    // First render: with rows including a discrepancy.
    wireApi({
      entries: [entryFixture()],
      audit: {
        rows: [
          auditFixture({ medicineId: "m-1", medicineName: "Morphine", discrepancy: 0 }),
          auditFixture({
            medicineId: "m-2",
            medicineName: "Fentanyl",
            scheduleClass: "H1",
            discrepancy: -5,
            currentOnHand: 30,
            registerBalance: 35,
          }),
        ],
        discrepancies: [],
      },
    });

    render(<ControlledSubstancesPage />);
    await screen.findByText("CS-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Audit Report/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/^\/controlled-substances\/audit-report\?/),
      ),
    );

    await screen.findByText("Morphine");
    await screen.findByText("Fentanyl");
    expect(screen.getByText("-5")).toBeInTheDocument();

    cleanup();
    apiMock.get.mockReset();

    // Second render: empty window.
    wireApi({
      entries: [],
      audit: { rows: [], discrepancies: [] },
    });
    render(<ControlledSubstancesPage />);
    fireEvent.click(screen.getByRole("button", { name: /Audit Report/i }));

    expect(
      await screen.findByText(/No register activity in the selected window\./i),
    ).toBeInTheDocument();
  });

  it("allows DOCTOR through the canView gate (no redirect, page chrome renders)", async () => {
    asDoctor();
    wireApi({ entries: [entryFixture()] });

    render(<ControlledSubstancesPage />);

    await screen.findByText("CS-2026-0001");
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/Access denied\./i)).not.toBeInTheDocument();
  });

  it("allows PHARMACIST through the canView gate (no redirect, page chrome renders)", async () => {
    asPharmacist();
    wireApi({ entries: [entryFixture()] });

    render(<ControlledSubstancesPage />);

    await screen.findByText("CS-2026-0001");
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/Access denied\./i)).not.toBeInTheDocument();
  });

  it("populates the medicine filter <select> from the requiresRegister-filtered /medicines response (drops non-register meds)", async () => {
    wireApi({
      medicines: [
        medicineFixture({ id: "m-1", name: "Morphine", requiresRegister: true }),
        medicineFixture({ id: "m-2", name: "Paracetamol", requiresRegister: false, scheduleClass: null }),
      ],
      entries: [],
    });

    render(<ControlledSubstancesPage />);
    await screen.findByText(/No entries match the filter\./i);

    const medicineSelect = document.getElementById(
      "cs-filter-medicine",
    ) as HTMLSelectElement;
    const optionValues = Array.from(medicineSelect.options).map(
      (o) => o.value,
    );

    // "" (All) + m-1 only. m-2 is filtered out (requiresRegister: false).
    expect(optionValues).toContain("");
    expect(optionValues).toContain("m-1");
    expect(optionValues).not.toContain("m-2");
  });
});
