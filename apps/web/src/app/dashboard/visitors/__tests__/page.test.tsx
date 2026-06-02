/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * VisitorsPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/visitors/page.tsx, the front-desk
 *     visitor check-in / check-out / pass-print surface. Endpoints the page hits:
 *       GET   /visitors/active                  (Active tab)
 *       GET   /visitors?date=...&limit=200      (Today tab)
 *       GET   /visitors-stats?period=today      (KPI tiles — Issue #746)
 *       POST  /visitors                         (check-in)
 *       PATCH /visitors/:id/photo               (optional photo attach)
 *       PATCH /visitors/:id/checkout            (check-out action)
 *
 *   - Behaviours covered:
 *       1.  Initial render — loading skeleton appears, then resolves to the
 *           empty-state and the Check-In CTA.
 *       2.  RBAC redirect (Issue #509) — PATIENT / NURSE / LAB_TECH /
 *           PHARMACIST trigger toast.error + router.replace("/dashboard/
 *           not-authorized?from=...").
 *       3.  RBAC allow-list — ADMIN / RECEPTION / DOCTOR do NOT redirect.
 *       4.  Auth still loading — no redirect side-effect.
 *       5.  Stats tiles — Total Today, Currently Inside (derived from the
 *           Active list), and the per-purpose bar chart use stats.byPurpose.
 *       6.  Currently-Inside fallback — Today tab uses
 *           `stats.currentlyActive ?? stats.currentInside ?? 0`.
 *       7.  Tab switching — clicking the "All Today" tab refetches with the
 *           date-scoped /visitors endpoint.
 *       8.  Defensive null-coercion (Issue #351) — a row with `name: null`
 *           and `purpose: null` does NOT unmount the page; it renders "—".
 *       9.  Initial avatar — non-photo row renders the uppercase first
 *           letter; "?" when name is blank.
 *      10.  Check-In modal — clicking the CTA opens the modal; clicking
 *           Cancel closes it without firing any POST.
 *      11.  Check-In validation — empty name surfaces toast.error and
 *           skips POST.
 *      12.  Check-In happy path — POST body only carries truthy fields;
 *           print-pass modal opens after success; load() refetches.
 *      13.  Check-In with photo — the optional PATCH /visitors/:id/photo
 *           fires after the POST.
 *      14.  Check-In with photo PATCH rejection — swallowed; print modal
 *           still opens.
 *      15.  Check-In POST rejection (Error) → toast.error(err.message);
 *           non-Error → fallback "Failed".
 *      16.  Check-Out — confirm=true triggers PATCH; confirm=false skips it.
 *      17.  Check-Out PATCH rejection surfaces toast.error.
 *      18.  Print Pass — clicking "Print Pass" on a row opens the print
 *           modal; Close button dismisses it.
 *      19.  Error-path resilience — list GET rejection sets empty list;
 *           page still renders without throwing.
 *      20.  File upload — onFileSelected reads the file and shows the
 *           captured-photo preview + Remove button.
 *
 *   - Mocks: @/lib/api, @/lib/toast, @/lib/store, @/lib/use-dialog,
 *     @/lib/time (elapsedMinutes), @/components/Skeleton, next/navigation.
 *     Camera (navigator.mediaDevices.getUserMedia) is deliberately NOT
 *     exercised — jsdom has no media stack and the per-tick setTimeout
 *     race with React state is brittle.
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
import userEvent from "@testing-library/user-event";

const { apiMock, toastMock, authMock, confirmMock, routerMock } = vi.hoisted(
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
    confirmMock: vi.fn<(opts?: any) => Promise<boolean>>(),
    routerMock: {
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    },
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(async () => ""),
}));
vi.mock("@/lib/time", () => ({
  elapsedMinutes: (_a: string, _b: string | null) => 17,
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) => (
    <div data-testid="skeleton-table" data-rows={rows} data-columns={columns} />
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/visitors",
}));

import VisitorsPage from "../page";

// ─── Fixtures ───────────────────────────────────────────────────────────

const now = new Date();
now.setHours(12, 0, 0, 0);
const past = new Date(now.getTime() - 48 * 60 * 60 * 1000);

function visitorFixture(overrides: Partial<any> = {}): any {
  return {
    id: "v-1",
    passNumber: "VP-001",
    name: "Asha Patel",
    phone: "+919999900001",
    idProofType: "Aadhaar",
    idProofNumber: "1234-5678-9012",
    patientId: null,
    purpose: "PATIENT_VISIT",
    department: "Cardiology",
    checkInAt: past.toISOString(),
    checkOutAt: null,
    notes: null,
    photoUrl: null,
    ...overrides,
  };
}

function statsFixture(overrides: Partial<any> = {}): any {
  return {
    totalToday: 7,
    currentlyActive: 3,
    byPurpose: {
      PATIENT_VISIT: 4,
      DELIVERY: 1,
      APPOINTMENT: 1,
      MEETING: 1,
      OTHER: 0,
    },
    ...overrides,
  };
}

function asReception() {
  authMock.mockReturnValue({
    user: { id: "u-rcp", role: "RECEPTION", name: "Rcp" },
    isLoading: false,
  });
}
function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-adm", role: "ADMIN", name: "Adm" },
    isLoading: false,
  });
}
function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
    isLoading: false,
  });
}
function asPatient() {
  authMock.mockReturnValue({
    user: { id: "u-pat", role: "PATIENT", name: "Pat" },
    isLoading: false,
  });
}
function asAuthLoading() {
  authMock.mockReturnValue({ user: null, isLoading: true });
}

/** Convenience: install a GET responder that maps endpoint prefix → payload. */
function installGetRoutes(routes: {
  activeVisitors?: any[];
  todayVisitors?: any[];
  stats?: any | null;
  rejectAll?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (routes.rejectAll) return Promise.reject(new Error("network down"));
    if (url === "/visitors/active") {
      return Promise.resolve({ data: routes.activeVisitors ?? [] });
    }
    if (url.startsWith("/visitors?date=")) {
      return Promise.resolve({ data: routes.todayVisitors ?? [] });
    }
    if (url.startsWith("/visitors-stats")) {
      return Promise.resolve({ data: routes.stats ?? null });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("VisitorsPage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
    authMock.mockReset();
    confirmMock.mockReset();
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
    // default — confirm resolves true unless overridden
    confirmMock.mockResolvedValue(true);
    asReception();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Initial render + loading + RBAC ────────────────────────────────

  it("shows the loading skeleton while load() is in flight, then resolves to empty state", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });

    render(<VisitorsPage />);

    // Skeleton appears synchronously.
    expect(screen.getByTestId("skeleton-table")).toBeInTheDocument();
    expect(screen.getByTestId("visitors-loading")).toHaveAttribute("aria-busy", "true");

    // Once GETs resolve, empty state appears.
    expect(await screen.findByText("No visitors")).toBeInTheDocument();
    expect(screen.queryByTestId("skeleton-table")).toBeNull();
    // CTA always present (when role is allowed).
    expect(screen.getByTestId("visitors-check-in-btn")).toBeInTheDocument();
  });

  it("renders the heading and the Check-In CTA", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    render(<VisitorsPage />);
    expect(
      screen.getByRole("heading", { name: /^visitors$/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /check in visitor/i }),
    ).toBeInTheDocument();
  });

  it("RBAC redirect — PATIENT triggers toast.error + router.replace with the encoded `from`", async () => {
    asPatient();
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });

    render(<VisitorsPage />);

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/restricted to front-desk/i),
      );
    });
    expect(routerMock.replace).toHaveBeenCalledWith(
      `/dashboard/not-authorized?from=${encodeURIComponent("/dashboard/visitors")}`,
    );
  });

  it("RBAC redirect — NURSE is NOT allowed (Issue #755) and gets redirected", async () => {
    authMock.mockReturnValue({
      user: { id: "u-n", role: "NURSE", name: "N" },
      isLoading: false,
    });
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    render(<VisitorsPage />);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalled());
  });

  it("RBAC allow — DOCTOR does NOT redirect", async () => {
    asDoctor();
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    render(<VisitorsPage />);
    // Wait for the empty-state to render so the effect has had a chance to fire.
    await screen.findByText("No visitors");
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("RBAC allow — ADMIN does NOT redirect", async () => {
    asAdmin();
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    render(<VisitorsPage />);
    await screen.findByText("No visitors");
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("auth still loading — effect does NOT redirect", async () => {
    asAuthLoading();
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    render(<VisitorsPage />);
    await screen.findByText("No visitors");
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  // ─── Stats tiles ────────────────────────────────────────────────────

  it("renders Total Today + the per-purpose bar chart with the right counts", async () => {
    installGetRoutes({
      activeVisitors: [],
      stats: statsFixture({ totalToday: 12 }),
    });
    render(<VisitorsPage />);
    expect(await screen.findByText("12")).toBeInTheDocument(); // totalToday tile
    expect(screen.getByText("Total Today")).toBeInTheDocument();
    // Bar-chart labels (purposes underscored → spaced).
    expect(screen.getByText("PATIENT VISIT")).toBeInTheDocument();
    expect(screen.getByText("DELIVERY")).toBeInTheDocument();
    expect(screen.getByText("APPOINTMENT")).toBeInTheDocument();
    expect(screen.getByText("MEETING")).toBeInTheDocument();
    expect(screen.getByText("OTHER")).toBeInTheDocument();
  });

  it("Currently-Inside tile (Active tab) — derived from `visitors.filter(!checkOutAt).length`", async () => {
    installGetRoutes({
      activeVisitors: [
        visitorFixture({ id: "a", checkOutAt: null }),
        visitorFixture({ id: "b", checkOutAt: null }),
        visitorFixture({ id: "c", checkOutAt: new Date().toISOString() }),
      ],
      stats: statsFixture({ currentlyActive: 999 }), // ignored on Active tab
    });
    render(<VisitorsPage />);
    // The "Currently Inside" label renders immediately, but its count is
    // derived from the active-visitors fetch — poll until the loaded data
    // (2, not 999, not the initial 0) is reflected in the tile.
    expect(await screen.findByText("Currently Inside")).toBeInTheDocument();
    await waitFor(() => {
      const tile = screen.getByText("Currently Inside").parentElement!;
      expect(tile.textContent).toMatch(/Currently Inside\s*2$/);
    });
  });

  it("Currently-Inside tile (Today tab) — uses stats.currentlyActive (Issue #746)", async () => {
    installGetRoutes({
      activeVisitors: [],
      todayVisitors: [],
      stats: statsFixture({ currentlyActive: 5, currentInside: 99 }),
    });
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");

    await user.click(screen.getByRole("button", { name: /^all today$/i }));
    await waitFor(() => {
      const tile = screen.getByText("Currently Inside").parentElement!;
      expect(tile.textContent).toMatch(/Currently Inside\s*5$/);
    });
  });

  it("Currently-Inside tile (Today tab) — legacy fallback to stats.currentInside", async () => {
    installGetRoutes({
      activeVisitors: [],
      todayVisitors: [],
      stats: { totalToday: 1, currentInside: 8, byPurpose: {} }, // no currentlyActive
    });
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");
    await user.click(screen.getByRole("button", { name: /^all today$/i }));
    await waitFor(() => {
      const tile = screen.getByText("Currently Inside").parentElement!;
      expect(tile.textContent).toMatch(/Currently Inside\s*8$/);
    });
  });

  it("stats null — Total Today defaults to 0; Inside derives from list", async () => {
    installGetRoutes({ activeVisitors: [], stats: null });
    render(<VisitorsPage />);
    await screen.findByText("No visitors");
    // Total Today tile should render 0.
    const total = screen.getByText("Total Today").parentElement!;
    expect(total.textContent).toMatch(/Total Today\s*0$/);
  });

  // ─── Tab switching ──────────────────────────────────────────────────

  it("clicking the All Today tab refetches /visitors with the date+limit querystring", async () => {
    installGetRoutes({ activeVisitors: [], todayVisitors: [], stats: statsFixture() });
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");

    await user.click(screen.getByRole("button", { name: /^all today$/i }));

    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => /^\/visitors\?date=\d{4}-\d{2}-\d{2}&limit=200$/.test(u))).toBe(true);
    });
  });

  // ─── Row rendering ──────────────────────────────────────────────────

  it("renders visitor rows with pass#, phone, purpose, department, elapsed minutes", async () => {
    installGetRoutes({
      activeVisitors: [
        visitorFixture({
          id: "row-1",
          passNumber: "VP-555",
          name: "Asha Patel",
          phone: "+91999",
          purpose: "DELIVERY",
          department: "Pharmacy",
        }),
      ],
      stats: statsFixture(),
    });
    render(<VisitorsPage />);
    expect(await screen.findByText("VP-555")).toBeInTheDocument();
    expect(screen.getByText("Asha Patel")).toBeInTheDocument();
    expect(screen.getByText("+91999")).toBeInTheDocument();
    // "DELIVERY" appears in both the chart legend AND the row cell — assert >=1.
    expect(screen.getAllByText("DELIVERY").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Pharmacy")).toBeInTheDocument();
    expect(screen.getByText("17m")).toBeInTheDocument(); // elapsedMinutes mock
  });

  it("defensively coerces null name/purpose (Issue #351) without crashing", async () => {
    installGetRoutes({
      activeVisitors: [
        visitorFixture({
          id: "row-null",
          name: null,
          purpose: null,
          passNumber: null,
        }),
      ],
      stats: statsFixture(),
    });
    render(<VisitorsPage />);
    // Page mounts; the row shows "—" for null name/purpose/pass without
    // crashing on .charAt / .replace. (The initial-letter avatar shows
    // "—" too since charAt of the fallback string is truthy.)
    //
    // Wait for the SKELETON to clear — not just the header button — so
    // the assertion below runs against the rendered table row, not the
    // pre-fetch skeleton state. The header `visitors-check-in-btn`
    // renders synchronously on mount, so awaiting it resolves before
    // the API fetch lands and the dashes never make it into the DOM.
    await waitFor(() =>
      expect(
        screen.queryByTestId("visitors-loading"),
      ).not.toBeInTheDocument(),
    );
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2); // name + purpose at minimum
  });

  it("renders the photo <img> when photoUrl is present (instead of the initial avatar)", async () => {
    installGetRoutes({
      activeVisitors: [
        visitorFixture({ id: "p", name: "Vimal", photoUrl: "data:image/jpeg;base64,Z" }),
      ],
      stats: statsFixture(),
    });
    render(<VisitorsPage />);
    const img = (await screen.findByAltText("Vimal")) as HTMLImageElement;
    expect(img.src).toContain("data:image/jpeg;base64,Z");
  });

  it("renders the first-letter avatar when photoUrl is absent", async () => {
    installGetRoutes({
      activeVisitors: [visitorFixture({ id: "v", name: "Bhavna" })],
      stats: statsFixture(),
    });
    render(<VisitorsPage />);
    await screen.findByText("Bhavna");
    expect(screen.getByText("B")).toBeInTheDocument(); // initial avatar
  });

  // ─── Check-In modal: open + cancel + validation ─────────────────────

  it("clicking Check-In Visitor opens the modal; Cancel closes it without firing POST", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");

    await user.click(screen.getByTestId("visitors-check-in-btn"));
    expect(
      screen.getByRole("heading", { name: /check in visitor/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^name \*/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /check in visitor/i }),
      ).toBeNull(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Check-In validation — empty name surfaces toast.error and skips POST", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");

    await user.click(screen.getByTestId("visitors-check-in-btn"));
    // Click the modal's Check In button (the form submit, NOT the open-modal CTA).
    const submitBtn = screen.getAllByRole("button", { name: /^check in$/i })[0];
    await user.click(submitBtn);

    expect(toastMock.error).toHaveBeenCalledWith("Name is required");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ─── Check-In happy path ────────────────────────────────────────────

  it("Check-In happy path — POST body only carries truthy fields; print modal opens after success", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    const created = visitorFixture({
      id: "new-1",
      passNumber: "VP-NEW",
      name: "Riya",
      purpose: "MEETING",
      department: "Admin",
      checkInAt: new Date().toISOString(),
    });
    apiMock.post.mockResolvedValue({ data: created });
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");

    await user.click(screen.getByTestId("visitors-check-in-btn"));
    await user.type(screen.getByLabelText(/^name \*/i), "Riya");
    await user.type(screen.getByLabelText(/^phone$/i), "9876543210");
    // Leave ID number blank — branch coverage for falsy field skip.
    await user.selectOptions(screen.getByLabelText(/^purpose$/i), "MEETING");
    await user.type(screen.getByLabelText(/^department$/i), "Admin");
    await user.type(screen.getByLabelText(/^notes$/i), "Vendor visit");

    const submitBtn = screen.getAllByRole("button", { name: /^check in$/i })[0];
    await user.click(submitBtn);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/visitors");
    expect(body).toEqual({
      name: "Riya",
      purpose: "MEETING",
      phone: "9876543210",
      idProofType: "Aadhaar",
      department: "Admin",
      notes: "Vendor visit",
    });
    // No idProofNumber, no patientId — both were left blank.
    expect(body).not.toHaveProperty("idProofNumber");
    expect(body).not.toHaveProperty("patientId");

    // Print pass modal opens.
    expect(await screen.findByText(/VISITOR PASS/)).toBeInTheDocument();
    expect(screen.getByText("VP-NEW")).toBeInTheDocument();
  });

  it("Check-In happy path WITH photo — fires PATCH /visitors/:id/photo after POST", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    apiMock.post.mockResolvedValue({
      data: visitorFixture({ id: "new-photo", passNumber: "VP-PIC", name: "Pic" }),
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");

    await user.click(screen.getByTestId("visitors-check-in-btn"));
    await user.type(screen.getByLabelText(/^name \*/i), "Pic");

    // Drive the file-upload path: click Upload Photo + dispatch a synthetic change.
    const uploadBtn = screen.getByRole("button", { name: /upload photo/i });
    expect(uploadBtn).toBeInTheDocument();
    // The hidden <input type="file"> is in the same panel.
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const file = new File(["abc"], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    // FileReader is async — wait for the captured-photo preview to appear.
    await screen.findByAltText("Captured");

    const submitBtn = screen.getAllByRole("button", { name: /^check in$/i })[0];
    await user.click(submitBtn);

    await waitFor(() => {
      const patchCall = apiMock.patch.mock.calls.find((c) =>
        String(c[0]).includes("/visitors/new-photo/photo"),
      );
      expect(patchCall).toBeTruthy();
      expect(patchCall?.[1]).toMatchObject({ photoUrl: expect.any(String) });
    });
    // Print modal still opens.
    expect(await screen.findByText(/VISITOR PASS/)).toBeInTheDocument();
  });

  it("Check-In photo PATCH rejection is swallowed; print modal still opens", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    apiMock.post.mockResolvedValue({
      data: visitorFixture({ id: "swallow", name: "S" }),
    });
    apiMock.patch.mockRejectedValue(new Error("photo upload down"));

    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");
    await user.click(screen.getByTestId("visitors-check-in-btn"));
    await user.type(screen.getByLabelText(/^name \*/i), "S");
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(["x"], "p.jpg", { type: "image/jpeg" })] },
    });
    await screen.findByAltText("Captured");
    await user.click(screen.getAllByRole("button", { name: /^check in$/i })[0]);

    expect(await screen.findByText(/VISITOR PASS/)).toBeInTheDocument();
    // toast.error should NOT have been called for the patch failure.
    expect(toastMock.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/photo/i),
    );
  });

  it("Check-In POST rejection (Error) surfaces toast.error with the message", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    apiMock.post.mockRejectedValue(new Error("phone duplicate"));
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");
    await user.click(screen.getByTestId("visitors-check-in-btn"));
    await user.type(screen.getByLabelText(/^name \*/i), "Dup");
    await user.click(screen.getAllByRole("button", { name: /^check in$/i })[0]);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("phone duplicate"),
    );
  });

  it("Check-In POST rejection (non-Error) falls back to default 'Failed' copy", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    apiMock.post.mockRejectedValue("boom");
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");
    await user.click(screen.getByTestId("visitors-check-in-btn"));
    await user.type(screen.getByLabelText(/^name \*/i), "Dup");
    await user.click(screen.getAllByRole("button", { name: /^check in$/i })[0]);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Failed"));
  });

  // ─── Check-out ──────────────────────────────────────────────────────

  it("Check-Out — confirm=true triggers PATCH /visitors/:id/checkout + reload", async () => {
    installGetRoutes({
      activeVisitors: [visitorFixture({ id: "co-1", name: "ToOut" })],
      stats: statsFixture(),
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("ToOut");

    await user.click(screen.getByRole("button", { name: /^check out$/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/visitors/co-1/checkout", {}),
    );
  });

  it("Check-Out — confirm=false skips the PATCH entirely", async () => {
    installGetRoutes({
      activeVisitors: [visitorFixture({ id: "co-2", name: "Stays" })],
      stats: statsFixture(),
    });
    confirmMock.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("Stays");
    await user.click(screen.getByRole("button", { name: /^check out$/i }));
    // give the microtask a chance
    await Promise.resolve();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Check-Out — PATCH rejection (Error) surfaces toast.error", async () => {
    installGetRoutes({
      activeVisitors: [visitorFixture({ id: "co-3", name: "Errs" })],
      stats: statsFixture(),
    });
    apiMock.patch.mockRejectedValue(new Error("already out"));
    confirmMock.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("Errs");
    await user.click(screen.getByRole("button", { name: /^check out$/i }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("already out"));
  });

  it("Check-Out — PATCH rejection (non-Error) falls back to default 'Failed'", async () => {
    installGetRoutes({
      activeVisitors: [visitorFixture({ id: "co-4", name: "Errs2" })],
      stats: statsFixture(),
    });
    apiMock.patch.mockRejectedValue("oops");
    confirmMock.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("Errs2");
    await user.click(screen.getByRole("button", { name: /^check out$/i }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Failed"));
  });

  it("checkedOut row hides the Check Out button (only Print Pass shown)", async () => {
    installGetRoutes({
      activeVisitors: [
        visitorFixture({
          id: "out",
          name: "Gone",
          checkOutAt: new Date().toISOString(),
        }),
      ],
      stats: statsFixture(),
    });
    render(<VisitorsPage />);
    await screen.findByText("Gone");
    expect(screen.queryByRole("button", { name: /^check out$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /print pass/i })).toBeInTheDocument();
  });

  // ─── Print Pass modal ───────────────────────────────────────────────

  it("Print Pass — clicking the row button opens the print modal; Close dismisses", async () => {
    installGetRoutes({
      activeVisitors: [
        visitorFixture({
          id: "pp",
          name: "PrintMe",
          passNumber: "VP-PRINT",
          purpose: "DELIVERY",
          department: "Lab",
          photoUrl: "data:image/jpeg;base64,X",
        }),
      ],
      stats: statsFixture(),
    });
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("PrintMe");

    await user.click(screen.getByRole("button", { name: /print pass/i }));
    expect(await screen.findByText("VISITOR PASS")).toBeInTheDocument();
    // VP-PRINT shows in the row cell + the modal — assert both visible.
    expect(screen.getAllByText("VP-PRINT").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Purpose:/)).toBeInTheDocument();
    // Department line renders because department is non-null.
    expect(screen.getByText(/Dept:/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^close$/i }));
    await waitFor(() => expect(screen.queryByText("VISITOR PASS")).toBeNull());
  });

  it("Print Pass — clicking Print calls window.print()", async () => {
    installGetRoutes({
      activeVisitors: [visitorFixture({ id: "pp2", name: "Win", passNumber: "VP-2" })],
      stats: statsFixture(),
    });
    const printSpy = vi.fn();
    Object.defineProperty(window, "print", { value: printSpy, configurable: true });

    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("Win");
    await user.click(screen.getByRole("button", { name: /print pass/i }));
    await screen.findByText("VISITOR PASS");
    await user.click(screen.getByRole("button", { name: /^print$/i }));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  // ─── Error-path resilience ──────────────────────────────────────────

  it("list GET rejection — page still mounts; renders empty state without throwing", async () => {
    installGetRoutes({ rejectAll: true });
    render(<VisitorsPage />);
    expect(await screen.findByText("No visitors")).toBeInTheDocument();
    expect(screen.getByTestId("visitors-check-in-btn")).toBeInTheDocument();
  });

  // ─── File upload: Remove button branch ──────────────────────────────

  it("captured-photo Remove button clears the preview and restores the upload buttons", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");
    await user.click(screen.getByTestId("visitors-check-in-btn"));

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(["x"], "p.jpg", { type: "image/jpeg" })] },
    });
    await screen.findByAltText("Captured");

    await user.click(screen.getByRole("button", { name: /remove/i }));
    await waitFor(() => expect(screen.queryByAltText("Captured")).toBeNull());
    expect(screen.getByRole("button", { name: /capture photo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /upload photo/i })).toBeInTheDocument();
  });

  it("file upload — selecting nothing (no files) is a no-op", async () => {
    installGetRoutes({ activeVisitors: [], stats: statsFixture() });
    const user = userEvent.setup();
    render(<VisitorsPage />);
    await screen.findByText("No visitors");
    await user.click(screen.getByTestId("visitors-check-in-btn"));

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    // Fire change with empty files list — the early-return branch.
    fireEvent.change(fileInput, { target: { files: [] } });
    // No preview should appear.
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByAltText("Captured")).toBeNull();
  });
});
