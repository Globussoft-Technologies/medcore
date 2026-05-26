/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AdmissionsPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/admissions/page.tsx, the IPD
 *     admissions list + new-admission modal for ADMIN / DOCTOR / NURSE /
 *     RECEPTION. Endpoints the page hits:
 *       GET  /admissions(?status=ADMITTED|DISCHARGED|"")  (list tabs)
 *       GET  /doctors                                     (modal dropdown)
 *       GET  /wards                                       (bed-availability + modal)
 *       GET  /patients?search=&limit=10                   (modal patient picker)
 *       POST /admissions                                  (create)
 *
 *   - Behaviours covered:
 *       1.  Initial render — header + tabs render after mount.
 *       2.  RBAC redirect (Issue #509) — PATIENT / LAB_TECH get
 *           toast.error + router.replace("/dashboard/not-authorized?from=...").
 *       3.  RBAC no-redirect — auth still loading: effect is a no-op.
 *       4.  ADMIN / DOCTOR / RECEPTION see the "Admit Patient" CTA;
 *           NURSE (allowed for VIEW but NOT in canAdmit) does NOT.
 *       5.  Tab switching — clicking each tab refetches /admissions with
 *           the right querystring (?status=ADMITTED, ?status=DISCHARGED, "").
 *       6.  Empty state — empty-state action label is "No beds available"
 *           when canAdmit + admitted + bedsUnavailable; clicking it toasts.
 *       7.  Row rendering — admission#, patient name (linked), ward/bed,
 *           diagnosis "Pending diagnosis" tooltip when null, status pill.
 *       8.  Admit modal — clicking the CTA opens the modal + triggers
 *           GET /doctors and a refresh of GET /wards.
 *       9.  Cancel closes the modal.
 *      10.  Bed-unavailable branch (Issue #16) — wards list has zero
 *           AVAILABLE beds: CTA renders aria-disabled / disabled, the modal
 *           panel header is replaced by the amber "No beds available" hint.
 *      11.  Patient search — < 2 chars does NOT fire /patients; >= 2 chars
 *           fires the debounced /patients call.
 *      12.  Selecting a patient swaps the input for the selected display
 *           and exposes a "Change" reset button.
 *      13.  Submit guards — missing patient, doctor, bed, reason each
 *           surface toast.error and skip POST.
 *      14.  Happy POST — sends the right body, closes the modal, refetches.
 *      15.  POST rejection with Error → toast.error(err.message);
 *           non-Error → fallback "Admission failed".
 *      16.  Error-path resilience — every GET rejection is swallowed
 *           (no uncaught promise; page still mounts).
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, next/navigation.
 *     @/lib/bed-summary and @/lib/format are used un-mocked (pure helpers).
 *
 *   - Notes:
 *     • DataTable renders BOTH a desktop table and a mobile card view, so
 *       every row cell appears twice in the DOM. We use findAllByText where
 *       the count doesn't matter and findAllBy + .length >= 1 where it does.
 *     • The header CTA is a bare <button> outside any form so it defaults
 *       to type="submit" per HTML — querying by `getAllByRole("button")` and
 *       filtering by `.type === "submit"` would mis-target it. Instead we
 *       always submit via `fireEvent.submit(container.querySelector("form")!)`.
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
  usePathname: () => "/dashboard/admissions",
}));

import AdmissionsPage from "../page";

// ─── Fixtures ───────────────────────────────────────────────────────────

// Use +48h / -48h offsets to avoid IST/UTC midnight traps.
const today = new Date();
today.setHours(12, 0, 0, 0);
const past = new Date(today.getTime() - 48 * 60 * 60 * 1000);

function admissionFixture(overrides: Partial<any> = {}): any {
  return {
    id: "adm-1",
    admissionNumber: "ADM-2026-001",
    admittedAt: past.toISOString(),
    dischargedAt: null,
    status: "ADMITTED",
    reason: "Acute appendicitis",
    diagnosis: null,
    patient: {
      id: "pat-1",
      mrNumber: "MR-001",
      user: { name: "Ramesh Kumar", phone: "+919999900001" },
    },
    doctor: { id: "doc-1", user: { name: "Dr. Mehta" } },
    bed: {
      id: "bed-1",
      bedNumber: "B-101",
      ward: { id: "ward-1", name: "General Ward" },
    },
    ...overrides,
  };
}

function wardFixture(overrides: Partial<any> = {}): any {
  return {
    id: "ward-1",
    name: "General Ward",
    beds: [
      { id: "bed-1", bedNumber: "B-101", status: "OCCUPIED", ward: { id: "ward-1", name: "General Ward" } },
      { id: "bed-2", bedNumber: "B-102", status: "AVAILABLE", ward: { id: "ward-1", name: "General Ward" } },
      { id: "bed-3", bedNumber: "B-103", status: "AVAILABLE", ward: { id: "ward-1", name: "General Ward" } },
    ],
    ...overrides,
  };
}

function doctorFixture(overrides: Partial<any> = {}): any {
  return {
    id: "doc-1",
    user: { name: "Dr. Mehta" },
    specialization: "Internal Medicine",
    ...overrides,
  };
}

function patientFixture(overrides: Partial<any> = {}): any {
  return {
    id: "pat-search-1",
    mrNumber: "MR-SEARCH",
    user: { name: "Anita Singh", phone: "+918888800001" },
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin" },
    isLoading: false,
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
function asReception() {
  authMock.mockReturnValue({
    user: { id: "u-recep", role: "RECEPTION", name: "Recep" },
    isLoading: false,
  });
}
function asPatient() {
  authMock.mockReturnValue({
    user: { id: "u-pat", role: "PATIENT", name: "Pat" },
    isLoading: false,
  });
}
function asLabTech() {
  authMock.mockReturnValue({
    user: { id: "u-lab", role: "LAB_TECH", name: "Lab" },
    isLoading: false,
  });
}
function asLoading() {
  authMock.mockReturnValue({ user: null, isLoading: true });
}

/**
 * Default GET wiring. Per-test overrides should call apiMock.get.mockImplementation
 * again BEFORE rendering.
 */
function wireDefaultGets(opts: {
  admissions?: any[];
  wards?: any[];
  doctors?: any[];
  patients?: any[];
} = {}) {
  const admissions = opts.admissions ?? [admissionFixture()];
  const wards = opts.wards ?? [wardFixture()];
  const doctors = opts.doctors ?? [doctorFixture()];
  const patients = opts.patients ?? [];

  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/admissions")) {
      return Promise.resolve({ data: admissions });
    }
    if (url === "/wards") {
      return Promise.resolve({ data: wards });
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

/**
 * Submit the modal's form. The header "Admit Patient" CTA is a bare button
 * that HTML defaults to type="submit" too, so we always submit by selecting
 * the actual <form> element rather than by clicking the submit button.
 */
function submitModalForm(container: HTMLElement) {
  const form = container.querySelector("form");
  if (!form) throw new Error("modal form not in DOM");
  fireEvent.submit(form);
}

describe("AdmissionsPage (IPD admissions register + admit modal — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Initial render + RBAC ───────────────────────────────────────────────

  it("renders the page header and tab strip after mount", async () => {
    wireDefaultGets();
    render(<AdmissionsPage />);

    expect(
      await screen.findByRole("heading", { name: /Admissions/i, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/In-patient admission management/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Currently Admitted/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Discharged$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^All$/ })).toBeInTheDocument();
  });

  it("PATIENT is redirected to /dashboard/not-authorized with from= and a toast", async () => {
    asPatient();
    wireDefaultGets();
    render(<AdmissionsPage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        "/dashboard/not-authorized?from=%2Fdashboard%2Fadmissions",
      ),
    );
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/restricted to clinical and reception roles/i),
    );
  });

  it("LAB_TECH is also redirected (Issue #509 — non-allowlisted role)", async () => {
    asLabTech();
    wireDefaultGets();
    render(<AdmissionsPage />);

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalled());
  });

  it("does NOT redirect while auth is still loading", async () => {
    asLoading();
    wireDefaultGets();
    render(<AdmissionsPage />);

    // Give the gate effect a tick to flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("ADMIN sees the 'Admit Patient' CTA", async () => {
    wireDefaultGets();
    render(<AdmissionsPage />);

    expect(
      await screen.findByRole("button", { name: /Admit Patient/i }),
    ).toBeInTheDocument();
  });

  it("DOCTOR sees the 'Admit Patient' CTA", async () => {
    asDoctor();
    wireDefaultGets();
    render(<AdmissionsPage />);

    expect(
      await screen.findByRole("button", { name: /Admit Patient/i }),
    ).toBeInTheDocument();
  });

  it("RECEPTION sees the 'Admit Patient' CTA", async () => {
    asReception();
    wireDefaultGets();
    render(<AdmissionsPage />);

    expect(
      await screen.findByRole("button", { name: /Admit Patient/i }),
    ).toBeInTheDocument();
  });

  it("NURSE can view the page but does NOT see the 'Admit Patient' CTA", async () => {
    asNurse();
    wireDefaultGets();
    render(<AdmissionsPage />);

    // Wait for wards GET so the canAdmit branch resolves before assertion.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/admissions?status=ADMITTED"));
    // Use findAll because the row appears in BOTH desktop + mobile views.
    expect((await screen.findAllByText("ADM-2026-001")).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.queryByRole("button", { name: /Admit Patient/i }),
    ).not.toBeInTheDocument();
  });

  // ── Row rendering ──────────────────────────────────────────────────────

  it("renders an ADMITTED row with admission#, patient link, ward/bed, status pill, and 'Pending diagnosis'", async () => {
    wireDefaultGets();
    render(<AdmissionsPage />);

    // Row content duplicates across desktop + mobile views.
    expect((await screen.findAllByText("ADM-2026-001")).length).toBeGreaterThanOrEqual(1);

    // Patient-name link in row → patient detail (with `from=admissions`
    // back-marker). Separate from the "View Chart" action link, which
    // goes to the admission detail.
    const patientLinks = screen.getAllByRole("link", { name: "Ramesh Kumar" });
    expect(patientLinks.length).toBeGreaterThanOrEqual(1);
    expect(patientLinks[0]).toHaveAttribute(
      "href",
      "/dashboard/patients/pat-1?from=admissions",
    );
    // MR shown under the name
    expect(screen.getAllByText("MR-001").length).toBeGreaterThanOrEqual(1);
    // Ward / Bed bedNumber appears in row cells.
    expect(screen.getAllByText(/B-101/).length).toBeGreaterThanOrEqual(1);
    // Status pill
    expect(screen.getAllByText(/^ADMITTED$/).length).toBeGreaterThanOrEqual(1);
    // Pending diagnosis surrogate (diagnosis: null)
    expect(screen.getAllByText(/Pending diagnosis/i).length).toBeGreaterThanOrEqual(1);
    // "View Chart" action link to the same detail route (desktop only — mobile
    // view of DataTable omits the actions column, so this is 1 occurrence).
    const view = screen.getAllByRole("link", { name: /View Chart/i });
    expect(view.length).toBeGreaterThanOrEqual(1);
    expect(view[0]).toHaveAttribute("href", "/dashboard/admissions/adm-1");
  });

  it("renders the literal diagnosis when present (no 'Pending diagnosis' surrogate)", async () => {
    wireDefaultGets({
      admissions: [
        admissionFixture({
          id: "adm-dx",
          admissionNumber: "ADM-2026-DX",
          diagnosis: "Pneumonia",
        }),
      ],
    });
    render(<AdmissionsPage />);

    expect((await screen.findAllByText("ADM-2026-DX")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Pneumonia$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Pending diagnosis/i)).not.toBeInTheDocument();
  });

  it("renders the DISCHARGED status pill for a discharged row", async () => {
    wireDefaultGets({
      admissions: [
        admissionFixture({
          id: "adm-d",
          admissionNumber: "ADM-2026-DIS",
          status: "DISCHARGED",
          dischargedAt: today.toISOString(),
        }),
      ],
    });
    render(<AdmissionsPage />);

    expect((await screen.findAllByText("ADM-2026-DIS")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^DISCHARGED$/).length).toBeGreaterThanOrEqual(1);
  });

  // ── Tab switching ───────────────────────────────────────────────────────

  it("clicking each tab refetches /admissions with the right querystring", async () => {
    wireDefaultGets({ admissions: [] });
    render(<AdmissionsPage />);

    // Initial: ADMITTED tab → ?status=ADMITTED
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/admissions?status=ADMITTED"),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Discharged$/ }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/admissions?status=DISCHARGED"),
    );

    fireEvent.click(screen.getByRole("button", { name: /^All$/ }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/admissions"),
    );
  });

  // ── Bed availability branch (Issue #16) ─────────────────────────────────

  it("when wards report zero AVAILABLE beds: header CTA is disabled / aria-disabled true", async () => {
    wireDefaultGets({
      wards: [
        wardFixture({
          beds: [
            { id: "b-1", bedNumber: "B-1", status: "OCCUPIED", ward: { id: "w-1", name: "General Ward" } },
            { id: "b-2", bedNumber: "B-2", status: "OCCUPIED", ward: { id: "w-1", name: "General Ward" } },
          ],
        }),
      ],
    });
    render(<AdmissionsPage />);

    // Wait for wards GET to populate so canAdmit logic resolves.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/wards"));

    const cta = await screen.findByRole("button", { name: /Admit Patient/i });
    await waitFor(() => expect(cta).toBeDisabled());
    expect(cta).toHaveAttribute("aria-disabled", "true");
    expect(cta).toHaveAttribute("title", expect.stringMatching(/No beds available/i));
    // The "no beds" pill badge on the CTA renders.
    expect(screen.getByText(/^no beds$/)).toBeInTheDocument();
  });

  it("empty-state action label flips to 'No beds available' and clicking it toasts.warning", async () => {
    wireDefaultGets({
      admissions: [],
      wards: [
        wardFixture({
          beds: [
            { id: "b-1", bedNumber: "B-1", status: "OCCUPIED", ward: { id: "w-1", name: "General Ward" } },
          ],
        }),
      ],
    });
    render(<AdmissionsPage />);

    // Wait for wards GET so bedsUnavailable resolves before assertion.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/wards"));

    // Empty-state action button surfaces the "No beds available" label.
    const noBeds = await screen.findByRole("button", { name: /^No beds available$/ });
    expect(noBeds).toBeInTheDocument();

    // Clicking the empty-state action calls toast.warning (it's a regular,
    // enabled <button> — unlike the header CTA which is disabled).
    fireEvent.click(noBeds);
    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(
        expect.stringMatching(/No beds available/i),
      ),
    );
  });

  // ── Modal: open / close / doctors load ──────────────────────────────────

  it("clicking the 'Admit Patient' CTA opens the modal and refreshes /doctors + /wards", async () => {
    wireDefaultGets();
    render(<AdmissionsPage />);

    const cta = await screen.findByRole("button", { name: /Admit Patient/i });

    // Snapshot wards call count BEFORE clicking so we can verify the modal
    // re-fetches them.
    const wardsBefore = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/wards",
    ).length;

    fireEvent.click(cta);

    expect(
      await screen.findByRole("heading", { name: /^Admit Patient$/ }),
    ).toBeInTheDocument();

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/doctors"));

    const wardsAfter = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/wards",
    ).length;
    expect(wardsAfter).toBeGreaterThan(wardsBefore);
  });

  it("Cancel button closes the modal", async () => {
    wireDefaultGets();
    render(<AdmissionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Admit Patient$/ }),
      ).not.toBeInTheDocument(),
    );
  });

  // ── Modal: patient search ───────────────────────────────────────────────

  it("typing < 2 chars does NOT fire /patients (debounce + guard)", async () => {
    wireDefaultGets();
    render(<AdmissionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    const input = screen.getByLabelText(/^Patient$/);
    fireEvent.change(input, { target: { value: "A" } });

    // Wait beyond the 300ms debounce.
    await new Promise((r) => setTimeout(r, 350));
    const patientCalls = apiMock.get.mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith("/patients?"),
    );
    expect(patientCalls.length).toBe(0);
  });

  it("typing >= 2 chars fires the debounced /patients call", async () => {
    wireDefaultGets({ patients: [patientFixture()] });
    render(<AdmissionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    fireEvent.change(screen.getByLabelText(/^Patient$/), {
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

    expect(await screen.findByText(/Anita Singh/)).toBeInTheDocument();
  });

  it("selecting a patient swaps the input for the selected display + a 'Change' button", async () => {
    wireDefaultGets({ patients: [patientFixture()] });
    render(<AdmissionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    fireEvent.change(screen.getByLabelText(/^Patient$/), {
      target: { value: "An" },
    });

    const row = await screen.findByText(/Anita Singh/);
    fireEvent.click(row.closest("button")!);

    // Selected display
    expect(screen.getByText(/Anita Singh/)).toBeInTheDocument();
    expect(screen.getByText(/MR-SEARCH/)).toBeInTheDocument();
    // Change resets back to the input.
    fireEvent.click(screen.getByRole("button", { name: /^Change$/ }));

    await waitFor(() =>
      expect(screen.getByLabelText(/^Patient$/)).toBeInTheDocument(),
    );
  });

  it("/patients rejection sets the result list back to empty (no uncaught)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/admissions")) return Promise.resolve({ data: [] });
      if (url === "/wards") return Promise.resolve({ data: [wardFixture()] });
      if (url === "/doctors") return Promise.resolve({ data: [doctorFixture()] });
      if (url.startsWith("/patients?"))
        return Promise.reject(new Error("search boom"));
      return Promise.resolve({ data: [] });
    });

    render(<AdmissionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    fireEvent.change(screen.getByLabelText(/^Patient$/), {
      target: { value: "An" },
    });

    await new Promise((r) => setTimeout(r, 350));
    // No selected display rendered.
    expect(screen.queryByRole("button", { name: /^Change$/ })).not.toBeInTheDocument();
  });

  // ── Submit guards ───────────────────────────────────────────────────────

  it("submit without a selected patient toasts an error and does not POST", async () => {
    wireDefaultGets();
    const { container } = render(<AdmissionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    submitModalForm(container);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Select a patient"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submit without a doctor toasts an error and does not POST", async () => {
    wireDefaultGets({ patients: [patientFixture()] });
    const { container } = render(<AdmissionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    // Pick a patient first.
    fireEvent.change(screen.getByLabelText(/^Patient$/), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita Singh/);
    fireEvent.click(row.closest("button")!);

    submitModalForm(container);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Select a doctor"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submit without a bed toasts an error and does not POST", async () => {
    wireDefaultGets({ patients: [patientFixture()] });
    const { container } = render(<AdmissionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    fireEvent.change(screen.getByLabelText(/^Patient$/), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita Singh/);
    fireEvent.click(row.closest("button")!);

    // Doctor select — option text is "Dr. Mehta — Internal Medicine".
    await screen.findByText(/Dr\. Mehta — Internal Medicine/i);
    fireEvent.change(screen.getByLabelText(/^Doctor$/), {
      target: { value: "doc-1" },
    });

    submitModalForm(container);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Select a bed"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submit without a reason toasts an error and does not POST", async () => {
    wireDefaultGets({ patients: [patientFixture()] });
    const { container } = render(<AdmissionsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    fireEvent.change(screen.getByLabelText(/^Patient$/), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita Singh/);
    fireEvent.click(row.closest("button")!);

    await screen.findByText(/Dr\. Mehta — Internal Medicine/i);
    fireEvent.change(screen.getByLabelText(/^Doctor$/), {
      target: { value: "doc-1" },
    });

    // Bed select — value is "bed-2" (an AVAILABLE one from wardFixture).
    fireEvent.change(screen.getByTestId("admit-bed-select"), {
      target: { value: "bed-2" },
    });

    submitModalForm(container);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Enter a reason for admission",
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ── Happy POST ──────────────────────────────────────────────────────────

  it("happy POST — sends the right body, closes the modal, and refetches the list", async () => {
    wireDefaultGets({ patients: [patientFixture()] });
    apiMock.post.mockResolvedValue({ data: { id: "adm-new" } });

    const { container } = render(<AdmissionsPage />);

    // Snapshot admissions call count BEFORE submit to verify refetch.
    const before = apiMock.get.mock.calls.filter((c: any[]) =>
      String(c[0]).startsWith("/admissions"),
    ).length;

    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    // Patient
    fireEvent.change(screen.getByLabelText(/^Patient$/), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita Singh/);
    fireEvent.click(row.closest("button")!);

    // Doctor
    await screen.findByText(/Dr\. Mehta — Internal Medicine/i);
    fireEvent.change(screen.getByLabelText(/^Doctor$/), {
      target: { value: "doc-1" },
    });

    // Bed
    fireEvent.change(screen.getByTestId("admit-bed-select"), {
      target: { value: "bed-2" },
    });

    // Reason + diagnosis
    fireEvent.change(screen.getByLabelText(/Reason for Admission/i), {
      target: { value: "Severe abdominal pain" },
    });
    fireEvent.change(screen.getByLabelText(/Diagnosis \(optional\)/i), {
      target: { value: "Suspected appendicitis" },
    });

    submitModalForm(container);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/admissions");
    expect(body).toMatchObject({
      patientId: "pat-search-1",
      doctorId: "doc-1",
      bedId: "bed-2",
      reason: "Severe abdominal pain",
      diagnosis: "Suspected appendicitis",
    });

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Patient admitted"),
    );

    // Modal closes.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Admit Patient$/ }),
      ).not.toBeInTheDocument(),
    );

    // Refetch fires.
    await waitFor(() => {
      const after = apiMock.get.mock.calls.filter((c: any[]) =>
        String(c[0]).startsWith("/admissions"),
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("happy POST without a diagnosis sends diagnosis: undefined (optional pruned)", async () => {
    wireDefaultGets({ patients: [patientFixture()] });
    apiMock.post.mockResolvedValue({ data: { id: "adm-new" } });

    const { container } = render(<AdmissionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    fireEvent.change(screen.getByLabelText(/^Patient$/), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita Singh/);
    fireEvent.click(row.closest("button")!);

    await screen.findByText(/Dr\. Mehta — Internal Medicine/i);
    fireEvent.change(screen.getByLabelText(/^Doctor$/), {
      target: { value: "doc-1" },
    });
    fireEvent.change(screen.getByTestId("admit-bed-select"), {
      target: { value: "bed-2" },
    });
    fireEvent.change(screen.getByLabelText(/Reason for Admission/i), {
      target: { value: "Observation" },
    });

    submitModalForm(container);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0];
    expect(body.diagnosis).toBeUndefined();
  });

  // ── POST error paths ────────────────────────────────────────────────────

  it("POST rejection with Error surfaces toast.error(err.message), modal stays open", async () => {
    wireDefaultGets({ patients: [patientFixture()] });
    apiMock.post.mockRejectedValue(new Error("bed already taken"));

    const { container } = render(<AdmissionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    fireEvent.change(screen.getByLabelText(/^Patient$/), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita Singh/);
    fireEvent.click(row.closest("button")!);

    await screen.findByText(/Dr\. Mehta — Internal Medicine/i);
    fireEvent.change(screen.getByLabelText(/^Doctor$/), {
      target: { value: "doc-1" },
    });
    fireEvent.change(screen.getByTestId("admit-bed-select"), {
      target: { value: "bed-2" },
    });
    fireEvent.change(screen.getByLabelText(/Reason for Admission/i), {
      target: { value: "Acute pain" },
    });

    submitModalForm(container);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("bed already taken"),
    );
    // Modal stays open.
    expect(
      screen.getByRole("heading", { name: /^Admit Patient$/ }),
    ).toBeInTheDocument();
  });

  it("POST rejection with non-Error falls back to 'Admission failed'", async () => {
    wireDefaultGets({ patients: [patientFixture()] });
    apiMock.post.mockRejectedValue("string rejection");

    const { container } = render(<AdmissionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    fireEvent.change(screen.getByLabelText(/^Patient$/), {
      target: { value: "An" },
    });
    const row = await screen.findByText(/Anita Singh/);
    fireEvent.click(row.closest("button")!);

    await screen.findByText(/Dr\. Mehta — Internal Medicine/i);
    fireEvent.change(screen.getByLabelText(/^Doctor$/), {
      target: { value: "doc-1" },
    });
    fireEvent.change(screen.getByTestId("admit-bed-select"), {
      target: { value: "bed-2" },
    });
    fireEvent.change(screen.getByLabelText(/Reason for Admission/i), {
      target: { value: "Test" },
    });

    submitModalForm(container);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Admission failed"),
    );
  });

  // ── Error-path resilience ──────────────────────────────────────────────

  it("swallows GET /admissions rejection and still mounts the page", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/admissions"))
        return Promise.reject(new Error("admissions boom"));
      if (url === "/wards") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    render(<AdmissionsPage />);
    // Header still renders.
    expect(
      await screen.findByRole("heading", { name: /Admissions/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it("swallows GET /wards rejection (badge stays at zero, no crash)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/admissions")) return Promise.resolve({ data: [] });
      if (url === "/wards") return Promise.reject(new Error("wards boom"));
      return Promise.resolve({ data: [] });
    });

    render(<AdmissionsPage />);
    // Header renders, CTA renders without crashing (wards=[] → hasBedCensus
    // false → CTA enabled, bedsUnavailable false).
    expect(
      await screen.findByRole("button", { name: /Admit Patient/i }),
    ).toBeInTheDocument();
  });

  it("swallows GET /doctors rejection — modal still opens with empty doctor select", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/admissions")) return Promise.resolve({ data: [] });
      if (url === "/wards") return Promise.resolve({ data: [wardFixture()] });
      if (url === "/doctors") return Promise.reject(new Error("doctors boom"));
      return Promise.resolve({ data: [] });
    });

    render(<AdmissionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Admit Patient/i }));
    await screen.findByRole("heading", { name: /^Admit Patient$/ });

    // Doctor placeholder still renders.
    expect(screen.getByText(/Select Doctor/i)).toBeInTheDocument();
  });
});
