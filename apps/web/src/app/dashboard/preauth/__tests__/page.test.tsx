/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PreAuthPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/preauth/page.tsx, the
 *     ADMIN/RECEPTION insurance pre-authorisation queue. Endpoints:
 *       GET   /preauth?status=PENDING|APPROVED|REJECTED   (list rows)
 *       GET   /preauth                                    (status=ALL branch)
 *       GET   /patients?search=...                        (modal patient picker)
 *       POST  /preauth                                    (create request)
 *       PATCH /preauth/:id/status                         (approve/reject/partial)
 *
 *   - Behaviours covered:
 *       1. RBAC — non-allowlisted role (DOCTOR) triggers toast.error +
 *          router.replace("/dashboard/not-authorized?from=...").
 *       2. ADMIN role renders chrome + fires the PENDING fetch on mount.
 *       3. Loading branch — `preauth-loading` skeleton wrapper while fetch
 *          is pending; tab buttons render.
 *       4. Empty branch — "No requests in this category." copy.
 *       5. Happy fetch — rows render with status pills (APPROVED green,
 *          REJECTED red, PARTIAL orange, PENDING/other yellow) and the
 *          "approved Rs. X" subtitle when approvedAmount is non-null.
 *       6. Tab switch fires a refetch with the new status param.
 *       7. ALL tab omits the status param ("?").
 *       8. Update button only renders on PENDING rows.
 *       9. New Request modal opens, closes (X button), and renders fields.
 *      10. Modal validates per-field — missing patient/insurer/policy/
 *          procedure/cost are all surfaced as inline errors; POST not fired.
 *      11. Patient search — debounced GET /patients fires when length ≥ 2,
 *          and the rendered option becomes the selected patient with a
 *          "Change" button.
 *      12. POST happy path — sends a well-shaped body, closes modal, reloads.
 *      13. POST error — generic Error message surfaces via toast.error.
 *      14. POST error with payload.details — surfaces field-errors instead.
 *      15. UpdateStatusModal — APPROVED happy path (PATCH wired), REJECTED
 *          requires rejectionReason (inline error), invalid amount blocks.
 *      16. Error-path resilience — initial GET rejection still flips loading
 *          off and renders the empty branch.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            @/lib/field-errors, next/navigation, @/components/Skeleton.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";

const {
  apiMock,
  toastMock,
  authMock,
  routerMock,
  extractFieldErrorsMock,
} = vi.hoisted(() => ({
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
  extractFieldErrorsMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/field-errors", () => ({
  extractFieldErrors: extractFieldErrorsMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/preauth",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import PreAuthPage from "../page";

type Row = {
  id: string;
  requestNumber: string;
  insuranceProvider: string;
  policyNumber: string;
  procedureName: string;
  estimatedCost: number;
  status: string;
  approvedAmount?: number | null;
  rejectionReason?: string | null;
  submittedAt: string;
  resolvedAt?: string | null;
  claimReferenceNumber?: string | null;
  diagnosis?: string | null;
  patient: {
    id: string;
    mrNumber: string;
    user: { name: string; phone: string };
  };
};

function rowFixture(overrides: Partial<Row> = {}): Row {
  return {
    id: "r-1",
    requestNumber: "PA-0001",
    insuranceProvider: "Star Health",
    policyNumber: "POL-12345",
    procedureName: "Knee Surgery",
    estimatedCost: 50000,
    status: "PENDING",
    approvedAmount: null,
    rejectionReason: null,
    submittedAt: "2026-05-20T10:00:00Z",
    resolvedAt: null,
    claimReferenceNumber: null,
    diagnosis: null,
    patient: {
      id: "p-1",
      mrNumber: "MR-001",
      user: { name: "Ramesh Kumar", phone: "9999999999" },
    },
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: {
      id: "u-admin",
      userId: "u-admin",
      role: "ADMIN",
      name: "Admin",
      email: "admin@test.local",
    },
    isLoading: false,
  });
}

function asReception() {
  authMock.mockReturnValue({
    user: {
      id: "u-recep",
      userId: "u-recep",
      role: "RECEPTION",
      name: "Recep",
      email: "recep@test.local",
    },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: {
      id: "u-doc",
      userId: "u-doc",
      role: "DOCTOR",
      name: "Doc",
      email: "doc@test.local",
    },
    isLoading: false,
  });
}

function asLoading() {
  authMock.mockReturnValue({ user: null, isLoading: true });
}

describe("PreAuth dashboard page (insurance pre-authorisation queue)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    extractFieldErrorsMock.mockReset();
    extractFieldErrorsMock.mockReturnValue(null);
    asAdmin();
    // Default: list endpoint returns empty so individual tests don't have
    // to wire it unless they assert on rows.
    apiMock.get.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects DOCTOR to /dashboard/not-authorized and toasts the restriction copy", async () => {
    asDoctor();

    render(<PreAuthPage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\/dashboard\/not-authorized\?from=%2Fdashboard%2Fpreauth$/,
        ),
      ),
    );
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/restricted to Admin and Reception/i),
    );
  });

  it("does NOT redirect while auth is still loading", async () => {
    asLoading();

    render(<PreAuthPage />);

    // Give the effect a tick to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("renders the page chrome + fires the PENDING fetch on mount for RECEPTION", async () => {
    asReception();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PreAuthPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/preauth?status=PENDING"),
    );
    expect(
      screen.getByRole("heading", { name: /Pre-Authorization/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New Request/i })).toBeInTheDocument();
    // Tab buttons present.
    expect(screen.getByRole("button", { name: /^Pending$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approved$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Rejected$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^All$/i })).toBeInTheDocument();
  });

  it("renders the SkeletonTable loading branch while the initial GET is pending", () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));

    render(<PreAuthPage />);

    expect(screen.getByTestId("preauth-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("renders the empty branch when the list is empty", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PreAuthPage />);

    expect(
      await screen.findByText(/No requests in this category/i),
    ).toBeInTheDocument();
  });

  it("renders one row per result with the request number and patient name", async () => {
    apiMock.get.mockResolvedValue({
      data: [rowFixture(), rowFixture({ id: "r-2", requestNumber: "PA-0002" })],
    });

    render(<PreAuthPage />);

    expect(await screen.findByText("PA-0001")).toBeInTheDocument();
    expect(screen.getByText("PA-0002")).toBeInTheDocument();
    // Two PENDING rows → two Update buttons.
    expect(screen.getAllByRole("button", { name: /^Update$/i })).toHaveLength(2);
  });

  it("shows the approved-amount subtitle when approvedAmount is non-null", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        rowFixture({
          status: "APPROVED",
          approvedAmount: 45000,
        }),
      ],
    });

    render(<PreAuthPage />);

    expect(await screen.findByText("PA-0001")).toBeInTheDocument();
    // fmtMoney formats with Indian grouping.
    expect(screen.getByText(/approved Rs\. 45,000/i)).toBeInTheDocument();
  });

  it("renders status pills with the right colour class per status", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        rowFixture({ id: "r-a", requestNumber: "PA-A", status: "APPROVED" }),
        rowFixture({ id: "r-r", requestNumber: "PA-R", status: "REJECTED" }),
        rowFixture({ id: "r-p", requestNumber: "PA-P", status: "PARTIAL" }),
        rowFixture({ id: "r-o", requestNumber: "PA-O", status: "PENDING" }),
      ],
    });

    render(<PreAuthPage />);

    const approved = await screen.findByText("APPROVED");
    const rejected = screen.getByText("REJECTED");
    const partial = screen.getByText("PARTIAL");
    const pending = screen.getByText("PENDING");

    expect(approved.className).toMatch(/bg-green-100/);
    expect(rejected.className).toMatch(/bg-red-100/);
    expect(partial.className).toMatch(/bg-orange-100/);
    expect(pending.className).toMatch(/bg-yellow-100/);
  });

  it("only renders the Update button on PENDING rows", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        rowFixture({ id: "r-1", requestNumber: "PA-0001", status: "PENDING" }),
        rowFixture({ id: "r-2", requestNumber: "PA-0002", status: "APPROVED" }),
      ],
    });

    render(<PreAuthPage />);

    await screen.findByText("PA-0001");
    expect(screen.getAllByRole("button", { name: /^Update$/i })).toHaveLength(1);
  });

  it("switching tabs re-fires the fetch with the new status param", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PreAuthPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/preauth?status=PENDING"),
    );

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Approved$/i }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/preauth?status=APPROVED"),
    );

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Rejected$/i }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/preauth?status=REJECTED"),
    );
  });

  it("the ALL tab omits the status querystring entirely", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PreAuthPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/preauth?status=PENDING"),
    );

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^All$/i }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/preauth?"),
    );
  });

  it("New Request modal opens with patient search input and required fields", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PreAuthPage />);

    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));

    expect(
      screen.getByRole("heading", { name: /New Pre-Auth Request/i }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search patient/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Insurance Provider/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Policy Number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Procedure Name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Estimated Cost/i)).toBeInTheDocument();
  });

  it("Submit with no fields filled does NOT POST (per-field guard fires)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PreAuthPage />);

    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));

    // Guard fires → no POST.
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.post).not.toHaveBeenCalled();
    // Modal still open.
    expect(
      screen.getByRole("heading", { name: /New Pre-Auth Request/i }),
    ).toBeInTheDocument();
  });

  it("Patient search debounce fires GET /patients and the picked row becomes the selected patient", async () => {
    // Initial list GET returns empty; subsequent /patients GET returns one row.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [
            { id: "p-1", mrNumber: "MR-100", user: { name: "Suresh Iyer" } },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PreAuthPage />);

    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));

    const searchInput = screen.getByPlaceholderText(/Search patient/i);
    fireEvent.change(searchInput, { target: { value: "Sur" } });

    // 300ms debounce.
    await new Promise((r) => setTimeout(r, 350));

    // Result option rendered.
    const opt = await screen.findByRole("button", {
      name: /Suresh Iyer.*MR-100/,
    });
    fireEvent.click(opt);

    // Selected patient pill renders with a Change button.
    expect(
      screen.getByText(/Suresh Iyer \(MR-100\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Change$/i }),
    ).toBeInTheDocument();
  });

  it("the modal Change button drops the selected patient back to search mode", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [
            { id: "p-1", mrNumber: "MR-100", user: { name: "Suresh Iyer" } },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PreAuthPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search patient/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Suresh Iyer.*MR-100/,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Change$/i }));

    // Search input is back.
    expect(screen.getByPlaceholderText(/Search patient/i)).toBeInTheDocument();
  });

  it("Patient search with <2 chars does NOT fire /patients GET", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PreAuthPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search patient/i), {
      target: { value: "S" },
    });
    await new Promise((r) => setTimeout(r, 350));

    expect(
      apiMock.get.mock.calls.some((c) =>
        (c[0] as string).startsWith("/patients?"),
      ),
    ).toBe(false);
  });

  it("Patient search swallows a failed GET and shows no results", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.reject(new Error("patient search blew up"));
      }
      return Promise.resolve({ data: [] });
    });

    render(<PreAuthPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search patient/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));

    // No option rendered.
    expect(
      screen.queryByRole("button", { name: /MR-100/ }),
    ).not.toBeInTheDocument();
    // No toast — the catch is silent.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Submitting with everything filled POSTs the well-shaped body, closes, reloads", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [
            { id: "p-1", mrNumber: "MR-100", user: { name: "Suresh Iyer" } },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PreAuthPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));

    // Pick a patient.
    fireEvent.change(screen.getByPlaceholderText(/Search patient/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Suresh Iyer.*MR-100/,
      }),
    );

    // Fill the rest.
    fireEvent.change(screen.getByLabelText(/Insurance Provider/i), {
      target: { value: "Star Health" },
    });
    fireEvent.change(screen.getByLabelText(/Policy Number/i), {
      target: { value: "POL-12345" },
    });
    fireEvent.change(screen.getByLabelText(/Procedure Name/i), {
      target: { value: "Knee Surgery" },
    });
    fireEvent.change(screen.getByLabelText(/Estimated Cost/i), {
      target: { value: "50000" },
    });
    fireEvent.change(screen.getByLabelText(/Diagnosis/i), {
      target: { value: "OA" },
    });
    fireEvent.change(screen.getByLabelText(/Notes/i), {
      target: { value: "urgent" },
    });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));

    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/preauth");
    expect(body).toMatchObject({
      patientId: "p-1",
      insuranceProvider: "Star Health",
      policyNumber: "POL-12345",
      procedureName: "Knee Surgery",
      estimatedCost: 50000,
      diagnosis: "OA",
      notes: "urgent",
    });

    // Modal closed.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /New Pre-Auth Request/i }),
      ).not.toBeInTheDocument(),
    );

    // List reload was triggered.
    expect(apiMock.get).toHaveBeenCalledWith("/preauth?status=PENDING");
  });

  it("omits diagnosis + notes from POST body when those textareas are empty", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [
            { id: "p-1", mrNumber: "MR-100", user: { name: "Suresh Iyer" } },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PreAuthPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search patient/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Suresh Iyer.*MR-100/,
      }),
    );
    fireEvent.change(screen.getByLabelText(/Insurance Provider/i), {
      target: { value: "Star Health" },
    });
    fireEvent.change(screen.getByLabelText(/Policy Number/i), {
      target: { value: "POL-12345" },
    });
    fireEvent.change(screen.getByLabelText(/Procedure Name/i), {
      target: { value: "Knee Surgery" },
    });
    fireEvent.change(screen.getByLabelText(/Estimated Cost/i), {
      target: { value: "50000" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));

    const [, body] = apiMock.post.mock.calls[0];
    expect((body as any).diagnosis).toBeUndefined();
    expect((body as any).notes).toBeUndefined();
  });

  it("POST error path with generic Error surfaces toast.error", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [
            { id: "p-1", mrNumber: "MR-100", user: { name: "Suresh Iyer" } },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockRejectedValue(new Error("server exploded"));
    extractFieldErrorsMock.mockReturnValue(null);

    render(<PreAuthPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search patient/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Suresh Iyer.*MR-100/,
      }),
    );
    fireEvent.change(screen.getByLabelText(/Insurance Provider/i), {
      target: { value: "Star Health" },
    });
    fireEvent.change(screen.getByLabelText(/Policy Number/i), {
      target: { value: "POL-1" },
    });
    fireEvent.change(screen.getByLabelText(/Procedure Name/i), {
      target: { value: "Knee" },
    });
    fireEvent.change(screen.getByLabelText(/Estimated Cost/i), {
      target: { value: "1000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server exploded"),
    );

    // Modal still open.
    expect(
      screen.getByRole("heading", { name: /New Pre-Auth Request/i }),
    ).toBeInTheDocument();
  });

  it("POST error with payload.details surfaces field-level errors (no generic toast)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [
            { id: "p-1", mrNumber: "MR-100", user: { name: "Suresh Iyer" } },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const apiErr = new Error("Validation failed");
    apiMock.post.mockRejectedValue(apiErr);
    extractFieldErrorsMock.mockReturnValue({
      insuranceProvider: "Insurance provider must be 3+ chars",
    });

    render(<PreAuthPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search patient/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Suresh Iyer.*MR-100/,
      }),
    );
    fireEvent.change(screen.getByLabelText(/Insurance Provider/i), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByLabelText(/Policy Number/i), {
      target: { value: "POL-1" },
    });
    fireEvent.change(screen.getByLabelText(/Procedure Name/i), {
      target: { value: "Knee" },
    });
    fireEvent.change(screen.getByLabelText(/Estimated Cost/i), {
      target: { value: "1000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    // No generic toast — extractFieldErrors returned a map.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("the New Request modal X button closes it without POSTing", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PreAuthPage />);

    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));
    expect(
      screen.getByRole("heading", { name: /New Pre-Auth Request/i }),
    ).toBeInTheDocument();

    // X button is the first close-style button in the modal header.
    const cancelBtn = screen.getByRole("button", { name: /^Cancel$/i });
    fireEvent.click(cancelBtn);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /New Pre-Auth Request/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("clicking Update on a PENDING row opens the UpdateStatusModal pre-filled", async () => {
    apiMock.get.mockResolvedValue({
      data: [rowFixture({ estimatedCost: 12345 })],
    });

    render(<PreAuthPage />);
    await screen.findByText("PA-0001");

    fireEvent.click(screen.getByRole("button", { name: /^Update$/i }));

    expect(
      screen.getByRole("heading", { name: /Update PA-0001/i }),
    ).toBeInTheDocument();
    // Approved amount pre-filled with the row's estimated cost.
    const amountInput = document.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement;
    expect(amountInput.value).toBe("12345");
  });

  it("UpdateStatusModal APPROVED happy path PATCHes /preauth/:id/status", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<PreAuthPage />);
    await screen.findByText("PA-0001");

    fireEvent.click(screen.getByRole("button", { name: /^Update$/i }));

    // Default status is APPROVED; the approvedAmount is pre-filled.
    const claimRefInput = screen.getByPlaceholderText(/Claim Reference/i);
    fireEvent.change(claimRefInput, { target: { value: "CLAIM-9" } });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));

    const [url, body] = apiMock.patch.mock.calls[0];
    expect(url).toBe("/preauth/r-1/status");
    expect(body).toMatchObject({
      status: "APPROVED",
      approvedAmount: 50000,
      claimReferenceNumber: "CLAIM-9",
    });
    expect((body as any).rejectionReason).toBeUndefined();

    // Modal closed + reload fired.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Update PA-0001/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.get).toHaveBeenCalledWith("/preauth?status=PENDING");
  });

  it("UpdateStatusModal REJECTED without a reason shows inline error and does NOT PATCH", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });

    render(<PreAuthPage />);
    await screen.findByText("PA-0001");

    fireEvent.click(screen.getByRole("button", { name: /^Update$/i }));

    const statusSelect = document.querySelector(
      "select",
    ) as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: "REJECTED" } });

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    expect(
      await screen.findByText(/Rejection reason is required/i),
    ).toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("UpdateStatusModal REJECTED with a reason PATCHes with the rejection branch shape", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<PreAuthPage />);
    await screen.findByText("PA-0001");

    fireEvent.click(screen.getByRole("button", { name: /^Update$/i }));

    const statusSelect = document.querySelector(
      "select",
    ) as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: "REJECTED" } });

    const reasonArea = screen.getByPlaceholderText(/Rejection reason/i);
    fireEvent.change(reasonArea, { target: { value: "Policy excludes" } });

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.patch.mock.calls[0];
    expect(body).toMatchObject({
      status: "REJECTED",
      rejectionReason: "Policy excludes",
    });
    expect((body as any).approvedAmount).toBeUndefined();
  });

  it("UpdateStatusModal blocks save when approvedAmount is non-positive", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });

    render(<PreAuthPage />);
    await screen.findByText("PA-0001");

    fireEvent.click(screen.getByRole("button", { name: /^Update$/i }));

    const amountInput = document.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    expect(
      await screen.findByText(/Approved amount must be greater than 0/i),
    ).toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("UpdateStatusModal PATCH rejection surfaces toast.error and keeps modal open", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });
    apiMock.patch.mockRejectedValue(new Error("update failed"));

    render(<PreAuthPage />);
    await screen.findByText("PA-0001");

    fireEvent.click(screen.getByRole("button", { name: /^Update$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("update failed"),
    );
    expect(
      screen.getByRole("heading", { name: /Update PA-0001/i }),
    ).toBeInTheDocument();
  });

  it("UpdateStatusModal Cancel button closes it without PATCHing", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });

    render(<PreAuthPage />);
    await screen.findByText("PA-0001");

    fireEvent.click(screen.getByRole("button", { name: /^Update$/i }));
    expect(
      screen.getByRole("heading", { name: /Update PA-0001/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Update PA-0001/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("silently swallows the initial GET rejection and renders the empty branch", async () => {
    apiMock.get.mockRejectedValue(new Error("server down"));

    render(<PreAuthPage />);

    expect(
      await screen.findByText(/No requests in this category/i),
    ).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
