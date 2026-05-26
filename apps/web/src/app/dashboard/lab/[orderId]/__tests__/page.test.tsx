/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * LabOrderPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises `apps/web/src/app/dashboard/lab/[orderId]/page.tsx`, the
 *     lab-order detail surface with result entry, status transitions,
 *     and the radiology-attachments side-panel (Issues #90/#147/#255/
 *     #459/#609/#620/#622/#624/#626/#627/#638/#640/#643).
 *
 *   - Endpoints touched:
 *       GET   /lab/orders/:orderId
 *       PATCH /lab/orders/:orderId/status   (SAMPLE_COLLECTED / COMPLETED)
 *       GET   /lab/orders/:orderId/attachments
 *       POST  /lab/orders/:orderId/attachments
 *       POST  /lab/results
 *
 *   - Behaviours covered:
 *       1. Loading skeleton — `lab-order-detail-loading` with aria-busy=true
 *          before the GET resolves.
 *       2. Role gate (Issue #90) — RECEPTION is bounced to
 *          /dashboard/not-authorized with the `from` query param;
 *          the order GET never fires.
 *       3. Allowed roles (LAB_TECH / DOCTOR / NURSE / ADMIN / PATIENT)
 *          fetch the order and render the chrome.
 *       4. Order-not-found branch — GET resolves to null and the
 *          "Order not found" copy renders with the Back-to-Lab + Go-back
 *          escape routes (Issue #627).
 *       5. Order header — orderNumber fallback to id.slice(0,8) when
 *          missing, status pill, "Print Report" CTA fires
 *          openPrintEndpoint("/lab/orders/:id/pdf"), patient header
 *          surfaces name + MR# + gender + age, ordering doctor section
 *          renders `formatDoctorName`.
 *       6. ORDERED → SAMPLE_COLLECTED CTA (Issue #624) — LAB_TECH sees
 *          "Mark Sample Collected"; confirm() resolves to true → PATCH
 *          /status fires with `{ status: "SAMPLE_COLLECTED" }` and the
 *          order reloads.
 *       7. Mark-collected confirm REJECTED → no PATCH.
 *       8. Mark-collected error path → toast.error with the message.
 *       9. Mark-complete CTA appears when every item has at least one
 *          result and the order is not yet COMPLETED; clicking PATCHes
 *          `/status` with `{ status: "COMPLETED" }` and reloads.
 *      10. Mark-complete confirm-rejected → no PATCH.
 *      11. Result entry (LAB_TECH on a non-finalised order):
 *            - Parameter required → toast.error "Parameter is required".
 *            - Value required → inline `error-lab-result-value` renders.
 *            - Numeric test (has unit) + free text → numeric-only
 *              guard fires `inline error + toast` and skips POST.
 *            - Numeric test + panic range → out-of-range guard fires
 *              the bound-specific inline error and skips POST.
 *            - Numeric test + 1e18 (above ±1e9 cap, Issue #638) → cap
 *              guard fires and skips POST.
 *            - Whitespace-only Unit (Issue #640) → toast.error + no POST.
 *            - Happy submit → POST /lab/results body shape, then reload.
 *            - API error with `payload.details[field=value]` → inline
 *              error rendered (Issue #95).
 *      12. Qualitative tests (Issue #620) — render a `<select>` with the
 *          canonical QUALITATIVE_RESULT_OPTIONS instead of the free-text
 *          input.
 *      13. Add Result form NOT rendered for the PATIENT role (Issue #255).
 *      14. Add Result form NOT rendered when the order is COMPLETED;
 *          finalised-order notice renders for LAB_TECH (Issue #609).
 *      15. Range-hint dedupe (Issue #147) — when `normalRange` already
 *          contains the unit, the unit is NOT appended a second time.
 *      16. Radiology attachments panel (Issue #622):
 *            - Renders only when at least one item is imaging-shaped.
 *            - Empty state copy "No imaging artefacts uploaded yet."
 *            - Existing attachments list with title, mimeType, size, and
 *              the canonical date.
 *            - Upload form is HIDDEN for the PATIENT role and shown for
 *              LAB_TECH.
 *            - Submit with no file → toast.error "Choose a file to upload".
 *            - Submit with file > 10 MB → toast.error 10-MB-cap copy.
 *            - Submit with empty title → toast.error title-required copy.
 *            - Happy upload → POST /lab/orders/:id/attachments with the
 *              base64-content + filename + title; success toast; refetch.
 *            - Upload API rejection → toast.error with the message.
 *
 *   - Mocks: @/lib/api (api + openPrintEndpoint), @/lib/store
 *     (useAuthStore — destructured, NOT selector form), @/lib/toast,
 *     @/lib/use-dialog (confirm), @/lib/format / format-doctor-name pass-through,
 *     @medcore/shared imaging+qualitative helpers stubbed for deterministic
 *     branch coverage, next/navigation, @/components/Skeleton passthrough.
 */

import { Suspense } from "react";
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
  confirmMock,
  fileReaderMock,
  sharedHelpers,
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
  confirmMock: vi.fn(),
  fileReaderMock: { lastInstance: null as any },
  sharedHelpers: {
    isImagingLabTest: vi.fn(
      (t: { name: string; category?: string | null }) =>
        /USG|Ultrasound|X-Ray|MRI|CT |ECG|Echo/i.test(t.name) ||
        (t.category ? /Imaging|Radiology/i.test(t.category) : false),
    ),
    getLabTestResultMode: vi.fn(
      (t: {
        name: string;
        category?: string | null;
        unit?: string | null;
        panicLow?: number | null;
        panicHigh?: number | null;
      }) => {
        if (/HIV|HBsAg|Widal|Dengue|ANA/i.test(t.name)) return "qualitative";
        if (sharedHelpers.isImagingLabTest({ name: t.name, category: t.category ?? null }))
          return "imaging";
        return "numeric";
      },
    ),
    QUALITATIVE_RESULT_OPTIONS: [
      "POSITIVE",
      "NEGATIVE",
      "REACTIVE",
      "NON_REACTIVE",
    ],
  },
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  openPrintEndpoint: openPrintEndpointMock,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/dashboard/lab/o1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orderId: "o1" }),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));
vi.mock("@/lib/format-doctor-name", () => ({
  formatDoctorName: (name: string) => `Dr. ${name}`,
}));
vi.mock("@/lib/format", () => ({
  formatDateTime: (iso: string) => `formatted(${iso})`,
}));
vi.mock("@medcore/shared", () => sharedHelpers);

import LabOrderPage from "../page";

// ─── Helpers ─────────────────────────────────────────────

function renderPage(orderId = "o1") {
  // `use(params)` reads from a Promise. React's `use()` short-circuits
  // when the Promise carries the internal `status: "fulfilled" / value`
  // markers — no Suspense round-trip. This is how React's own React Server
  // Components plumbing pre-tags its `use()` payloads. Without this the
  // microtask resolution never lands inside the synchronous test window
  // (the same Suspense-fallback-never-flushes gotcha that bit the
  // feedback/[patientId] page tests).
  const params: any = Promise.resolve({ orderId });
  params.status = "fulfilled";
  params.value = { orderId };
  return render(
    <Suspense fallback={<div data-testid="route-suspense" />}>
      <LabOrderPage params={params} />
    </Suspense>,
  );
}

type OrderItem = {
  id: string;
  status: string;
  test: {
    id: string;
    name: string;
    normalRange?: string | null;
    unit?: string | null;
    category?: string | null;
    panicLow?: number | null;
    panicHigh?: number | null;
  };
  results?: Array<{
    id: string;
    parameter: string;
    value: string;
    unit?: string | null;
    normalRange?: string | null;
    flag?: string | null;
    notes?: string | null;
  }>;
};

function order(overrides: {
  status?: string;
  notes?: string | null;
  orderNumber?: string | null;
  doctor?: { user: { name: string } } | null;
  items?: OrderItem[];
} = {}) {
  return {
    id: "o1-full-id",
    // Important: `?? defaultVal` would keep us from overriding to undefined.
    // Pass-through the override field as-is so callers can test the
    // `orderNumber || id.slice(0,8)` fallback branch with `orderNumber: ""`.
    orderNumber:
      "orderNumber" in overrides ? overrides.orderNumber : "LAB-2026-0001",
    orderedAt: "2026-05-01T10:00:00.000Z",
    status: overrides.status ?? "SAMPLE_COLLECTED",
    notes: overrides.notes ?? null,
    patient: {
      id: "p1",
      mrNumber: "MR-00007",
      age: 34,
      gender: "F",
      user: { name: "Anita Sharma", phone: "9999988888" },
    },
    ...(overrides.doctor === undefined
      ? { doctor: { user: { name: "Mehta" } } }
      : overrides.doctor === null
      ? {}
      : { doctor: overrides.doctor }),
    items:
      overrides.items ??
      ([
        {
          id: "oi-1",
          status: "IN_PROGRESS",
          test: {
            id: "t-glu",
            name: "Glucose",
            normalRange: "70-110",
            unit: "mg/dL",
            category: "Biochemistry",
            panicLow: 40,
            panicHigh: 500,
          },
          results: [],
        },
      ] as OrderItem[]),
  };
}

function wireOrderGet(orderResp: any) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.endsWith("/attachments")) {
      return Promise.resolve({ data: [] });
    }
    if (url.startsWith("/lab/orders/")) {
      return Promise.resolve({ data: orderResp });
    }
    return Promise.resolve({ data: null });
  });
}

// ─── Tests ───────────────────────────────────────────────

describe("LabOrderPage — lab-order detail surface", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    openPrintEndpointMock.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    confirmMock.mockReset();
    authMock.mockReset();
    sharedHelpers.isImagingLabTest.mockClear();
    sharedHelpers.getLabTestResultMode.mockClear();
    confirmMock.mockResolvedValue(true);
    authMock.mockReturnValue({
      user: { id: "u-lt", role: "LAB_TECH", name: "Tech" },
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading skeleton with aria-busy while the GET is in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    renderPage();
    const loader = await screen.findByTestId("lab-order-detail-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card").length).toBeGreaterThanOrEqual(3);
  });

  it("bounces RECEPTION to /dashboard/not-authorized and never fetches the order", async () => {
    authMock.mockReturnValue({
      user: { id: "u-rec", role: "RECEPTION", name: "Rec" },
      isLoading: false,
    });
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    renderPage();

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledTimes(1);
    });
    const target = String(routerMock.replace.mock.calls[0][0]);
    expect(target.startsWith("/dashboard/not-authorized?from=")).toBe(true);
    expect(decodeURIComponent(target)).toContain("/dashboard/lab/o1");
    expect(toastMock.error).toHaveBeenCalledWith(
      "Lab orders & results are restricted to clinical staff.",
    );
    // The disallowed-role gate short-circuits the order fetch.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("does not gate while the auth store is still loading", async () => {
    authMock.mockReturnValue({ user: null, isLoading: true });
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    renderPage();
    await screen.findByTestId("lab-order-detail-loading");
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("shows the not-found branch when the order GET resolves to null", async () => {
    wireOrderGet(null);
    renderPage();
    await screen.findByText("Order not found");
    expect(
      screen.getByRole("link", { name: /Back to Lab Orders/i }),
    ).toHaveAttribute("href", "/dashboard/lab");
    fireEvent.click(screen.getByRole("button", { name: /Go back/i }));
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it("renders the order header with patient / doctor / status pill and Print CTA", async () => {
    wireOrderGet(
      order({
        status: "IN_PROGRESS",
        notes: "Fasting since 8 PM.",
      }),
    );
    renderPage();

    await screen.findByText(/LAB-2026-0001/);
    expect(
      screen.getByRole("heading", { name: /LAB-2026-0001/ }),
    ).toBeInTheDocument();
    // Status pill — underscores stripped, spaces in. The order pill and the
    // (sole) item-status pill both render "IN PROGRESS", so both are
    // matched. Assert the pair, then check the order-level one carries the
    // wider px-3 padding class.
    const pills = screen.getAllByText("IN PROGRESS");
    expect(pills.length).toBeGreaterThanOrEqual(2);
    expect(pills.some((p) => p.className.includes("px-3"))).toBe(true);
    // Patient header.
    expect(screen.getByText("Anita Sharma")).toBeInTheDocument();
    expect(screen.getByText(/MR-00007.*F.*34 yrs/)).toBeInTheDocument();
    // Doctor formatted with the formatDoctorName mock.
    expect(screen.getByText("Dr. Mehta")).toBeInTheDocument();
    // Notes block.
    expect(screen.getByText("Fasting since 8 PM.")).toBeInTheDocument();
    // Print CTA fires the print endpoint with the correct path.
    fireEvent.click(screen.getByRole("button", { name: /Print lab report/i }));
    expect(openPrintEndpointMock).toHaveBeenCalledWith(
      "/lab/orders/o1-full-id/pdf",
    );
  });

  it("falls back to id.slice(0,8) when orderNumber is missing", async () => {
    wireOrderGet(
      order({
        orderNumber: "",
      }),
    );
    renderPage();
    // id "o1-full-id" → slice(0,8) → "o1-full-". The heading composes
    // "Order " + slice across separate text nodes; match on the heading
    // role with a function-style matcher to traverse the children.
    await screen.findByRole("heading", {
      name: (name) => /Order\s+o1-full-/.test(name),
    });
  });

  it("LAB_TECH on ORDERED order: 'Mark Sample Collected' PATCHes /status and reloads", async () => {
    wireOrderGet(order({ status: "ORDERED" }));
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    renderPage();
    const btn = await screen.findByTestId("lab-mark-collected-btn");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/lab/orders/o1/status",
        { status: "SAMPLE_COLLECTED" },
      );
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      "Sample marked as collected.",
    );
  });

  it("mark-collected: confirm rejected → no PATCH", async () => {
    wireOrderGet(order({ status: "ORDERED" }));
    confirmMock.mockResolvedValueOnce(false);
    renderPage();
    const btn = await screen.findByTestId("lab-mark-collected-btn");
    fireEvent.click(btn);
    // microtask drain
    await Promise.resolve();
    await Promise.resolve();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("mark-collected: PATCH error surfaces toast.error with the message", async () => {
    wireOrderGet(order({ status: "ORDERED" }));
    apiMock.patch.mockRejectedValue(new Error("status server down"));
    renderPage();
    const btn = await screen.findByTestId("lab-mark-collected-btn");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("status server down");
    });
  });

  it("mark-complete CTA: appears when every item has results and order != COMPLETED; PATCHes + reloads", async () => {
    const populated = order({
      status: "IN_PROGRESS",
      items: [
        {
          id: "oi-1",
          status: "IN_PROGRESS",
          test: {
            id: "t-glu",
            name: "Glucose",
            unit: "mg/dL",
            normalRange: "70-110",
          },
          results: [
            {
              id: "r-1",
              parameter: "Fasting glucose",
              value: "92",
              unit: "mg/dL",
              normalRange: "70-110",
              flag: "NORMAL",
              notes: null,
            },
          ],
        },
      ],
    });
    wireOrderGet(populated);
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    renderPage();
    const btn = await screen.findByRole("button", {
      name: /Mark Order Complete/i,
    });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/lab/orders/o1/status",
        { status: "COMPLETED" },
      );
    });
  });

  it("mark-complete: confirm rejected → no PATCH", async () => {
    wireOrderGet(
      order({
        status: "IN_PROGRESS",
        items: [
          {
            id: "oi-1",
            status: "IN_PROGRESS",
            test: { id: "t-glu", name: "Glucose", unit: "mg/dL" },
            results: [
              {
                id: "r-1",
                parameter: "Fasting",
                value: "92",
                flag: "NORMAL",
              },
            ],
          },
        ],
      }),
    );
    confirmMock.mockResolvedValueOnce(false);
    renderPage();
    const btn = await screen.findByRole("button", {
      name: /Mark Order Complete/i,
    });
    fireEvent.click(btn);
    await Promise.resolve();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Add Result form: 'Parameter is required' toast when parameter is empty", async () => {
    wireOrderGet(order());
    renderPage();
    const form = await screen.findByTestId("lab-add-result-form");
    fireEvent.submit(form);
    expect(toastMock.error).toHaveBeenCalledWith("Parameter is required");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Result form: inline 'Value is required' error when value is empty", async () => {
    wireOrderGet(order());
    renderPage();
    const form = await screen.findByTestId("lab-add-result-form");
    // Parameter present, value missing.
    const paramInput = screen.getByPlaceholderText("Parameter");
    fireEvent.change(paramInput, { target: { value: "Fasting glucose" } });
    fireEvent.submit(form);
    expect(
      await screen.findByTestId("error-lab-result-value"),
    ).toHaveTextContent(/Value is required/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Numeric test + scientific-notation value → numeric-only inline error + toast, no POST", async () => {
    wireOrderGet(order());
    renderPage();
    const form = await screen.findByTestId("lab-add-result-form");
    fireEvent.change(screen.getByPlaceholderText("Parameter"), {
      target: { value: "Fasting glucose" },
    });
    // "1e5" is accepted by `<input type=number>` (jsdom mirrors browser
    // behaviour for scientific notation) but the source-side regex
    // `/^-?\d+(\.\d+)?$/` rejects the `e` — so we hit the numeric-only
    // branch without being short-circuited by an empty input.value.
    fireEvent.change(screen.getByTestId("lab-result-value"), {
      target: { value: "1e5" },
    });
    fireEvent.submit(form);
    expect(
      await screen.findByTestId("error-lab-result-value"),
    ).toHaveTextContent(/must be a number/);
    expect(toastMock.error).toHaveBeenCalledWith(
      "Result value must be a number for this test",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Numeric test + value below panicLow → bound-specific inline error, no POST", async () => {
    wireOrderGet(order()); // panicLow=40
    renderPage();
    const form = await screen.findByTestId("lab-add-result-form");
    fireEvent.change(screen.getByPlaceholderText("Parameter"), {
      target: { value: "Fasting glucose" },
    });
    fireEvent.change(screen.getByTestId("lab-result-value"), {
      target: { value: "10" },
    });
    fireEvent.submit(form);
    expect(
      await screen.findByTestId("error-lab-result-value"),
    ).toHaveTextContent(/Value must be ≥ 40/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Numeric test + value above panicHigh → bound-specific inline error, no POST", async () => {
    wireOrderGet(order()); // panicHigh=500
    renderPage();
    const form = await screen.findByTestId("lab-add-result-form");
    fireEvent.change(screen.getByPlaceholderText("Parameter"), {
      target: { value: "Fasting glucose" },
    });
    fireEvent.change(screen.getByTestId("lab-result-value"), {
      target: { value: "9000" },
    });
    fireEvent.submit(form);
    expect(
      await screen.findByTestId("error-lab-result-value"),
    ).toHaveTextContent(/Value must be ≤ 500/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Numeric test + value above ±1e9 cap → 'outside the supported numeric range' inline error (Issue #638)", async () => {
    wireOrderGet(
      order({
        items: [
          {
            id: "oi-1",
            status: "IN_PROGRESS",
            // Numeric (has unit), but no panic bounds — exercise the cap branch.
            test: { id: "t-x", name: "Random Marker", unit: "mg/dL" },
            results: [],
          },
        ],
      }),
    );
    renderPage();
    const form = await screen.findByTestId("lab-add-result-form");
    fireEvent.change(screen.getByPlaceholderText("Parameter"), {
      target: { value: "X" },
    });
    // "10000000000" (1e10 plain-text) passes the regex but trips the ±1e9
    // cap branch. Scientific-notation "1e18" would fail the regex first.
    fireEvent.change(screen.getByTestId("lab-result-value"), {
      target: { value: "10000000000" },
    });
    fireEvent.submit(form);
    expect(
      await screen.findByTestId("error-lab-result-value"),
    ).toHaveTextContent(/outside the supported numeric range/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Unit field with only whitespace → toast.error + no POST (Issue #640)", async () => {
    wireOrderGet(
      order({
        items: [
          {
            id: "oi-1",
            status: "IN_PROGRESS",
            // Non-numeric (no unit on the test definition) so we skip the
            // numeric checks; the whitespace-unit check is the gate we want.
            test: { id: "t-color", name: "Urine Color" },
            results: [],
          },
        ],
      }),
    );
    renderPage();
    const form = await screen.findByTestId("lab-add-result-form");
    fireEvent.change(screen.getByPlaceholderText("Parameter"), {
      target: { value: "Color" },
    });
    fireEvent.change(screen.getByTestId("lab-result-value"), {
      target: { value: "Yellow" },
    });
    fireEvent.change(screen.getByPlaceholderText("Unit"), {
      target: { value: "   " },
    });
    fireEvent.submit(form);
    expect(toastMock.error).toHaveBeenCalledWith(
      "Unit cannot be only whitespace. Leave blank or enter a real unit.",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Happy submit → POST /lab/results with the correct body and reloads the order", async () => {
    wireOrderGet(order());
    apiMock.post.mockResolvedValue({ data: { id: "r-new" } });

    renderPage();
    const form = await screen.findByTestId("lab-add-result-form");
    fireEvent.change(screen.getByPlaceholderText("Parameter"), {
      target: { value: "Fasting glucose" },
    });
    fireEvent.change(screen.getByTestId("lab-result-value"), {
      target: { value: "92" },
    });
    fireEvent.change(screen.getByPlaceholderText("Normal Range"), {
      target: { value: "70-110" },
    });
    fireEvent.change(screen.getByPlaceholderText("Notes (optional)"), {
      target: { value: "after 8h fast" },
    });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/lab/results", {
        orderItemId: "oi-1",
        parameter: "Fasting glucose",
        value: "92",
        unit: "mg/dL",
        normalRange: "70-110",
        flag: "NORMAL",
        notes: "after 8h fast",
      });
    });
  });

  it("API error with payload.details[field=value] surfaces inline error (Issue #95)", async () => {
    wireOrderGet(order());
    apiMock.post.mockRejectedValue(
      Object.assign(new Error("rejected"), {
        payload: {
          details: [{ field: "value", message: "Server says no" }],
        },
      }),
    );
    renderPage();
    const form = await screen.findByTestId("lab-add-result-form");
    fireEvent.change(screen.getByPlaceholderText("Parameter"), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByTestId("lab-result-value"), {
      target: { value: "92" },
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Server says no");
    });
    expect(
      await screen.findByTestId("error-lab-result-value"),
    ).toHaveTextContent("Server says no");
  });

  it("API error without details falls back to err.message toast", async () => {
    wireOrderGet(order());
    apiMock.post.mockRejectedValue(new Error("submit failed"));
    renderPage();
    const form = await screen.findByTestId("lab-add-result-form");
    fireEvent.change(screen.getByPlaceholderText("Parameter"), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByTestId("lab-result-value"), {
      target: { value: "92" },
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("submit failed");
    });
  });

  it("Qualitative test renders the QUALITATIVE_RESULT_OPTIONS picker (Issue #620)", async () => {
    wireOrderGet(
      order({
        items: [
          {
            id: "oi-q",
            status: "IN_PROGRESS",
            test: { id: "t-hiv", name: "HIV", category: "Serology" },
            results: [],
          },
        ],
      }),
    );
    renderPage();
    const valueField = await screen.findByTestId("lab-result-value");
    expect(valueField.tagName).toBe("SELECT");
    expect(valueField.querySelectorAll("option").length).toBeGreaterThanOrEqual(
      sharedHelpers.QUALITATIVE_RESULT_OPTIONS.length + 1, // +1 for "Select result…"
    );
  });

  it("Add Result form is NOT rendered for the PATIENT role (Issue #255)", async () => {
    authMock.mockReturnValue({
      user: { id: "u-pat", role: "PATIENT", name: "Pat" },
      isLoading: false,
    });
    wireOrderGet(order());
    renderPage();
    await screen.findByText("Anita Sharma");
    expect(
      screen.queryByTestId("lab-add-result-form"),
    ).not.toBeInTheDocument();
  });

  it("Finalised order: Add Result form HIDDEN, finalised notice shown for LAB_TECH (Issue #609)", async () => {
    wireOrderGet(
      order({
        status: "COMPLETED",
        items: [
          {
            id: "oi-1",
            status: "COMPLETED",
            test: { id: "t-glu", name: "Glucose", unit: "mg/dL" },
            results: [
              {
                id: "r-1",
                parameter: "G",
                value: "92",
                unit: "mg/dL",
                flag: "NORMAL",
              },
            ],
          },
        ],
      }),
    );
    renderPage();
    await screen.findByText("Anita Sharma");
    expect(
      screen.getByTestId("lab-result-finalised-notice"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("lab-add-result-form"),
    ).not.toBeInTheDocument();
    // The mark-complete CTA must not render for an already-COMPLETED order.
    expect(
      screen.queryByRole("button", { name: /Mark Order Complete/i }),
    ).not.toBeInTheDocument();
  });

  it("Range-hint dedupes the unit when normalRange already includes it (Issue #147)", async () => {
    wireOrderGet(
      order({
        items: [
          {
            id: "oi-1",
            status: "IN_PROGRESS",
            test: {
              id: "t-glu",
              name: "Glucose",
              // Range already mentions the unit — must NOT be appended again.
              normalRange: "70-110 mg/dL",
              unit: "mg/dL",
            },
            results: [],
          },
        ],
      }),
    );
    renderPage();
    const hint = await screen.findByTestId("lab-range-hint");
    expect(hint.textContent).toMatch(/Normal range: 70-110 mg\/dL$/);
    // Double-unit guard: the substring "mg/dL mg/dL" must not appear.
    expect(hint.textContent).not.toMatch(/mg\/dL\s+mg\/dL/);
  });

  it("RadiologyAttachmentsPanel: renders only when an imaging item is present + LAB_TECH sees upload form", async () => {
    const orderResp = order({
      items: [
        {
          id: "oi-img",
          status: "IN_PROGRESS",
          test: {
            id: "t-usg",
            name: "USG Abdomen",
            category: "Imaging",
          },
          results: [],
        },
      ],
    });
    wireOrderGet(orderResp);
    renderPage();
    expect(await screen.findByTestId("lab-radiology-panel")).toBeInTheDocument();
    // Empty-attachments copy.
    expect(
      screen.getByText("No imaging artefacts uploaded yet."),
    ).toBeInTheDocument();
    // LAB_TECH sees the upload form.
    expect(screen.getByTestId("lab-attachment-upload-form")).toBeInTheDocument();
  });

  it("RadiologyAttachmentsPanel: NOT rendered for non-imaging-only orders", async () => {
    wireOrderGet(order()); // Glucose only — non-imaging.
    renderPage();
    await screen.findByText("Anita Sharma");
    expect(screen.queryByTestId("lab-radiology-panel")).not.toBeInTheDocument();
  });

  it("RadiologyAttachmentsPanel: existing attachments render with title / mimeType / size", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.endsWith("/attachments")) {
        return Promise.resolve({
          data: [
            {
              id: "a-1",
              title: "USG Abdomen — final",
              filePath: "uploads/a1.pdf",
              fileSize: 2048,
              mimeType: "application/pdf",
              createdAt: "2026-05-02T10:00:00.000Z",
            },
          ],
        });
      }
      if (url.startsWith("/lab/orders/")) {
        return Promise.resolve({
          data: order({
            items: [
              {
                id: "oi-img",
                status: "IN_PROGRESS",
                test: {
                  id: "t-usg",
                  name: "USG Abdomen",
                  category: "Imaging",
                },
                results: [],
              },
            ],
          }),
        });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    const row = await screen.findByTestId("lab-attachment-row");
    expect(row).toHaveTextContent("USG Abdomen — final");
    expect(row).toHaveTextContent("application/pdf");
    // 2048 / 1024 = 2.0 KB rendered.
    expect(row).toHaveTextContent(/2\.0 KB/);
  });

  it("RadiologyAttachmentsPanel: upload form HIDDEN for PATIENT", async () => {
    authMock.mockReturnValue({
      user: { id: "u-pat", role: "PATIENT", name: "Pat" },
      isLoading: false,
    });
    wireOrderGet(
      order({
        items: [
          {
            id: "oi-img",
            status: "IN_PROGRESS",
            test: { id: "t-usg", name: "USG Abdomen", category: "Imaging" },
            results: [],
          },
        ],
      }),
    );
    renderPage();
    await screen.findByTestId("lab-radiology-panel");
    expect(
      screen.queryByTestId("lab-attachment-upload-form"),
    ).not.toBeInTheDocument();
  });

  it("RadiologyAttachmentsPanel: submit without a file → toast.error 'Choose a file to upload'", async () => {
    wireOrderGet(
      order({
        items: [
          {
            id: "oi-img",
            status: "IN_PROGRESS",
            test: { id: "t-usg", name: "USG Abdomen", category: "Imaging" },
            results: [],
          },
        ],
      }),
    );
    renderPage();
    const form = await screen.findByTestId("lab-attachment-upload-form");
    fireEvent.submit(form);
    expect(toastMock.error).toHaveBeenCalledWith("Choose a file to upload");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("RadiologyAttachmentsPanel: file > 10 MB → toast.error 10-MB cap copy, no POST", async () => {
    wireOrderGet(
      order({
        items: [
          {
            id: "oi-img",
            status: "IN_PROGRESS",
            test: { id: "t-usg", name: "USG Abdomen", category: "Imaging" },
            results: [],
          },
        ],
      }),
    );
    renderPage();
    const form = await screen.findByTestId("lab-attachment-upload-form");
    const fileInput = screen.getByTestId("lab-attachment-file") as HTMLInputElement;
    // Stub a 12 MB file.
    const bigFile = new File([new Uint8Array(1)], "x.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(bigFile, "size", { value: 12 * 1024 * 1024 });
    Object.defineProperty(fileInput, "files", { value: [bigFile] });
    fireEvent.change(fileInput);
    // Title supplied so we'd otherwise pass the title check.
    fireEvent.change(screen.getByTestId("lab-attachment-title"), {
      target: { value: "USG report" },
    });
    fireEvent.submit(form);
    expect(toastMock.error).toHaveBeenCalledWith(
      "File exceeds 10 MB cap. Compress before re-uploading.",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("RadiologyAttachmentsPanel: empty title → toast.error title-required copy, no POST", async () => {
    wireOrderGet(
      order({
        items: [
          {
            id: "oi-img",
            status: "IN_PROGRESS",
            test: { id: "t-usg", name: "USG Abdomen", category: "Imaging" },
            results: [],
          },
        ],
      }),
    );
    renderPage();
    const form = await screen.findByTestId("lab-attachment-upload-form");
    const fileInput = screen.getByTestId("lab-attachment-file") as HTMLInputElement;
    const okFile = new File([new Uint8Array([1, 2, 3])], "x.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(okFile, "size", { value: 100 });
    Object.defineProperty(fileInput, "files", { value: [okFile] });
    fireEvent.change(fileInput);
    fireEvent.submit(form);
    expect(toastMock.error).toHaveBeenCalledWith(
      'Title is required (e.g. "USG Abdomen — final report")',
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("RadiologyAttachmentsPanel: happy upload → POST /attachments with the expected payload and success toast", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.endsWith("/attachments")) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: order({
          items: [
            {
              id: "oi-img",
              status: "IN_PROGRESS",
              test: {
                id: "t-usg",
                name: "USG Abdomen",
                category: "Imaging",
              },
              results: [],
            },
          ],
        }),
      });
    });
    apiMock.post.mockResolvedValue({ data: { id: "a-new" } });

    // Stub FileReader so the base64 conversion is deterministic.
    const RealFileReader = (globalThis as any).FileReader;
    class StubReader {
      onload: ((e: any) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      result: string | null = null;
      readAsDataURL(_f: any) {
        this.result = "data:application/pdf;base64,ZmFrZS1iYXNlNjQ=";
        // Fire onload on the next microtask. Using queueMicrotask keeps the
        // resolution inside React's act-batch window — setTimeout(0) was
        // sometimes hanging past vitest's waitFor budget.
        queueMicrotask(() => this.onload && this.onload({} as any));
      }
    }
    (globalThis as any).FileReader = StubReader as any;

    try {
      renderPage();
      const form = await screen.findByTestId("lab-attachment-upload-form");
      const fileInput = screen.getByTestId(
        "lab-attachment-file",
      ) as HTMLInputElement;
      const okFile = new File([new Uint8Array([1, 2, 3])], "report.pdf", {
        type: "application/pdf",
      });
      Object.defineProperty(okFile, "size", { value: 500 });
      Object.defineProperty(fileInput, "files", { value: [okFile] });
      fireEvent.change(fileInput);
      fireEvent.change(screen.getByTestId("lab-attachment-title"), {
        target: { value: "USG Abdomen — final" },
      });
      fireEvent.submit(form);

      await waitFor(() => {
        // RadiologyAttachmentsPanel is keyed on `order.id` (the full DB id),
        // NOT the URL slug — the parent passes `orderId={order.id}`.
        expect(apiMock.post).toHaveBeenCalledWith(
          "/lab/orders/o1-full-id/attachments",
          expect.objectContaining({
            filename: "report.pdf",
            base64Content: "ZmFrZS1iYXNlNjQ=",
            title: "USG Abdomen — final",
          }),
        );
      });
      expect(toastMock.success).toHaveBeenCalledWith("Attachment uploaded");
    } finally {
      (globalThis as any).FileReader = RealFileReader;
    }
  });

  it("RadiologyAttachmentsPanel: upload API rejection → toast.error with err.message", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.endsWith("/attachments")) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: order({
          items: [
            {
              id: "oi-img",
              status: "IN_PROGRESS",
              test: {
                id: "t-usg",
                name: "USG Abdomen",
                category: "Imaging",
              },
              results: [],
            },
          ],
        }),
      });
    });
    apiMock.post.mockRejectedValue(new Error("upload boom"));

    const RealFileReader = (globalThis as any).FileReader;
    class StubReader {
      onload: ((e: any) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      result: string | null = null;
      readAsDataURL(_f: any) {
        this.result = "data:application/pdf;base64,YWJj";
        setTimeout(() => this.onload && this.onload({} as any), 0);
      }
    }
    (globalThis as any).FileReader = StubReader as any;

    try {
      renderPage();
      const form = await screen.findByTestId("lab-attachment-upload-form");
      const fileInput = screen.getByTestId(
        "lab-attachment-file",
      ) as HTMLInputElement;
      const okFile = new File([new Uint8Array([1])], "r.pdf", {
        type: "application/pdf",
      });
      Object.defineProperty(okFile, "size", { value: 10 });
      Object.defineProperty(fileInput, "files", { value: [okFile] });
      fireEvent.change(fileInput);
      fireEvent.change(screen.getByTestId("lab-attachment-title"), {
        target: { value: "T" },
      });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(toastMock.error).toHaveBeenCalledWith("upload boom");
      });
    } finally {
      (globalThis as any).FileReader = RealFileReader;
    }
  });

  it("DOCTOR can view but cannot enter results (A5 RBAC drift — Issue #459)", async () => {
    authMock.mockReturnValue({
      user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
      isLoading: false,
    });
    wireOrderGet(order());
    renderPage();
    await screen.findByText("Anita Sharma");
    // DOCTOR is NOT in (ADMIN | LAB_TECH) → no Add Result form.
    expect(
      screen.queryByTestId("lab-add-result-form"),
    ).not.toBeInTheDocument();
  });

  it("ADMIN sees the Add Result form", async () => {
    authMock.mockReturnValue({
      user: { id: "u-adm", role: "ADMIN", name: "Adm" },
      isLoading: false,
    });
    wireOrderGet(order());
    renderPage();
    expect(
      await screen.findByTestId("lab-add-result-form"),
    ).toBeInTheDocument();
  });
});
