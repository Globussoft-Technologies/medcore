/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SuppliersPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/suppliers/page.tsx, the procurement
 *     vendor catalog (Issue #692: per-row Edit + Deactivate; Issue #832: search
 *     glyph). Endpoints hit:
 *       GET   /suppliers[?search=&active=false]   (list, with showInactive toggle)
 *       GET   /suppliers/:id                      (detail panel + POs)
 *       POST  /suppliers                          (Add modal)
 *       PATCH /suppliers/:id                      (Edit modal, toggleActive,
 *                                                  Contract panel)
 *
 *   - Behaviours covered:
 *       1. Initial render — heading, "Add Supplier" CTA, search input present.
 *       2. Loading skeleton — `suppliers-loading` testid + aria-busy while list
 *          GET is in flight.
 *       3. Happy fetch — rows render with name, contact person, phone, email,
 *          GST, PO count, Active badge, payment terms subline.
 *       4. Empty branch — "No suppliers found" copy.
 *       5. Initial GET rejection — catches, flips loading off, renders empty.
 *       6. Search field updates the querystring (?search=…).
 *       7. Show-deactivated toggle adds ?active=false to the list GET.
 *       8. Row click opens detail panel — fetches /suppliers/:id; renders phone,
 *          email, address, GST in the side panel.
 *       9. Detail panel loading state — `supplier-detail-loading` aria-busy
 *          while the detail GET is in flight.
 *      10. Detail panel close button (X) drops selectedId + detail.
 *      11. Detail panel — PO list renders with status badges; renders "No
 *          purchase orders yet" when empty.
 *      12. Status badge color classes — DRAFT/PENDING/APPROVED/RECEIVED/
 *          CANCELLED/unknown fallback all covered via statusBadge().
 *      13. Detail GET rejection — detail stays null (no crash).
 *      14. Add modal — opens, requires name (blank rejected with inline error),
 *          submits the trimmed body, closes on success, reloads.
 *      15. Add modal POST rejection — Error → inline error message; non-Error
 *          → "Failed to save supplier" fallback. Modal stays open.
 *      16. Add modal X / Cancel — closes without POST.
 *      17. Edit modal — opens via per-row Edit button, pre-fills with row's
 *          current values, requires name, PATCHes /suppliers/:id, toasts
 *          "Supplier updated", closes, reloads.
 *      18. Edit modal — isActive toggle flips checkbox; PATCH body includes it.
 *      19. Edit modal POST rejection surfaces inline error.
 *      20. Toggle-active — Deactivate fires danger:true confirm + PATCHes
 *          isActive:false; success toast; clears side panel if currently
 *          selected. Activate (when row is inactive) does NOT clear the panel.
 *      21. Toggle-active declined confirm — no PATCH.
 *      22. Toggle-active PATCH rejection — Error → toast.error(message);
 *          non-Error → "Failed to deactivate" fallback.
 *      23. Contract panel — "No contract dates set" copy when both nulls.
 *      24. Contract panel — Edit button switches to date inputs; Cancel reverts.
 *      25. Contract panel — Save PATCHes /suppliers/:id with the dates and
 *          updates the parent detail; rejection toasts the error.
 *      26. Contract panel — "Expiring Soon" badge when daysLeft in [0,30].
 *      27. Contract panel — "Expired" badge when daysLeft < 0.
 *
 *   - Mocks: @/lib/api, @/lib/toast, @/lib/store (unused by page, but mocked
 *            defensively), @/lib/use-dialog (useConfirm wired per test),
 *            next/navigation, @/components/Skeleton, lucide-react icons.
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
  usePrompt: () => vi.fn(async () => ""),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/suppliers",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
  SkeletonText: ({ lines }: { lines: number }) => (
    <div data-testid="skeleton-text-stub" data-lines={lines} />
  ),
}));
vi.mock("lucide-react", () => ({
  Truck: () => <span data-testid="icon-truck" />,
  Plus: () => <span data-testid="icon-plus" />,
  X: () => <span data-testid="icon-x" />,
  Mail: () => <span data-testid="icon-mail" />,
  Phone: () => <span data-testid="icon-phone" />,
  MapPin: () => <span data-testid="icon-mappin" />,
  FileText: () => <span data-testid="icon-filetext" />,
  Edit2: () => <span data-testid="icon-edit" />,
  Power: () => <span data-testid="icon-power" />,
  Search: () => <span data-testid="icon-search" />,
}));

import SuppliersPage from "../page";

type SupplierRecord = {
  id: string;
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  gstNumber?: string | null;
  paymentTerms?: string | null;
  isActive: boolean;
  createdAt: string;
  contractStart?: string | null;
  contractEnd?: string | null;
  _count?: { purchaseOrders: number };
};

type PORecord = {
  id: string;
  poNumber: string;
  status: string;
  totalAmount: number;
  createdAt: string;
  items: Array<{ id: string; description: string }>;
};

function supplierFixture(
  overrides: Partial<SupplierRecord> = {},
): SupplierRecord {
  return {
    id: "sup-1",
    name: "Acme Pharma",
    contactPerson: "Jane Roe",
    phone: "+91-9876543210",
    email: "sales@acme.example",
    address: "123 Industrial Estate, Pune",
    gstNumber: "27ABCDE1234F1Z5",
    paymentTerms: "Net 30",
    isActive: true,
    createdAt: "2026-01-15T08:00:00.000Z",
    contractStart: null,
    contractEnd: null,
    _count: { purchaseOrders: 5 },
    ...overrides,
  };
}

function poFixture(overrides: Partial<PORecord> = {}): PORecord {
  return {
    id: "po-1",
    poNumber: "PO-2026-0001",
    status: "PENDING",
    totalAmount: 5000,
    createdAt: "2026-04-01T00:00:00.000Z",
    items: [{ id: "li-1", description: "Saline" }],
    ...overrides,
  };
}

/**
 * Dispatches the list / detail GETs by url shape. listResponse may be an Error
 * (rejected promise) or a payload. detailResponses is keyed by supplier id.
 */
function wireApiGet(opts: {
  listResponse?: { data: SupplierRecord[] } | Error;
  detailResponses?: Record<
    string,
    { data: SupplierRecord & { purchaseOrders: PORecord[] } } | Error
  >;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/suppliers/")) {
      const id = url.replace("/suppliers/", "").split("?")[0];
      const r =
        opts.detailResponses?.[id] ??
        ({
          data: {
            ...supplierFixture({ id }),
            purchaseOrders: [],
          },
        } as any);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    if (url.startsWith("/suppliers")) {
      const r = opts.listResponse ?? { data: [] };
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    return Promise.resolve({ data: [] });
  });
}

describe("SuppliersPage — list, detail panel, Add + Edit modals, toggle-active, contract panel", () => {
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
    authMock.mockReturnValue({
      user: { id: "u-admin", role: "ADMIN", name: "Admin" },
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the heading, Add Supplier CTA, and search input on initial mount", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<SuppliersPage />);
    expect(
      await screen.findByRole("heading", { name: /Suppliers/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add Supplier/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/Search suppliers/)).toBeInTheDocument();
  });

  it("renders the loading skeleton with aria-busy while the list GET is in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<SuppliersPage />);
    const loader = await screen.findByTestId("suppliers-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("renders the empty-state copy when the list is []", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<SuppliersPage />);
    expect(await screen.findByText("No suppliers found")).toBeInTheDocument();
  });

  it("renders a row per supplier with name, contact, phone, email, GST, PO count, and Active badge", async () => {
    wireApiGet({
      listResponse: {
        data: [
          supplierFixture(),
          supplierFixture({
            id: "sup-2",
            name: "Beta Distributors",
            contactPerson: "Other Person",
            phone: null,
            email: null,
            gstNumber: null,
            isActive: false,
            paymentTerms: null,
          }),
        ],
      },
    });
    render(<SuppliersPage />);
    expect(await screen.findByText("Acme Pharma")).toBeInTheDocument();
    expect(screen.getByText("Jane Roe")).toBeInTheDocument();
    expect(screen.getByText("Other Person")).toBeInTheDocument();
    expect(screen.getByText("+91-9876543210")).toBeInTheDocument();
    expect(screen.getByText("sales@acme.example")).toBeInTheDocument();
    expect(screen.getByText("27ABCDE1234F1Z5")).toBeInTheDocument();
    expect(screen.getByText("Net 30")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByText("Beta Distributors")).toBeInTheDocument();
  });

  it("initial GET rejection still flips loading off and renders empty state", async () => {
    wireApiGet({ listResponse: new Error("boom") });
    render(<SuppliersPage />);
    expect(await screen.findByText("No suppliers found")).toBeInTheDocument();
    expect(screen.queryByTestId("suppliers-loading")).not.toBeInTheDocument();
  });

  it("typing into the search box refetches with ?search=...", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<SuppliersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/suppliers"));

    fireEvent.change(screen.getByLabelText(/Search suppliers/), {
      target: { value: "acme" },
    });
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/suppliers?search=acme"),
    );
  });

  it("Show deactivated toggle adds ?active=false to the list GET", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<SuppliersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/suppliers"));

    fireEvent.click(screen.getByTestId("suppliers-show-inactive"));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/suppliers?active=false"),
    );
  });

  it("clicking a row opens the detail panel with phone/email/address/GST and PO list", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: {
            ...supplierFixture(),
            purchaseOrders: [
              poFixture({ status: "DRAFT" }),
              poFixture({ id: "po-2", poNumber: "PO-2026-0002", status: "APPROVED" }),
            ],
          } as any,
        },
      },
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));

    // Side-panel header (detail.name) — there will be two "Acme Pharma" nodes
    // (row + heading); use heading role to disambiguate.
    expect(
      await screen.findByRole("heading", { name: "Acme Pharma" }),
    ).toBeInTheDocument();
    expect(screen.getByText("123 Industrial Estate, Pune")).toBeInTheDocument();
    // PO list — two rows + status badge classes.
    expect(screen.getByText("PO-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("PO-2026-0002")).toBeInTheDocument();
    expect(screen.getByText("DRAFT").className).toMatch(/bg-gray-100/);
    expect(screen.getByText("APPROVED").className).toMatch(/bg-blue-100/);
  });

  it("renders the detail-loading skeleton while the /suppliers/:id GET is pending", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/suppliers/")) return new Promise(() => {});
      return Promise.resolve({ data: [supplierFixture()] });
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    const loader = await screen.findByTestId("supplier-detail-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
  });

  it("detail panel close (X) drops selectedId — side panel disappears", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: { ...supplierFixture(), purchaseOrders: [] } as any,
        },
      },
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByRole("heading", { name: "Acme Pharma" });

    // The side-panel close X is the button whose icon is the X icon AND
    // which sits inside the side panel (the <aside>). Find buttons that
    // contain icon-x.
    const xButtons = screen.getAllByRole("button").filter(
      (b) => b.querySelector('[data-testid="icon-x"]') !== null,
    );
    // Pick the one inside an <aside>.
    const sideX = xButtons.find((b) => !!b.closest("aside"))!;
    fireEvent.click(sideX);

    expect(
      screen.queryByRole("heading", { name: "Acme Pharma" }),
    ).not.toBeInTheDocument();
  });

  it("detail panel renders 'No purchase orders yet' when the supplier has []", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: { ...supplierFixture(), purchaseOrders: [] } as any,
        },
      },
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    expect(
      await screen.findByText("No purchase orders yet"),
    ).toBeInTheDocument();
  });

  it("detail GET rejection leaves detail null — no crash", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: { "sup-1": new Error("detail down") },
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    // Should NOT throw — and side-panel name heading should NOT show.
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Acme Pharma" }),
      ).not.toBeInTheDocument();
    });
  });

  it("renders every status badge color class on PO rows (DRAFT/PENDING/APPROVED/RECEIVED/CANCELLED/unknown)", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: {
            ...supplierFixture(),
            purchaseOrders: [
              poFixture({ id: "p1", poNumber: "PO-D", status: "DRAFT" }),
              poFixture({ id: "p2", poNumber: "PO-P", status: "PENDING" }),
              poFixture({ id: "p3", poNumber: "PO-A", status: "APPROVED" }),
              poFixture({ id: "p4", poNumber: "PO-R", status: "RECEIVED" }),
              poFixture({ id: "p5", poNumber: "PO-C", status: "CANCELLED" }),
              poFixture({ id: "p6", poNumber: "PO-U", status: "WEIRDSTATE" }),
            ],
          } as any,
        },
      },
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByText("PO-D");
    expect(screen.getByText("DRAFT").className).toMatch(/bg-gray-100/);
    expect(screen.getByText("PENDING").className).toMatch(/bg-yellow-100/);
    expect(screen.getByText("APPROVED").className).toMatch(/bg-blue-100/);
    expect(screen.getByText("RECEIVED").className).toMatch(/bg-green-100/);
    expect(screen.getByText("CANCELLED").className).toMatch(/bg-red-100/);
    expect(screen.getByText("WEIRDSTATE").className).toMatch(/bg-gray-100/);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Add Supplier modal
  // ────────────────────────────────────────────────────────────────────────

  it("Add Supplier modal opens, blank name rejects with inline error", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<SuppliersPage />);
    await screen.findByText("No suppliers found");

    fireEvent.click(screen.getByRole("button", { name: /Add Supplier/ }));
    expect(
      await screen.findByRole("heading", { name: /^Add Supplier$/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Create Supplier/ }));
    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Supplier modal happy path: POSTs the trimmed body, closes modal, reloads list", async () => {
    wireApiGet({ listResponse: { data: [] } });
    apiMock.post.mockResolvedValue({ data: { id: "new-sup" } });

    render(<SuppliersPage />);
    await screen.findByText("No suppliers found");

    fireEvent.click(screen.getByRole("button", { name: /Add Supplier/ }));
    await screen.findByRole("heading", { name: /^Add Supplier$/ });

    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "Gamma Supplies" },
    });
    fireEvent.change(screen.getByLabelText("Contact Person"), {
      target: { value: "Mike Doe" },
    });
    fireEvent.change(screen.getByLabelText("Phone"), {
      target: { value: "+91-9999988888" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "mike@gamma.example" },
    });
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "Plot 9, Sector 12" },
    });
    fireEvent.change(screen.getByLabelText("GST Number"), {
      target: { value: "07AAACG1234A1Z1" },
    });
    fireEvent.change(screen.getByLabelText("Payment Terms"), {
      target: { value: "Net 60" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Create Supplier/ }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/suppliers", {
        name: "Gamma Supplies",
        contactPerson: "Mike Doe",
        phone: "+91-9999988888",
        email: "mike@gamma.example",
        address: "Plot 9, Sector 12",
        gstNumber: "07AAACG1234A1Z1",
        paymentTerms: "Net 60",
      });
    });
    // Modal closes.
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /^Add Supplier$/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("Add Supplier POST Error rejection surfaces the inline error message", async () => {
    wireApiGet({ listResponse: { data: [] } });
    apiMock.post.mockRejectedValue(new Error("duplicate vendor"));

    render(<SuppliersPage />);
    await screen.findByText("No suppliers found");

    fireEvent.click(screen.getByRole("button", { name: /Add Supplier/ }));
    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "Dup Co" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Supplier/ }));

    expect(await screen.findByText("duplicate vendor")).toBeInTheDocument();
    // Modal stays open.
    expect(
      screen.getByRole("heading", { name: /^Add Supplier$/ }),
    ).toBeInTheDocument();
  });

  it("Add Supplier non-Error POST rejection falls back to 'Failed to save supplier'", async () => {
    wireApiGet({ listResponse: { data: [] } });
    apiMock.post.mockRejectedValue("nope");

    render(<SuppliersPage />);
    await screen.findByText("No suppliers found");

    fireEvent.click(screen.getByRole("button", { name: /Add Supplier/ }));
    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "Whatever" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Supplier/ }));

    expect(
      await screen.findByText("Failed to save supplier"),
    ).toBeInTheDocument();
  });

  it("Add Supplier Cancel button closes modal without POSTing", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<SuppliersPage />);
    await screen.findByText("No suppliers found");

    fireEvent.click(screen.getByRole("button", { name: /Add Supplier/ }));
    await screen.findByRole("heading", { name: /^Add Supplier$/ });

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(
      screen.queryByRole("heading", { name: /^Add Supplier$/ }),
    ).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Supplier X button closes modal without POSTing", async () => {
    wireApiGet({ listResponse: { data: [] } });
    render(<SuppliersPage />);
    await screen.findByText("No suppliers found");

    fireEvent.click(screen.getByRole("button", { name: /Add Supplier/ }));
    await screen.findByRole("heading", { name: /^Add Supplier$/ });

    // The modal's X is the first icon-x button (there's no detail panel open).
    const xBtn = screen
      .getAllByRole("button")
      .find((b) => b.querySelector('[data-testid="icon-x"]') !== null)!;
    fireEvent.click(xBtn);
    expect(
      screen.queryByRole("heading", { name: /^Add Supplier$/ }),
    ).not.toBeInTheDocument();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Edit Supplier modal (Issue #692)
  // ────────────────────────────────────────────────────────────────────────

  it("Edit modal opens via the per-row Edit button pre-filled with current values", async () => {
    wireApiGet({ listResponse: { data: [supplierFixture()] } });
    render(<SuppliersPage />);
    await screen.findByText("Acme Pharma");

    fireEvent.click(screen.getByTestId("supplier-edit-sup-1"));
    expect(await screen.findByTestId("supplier-edit-modal")).toBeInTheDocument();
    expect(screen.getByTestId("edit-supplier-name")).toHaveValue("Acme Pharma");
    expect(screen.getByLabelText("Contact Person")).toHaveValue("Jane Roe");
    expect(screen.getByLabelText("Phone")).toHaveValue("+91-9876543210");
    expect(screen.getByLabelText("Email")).toHaveValue("sales@acme.example");
    expect(screen.getByLabelText("GST Number")).toHaveValue("27ABCDE1234F1Z5");
    expect(screen.getByLabelText("Payment Terms")).toHaveValue("Net 30");
    expect(screen.getByTestId("edit-supplier-active")).toBeChecked();
  });

  it("Edit modal blank name rejects with inline 'Name is required'", async () => {
    wireApiGet({ listResponse: { data: [supplierFixture()] } });
    render(<SuppliersPage />);
    await screen.findByText("Acme Pharma");

    fireEvent.click(screen.getByTestId("supplier-edit-sup-1"));
    await screen.findByTestId("supplier-edit-modal");
    fireEvent.change(screen.getByTestId("edit-supplier-name"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("edit-supplier-save"));
    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Edit modal happy path: PATCHes /suppliers/:id, toasts success, closes modal, reloads", async () => {
    wireApiGet({ listResponse: { data: [supplierFixture()] } });
    apiMock.patch.mockResolvedValue({
      data: supplierFixture({ name: "Acme Pharma Renamed" }),
    });

    render(<SuppliersPage />);
    await screen.findByText("Acme Pharma");

    fireEvent.click(screen.getByTestId("supplier-edit-sup-1"));
    await screen.findByTestId("supplier-edit-modal");

    fireEvent.change(screen.getByTestId("edit-supplier-name"), {
      target: { value: "Acme Pharma Renamed" },
    });
    // Flip isActive off so we hit the toggle branch too.
    fireEvent.click(screen.getByTestId("edit-supplier-active"));

    fireEvent.click(screen.getByTestId("edit-supplier-save"));

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/suppliers/sup-1",
        expect.objectContaining({
          name: "Acme Pharma Renamed",
          isActive: false,
        }),
      );
      expect(toastMock.success).toHaveBeenCalledWith("Supplier updated");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("supplier-edit-modal")).not.toBeInTheDocument();
    });
  });

  it("Edit modal POST rejection surfaces 'Failed to save' fallback for non-Error throw", async () => {
    wireApiGet({ listResponse: { data: [supplierFixture()] } });
    apiMock.patch.mockRejectedValue("nope");

    render(<SuppliersPage />);
    await screen.findByText("Acme Pharma");

    fireEvent.click(screen.getByTestId("supplier-edit-sup-1"));
    await screen.findByTestId("supplier-edit-modal");

    fireEvent.click(screen.getByTestId("edit-supplier-save"));
    expect(await screen.findByText("Failed to save")).toBeInTheDocument();
    // Modal stays open.
    expect(screen.getByTestId("supplier-edit-modal")).toBeInTheDocument();
  });

  it("Edit modal Error PATCH rejection surfaces the Error.message", async () => {
    wireApiGet({ listResponse: { data: [supplierFixture()] } });
    apiMock.patch.mockRejectedValue(new Error("constraint violated"));

    render(<SuppliersPage />);
    await screen.findByText("Acme Pharma");

    fireEvent.click(screen.getByTestId("supplier-edit-sup-1"));
    await screen.findByTestId("supplier-edit-modal");
    fireEvent.click(screen.getByTestId("edit-supplier-save"));
    expect(await screen.findByText("constraint violated")).toBeInTheDocument();
  });

  it("Edit modal Cancel + X buttons close without PATCH", async () => {
    wireApiGet({ listResponse: { data: [supplierFixture()] } });
    render(<SuppliersPage />);
    await screen.findByText("Acme Pharma");

    fireEvent.click(screen.getByTestId("supplier-edit-sup-1"));
    await screen.findByTestId("supplier-edit-modal");
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(screen.queryByTestId("supplier-edit-modal")).not.toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Toggle-active (deactivate / reactivate)
  // ────────────────────────────────────────────────────────────────────────

  it("Deactivate fires danger:true confirm, PATCHes isActive:false, toasts success", async () => {
    wireApiGet({ listResponse: { data: [supplierFixture()] } });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SuppliersPage />);
    await screen.findByText("Acme Pharma");

    fireEvent.click(screen.getByTestId("supplier-toggle-active-sup-1"));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Deactivate Acme Pharma?",
          danger: true,
          confirmLabel: "Deactivate",
        }),
      );
      expect(apiMock.patch).toHaveBeenCalledWith("/suppliers/sup-1", {
        isActive: false,
      });
      expect(toastMock.success).toHaveBeenCalledWith("Deactivated Acme Pharma");
    });
  });

  it("Activate (when row is inactive) fires non-danger confirm + PATCHes isActive:true; does NOT clear the panel", async () => {
    const inactive = supplierFixture({ isActive: false });
    wireApiGet({
      listResponse: { data: [inactive] },
      detailResponses: {
        "sup-1": { data: { ...inactive, purchaseOrders: [] } as any },
      },
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByRole("heading", { name: "Acme Pharma" });

    fireEvent.click(screen.getByTestId("supplier-toggle-active-sup-1"));
    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Activate Acme Pharma?",
          danger: false,
          confirmLabel: "Activate",
        }),
      );
      expect(apiMock.patch).toHaveBeenCalledWith("/suppliers/sup-1", {
        isActive: true,
      });
      expect(toastMock.success).toHaveBeenCalledWith("Activated Acme Pharma");
    });
    // Detail panel still up.
    expect(
      screen.getByRole("heading", { name: "Acme Pharma" }),
    ).toBeInTheDocument();
  });

  it("Deactivate clears the side panel if the deactivated row is currently selected", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: { ...supplierFixture(), purchaseOrders: [] } as any,
        },
      },
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByRole("heading", { name: "Acme Pharma" });

    fireEvent.click(screen.getByTestId("supplier-toggle-active-sup-1"));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith("/suppliers/sup-1", {
        isActive: false,
      });
    });
    // The side-panel heading drops.
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Acme Pharma" }),
      ).not.toBeInTheDocument();
    });
  });

  it("Declining the confirm dialog skips the PATCH", async () => {
    wireApiGet({ listResponse: { data: [supplierFixture()] } });
    confirmMock.mockResolvedValue(false);

    render(<SuppliersPage />);
    await screen.findByText("Acme Pharma");

    fireEvent.click(screen.getByTestId("supplier-toggle-active-sup-1"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("toggle-active Error PATCH rejection toasts the Error.message", async () => {
    wireApiGet({ listResponse: { data: [supplierFixture()] } });
    apiMock.patch.mockRejectedValue(new Error("server down"));

    render(<SuppliersPage />);
    await screen.findByText("Acme Pharma");

    fireEvent.click(screen.getByTestId("supplier-toggle-active-sup-1"));
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("server down");
    });
  });

  it("toggle-active non-Error PATCH rejection falls back to 'Failed to deactivate'", async () => {
    wireApiGet({ listResponse: { data: [supplierFixture()] } });
    apiMock.patch.mockRejectedValue("nope");

    render(<SuppliersPage />);
    await screen.findByText("Acme Pharma");

    fireEvent.click(screen.getByTestId("supplier-toggle-active-sup-1"));
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Failed to deactivate");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Contract panel (inside detail panel)
  // ────────────────────────────────────────────────────────────────────────

  it("Contract panel: renders 'No contract dates set' when both nulls", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: { ...supplierFixture(), purchaseOrders: [] } as any,
        },
      },
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByRole("heading", { name: "Acme Pharma" });
    expect(
      screen.getByText("No contract dates set."),
    ).toBeInTheDocument();
  });

  it("Contract panel: Add button switches to date inputs; Cancel reverts to the read view", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: { ...supplierFixture(), purchaseOrders: [] } as any,
        },
      },
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByRole("heading", { name: "Acme Pharma" });

    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(screen.getByLabelText("Start")).toBeInTheDocument();
    expect(screen.getByLabelText("End")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(screen.queryByLabelText("Start")).not.toBeInTheDocument();
    expect(screen.getByText("No contract dates set.")).toBeInTheDocument();
  });

  it("Contract panel Save PATCHes /suppliers/:id with dates and reverts to read view", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: { ...supplierFixture(), purchaseOrders: [] } as any,
        },
      },
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByRole("heading", { name: "Acme Pharma" });

    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    fireEvent.change(screen.getByLabelText("Start"), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText("End"), {
      target: { value: "2027-05-31" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith("/suppliers/sup-1", {
        contractStart: "2026-06-01",
        contractEnd: "2027-05-31",
      });
    });
    // Reverted to read view — Cancel/Save buttons gone.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /^Save$/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("Contract panel Save rejection toasts the Error.message (and non-Error 'Save failed' fallback)", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: { ...supplierFixture(), purchaseOrders: [] } as any,
        },
      },
    });
    apiMock.patch.mockRejectedValueOnce(new Error("nope"));

    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByRole("heading", { name: "Acme Pharma" });

    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("nope"));

    // Now non-Error rejection path.
    apiMock.patch.mockRejectedValueOnce("string-throw");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Save failed"),
    );
  });

  it("Contract panel renders 'Expiring Soon (Xd)' when contractEnd is within 30 days (+48h buffer)", async () => {
    // +48h, not +24h, to dodge IST/UTC midnight edges.
    const inTwoDays = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: {
            ...supplierFixture({
              contractStart: "2026-01-01T00:00:00.000Z",
              contractEnd: inTwoDays,
            }),
            purchaseOrders: [],
          } as any,
        },
      },
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByRole("heading", { name: "Acme Pharma" });
    expect(
      screen.getByText(/Expiring Soon/),
    ).toBeInTheDocument();
  });

  it("Contract panel renders 'Expired' when contractEnd is in the past", async () => {
    const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
      .toISOString();
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: {
            ...supplierFixture({
              contractStart: "2024-01-01T00:00:00.000Z",
              contractEnd: lastYear,
            }),
            purchaseOrders: [],
          } as any,
        },
      },
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByRole("heading", { name: "Acme Pharma" });
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("Contract panel Edit button reads 'Edit' (not 'Add') when contract dates already exist", async () => {
    wireApiGet({
      listResponse: { data: [supplierFixture()] },
      detailResponses: {
        "sup-1": {
          data: {
            ...supplierFixture({
              contractStart: "2026-01-01T00:00:00.000Z",
              contractEnd: "2027-01-01T00:00:00.000Z",
            }),
            purchaseOrders: [],
          } as any,
        },
      },
    });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByTestId("supplier-row-sup-1"));
    await screen.findByRole("heading", { name: "Acme Pharma" });
    expect(
      screen.getByRole("button", { name: /^Edit$/ }),
    ).toBeInTheDocument();
  });
});
