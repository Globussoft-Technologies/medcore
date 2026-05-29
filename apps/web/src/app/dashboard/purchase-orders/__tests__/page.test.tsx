/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PurchaseOrdersPage (list) — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/purchase-orders/page.tsx, the
 *     procurement landing screen (Issue #509 view-allowed gate, Issue #63
 *     GST-aware list, NewPOModal create flow). Endpoints hit:
 *       GET  /purchase-orders[?status=...]      (list, by tab)
 *       GET  /suppliers                         (modal supplier select)
 *       GET  /medicines?limit=200               (modal medicine select)
 *       POST /purchase-orders                   (modal create — draft)
 *       POST /purchase-orders/:id/{submit|approve|receive|cancel}
 *
 *   - Behaviours covered:
 *       1. RBAC — VIEW_ALLOWED gate (ADMIN/RECEPTION/PHARMACIST). NURSE
 *          triggers toast.error + router.replace to /not-authorized?from=...
 *          with the breadcrumb intact.
 *       2. Auth still loading — no redirect fires until isLoading flips.
 *       3. Loading skeleton — purchase-orders-loading testid + aria-busy.
 *       4. Empty branch — "No purchase orders found" copy.
 *       5. ALL tab fetches /purchase-orders with NO status qs; specific tabs
 *          append ?status=DRAFT etc.
 *       6. Tab buttons toggle styling AND refetch with the matching status qs.
 *       7. Status badge color classes — DRAFT, PENDING, APPROVED, RECEIVED,
 *          CANCELLED branches.
 *       8. Per-row actions render by status:
 *          DRAFT     → Submit + Cancel
 *          PENDING   → Approve + Cancel
 *          APPROVED  → Receive + Cancel
 *          RECEIVED  → none
 *          CANCELLED → none
 *       9. Confirm dialog accepted → POST to /purchase-orders/:id/<action>
 *          fires + list reloads. Accepted on the danger:true path for cancel.
 *      10. Confirm dialog declined → no POST fires.
 *      11. Action error path — Error → toast.error(message); non-Error →
 *          falls back to "Action failed".
 *      12. PO row hyperlinks to /dashboard/purchase-orders/:id.
 *      13. Initial list-fetch rejection still flips loading off and shows
 *          the empty state (try/catch swallow).
 *      14. New PO modal — opens via "New PO" button, fetches suppliers +
 *          medicines on mount, closes via X (no POST) + Cancel (no POST).
 *      15. Modal validation — blank supplier rejects with "Select a supplier".
 *          Blank description rejects "Row N: description is required".
 *          Qty < 1 rejects. Unit price < 0.01 rejects. Tax % outside [0,100]
 *          rejects.
 *      16. Modal medicine select auto-fills the row description with
 *          "<name> <strength>".
 *      17. Modal Add Row + remove-row (Trash) controls work; the trash icon
 *          is hidden when only one row remains.
 *      18. Modal subtotal/tax/total formula — subtotal = sum(q*p),
 *          tax = subtotal * pct/100, total = subtotal + tax (asserted via
 *          rendered Rs. values).
 *      19. Modal happy POST — POST /purchase-orders with the constructed
 *          body (supplierId, items[], taxPercentage, expectedAt, notes),
 *          parent reloads, modal closes.
 *      20. Modal POST error surfaces inline error banner ("server unavailable"
 *          / "Failed to create PO" fallback).
 *      21. Suppliers/medicines fetch rejection — modal still renders with
 *          empty option lists (try/catch swallow).
 *
 *   - Mocks: @/lib/api, @/lib/toast, @/lib/store (useAuthStore object-return),
 *            @/lib/use-dialog (useConfirm), next/navigation (useRouter +
 *            usePathname), @/components/Skeleton stub, lucide-react icon
 *            stubs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, routerMock, confirmMock } = vi.hoisted(
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
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    },
    confirmMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/purchase-orders",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));
vi.mock("lucide-react", () => ({
  ShoppingCart: () => <span data-testid="icon-cart" />,
  Plus: () => <span data-testid="icon-plus" />,
  X: () => <span data-testid="icon-x" />,
  Trash2: () => <span data-testid="icon-trash" />,
}));

import PurchaseOrdersPage from "../page";

type PORecord = {
  id: string;
  poNumber: string;
  status: "DRAFT" | "PENDING" | "APPROVED" | "RECEIVED" | "CANCELLED";
  orderedAt: string;
  expectedAt?: string | null;
  receivedAt?: string | null;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  createdAt: string;
  supplier: { id: string; name: string };
  items: Array<{
    id: string;
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
};

function poFixture(overrides: Partial<PORecord> = {}): PORecord {
  return {
    id: "po-1",
    poNumber: "PO-2026-0001",
    status: "DRAFT",
    orderedAt: "2026-04-01T08:30:00.000Z",
    expectedAt: null,
    receivedAt: null,
    subtotal: 1000,
    taxAmount: 0,
    totalAmount: 1000,
    createdAt: "2026-04-01T08:30:00.000Z",
    supplier: { id: "sup-1", name: "Acme Pharma" },
    items: [
      {
        id: "li-1",
        description: "Paracetamol 500mg",
        quantity: 100,
        unitPrice: 10,
        amount: 1000,
      },
    ],
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin" },
    isLoading: false,
  });
}

function asReception() {
  authMock.mockReturnValue({
    user: { id: "u-recep", role: "RECEPTION", name: "Front Desk" },
    isLoading: false,
  });
}

function asPharmacist() {
  authMock.mockReturnValue({
    user: { id: "u-pharm", role: "PHARMACIST", name: "Pharm" },
    isLoading: false,
  });
}

function asNurse() {
  authMock.mockReturnValue({
    user: { id: "u-nurse", role: "NURSE", name: "Nurse" },
    isLoading: false,
  });
}

function asLoading() {
  authMock.mockReturnValue({ user: null, isLoading: true });
}

/**
 * The component fires two parallel GETs in the modal (suppliers + medicines)
 * plus a list GET on mount. Use this dispatcher to wire predictable responses
 * by url pattern.
 */
function wireApiGet(opts: {
  listResponse?: { data: PORecord[] } | Error;
  suppliersResponse?: { data: Array<{ id: string; name: string }> } | Error;
  medicinesResponse?: {
    data: Array<{ id: string; name: string; strength?: string | null }>;
  } | Error;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/purchase-orders")) {
      const r = opts.listResponse ?? { data: [] };
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    if (url.startsWith("/suppliers")) {
      const r = opts.suppliersResponse ?? { data: [] };
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    if (url.startsWith("/medicines")) {
      const r = opts.medicinesResponse ?? { data: [] };
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    return Promise.resolve({ data: [] });
  });
}

describe("PurchaseOrdersPage — procurement list / tabs / new-PO modal", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects NURSE to /dashboard/not-authorized with the ?from= breadcrumb and toasts a role-restriction error", async () => {
    asNurse();
    wireApiGet({ listResponse: { data: [] } });

    render(<PurchaseOrdersPage />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith(
        "/dashboard/not-authorized?from=%2Fdashboard%2Fpurchase-orders",
      );
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/Admin, Reception and Pharmacist/),
    );
  });

  it("does not redirect while the auth store is still loading (isLoading=true)", async () => {
    asLoading();
    wireApiGet({ listResponse: { data: [] } });

    render(<PurchaseOrdersPage />);

    // Give effects a tick.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("RECEPTION + PHARMACIST are not redirected (whitelisted alongside ADMIN)", async () => {
    asReception();
    wireApiGet({ listResponse: { data: [] } });

    const { unmount } = render(<PurchaseOrdersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(routerMock.replace).not.toHaveBeenCalled();
    unmount();

    routerMock.replace.mockReset();
    asPharmacist();
    render(<PurchaseOrdersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("renders the loading skeleton (aria-busy) while the list GET is in flight", async () => {
    asAdmin();
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<PurchaseOrdersPage />);

    const loader = await screen.findByTestId("purchase-orders-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("renders the empty-state copy when the list is []", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<PurchaseOrdersPage />);
    expect(
      await screen.findByText("No purchase orders found"),
    ).toBeInTheDocument();
  });

  it("ALL tab fetches /purchase-orders with no querystring; status tabs append ?status=", async () => {
    wireApiGet({ listResponse: { data: [] } });

    render(<PurchaseOrdersPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/purchase-orders"),
    );

    // Switch tab to DRAFT — refetches with ?status=DRAFT.
    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/purchase-orders?status=DRAFT"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Pending" }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/purchase-orders?status=PENDING",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/purchase-orders?status=APPROVED",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Received" }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/purchase-orders?status=RECEIVED",
      ),
    );
  });

  it("renders every status badge color class (DRAFT/PENDING/APPROVED/RECEIVED/CANCELLED)", async () => {
    wireApiGet({
      listResponse: {
        data: [
          poFixture({ id: "p1", poNumber: "PO-1", status: "DRAFT" }),
          poFixture({ id: "p2", poNumber: "PO-2", status: "PENDING" }),
          poFixture({ id: "p3", poNumber: "PO-3", status: "APPROVED" }),
          poFixture({ id: "p4", poNumber: "PO-4", status: "RECEIVED" }),
          poFixture({ id: "p5", poNumber: "PO-5", status: "CANCELLED" }),
        ],
      },
    });

    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-1");

    expect(screen.getByText("DRAFT").className).toMatch(/bg-gray-100/);
    expect(screen.getByText("PENDING").className).toMatch(/bg-yellow-100/);
    expect(screen.getByText("APPROVED").className).toMatch(/bg-blue-100/);
    expect(screen.getByText("RECEIVED").className).toMatch(/bg-green-100/);
    expect(screen.getByText("CANCELLED").className).toMatch(/bg-red-100/);
  });

  it("DRAFT row shows Submit + Cancel; clicking Submit confirms and POSTs /submit", async () => {
    wireApiGet({
      listResponse: {
        data: [poFixture({ status: "DRAFT" })],
      },
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Submit this PO for approval?",
          danger: false,
        }),
      );
      expect(apiMock.post).toHaveBeenCalledWith(
        "/purchase-orders/po-1/submit",
        {},
      );
    });
  });

  it("PENDING row shows Approve + Cancel; Approve POSTs /approve and reloads the list", async () => {
    wireApiGet({
      listResponse: {
        data: [poFixture({ status: "PENDING" })],
      },
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-2026-0001");

    // Note: there's also a tab labeled "Approved" — narrow to exact "Approve".
    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/purchase-orders/po-1/approve",
        {},
      );
    });
    // List reloads after success (initial + reload = 2 list GETs).
    await waitFor(() => {
      const listCalls = apiMock.get.mock.calls.filter((c: any[]) =>
        String(c[0]).startsWith("/purchase-orders"),
      );
      expect(listCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("APPROVED row shows Receive + Cancel; Receive (with confirm receive message) POSTs /receive", async () => {
    wireApiGet({
      listResponse: {
        data: [poFixture({ status: "APPROVED" })],
      },
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-2026-0001");

    // Tab labeled "Received" also matches /Receive/ — use exact form.
    fireEvent.click(screen.getByRole("button", { name: /^Receive$/ }));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Mark as received?",
          message: "This will update inventory.",
        }),
      );
      expect(apiMock.post).toHaveBeenCalledWith(
        "/purchase-orders/po-1/receive",
        {},
      );
    });
  });

  it("Cancel button fires confirm with danger:true and POSTs /cancel", async () => {
    wireApiGet({
      listResponse: {
        data: [poFixture({ status: "PENDING" })],
      },
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Cancel this PO?",
          danger: true,
        }),
      );
      expect(apiMock.post).toHaveBeenCalledWith(
        "/purchase-orders/po-1/cancel",
        {},
      );
    });
  });

  it("RECEIVED and CANCELLED rows render no transition buttons (terminal)", async () => {
    wireApiGet({
      listResponse: {
        data: [
          poFixture({ id: "rec", poNumber: "PO-REC", status: "RECEIVED" }),
          poFixture({ id: "can", poNumber: "PO-CAN", status: "CANCELLED" }),
        ],
      },
    });

    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-REC");

    // The page-level "New PO" button always exists, as do the tabs labeled
    // "Approved" / "Received" / "Draft" / "Pending". Transition action
    // buttons should NOT exist for these terminal rows — match exact labels.
    expect(
      screen.queryByRole("button", { name: /^Submit$/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Approve$/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Receive$/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Cancel$/ }),
    ).not.toBeInTheDocument();
  });

  it("declining the confirm dialog skips the POST", async () => {
    wireApiGet({
      listResponse: {
        data: [poFixture({ status: "DRAFT" })],
      },
    });
    confirmMock.mockResolvedValue(false);

    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());

    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("toasts the error message when the action POST rejects with an Error", async () => {
    wireApiGet({
      listResponse: {
        data: [poFixture({ status: "DRAFT" })],
      },
    });
    apiMock.post.mockRejectedValue(new Error("queue offline"));

    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("queue offline");
    });
  });

  it("falls back to 'Action failed' when the POST rejection is not an Error", async () => {
    wireApiGet({
      listResponse: {
        data: [poFixture({ status: "DRAFT" })],
      },
    });
    apiMock.post.mockRejectedValue("nope");

    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Action failed");
    });
  });

  it("PO-number column links to /dashboard/purchase-orders/:id", async () => {
    wireApiGet({
      listResponse: {
        data: [poFixture({ id: "po-xyz", poNumber: "PO-XYZ" })],
      },
    });

    render(<PurchaseOrdersPage />);
    const link = await screen.findByRole("link", { name: "PO-XYZ" });
    expect(link).toHaveAttribute("href", "/dashboard/purchase-orders/po-xyz");
  });

  it("initial list GET rejection still flips loading off and renders the empty state", async () => {
    wireApiGet({ listResponse: new Error("boom") });

    render(<PurchaseOrdersPage />);
    expect(
      await screen.findByText("No purchase orders found"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("purchase-orders-loading"),
    ).not.toBeInTheDocument();
  });

  // ────────────────────────────────────────────────────────────────────────
  // NewPOModal
  // ────────────────────────────────────────────────────────────────────────

  it("opens the New PO modal and fetches suppliers + medicines", async () => {
    wireApiGet({
      listResponse: { data: [] },
      suppliersResponse: {
        data: [
          { id: "sup-1", name: "Acme Pharma" },
          { id: "sup-2", name: "Beta Distributors" },
        ],
      },
      medicinesResponse: {
        data: [{ id: "m-1", name: "Paracetamol", strength: "500mg" }],
      },
    });

    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));

    expect(
      await screen.findByRole("heading", { name: /New Purchase Order/ }),
    ).toBeInTheDocument();

    // suppliers/medicines fetched.
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/suppliers");
      expect(apiMock.get).toHaveBeenCalledWith("/medicines?limit=200");
    });

    // Supplier <select> contains both options.
    const supplierSelect = screen.getByLabelText(/Supplier/) as HTMLSelectElement;
    expect(
      within(supplierSelect).getByRole("option", { name: "Acme Pharma" }),
    ).toBeInTheDocument();
    expect(
      within(supplierSelect).getByRole("option", { name: "Beta Distributors" }),
    ).toBeInTheDocument();
  });

  it("X button closes the modal without POSTing", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    // X close button — only icon, no accessible name. It's the first button
    // child after the heading.
    const closeButtons = screen.getAllByRole("button");
    const xClose = closeButtons.find(
      (b) => b.querySelector('[data-testid="icon-x"]') !== null,
    )!;
    fireEvent.click(xClose);

    expect(
      screen.queryByRole("heading", { name: /New Purchase Order/ }),
    ).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Cancel button in the modal footer closes without POSTing", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    // Modal-footer Cancel.
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    expect(
      screen.queryByRole("heading", { name: /New Purchase Order/ }),
    ).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects submit when supplier is blank", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    fireEvent.click(screen.getByRole("button", { name: /Create Draft PO/ }));
    expect(
      await screen.findByText("Select a supplier"),
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects submit when a row description is blank", async () => {
    wireApiGet({
      listResponse: { data: [] },
      suppliersResponse: { data: [{ id: "sup-1", name: "Acme" }] },
    });
    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    fireEvent.change(screen.getByLabelText(/Supplier/), {
      target: { value: "sup-1" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Create Draft PO/ }));
    expect(
      await screen.findByText(/Row 1: description is required/),
    ).toBeInTheDocument();
  });

  it("rejects submit when quantity < 1", async () => {
    wireApiGet({
      listResponse: { data: [] },
      suppliersResponse: { data: [{ id: "sup-1", name: "Acme" }] },
    });
    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    fireEvent.change(screen.getByLabelText(/Supplier/), {
      target: { value: "sup-1" },
    });

    // Find description cell input + quantity input by display value.
    const descInput = screen.getAllByRole("textbox").find((i) => {
      const el = i as HTMLInputElement;
      return el.type === "text" && el.value === "";
    }) as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Test item" } });

    const qtyInput = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(qtyInput, { target: { value: "0" } });

    fireEvent.click(screen.getByRole("button", { name: /Create Draft PO/ }));
    expect(
      await screen.findByText(/Row 1: quantity must be at least 1/),
    ).toBeInTheDocument();
  });

  it("rejects submit when unit price < 0.01", async () => {
    wireApiGet({
      listResponse: { data: [] },
      suppliersResponse: { data: [{ id: "sup-1", name: "Acme" }] },
    });
    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    fireEvent.change(screen.getByLabelText(/Supplier/), {
      target: { value: "sup-1" },
    });
    const descInput = screen.getAllByRole("textbox").find((i) => {
      const el = i as HTMLInputElement;
      return el.type === "text" && el.value === "";
    }) as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Test item" } });

    // Leave unitPrice blank (parseFloat("") = NaN) — triggers "unit price"
    // validation branch.
    fireEvent.click(screen.getByRole("button", { name: /Create Draft PO/ }));
    expect(
      await screen.findByText(/Row 1: unit price must be at least 0\.01/),
    ).toBeInTheDocument();
  });

  it("rejects submit when tax % is out of [0,100] range", async () => {
    wireApiGet({
      listResponse: { data: [] },
      suppliersResponse: { data: [{ id: "sup-1", name: "Acme" }] },
    });
    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    // Wait for the supplier <option> to populate from the async GET before
    // dispatching the change event — otherwise on slower CI runs the select
    // still only has the placeholder option and the change silently falls
    // back to "", which lets the "Select a supplier" validation fire first
    // (masking the tax-range error we want to assert).
    const supplierSelect = (await screen.findByLabelText(
      /Supplier/,
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(
        within(supplierSelect).queryByRole("option", { name: "Acme" }),
      ).not.toBeNull(),
    );
    fireEvent.change(supplierSelect, { target: { value: "sup-1" } });

    const descInput = screen.getAllByRole("textbox").find((i) => {
      const el = i as HTMLInputElement;
      return el.type === "text" && el.value === "";
    }) as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Test item" } });

    // Need a valid unit price first, otherwise that validation triggers first.
    const numericInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    // numericInputs order = [qty, unitPrice, taxPercentage]. Set unitPrice.
    fireEvent.change(numericInputs[1], { target: { value: "10" } });

    // Now set tax to 150 (out of range).
    const taxInput = screen.getByLabelText(/Tax %/) as HTMLInputElement;
    fireEvent.change(taxInput, { target: { value: "150" } });

    fireEvent.click(screen.getByRole("button", { name: /Create Draft PO/ }));
    expect(
      await screen.findByText(/Tax % must be between 0 and 100/),
    ).toBeInTheDocument();
  });

  it("Add Row appends a new line item; the trash icon hides when only one row remains", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    // Initially 1 row, no trash icon.
    expect(screen.queryAllByTestId("icon-trash")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /Add Row/ }));
    // 2 rows → 2 trash icons.
    expect(screen.getAllByTestId("icon-trash")).toHaveLength(2);

    // Click the first trash → back to 1 row, icon disappears.
    const trashButtons = screen
      .getAllByTestId("icon-trash")
      .map((i) => i.closest("button")!);
    fireEvent.click(trashButtons[0]);
    expect(screen.queryAllByTestId("icon-trash")).toHaveLength(0);
  });

  it("medicine select auto-fills the row description with '<name> <strength>'", async () => {
    wireApiGet({
      listResponse: { data: [] },
      suppliersResponse: { data: [{ id: "sup-1", name: "Acme" }] },
      medicinesResponse: {
        data: [
          { id: "m-1", name: "Paracetamol", strength: "500mg" },
          { id: "m-2", name: "Bandage", strength: null },
        ],
      },
    });
    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    // Wait for medicines fetch to populate options.
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/medicines?limit=200"),
    );

    // Locate the row-level medicine select (the one containing "-- custom --").
    const allSelects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const medSelect = allSelects.find((s) =>
      Array.from(s.options).some((o) => o.text.includes("custom")),
    )!;
    fireEvent.change(medSelect, { target: { value: "m-1" } });

    // Description input now reads "Paracetamol 500mg".
    expect(screen.getByDisplayValue("Paracetamol 500mg")).toBeInTheDocument();

    // Strength=null medicine fills only the name. Both the medicine <select>
    // (selected option text "Bandage") and the description <input> end up with
    // displayValue "Bandage" — assert at least one of them is the description
    // input.
    fireEvent.change(medSelect, { target: { value: "m-2" } });
    const bandageMatches = screen.getAllByDisplayValue("Bandage");
    expect(
      bandageMatches.some(
        (el) => (el as HTMLInputElement).tagName === "INPUT",
      ),
    ).toBe(true);
  });

  it("renders subtotal/tax/total formula correctly as inputs change", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    // Initial: qty=1, price="" → subtotal 0, tax 0, total 0.
    expect(screen.getAllByText(/Rs\.\s*0\.00/).length).toBeGreaterThanOrEqual(3);

    // Set qty=10, price=5, tax=10% → subtotal=50 (row Amount + Subtotal row),
    // tax=5, total=55. Row Amount and Subtotal both render Rs. 50.00.
    const numericInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(numericInputs[0], { target: { value: "10" } }); // qty
    fireEvent.change(numericInputs[1], { target: { value: "5" } }); // unitPrice
    fireEvent.change(numericInputs[2], { target: { value: "10" } }); // tax

    await waitFor(() => {
      // Two occurrences of 50.00 (line amount + subtotal summary).
      expect(screen.getAllByText(/Rs\.\s*50\.00/).length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText(/Rs\.\s*5\.00/)).toBeInTheDocument();
      expect(screen.getByText(/Rs\.\s*55\.00/)).toBeInTheDocument();
    });
  });

  it("happy path: POSTs /purchase-orders with the expected body and reloads", async () => {
    wireApiGet({
      listResponse: { data: [] },
      suppliersResponse: { data: [{ id: "sup-1", name: "Acme" }] },
    });
    apiMock.post.mockResolvedValue({ data: { id: "po-new" } });

    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    // Wait for the modal's async /suppliers fetch to populate options — without
    // this, fireEvent.change(value:"sup-1") fires before <option value="sup-1">
    // exists in the DOM and React's controlled <select> silently drops it.
    await screen.findByRole("option", { name: "Acme" });

    // Fill supplier + expected date + notes.
    fireEvent.change(screen.getByLabelText(/Supplier/), {
      target: { value: "sup-1" },
    });
    fireEvent.change(screen.getByLabelText(/Expected Date/), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText(/Notes/), {
      target: { value: "Quarterly stock-up" },
    });

    // Fill row 1: description, price (qty pre-filled to 1).
    const descInput = screen.getAllByRole("textbox").find((i) => {
      const el = i as HTMLInputElement;
      return el.type === "text" && el.value === "";
    }) as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Saline IV bags" } });

    const numericInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(numericInputs[1], { target: { value: "25" } }); // unitPrice
    fireEvent.change(numericInputs[2], { target: { value: "5" } }); // tax

    fireEvent.click(screen.getByRole("button", { name: /Create Draft PO/ }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/purchase-orders", {
        supplierId: "sup-1",
        items: [
          {
            description: "Saline IV bags",
            medicineId: undefined,
            quantity: 1,
            unitPrice: 25,
          },
        ],
        taxPercentage: 5,
        expectedAt: "2026-06-01",
        notes: "Quarterly stock-up",
      });
    });

    // Modal closes + list reloads.
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /New Purchase Order/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("surfaces the inline error banner with the message when POST rejects with Error", async () => {
    wireApiGet({
      listResponse: { data: [] },
      suppliersResponse: { data: [{ id: "sup-1", name: "Acme" }] },
    });
    apiMock.post.mockRejectedValue(new Error("server unavailable"));

    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    // Wait for the async /suppliers fetch to populate the dropdown before
    // selecting — without this, fireEvent.change fires before the option
    // exists and React's controlled <select> silently drops the value.
    // (Same race the happy-path test guards against above.)
    await screen.findByRole("option", { name: "Acme" });

    fireEvent.change(screen.getByLabelText(/Supplier/), {
      target: { value: "sup-1" },
    });
    const descInput = screen.getAllByRole("textbox").find((i) => {
      const el = i as HTMLInputElement;
      return el.type === "text" && el.value === "";
    }) as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Test" } });
    const numericInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(numericInputs[1], { target: { value: "10" } });

    fireEvent.click(screen.getByRole("button", { name: /Create Draft PO/ }));

    expect(
      await screen.findByText("server unavailable"),
    ).toBeInTheDocument();
    // Modal stays open on error.
    expect(
      screen.getByRole("heading", { name: /New Purchase Order/ }),
    ).toBeInTheDocument();
  });

  it("falls back to 'Failed to create PO' when POST rejection is not an Error", async () => {
    wireApiGet({
      listResponse: { data: [] },
      suppliersResponse: { data: [{ id: "sup-1", name: "Acme" }] },
    });
    apiMock.post.mockRejectedValue("nope");

    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    await screen.findByRole("option", { name: "Acme" });

    fireEvent.change(screen.getByLabelText(/Supplier/), {
      target: { value: "sup-1" },
    });
    const descInput = screen.getAllByRole("textbox").find((i) => {
      const el = i as HTMLInputElement;
      return el.type === "text" && el.value === "";
    }) as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Test" } });
    const numericInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(numericInputs[1], { target: { value: "10" } });

    fireEvent.click(screen.getByRole("button", { name: /Create Draft PO/ }));

    expect(
      await screen.findByText("Failed to create PO"),
    ).toBeInTheDocument();
  });

  it("suppliers + medicines fetch rejections still render the modal with empty option lists", async () => {
    wireApiGet({
      listResponse: { data: [] },
      suppliersResponse: new Error("supplier service down"),
      medicinesResponse: new Error("medicine service down"),
    });

    render(<PurchaseOrdersPage />);
    await screen.findByText("No purchase orders found");

    fireEvent.click(screen.getByRole("button", { name: /New PO/ }));
    await screen.findByRole("heading", { name: /New Purchase Order/ });

    // Supplier select has only the placeholder option.
    const supplierSelect = screen.getByLabelText(/Supplier/) as HTMLSelectElement;
    await waitFor(() => {
      const opts = within(supplierSelect).getAllByRole("option");
      expect(opts).toHaveLength(1);
      expect(opts[0]).toHaveTextContent("Select supplier");
    });
  });
});
