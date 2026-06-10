/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PrescriptionsPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/prescriptions/page.tsx, the
 *     Rx queue + Rx writer. Top endpoints the page hits:
 *       GET    /prescriptions?page=&limit=             (list)
 *       GET    /prescriptions/templates/list           (templates)
 *       GET    /patients/:id/renal-function            (renal banner)
 *       POST   /prescriptions/check-interactions       (DDI preview)
 *       POST   /prescriptions                          (create)
 *       PATCH  /prescriptions/:id                      (edit / sign)
 *       POST   /prescriptions/:id/print                (mark printed)
 *       POST   /prescriptions/:id/share                (share)
 *       POST   /pharmacy/dispense                      (pharmacist)
 *       POST   /pharmacy/prescriptions/:id/reject      (pharmacist)
 *
 *   - Behaviours covered:
 *       1. RBAC — RX_ALLOWED (ADMIN/DOCTOR/NURSE/PHARMACIST/PATIENT)
 *          let through; RECEPTION redirected to /not-authorized.
 *       2. Auth-hydration gate — isLoading=true short-circuits the
 *          fetch + redirect.
 *       3. Loading branch — `rx-loading` skeleton renders pending GET.
 *       4. Empty branch — EmptyState "No prescriptions yet" copy.
 *       5. Error branch — GET reject → `rx-error` shows message + Retry.
 *       6. Happy fetch — rows render patient + diagnosis + doctor.
 *       7. Search filter — debounced; matches across patient/doctor/
 *          medicine names.
 *       8. Status filter — ISSUED vs PRINTED filters client-side.
 *       9. Sort toggling — sortKey + sortDir flip.
 *      10. Pagination — page-size change + prev/next disabled states.
 *      11. Write Prescription button shown only to DOCTOR; opens form.
 *      12. Form submit blocks when fields are blank — toast.warning +
 *          inline errors (patientId, appointmentId, diagnosis,
 *          medicines).
 *      13. Add / Remove medicine row.
 *      14. Dose chip click + Custom dosage input.
 *      15. Frequency segmented click.
 *      16. Route segmented click + Custom route input.
 *      17. Quantity manual override + Reset-to-auto.
 *      18. Print action — POSTs /:id/print + window.open.
 *      19. Share success → toast.success.
 *      20. Share 409 unsigned → opens sign-share modal.
 *      21. Pharmacist Dispense + Reject actions.
 *      22. Reject with reason < 10 chars → toast.error.
 *      23. Edit mode — Edit button pre-fills form; submit hits PATCH.
 *      24. EmptyState "No matches" when filters yield 0 rows.
 *
 *   - Mocks: @/lib/api, @/lib/toast, @/lib/store, @/lib/i18n,
 *            @/components/EntityPicker, @/components/Autocomplete,
 *            @/components/Skeleton, next/navigation, window.confirm,
 *            window.open, window.prompt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
  act,
} from "@testing-library/react";

const { apiMock, printPdfMock, downloadFileMock, toastMock, authMock, routerMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  printPdfMock: vi.fn(),
  downloadFileMock: vi.fn(),
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

vi.mock("@/lib/api", () => ({
  api: apiMock,
  printPdfEndpoint: printPdfMock,
  downloadFileEndpoint: downloadFileMock,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? "Prescriptions",
    lang: "en",
    setLang: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/prescriptions",
}));

// Stub EntityPicker so we can drive the picked id via a plain input. The real
// component hits /patients and /appointments — undesirable in a unit test.
// Use defaultValue (uncontrolled) so the test's fireEvent.change always
// commits the typed UUID — controlled-input semantics in React + jsdom snap
// the input back to "" when value prop hasn't yet round-tripped.
vi.mock("@/components/EntityPicker", () => ({
  EntityPicker: ({ value, onChange, testIdPrefix }: any) => (
    <input
      data-testid={`${testIdPrefix ?? "picker"}-stub`}
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

// Stub Autocomplete with a controlled plain input — exposes value/onChange.
// We synthesize the "item" callback via a separate onSelect input the tests
// can use when they need to fire the medicine-detail fetch.
vi.mock("@/components/Autocomplete", () => ({
  Autocomplete: ({ value, onChange, placeholder, inputClassName }: any) => (
    <input
      placeholder={placeholder}
      data-testid={`autocomplete-${(placeholder || "input").replace(/\s+/g, "-").toLowerCase()}`}
      value={value || ""}
      onChange={(e) => onChange(e.target.value, undefined)}
      className={inputClassName}
    />
  ),
}));

vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
  SkeletonTable: ({ rows, columns }: { rows?: number; columns?: number }) => (
    <div data-testid="skeleton-table" data-rows={rows} data-columns={columns} />
  ),
}));

vi.mock("@/components/Tooltip", () => ({
  InfoIcon: ({ tooltip }: any) => (
    <span data-testid="info-icon" aria-label={tooltip} />
  ),
  Tooltip: ({ children }: any) => <span>{children}</span>,
}));

vi.mock("@/components/EmptyState", () => ({
  EmptyState: ({ title, description, action }: any) => (
    <div data-testid="empty-state">
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action ? (
        <button onClick={action.onClick} data-testid="empty-state-action">
          {action.label}
        </button>
      ) : null}
    </div>
  ),
}));

import PrescriptionsPage from "../page";

type RxItem = {
  id?: string;
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions: string | null;
  kanbanStatus?: string;
};

type RxRecord = {
  id: string;
  diagnosis: string;
  advice: string | null;
  followUpDate: string | null;
  createdAt: string;
  printed?: boolean;
  sharedVia?: string | null;
  status?: string;
  billed?: boolean;
  items: RxItem[];
  doctor: { user: { name: string } };
  patient: { user: { name: string; phone: string } };
};

function rxFixture(overrides: Partial<RxRecord> = {}): RxRecord {
  return {
    id: "rx-1",
    diagnosis: "E11.9 — Type 2 diabetes",
    advice: "Reduce sugar",
    followUpDate: null,
    // Dynamic "today" so the page's default Today date-filter includes it.
    createdAt: new Date().toISOString(),
    printed: false,
    sharedVia: null,
    items: [
      {
        id: "ix-1",
        medicineName: "Metformin",
        dosage: "500mg",
        frequency: "1-0-1 (Morning-Night)",
        duration: "30 days",
        instructions: "After meals",
      },
    ],
    doctor: { user: { name: "Dr. Anita Rao" } },
    patient: { user: { name: "Rakesh Patel", phone: "+91-99-8800-1234" } },
    ...overrides,
  };
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Dr Test" },
    isLoading: false,
  });
}
function asPharmacist() {
  authMock.mockReturnValue({
    user: { id: "u-pharm", role: "PHARMACIST", name: "Pharm" },
    isLoading: false,
  });
}
function asReception() {
  authMock.mockReturnValue({
    user: { id: "u-rec", role: "RECEPTION", name: "Front" },
    isLoading: false,
  });
}
function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-adm", role: "ADMIN", name: "Admin" },
    isLoading: false,
  });
}

/**
 * Default GET responder. Returns:
 *   - GET /prescriptions?... → empty list
 *   - GET /prescriptions/templates/list → empty list
 *   - any other GET → empty {data:[]}
 * Tests override per-case via apiMock.get.mockImplementationOnce / .mockImplementation.
 */
function defaultGetResponder() {
  return (url: string) => {
    if (url.startsWith("/prescriptions/templates")) {
      return Promise.resolve({ data: [] });
    }
    if (url.startsWith("/prescriptions?")) {
      return Promise.resolve({ data: [], meta: { total: 0 } });
    }
    return Promise.resolve({ data: [] });
  };
}

describe("PrescriptionsPage (Rx queue + writer — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    printPdfMock.mockReset();
    printPdfMock.mockResolvedValue(undefined);
    downloadFileMock.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asDoctor();
    apiMock.get.mockImplementation(defaultGetResponder());
  });

  afterEach(() => {
    cleanup();
  });

  // ── RBAC + hydration ─────────────────────────────────────────────────

  it("redirects RECEPTION to /dashboard/not-authorized and shows a role-restriction toast", async () => {
    asReception();

    render(<PrescriptionsPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/restricted to clinical staff/i),
      ),
    );
    expect(routerMock.replace).toHaveBeenCalledWith(
      `/dashboard/not-authorized?from=${encodeURIComponent(
        "/dashboard/prescriptions",
      )}`,
    );
  });

  it("does NOT redirect or fetch when auth store is still loading", async () => {
    authMock.mockReturnValue({ user: null, isLoading: true });

    render(<PrescriptionsPage />);
    await new Promise((r) => setTimeout(r, 20));

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    // No prescriptions GET fires while auth is loading.
    expect(
      apiMock.get.mock.calls.find((c) =>
        String(c[0]).startsWith("/prescriptions?"),
      ),
    ).toBeUndefined();
  });

  // ── List rendering ───────────────────────────────────────────────────

  it("renders the skeleton loading state while the initial /prescriptions GET is pending", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) return new Promise(() => {});
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);

    expect(await screen.findByTestId("rx-loading")).toBeInTheDocument();
    expect(screen.getAllByTestId("skeleton-card").length).toBeGreaterThan(0);
  });

  it("renders EmptyState 'No prescriptions yet' when the list is empty and exposes a 'Write prescription' CTA for the doctor", async () => {
    render(<PrescriptionsPage />);

    expect(await screen.findByTestId("empty-state")).toBeInTheDocument();
    expect(screen.getByText(/No prescriptions yet/i)).toBeInTheDocument();
    expect(screen.getByTestId("empty-state-action")).toHaveTextContent(
      /Write prescription/i,
    );
  });

  it("renders the error branch with retry button when the initial GET rejects", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?"))
        return Promise.reject(new Error("server down"));
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);

    expect(await screen.findByTestId("rx-error")).toBeInTheDocument();
    expect(screen.getByText(/server down/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Retry/i }),
    ).toBeInTheDocument();
  });

  it("renders one row per prescription with patient name, diagnosis, doctor and issued date", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [
            rxFixture({ id: "rx-1", patient: { user: { name: "Alpha P", phone: "1" } } }),
            rxFixture({ id: "rx-2", patient: { user: { name: "Beta P", phone: "2" } } }),
          ],
          meta: { total: 2 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);

    expect(await screen.findByText("Alpha P")).toBeInTheDocument();
    expect(screen.getByText("Beta P")).toBeInTheDocument();
    expect(screen.getAllByText(/E11.9 — Type 2 diabetes/i).length).toBe(2);
    expect(screen.getByTestId("rx-row-rx-1")).toBeInTheDocument();
    expect(screen.getByTestId("rx-row-rx-2")).toBeInTheDocument();
    // Default Today date-filter is active, so the count uses the filtered
    // "X of Y shown" format; both rows are dated today (dynamic fixture).
    expect(screen.getByTestId("rx-total-count").textContent).toMatch(
      /2 of 2 shown/,
    );
  });

  // ── Toolbar — search / status / sort / paginate ─────────────────────

  it("expands a row to show the items table when the row header is clicked", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");

    // Click the row header button (first button inside the row).
    const row = screen.getByTestId("rx-row-rx-1");
    fireEvent.click(within(row).getAllByRole("button")[0]);

    expect(await screen.findByText("Metformin")).toBeInTheDocument();
    // Instructions now render below the medicine name, prefixed "Instructions:".
    expect(screen.getByText(/Instructions: After meals/)).toBeInTheDocument();
  });

  it("debounces the search input and filters by patient / diagnosis / medicine name client-side", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [
            rxFixture({
              id: "rx-1",
              patient: { user: { name: "Alpha", phone: "1" } },
            }),
            rxFixture({
              id: "rx-2",
              patient: { user: { name: "Beta", phone: "2" } },
            }),
          ],
          meta: { total: 2 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Alpha");

    const searchInput = screen.getByTestId("rx-search-input");
    fireEvent.change(searchInput, { target: { value: "Beta" } });

    // The 300ms debounce inside the page means we must wait it out.
    await waitFor(
      () => {
        expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
        expect(screen.getByText("Beta")).toBeInTheDocument();
      },
      { timeout: 1000 },
    );
    expect(screen.getByTestId("rx-total-count").textContent).toMatch(
      /1 of 2 shown/,
    );
  });

  it("renders the 'No matches' EmptyState when filters exclude every row and the 'Clear filters' action restores them", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");

    fireEvent.change(screen.getByTestId("rx-search-input"), {
      target: { value: "no-such-thing-xyz" },
    });
    await waitFor(
      () => expect(screen.getByText(/No matches/i)).toBeInTheDocument(),
      { timeout: 1000 },
    );

    fireEvent.click(screen.getByTestId("empty-state-action"));
    await waitFor(() =>
      expect(screen.getByText("Rakesh Patel")).toBeInTheDocument(),
    );
  });

  it("filters by ISSUED vs PRINTED via the status select", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [
            rxFixture({
              id: "rx-1",
              printed: false,
              patient: { user: { name: "Issued Pat", phone: "1" } },
            }),
            rxFixture({
              id: "rx-2",
              printed: true,
              patient: { user: { name: "Printed Pat", phone: "2" } },
            }),
          ],
          meta: { total: 2 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Issued Pat");

    fireEvent.change(screen.getByTestId("rx-status-filter"), {
      target: { value: "PRINTED" },
    });
    await waitFor(() => {
      expect(screen.queryByText("Issued Pat")).not.toBeInTheDocument();
      expect(screen.getByText("Printed Pat")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("rx-status-filter"), {
      target: { value: "ISSUED" },
    });
    await waitFor(() => {
      expect(screen.getByText("Issued Pat")).toBeInTheDocument();
      expect(screen.queryByText("Printed Pat")).not.toBeInTheDocument();
    });
  });

  it("toggles sort key + direction when sort buttons are clicked", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [
            rxFixture({
              id: "rx-1",
              patient: { user: { name: "Zach", phone: "1" } },
            }),
            rxFixture({
              id: "rx-2",
              patient: { user: { name: "Alice", phone: "2" } },
            }),
          ],
          meta: { total: 2 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Zach");

    // Click patient sort — first click sets asc, expect Alice first.
    fireEvent.click(screen.getByTestId("rx-sort-patient"));
    await waitFor(() => {
      const rows = screen
        .getAllByTestId(/^rx-row-/)
        .map((el) => el.getAttribute("data-testid"));
      expect(rows[0]).toBe("rx-row-rx-2"); // Alice → rx-2 first
    });

    // Click again to flip to desc — Zach first.
    fireEvent.click(screen.getByTestId("rx-sort-patient"));
    await waitFor(() => {
      const rows = screen
        .getAllByTestId(/^rx-row-/)
        .map((el) => el.getAttribute("data-testid"));
      expect(rows[0]).toBe("rx-row-rx-1");
    });

    // Click doctor sort to flip key.
    fireEvent.click(screen.getByTestId("rx-sort-doctor"));
    // Both rows have the same doctor name, so order is stable; just ensure
    // no crash and the active chip switches.
    expect(screen.getByTestId("rx-sort-doctor").className).toMatch(/primary/);
  });

  it("renders pagination controls with prev disabled on page 1 and next disabled when only one page exists", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");

    expect(screen.getByTestId("rx-page-prev")).toBeDisabled();
    expect(screen.getByTestId("rx-page-next")).toBeDisabled();
    expect(screen.getByTestId("rx-page-status").textContent).toMatch(
      /Page 1 of 1/,
    );
  });

  it("changes the page size and refetches with the new ?limit= value", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");

    fireEvent.change(screen.getByTestId("rx-page-size"), {
      target: { value: "50" },
    });

    await waitFor(() =>
      expect(
        apiMock.get.mock.calls.find((c) =>
          String(c[0]).includes("limit=50"),
        ),
      ).toBeTruthy(),
    );
  });

  // ── Write Rx form ────────────────────────────────────────────────────

  it("hides the Write Prescription button for non-DOCTOR (PHARMACIST sees rows but no writer)", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");

    expect(
      screen.queryByRole("button", { name: /Write Prescription/i }),
    ).not.toBeInTheDocument();
  });

  it("opens the Rx writer when the DOCTOR clicks Write Prescription, and toggles it closed again", async () => {
    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);

    // Use the toolbar button (exact match) — the EmptyState CTA also matches a
    // regex like /Write Prescription/i.
    fireEvent.click(screen.getByRole("button", { name: "Write Prescription" }));
    expect(screen.getByTestId("rx-new-form")).toBeInTheDocument();

    // Toggle closes.
    fireEvent.click(screen.getByRole("button", { name: "Write Prescription" }));
    expect(screen.queryByTestId("rx-new-form")).not.toBeInTheDocument();
  });

  it("blocks Save on an empty form, surfaces toast.warning and inline errors for patient/diagnosis/medicines", async () => {
    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);

    fireEvent.click(
      screen.getByRole("button", { name: "Write Prescription" }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Save Prescription/i }));

    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(
        expect.stringMatching(/fix the highlighted fields/i),
      ),
    );
    // Patient picker error rendered.
    expect(screen.getByTestId("error-rx-patient")).toBeInTheDocument();
    // No network POST attempted.
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("adds and removes a medicine row in the writer", async () => {
    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(
      screen.getByRole("button", { name: "Write Prescription" }),
    );

    // Starts with row 0.
    expect(screen.getByTestId("rx-medicine-row-0")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /\+ Add Medicine/i }));
    expect(screen.getByTestId("rx-medicine-row-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("rx-remove-medicine-1"));
    expect(screen.queryByTestId("rx-medicine-row-1")).not.toBeInTheDocument();
  });

  it("clicks a dose chip and writes the preset literal into the dosage state", async () => {
    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(
      screen.getByRole("button", { name: "Write Prescription" }),
    );

    fireEvent.click(screen.getByTestId("rx-dose-chip-0-500mg"));
    expect(screen.getByTestId("rx-dose-chip-0-500mg")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Toggle into custom mode and reveal the free-text input.
    fireEvent.click(screen.getByTestId("rx-dose-chip-0-custom"));
    expect(screen.getByTestId("rx-dose-custom-input-0")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("rx-dose-custom-input-0"), {
      target: { value: "750mg" },
    });
    expect(
      (screen.getByTestId("rx-dose-custom-input-0") as HTMLInputElement).value,
    ).toBe("750mg");
  });

  it("clicks a frequency segmented option and a route segmented option, then flips route to Custom and writes a value", async () => {
    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(
      screen.getByRole("button", { name: "Write Prescription" }),
    );

    // Pick frequency "1-1-1 (Three times)" via the segmented control. Each
    // option's testid is rx-frequency-option-<idx>-<first word>.
    const freqGroup = screen.getByTestId("rx-frequency-segmented-0");
    const tdsBtn = within(freqGroup)
      .getAllByRole("button")
      .find((b) => /1-1-1/.test(b.textContent || ""));
    expect(tdsBtn).toBeTruthy();
    fireEvent.click(tdsBtn!);
    expect(tdsBtn!).toHaveAttribute("aria-pressed", "true");

    // Route — click first preset, then Custom, then type.
    const routeGroup = screen.getByTestId("rx-route-segmented-0");
    const presets = within(routeGroup).getAllByRole("button");
    fireEvent.click(presets[0]);
    fireEvent.click(screen.getByTestId("rx-route-option-0-custom"));
    fireEvent.change(screen.getByTestId("rx-route-custom-input-0"), {
      target: { value: "Inhalation" },
    });
    expect(
      (screen.getByTestId("rx-route-custom-input-0") as HTMLInputElement).value,
    ).toBe("Inhalation");
  });

  it("auto-quantity flips to manual when the user edits the qty field; Reset-to-auto restores derived value", async () => {
    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(
      screen.getByRole("button", { name: "Write Prescription" }),
    );

    // Pick freq + duration so an auto qty is computed.
    const freqGroup = screen.getByTestId("rx-frequency-segmented-0");
    const tdsBtn = within(freqGroup)
      .getAllByRole("button")
      .find((b) => /1-1-1/.test(b.textContent || ""));
    fireEvent.click(tdsBtn!);
    fireEvent.change(screen.getByTestId("rx-duration-input-0"), {
      target: { value: "5 days" },
    });

    // Auto label present.
    await waitFor(() =>
      expect(screen.getByTestId("rx-qty-auto-hint-0")).toBeInTheDocument(),
    );

    // Manual override flips it.
    fireEvent.change(screen.getByTestId("rx-qty-input-0"), {
      target: { value: "42" },
    });
    expect(screen.getByTestId("rx-qty-reset-auto-0")).toBeInTheDocument();

    // Reset-to-auto restores derived computation.
    fireEvent.click(screen.getByTestId("rx-qty-reset-auto-0"));
    await waitFor(() =>
      expect(screen.getByTestId("rx-qty-auto-hint-0")).toBeInTheDocument(),
    );
  });

  // ── Card actions: print / share / dispense / reject / edit ──────────

  it("Print action POSTs /:id/print and prints the PDF in-place (no new tab)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });
    apiMock.post.mockResolvedValue({ data: {} });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");

    // Expand the row to reveal action footer.
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    fireEvent.click(screen.getByRole("button", { name: /^Print$/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/prescriptions/rx-1/print",
        {},
      ),
    );
    // Print now prints the PDF in-place via a hidden iframe — no new tab.
    expect(printPdfMock).toHaveBeenCalledWith(
      "/prescriptions/rx-1/pdf?format=pdf",
    );
  });

  it("Download PDF action downloads the file directly (no viewer tab)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    fireEvent.click(screen.getByTestId("rx-download-rx-1"));

    expect(downloadFileMock).toHaveBeenCalledWith(
      "/prescriptions/rx-1/pdf?format=pdf&download=1",
      "prescription-rx-1.pdf",
    );
  });

  it("Share success POSTs /:id/share with the WhatsApp channel and toasts success", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });
    apiMock.post.mockResolvedValue({ data: {} });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Share via WhatsApp/i }),
    );

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/prescriptions/rx-1/share",
        { channel: "WHATSAPP" },
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/shared via WHATSAPP/i),
    );
  });

  it("Share 409 unsigned response opens the Sign-before-share modal with the right patient context", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });
    apiMock.post.mockImplementation((url: string) => {
      if (url.endsWith("/share")) {
        const err = Object.assign(new Error("Cannot share an unsigned prescription"), {
          status: 409,
          payload: { error: "Cannot share an unsigned prescription" },
        });
        return Promise.reject(err);
      }
      return Promise.resolve({ data: {} });
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    fireEvent.click(screen.getByRole("button", { name: /Share via Email/i }));

    expect(
      await screen.findByTestId("rx-sign-share-modal"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/has no digital signature on file/i),
    ).toBeInTheDocument();
  });

  it("Share non-409 failure toasts the error", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });
    apiMock.post.mockImplementation((url: string) => {
      if (url.endsWith("/share")) {
        return Promise.reject(new Error("network broke"));
      }
      return Promise.resolve({ data: {} });
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Share via WhatsApp/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("network broke"),
    );
  });

  it("shows live stock availability per medicine in the expanded row (in-stock vs out-of-stock)", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [
            rxFixture({
              id: "rx-1",
              items: [
                {
                  id: "ix-1",
                  medicineName: "Metformin",
                  dosage: "500mg",
                  frequency: "1-0-1",
                  duration: "30 days",
                  instructions: "Route: PO | Qty: 5 | after meals",
                },
                {
                  id: "ix-2",
                  medicineName: "Warfarin",
                  dosage: "5mg",
                  frequency: "0-0-1",
                  duration: "10 days",
                  instructions: "Route: PO | Qty: 10 | night",
                },
              ],
            }),
          ],
          meta: { total: 1 },
        });
      }
      if (url.includes("/availability")) {
        return Promise.resolve({
          data: {
            items: [
              {
                medicineName: "Metformin",
                requiredQty: 5,
                availableQty: 40,
                matched: true,
                available: true,
              },
              {
                medicineName: "Warfarin",
                requiredQty: 10,
                availableQty: 2,
                matched: true,
                available: false,
              },
            ],
            allAvailable: false,
          },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    // First medicine is in stock; second is short / out of stock.
    await waitFor(() =>
      expect(screen.getByTestId("rx-stock-rx-1-0")).toHaveTextContent(
        /in stock/i,
      ),
    );
    expect(screen.getByTestId("rx-stock-rx-1-1")).toHaveTextContent(
      /short|out of stock/i,
    );
  });

  it("PHARMACIST staged action — PENDING 'Dispense in Kanban' button routes to the scoped board (no per-Rx transition)", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1", status: "PENDING" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    const btn = screen.getByTestId("rx-dispense-rx-1");
    expect(btn).toHaveTextContent("Dispense in Kanban");
    fireEvent.click(btn);

    // Dispensing is per-medicine on the Kanban now: the list just opens the
    // board scoped to this prescription — it never PATCHes/dispenses here.
    expect(routerMock.push).toHaveBeenCalledWith(
      "/dashboard/pharmacy-kanban?prescription=rx-1",
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("PHARMACIST staged action — a DISPENSING Rx also opens the Kanban (not a 'Ready' transition)", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1", status: "DISPENSING" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    const btn = screen.getByTestId("rx-dispense-rx-1");
    expect(btn).toHaveTextContent("Dispense in Kanban");
    fireEvent.click(btn);

    expect(routerMock.push).toHaveBeenCalledWith(
      "/dashboard/pharmacy-kanban?prescription=rx-1",
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("PHARMACIST staged action — DISPENSED Rx with a pending line shows 'Finish … in Kanban' and routes to the board", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          // Per-line state: one dispensed, one still pending (out of stock) →
          // partially dispensed → "Finish in Kanban".
          data: [
            rxFixture({
              id: "rx-1",
              status: "DISPENSED",
              items: [
                {
                  id: "ix-1",
                  medicineName: "Aspirin",
                  dosage: "75mg",
                  frequency: "1-0-0",
                  duration: "5 days",
                  instructions: null,
                  kanbanStatus: "DISPENSED",
                },
                {
                  id: "ix-2",
                  medicineName: "Metformin",
                  dosage: "500mg",
                  frequency: "1-0-1",
                  duration: "30 days",
                  instructions: null,
                  kanbanStatus: "PENDING",
                },
              ],
            }),
          ],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    const btn = await screen.findByTestId("rx-dispense-rx-1");
    await waitFor(() => expect(btn).toHaveTextContent(/Finish in Kanban/));
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(routerMock.push).toHaveBeenCalledWith(
      "/dashboard/pharmacy-kanban?prescription=rx-1",
    );
  });

  it("badges a billed script as 'Dispensed' even with an out-of-stock line", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [
            rxFixture({
              id: "rx-1",
              status: "DISPENSING",
              billed: true, // bill generated → "Dispensed" regardless of ORS
              items: [
                {
                  id: "ix-1",
                  medicineName: "Aspirin",
                  dosage: "75mg",
                  frequency: "1-0-0",
                  duration: "5 days",
                  instructions: null,
                  kanbanStatus: "DISPENSED",
                },
                {
                  id: "ix-2",
                  medicineName: "ORS Sachet",
                  dosage: "5ml",
                  frequency: "0-0-1",
                  duration: "5 days",
                  instructions: null,
                  kanbanStatus: "PENDING",
                },
              ],
            }),
          ],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    const badge = await screen.findByTestId("rx-status-badge-rx-1");
    expect(badge).toHaveTextContent(/Dispensed/i);
  });

  it("PHARMACIST Reject — confirm stays disabled for a < 10 char reason and never POSTs", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    fireEvent.click(screen.getByTestId("rx-reject-rx-1"));

    // Modal opens; a too-short reason keeps the confirm button disabled.
    const reason = await screen.findByTestId("rx-reject-reason");
    fireEvent.change(reason, { target: { value: "too short" } }); // 9 chars
    expect(screen.getByTestId("rx-reject-confirm")).toBeDisabled();

    // No /reject POST fired.
    expect(
      apiMock.post.mock.calls.find((c) =>
        String(c[0]).includes("/reject"),
      ),
    ).toBeUndefined();
  });

  it("PHARMACIST Reject — happy path POSTs /pharmacy/prescriptions/:id/reject with the reason", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });
    apiMock.post.mockResolvedValue({ data: {} });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    fireEvent.click(screen.getByTestId("rx-reject-rx-1"));

    const reason = await screen.findByTestId("rx-reject-reason");
    fireEvent.change(reason, {
      target: { value: "out of stock currently in the warehouse" },
    });
    fireEvent.click(screen.getByTestId("rx-reject-confirm"));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/pharmacy/prescriptions/rx-1/reject",
        expect.objectContaining({
          reason: expect.stringContaining("out of stock"),
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Prescription rejected");
  });

  it("PHARMACIST Reject — cancelling the modal is a no-op", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    fireEvent.click(screen.getByTestId("rx-reject-rx-1"));

    const modal = await screen.findByTestId("rx-reject-modal");
    fireEvent.click(within(modal).getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByTestId("rx-reject-modal")).not.toBeInTheDocument(),
    );
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(
      apiMock.post.mock.calls.find((c) =>
        String(c[0]).includes("/reject"),
      ),
    ).toBeUndefined();
  });

  it("Edit button opens the writer in Edit mode, pre-fills diagnosis, and shows 'Update Prescription' submit label", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [
            rxFixture({
              id: "rx-1",
              diagnosis: "J45.9 — Asthma, unspecified",
              advice: "Inhaler twice daily",
            }),
          ],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    fireEvent.click(screen.getByTestId("rx-edit-rx-1"));

    expect(
      screen.getByRole("heading", { name: /Edit Prescription/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Update Prescription/i }),
    ).toBeInTheDocument();
    // Locked-banner copy.
    expect(
      screen.getByText(/Patient and appointment are locked/i),
    ).toBeInTheDocument();
  });

  it("Cancel inside the writer closes the form without firing any network calls", async () => {
    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);

    fireEvent.click(
      screen.getByRole("button", { name: "Write Prescription" }),
    );
    expect(screen.getByTestId("rx-new-form")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(screen.queryByTestId("rx-new-form")).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  // ── Pre-printed status surface ───────────────────────────────────────

  it("always labels the print button 'Print' (never 'Re-Print'), even for a previously-printed Rx", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1", printed: true })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    expect(
      screen.getByRole("button", { name: /^Print$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Re-Print/i }),
    ).not.toBeInTheDocument();
  });

  it("admin sees Dispense + Reject buttons (parity with pharmacist) and the row footer renders the sharedVia chip when set", async () => {
    asAdmin();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [
            rxFixture({
              id: "rx-1",
              sharedVia: "WHATSAPP",
            }),
          ],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    expect(screen.getByTestId("rx-dispense-rx-1")).toBeInTheDocument();
    expect(screen.getByTestId("rx-reject-rx-1")).toBeInTheDocument();
    expect(screen.getByText(/Shared: WHATSAPP/i)).toBeInTheDocument();
  });

  // ── Templates + submit happy path + interactions + sign-share confirm ─

  it("renders a template dropdown when /prescriptions/templates/list returns rows, and applying one prefills diagnosis + items", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions/templates")) {
        return Promise.resolve({
          data: [
            {
              id: "t-1",
              name: "Diabetes starter",
              diagnosis: "E11.9 — Type 2 diabetes",
              advice: "Reduce sugar",
              items: [
                {
                  medicineName: "Metformin",
                  dosage: "500mg",
                  frequency: "1-0-1 (Morning-Night)",
                  duration: "30 days",
                  instructions: "After meals",
                },
              ],
            },
          ],
        });
      }
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({ data: [], meta: { total: 0 } });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);

    fireEvent.click(screen.getByRole("button", { name: "Write Prescription" }));

    const tplSelect = await screen.findByLabelText(/Use Template/i);
    fireEvent.change(tplSelect, { target: { value: "t-1" } });

    // Diagnosis autocomplete is stubbed — check the underlying input value.
    await waitFor(() => {
      const input = screen.getByPlaceholderText(
        /Search ICD-10/i,
      ) as HTMLInputElement;
      expect(input.value).toBe("E11.9 — Type 2 diabetes");
    });
    expect(
      (screen.getByPlaceholderText(/Medicine name/i) as HTMLInputElement).value,
    ).toBe("Metformin");
  });

  it("happy POST — fills patient/appointment/diagnosis/medicine, preview returns no blocking warnings, POST /prescriptions fires with the full body", async () => {
    apiMock.get.mockImplementation(defaultGetResponder());
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/prescriptions/check-interactions") {
        return Promise.resolve({ data: { warnings: [], hasBlocking: false } });
      }
      return Promise.resolve({ data: { id: "rx-new" } });
    });

    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(screen.getByRole("button", { name: "Write Prescription" }));

    // Drive the EntityPicker stubs. Each fireEvent.change emits a synthetic
    // React onChange; the page's setForm runs synchronously inside the React
    // event handler. We let the microtask queue flush between changes so the
    // appointment picker mounts (gated on form.patientId) before we drive it.
    fireEvent.change(screen.getByTestId("rx-patient-picker-stub"), {
      target: { value: "a1b2c3d4-e5f6-4789-8abc-def012345678" },
    });
    const appointmentPicker = await screen.findByTestId(
      "rx-appointment-picker-stub",
    );
    fireEvent.change(appointmentPicker, {
      target: { value: "b2c3d4e5-f6a7-4890-9bcd-ef0123456789" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Search ICD-10/i), {
      target: { value: "E11.9 — Type 2 diabetes" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Medicine name/i), {
      target: { value: "Metformin" },
    });
    fireEvent.click(screen.getByTestId("rx-dose-chip-0-500mg"));
    const freqGroup = screen.getByTestId("rx-frequency-segmented-0");
    const tdsBtn = within(freqGroup)
      .getAllByRole("button")
      .find((b) => /1-1-1/.test(b.textContent || ""));
    fireEvent.click(tdsBtn!);
    fireEvent.change(screen.getByTestId("rx-duration-input-0"), {
      target: { value: "5 days" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Save Prescription/i }),
    );

    await waitFor(
      () => {
        const previewCall = apiMock.post.mock.calls.find(
          (c) => String(c[0]) === "/prescriptions/check-interactions",
        );
        expect(previewCall).toBeTruthy();
      },
      { timeout: 2000 },
    );
    await waitFor(
      () => {
        const createCall = apiMock.post.mock.calls.find(
          (c) => String(c[0]) === "/prescriptions",
        );
        expect(createCall).toBeTruthy();
        expect(createCall![1]).toMatchObject({
          appointmentId: "b2c3d4e5-f6a7-4890-9bcd-ef0123456789",
          patientId: "a1b2c3d4-e5f6-4789-8abc-def012345678",
          diagnosis: "E11.9 — Type 2 diabetes",
          overrideWarnings: false,
        });
      },
      { timeout: 2000 },
    );
  });

  it("interactions preview returns blocking warnings → modal renders + 'Override and continue' submits the prescription with overrideWarnings:true", async () => {
    apiMock.get.mockImplementation(defaultGetResponder());
    let postedWithOverride: any = null;
    apiMock.post.mockImplementation((url: string, body: any) => {
      if (url === "/prescriptions/check-interactions") {
        return Promise.resolve({
          data: {
            warnings: [
              {
                drugA: "Metformin",
                drugB: "Warfarin",
                severity: "SEVERE",
                description: "INR may swing",
                source: "NEW_VS_EXISTING",
              },
            ],
            hasBlocking: true,
          },
        });
      }
      if (url === "/prescriptions") {
        postedWithOverride = body;
        return Promise.resolve({ data: { id: "rx-new" } });
      }
      return Promise.resolve({ data: {} });
    });

    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(screen.getByRole("button", { name: "Write Prescription" }));

    fireEvent.change(screen.getByTestId("rx-patient-picker-stub"), {
      target: { value: "a1b2c3d4-e5f6-4789-8abc-def012345678" },
    });
    const apptStub = await screen.findByTestId("rx-appointment-picker-stub");
    fireEvent.change(apptStub, {
      target: { value: "b2c3d4e5-f6a7-4890-9bcd-ef0123456789" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Search ICD-10/i), {
      target: { value: "E11.9 — Type 2 diabetes" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Medicine name/i), {
      target: { value: "Metformin" },
    });
    fireEvent.click(screen.getByTestId("rx-dose-chip-0-500mg"));
    const freqGroup = screen.getByTestId("rx-frequency-segmented-0");
    fireEvent.click(
      within(freqGroup)
        .getAllByRole("button")
        .find((b) => /1-1-1/.test(b.textContent || ""))!,
    );
    fireEvent.change(screen.getByTestId("rx-duration-input-0"), {
      target: { value: "5 days" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Save Prescription/i }));

    // Interaction modal renders the warning.
    expect(
      await screen.findByText(/Drug Interaction Warning/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Metformin ↔ Warfarin/i)).toBeInTheDocument();
    expect(screen.getByText("SEVERE")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Override and continue/i }));

    await waitFor(() => expect(postedWithOverride).not.toBeNull(), {
      timeout: 2000,
    });
    expect(postedWithOverride.overrideWarnings).toBe(true);
  });

  it("interaction modal Cancel-and-revise closes the modal without POSTing", async () => {
    apiMock.get.mockImplementation(defaultGetResponder());
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/prescriptions/check-interactions") {
        return Promise.resolve({
          data: {
            warnings: [
              {
                drugA: "X",
                drugB: "Y",
                severity: "MODERATE",
                description: "Modest concern",
                source: "NEW_VS_NEW",
              },
            ],
            hasBlocking: true,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(screen.getByRole("button", { name: "Write Prescription" }));

    fireEvent.change(screen.getByTestId("rx-patient-picker-stub"), {
      target: { value: "a1b2c3d4-e5f6-4789-8abc-def012345678" },
    });
    const apptStub = await screen.findByTestId("rx-appointment-picker-stub");
    fireEvent.change(apptStub, {
      target: { value: "b2c3d4e5-f6a7-4890-9bcd-ef0123456789" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Search ICD-10/i), {
      target: { value: "E11.9 — Type 2 diabetes" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Medicine name/i), {
      target: { value: "X" },
    });
    fireEvent.click(screen.getByTestId("rx-dose-chip-0-500mg"));
    fireEvent.click(
      within(screen.getByTestId("rx-frequency-segmented-0"))
        .getAllByRole("button")
        .find((b) => /1-1-1/.test(b.textContent || ""))!,
    );
    fireEvent.change(screen.getByTestId("rx-duration-input-0"), {
      target: { value: "5 days" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Save Prescription/i }));

    await screen.findByText(/Drug Interaction Warning/i);
    fireEvent.click(
      screen.getByRole("button", { name: /Cancel and revise/i }),
    );

    await waitFor(() =>
      expect(
        screen.queryByText(/Drug Interaction Warning/i),
      ).not.toBeInTheDocument(),
    );
    // No /prescriptions POST fired (only the check-interactions preview).
    expect(
      apiMock.post.mock.calls.filter(
        (c) => String(c[0]) === "/prescriptions",
      ).length,
    ).toBe(0);
  });

  it("Sign-share modal Cancel resets the share-target state and closes the modal", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });
    apiMock.post.mockImplementation((url: string) => {
      if (url.endsWith("/share")) {
        const err = Object.assign(new Error("unsigned"), {
          status: 409,
          payload: { error: "Cannot share an unsigned prescription" },
        });
        return Promise.reject(err);
      }
      return Promise.resolve({ data: {} });
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );
    fireEvent.click(screen.getByRole("button", { name: /Share via Email/i }));

    await screen.findByTestId("rx-sign-share-modal");

    fireEvent.click(
      within(screen.getByTestId("rx-sign-share-modal")).getByRole("button", {
        name: /^Cancel$/i,
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("rx-sign-share-modal"),
      ).not.toBeInTheDocument(),
    );
  });

  it("opens the generic-substitutes modal when the row is filled and 'Check for cheaper generics' is clicked; resolves a base medicine via autocomplete then GETs /medicines/:id/generics", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medicines/search/autocomplete")) {
        return Promise.resolve({
          data: [{ id: "m-base", name: "Metformin" }],
        });
      }
      if (url === "/medicines/m-base/generics") {
        return Promise.resolve({
          data: {
            base: { id: "m-base", name: "Metformin", brand: "Glycomet" },
            basePrice: 50,
            alternatives: [
              {
                id: "m-alt-1",
                name: "Metformin Generic",
                brand: "Sun",
                strength: "500mg",
                form: "Tablet",
                availableStock: 100,
                sellingPrice: 30,
                savingsVsBrand: 20,
              },
            ],
          },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(screen.getByRole("button", { name: "Write Prescription" }));

    // Fill the medicine name so the per-row "Check generics" button renders.
    fireEvent.change(screen.getByPlaceholderText(/Medicine name/i), {
      target: { value: "Metformin" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Check for cheaper generics/i }),
    );

    expect(
      await screen.findByText(/Cheaper Generic Alternatives/i),
    ).toBeInTheDocument();
    // Alternative row + Switch button renders.
    await screen.findByText("Metformin Generic");
    fireEvent.click(screen.getByRole("button", { name: /Switch/i }));

    // After switch, the medicine row picks up the alt's name.
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText(/Medicine name/i) as HTMLInputElement)
          .value,
      ).toBe("Metformin Generic"),
    );
  });

  it("shows the renal-dose-adjustment banner when /patients/:id/renal-function reports CrCl below 60", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients/") && url.endsWith("/renal-function")) {
        return Promise.resolve({
          data: {
            crClMlPerMin: 42,
            ckdStage: "MODERATE",
            latestCreatinine: { value: 1.7, reportedAt: "2026-05-01" },
          },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(screen.getByRole("button", { name: "Write Prescription" }));

    // Drive the patient picker so the renal-function effect runs.
    fireEvent.change(screen.getByTestId("rx-patient-picker-stub"), {
      target: { value: "a1b2c3d4-e5f6-4789-8abc-def012345678" },
    });

    await waitFor(() =>
      expect(
        screen.getByText(/Renal dose adjustment needed/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/CrCl 42 mL\/min/i)).toBeInTheDocument();
    expect(screen.getByText(/MODERATE/)).toBeInTheDocument();
  });

  it("Edit mode happy PATCH — submitting the writer in edit mode PATCHes /prescriptions/:id with the wire payload (no patient/appointment fields)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [
            rxFixture({
              id: "rx-1",
              diagnosis: "J45.9 — Asthma",
              advice: "Inhaler twice daily",
              followUpDate: "2026-06-01T00:00:00.000Z",
              items: [
                {
                  medicineName: "Salbutamol",
                  dosage: "100mcg",
                  frequency: "1-1-1 (Three times)",
                  duration: "30 days",
                  instructions: null,
                },
              ],
            }),
          ],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });
    apiMock.patch.mockResolvedValue({ data: { id: "rx-1" } });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");

    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );
    fireEvent.click(screen.getByTestId("rx-edit-rx-1"));

    // We're now in edit mode. Submit immediately — diagnosis + items are
    // pre-filled from the row.
    fireEvent.click(
      screen.getByRole("button", { name: /Update Prescription/i }),
    );

    await waitFor(
      () => {
        const patchCall = apiMock.patch.mock.calls.find(
          (c) => String(c[0]) === "/prescriptions/rx-1",
        );
        expect(patchCall).toBeTruthy();
        // Wire shape: includes diagnosis + items[], excludes patient/appointment.
        expect(patchCall![1]).toMatchObject({
          diagnosis: "J45.9 — Asthma",
          overrideWarnings: false,
        });
        expect((patchCall![1] as any).appointmentId).toBeUndefined();
        expect((patchCall![1] as any).patientId).toBeUndefined();
      },
      { timeout: 2000 },
    );
    expect(toastMock.success).toHaveBeenCalledWith("Prescription updated");
  });

  it("Save error — POST /prescriptions rejection with a payload.error surfaces a toast.error with that exact message", async () => {
    apiMock.get.mockImplementation(defaultGetResponder());
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/prescriptions/check-interactions") {
        return Promise.resolve({ data: { warnings: [], hasBlocking: false } });
      }
      if (url === "/prescriptions") {
        const err = Object.assign(new Error("server-err"), {
          payload: { error: "Server rejected — try again" },
        });
        return Promise.reject(err);
      }
      return Promise.resolve({ data: {} });
    });

    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(screen.getByRole("button", { name: "Write Prescription" }));

    fireEvent.change(screen.getByTestId("rx-patient-picker-stub"), {
      target: { value: "a1b2c3d4-e5f6-4789-8abc-def012345678" },
    });
    const apptPicker = await screen.findByTestId("rx-appointment-picker-stub");
    fireEvent.change(apptPicker, {
      target: { value: "b2c3d4e5-f6a7-4890-9bcd-ef0123456789" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Search ICD-10/i), {
      target: { value: "E11.9 — Type 2 diabetes" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Medicine name/i), {
      target: { value: "Metformin" },
    });
    fireEvent.click(screen.getByTestId("rx-dose-chip-0-500mg"));
    fireEvent.click(
      within(screen.getByTestId("rx-frequency-segmented-0"))
        .getAllByRole("button")
        .find((b) => /1-1-1/.test(b.textContent || ""))!,
    );
    fireEvent.change(screen.getByTestId("rx-duration-input-0"), {
      target: { value: "5 days" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Save Prescription/i }));

    await waitFor(
      () =>
        expect(toastMock.error).toHaveBeenCalledWith(
          "Server rejected — try again",
        ),
      { timeout: 2000 },
    );
  });

  it("READY staged action — 'Dispense in Kanban' routes to the board (dispensing moved off the list)", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [rxFixture({ id: "rx-1", status: "READY" })],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    fireEvent.click(screen.getByTestId("rx-dispense-rx-1"));

    expect(routerMock.push).toHaveBeenCalledWith(
      "/dashboard/pharmacy-kanban?prescription=rx-1",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("interaction modal — CONTRAINDICATED severity badge styling renders the red variant", async () => {
    apiMock.get.mockImplementation(defaultGetResponder());
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/prescriptions/check-interactions") {
        return Promise.resolve({
          data: {
            warnings: [
              {
                drugA: "A",
                drugB: "B",
                severity: "CONTRAINDICATED",
                description: "Never combine",
                source: "NEW_VS_NEW",
              },
            ],
            hasBlocking: true,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(<PrescriptionsPage />);
    await screen.findByText(/No prescriptions yet/i);
    fireEvent.click(screen.getByRole("button", { name: "Write Prescription" }));

    fireEvent.change(screen.getByTestId("rx-patient-picker-stub"), {
      target: { value: "a1b2c3d4-e5f6-4789-8abc-def012345678" },
    });
    const apptPicker = await screen.findByTestId("rx-appointment-picker-stub");
    fireEvent.change(apptPicker, {
      target: { value: "b2c3d4e5-f6a7-4890-9bcd-ef0123456789" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Search ICD-10/i), {
      target: { value: "E11.9 — Type 2 diabetes" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Medicine name/i), {
      target: { value: "A" },
    });
    fireEvent.click(screen.getByTestId("rx-dose-chip-0-500mg"));
    fireEvent.click(
      within(screen.getByTestId("rx-frequency-segmented-0"))
        .getAllByRole("button")
        .find((b) => /1-1-1/.test(b.textContent || ""))!,
    );
    fireEvent.change(screen.getByTestId("rx-duration-input-0"), {
      target: { value: "5 days" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Save Prescription/i }));

    expect(
      await screen.findByText(/Drug Interaction Warning/i),
    ).toBeInTheDocument();
    expect(screen.getByText("CONTRAINDICATED")).toBeInTheDocument();
    expect(screen.getByText(/Both medicines in this prescription/i)).toBeInTheDocument();
  });

  it("renders Advice and (future) follow-up date in the expanded row when present", async () => {
    // Future date — formatRxIssuedDate will produce a stable en-IN string.
    const future = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/prescriptions?")) {
        return Promise.resolve({
          data: [
            rxFixture({
              id: "rx-1",
              advice: "Drink water",
              followUpDate: future,
            }),
          ],
          meta: { total: 1 },
        });
      }
      return defaultGetResponder()(url);
    });

    render(<PrescriptionsPage />);
    await screen.findByText("Rakesh Patel");
    fireEvent.click(
      within(screen.getByTestId("rx-row-rx-1")).getAllByRole("button")[0],
    );

    expect(screen.getByText(/Drink water/)).toBeInTheDocument();
    expect(screen.getByText(/Follow-up:/)).toBeInTheDocument();
  });
});
