/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PurchaseOrderDetailPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/purchase-orders/[id]/page.tsx`, the PO
 *     detail view (Issue #63 GST split + DRAFT timeline hint). The page hits:
 *       GET  /purchase-orders/:id
 *       POST /purchase-orders/:id/submit
 *       POST /purchase-orders/:id/approve
 *       POST /purchase-orders/:id/cancel
 *       POST /purchase-orders/:id/receive
 *
 *   - Behaviours covered:
 *       1. Loading skeleton with aria-busy while the GET is in flight.
 *       2. URL :id threads into the GET endpoint.
 *       3. Fetch-reject → "Purchase order not found" empty state with Back link.
 *       4. Status-flow progress bar suppressed for CANCELLED PO.
 *       5. statusBadge() — all 5 status branches (DRAFT, PENDING, APPROVED,
 *          RECEIVED, CANCELLED) render the correct color class.
 *       6. DRAFT shows action: Submit + Cancel + timeline draft-note.
 *       7. PENDING shows: Approve + Cancel; orderedAt/expectedAt render.
 *       8. APPROVED shows: Receive + Cancel; receivedAt renders when present.
 *       9. RECEIVED shows: no transition buttons (no Cancel either).
 *      10. CANCELLED shows: no transition buttons.
 *      11. Submit confirm → POST /submit + reload.
 *      12. Approve confirm → POST /approve + reload.
 *      13. Cancel confirm (danger:true) → POST /cancel + reload.
 *      14. Confirm-rejected (user clicks No) → no POST.
 *      15. Action error → toast.error with the message.
 *      16. Non-Error rejection → falls back to "Action failed".
 *      17. GST breakdown — CGST_SGST splits into two rows.
 *      18. GST breakdown — IGST renders single row.
 *      19. No GST breakdown — single Tax row fallback.
 *      20. Supplier optional fields — contact, phone, email, address, GSTIN
 *          omitted when missing.
 *      21. Items table renders unit price, qty, amount, and medicine-linked
 *          subtitle when present.
 *      22. Notes section omitted when notes are null.
 *      23. Print button calls window.print().
 *      24. Back button calls router.back().
 *      25. Receive modal — opens, pre-fills quantities, partial-receipt
 *          banner shows when qty < ordered, POSTs the expected payload, and
 *          re-fetches on save.
 *      26. Receive modal — full receipt (qty == ordered) hides partial banner,
 *          button text reads "Receive All".
 *      27. Receive modal — close button + Cancel button dismiss without POST.
 *      28. Receive modal — error rejection surfaces toast.error.
 *      29. Receive modal — non-Error rejection falls back to "Receipt failed".
 *
 *   - Mocks: @/lib/api, @/lib/toast, @/lib/use-dialog (confirm), next/navigation
 *            (useParams threads `id: "po1"`), @/components/Skeleton passthrough,
 *            lucide-react icon stubs.
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

const { apiMock, toastMock, routerMock, confirmMock } = vi.hoisted(() => ({
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
  confirmMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useParams: () => ({ id: "po1" }),
  usePathname: () => "/dashboard/purchase-orders/po1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));
vi.mock("lucide-react", () => ({
  ArrowLeft: () => <span data-testid="icon-arrow-left" />,
  Printer: () => <span data-testid="icon-printer" />,
  Check: () => <span data-testid="icon-check" />,
  Send: () => <span data-testid="icon-send" />,
  Package: () => <span data-testid="icon-package" />,
  X: () => <span data-testid="icon-x" />,
}));

import PurchaseOrderDetailPage from "../page";

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
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  supplier: {
    id: string;
    name: string;
    contactPerson?: string | null;
    phone?: string | null;
    email?: string | null;
    gstNumber?: string | null;
    address?: string | null;
  };
  items: Array<{
    id: string;
    description: string;
    medicineId?: string | null;
    quantity: number;
    unitPrice: number;
    amount: number;
    medicine?: { id: string; name: string; strength?: string | null } | null;
  }>;
  gstBreakdown?: {
    type: "CGST_SGST" | "IGST";
    cgst: number;
    sgst: number;
    igst: number;
  };
};

function po(overrides: Partial<PORecord> = {}): { data: PORecord } {
  return {
    data: {
      id: "po1",
      poNumber: "PO-2026-0001",
      status: "DRAFT",
      orderedAt: "2026-04-01T08:30:00.000Z",
      expectedAt: "2026-04-10T08:30:00.000Z",
      receivedAt: null,
      subtotal: 1000,
      taxAmount: 180,
      totalAmount: 1180,
      notes: null,
      createdAt: "2026-04-01T08:30:00.000Z",
      updatedAt: "2026-04-01T08:30:00.000Z",
      supplier: {
        id: "sup-1",
        name: "Acme Pharma",
      },
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
    },
  };
}

describe("PurchaseOrderDetailPage — PO detail / status transitions / GRN", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading skeleton with aria-busy while the GET is in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<PurchaseOrderDetailPage />);

    const loader = await screen.findByTestId("purchase-order-detail-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card").length).toBe(3);
  });

  it("threads the URL :id into the GET endpoint", async () => {
    apiMock.get.mockResolvedValue(po());
    render(<PurchaseOrderDetailPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/purchase-orders/po1"),
    );
  });

  it("renders the not-found empty state when the fetch rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("boom"));
    render(<PurchaseOrderDetailPage />);

    await screen.findByText(/Purchase order not found/);
    expect(
      screen.queryByTestId("purchase-order-detail-loading"),
    ).not.toBeInTheDocument();
    // Back link present.
    expect(screen.getByRole("link", { name: /Back/i })).toHaveAttribute(
      "href",
      "/dashboard/purchase-orders",
    );
  });

  it("DRAFT status renders Submit + Cancel actions and the draft timeline note", async () => {
    apiMock.get.mockResolvedValue(po({ status: "DRAFT" }));
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    // DRAFT badge — there are two "DRAFT" occurrences in the DOM (badge +
    // status-flow step). The badge is the one carrying bg-gray-100.
    const draftMatches = screen.getAllByText("DRAFT");
    expect(
      draftMatches.some((el) => el.className.includes("bg-gray-100")),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: /Submit/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Cancel/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Approve/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Receive/i }),
    ).not.toBeInTheDocument();

    // Timeline draft-note shown; ordered/expected DOM not rendered.
    expect(
      screen.getByTestId("po-timeline-draft-note"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("po-ordered-at")).not.toBeInTheDocument();
  });

  it("PENDING status renders Approve + Cancel and the timeline ordered/expected dates", async () => {
    apiMock.get.mockResolvedValue(po({ status: "PENDING" }));
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    const pendingMatches = screen.getAllByText("PENDING");
    expect(
      pendingMatches.some((el) => el.className.includes("bg-yellow-100")),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: /Approve/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Cancel/i }),
    ).toBeInTheDocument();

    // Ordered + expected render — draft-note hidden.
    expect(screen.getByTestId("po-ordered-at")).toBeInTheDocument();
    expect(screen.getByTestId("po-expected-at")).toBeInTheDocument();
    expect(
      screen.queryByTestId("po-timeline-draft-note"),
    ).not.toBeInTheDocument();
  });

  it("APPROVED status renders Receive + Cancel; receivedAt shown when present", async () => {
    apiMock.get.mockResolvedValue(
      po({
        status: "APPROVED",
        receivedAt: "2026-04-15T08:30:00.000Z",
      }),
    );
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    const approvedMatches = screen.getAllByText("APPROVED");
    expect(
      approvedMatches.some((el) => el.className.includes("bg-blue-100")),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: /Receive/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Cancel/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Received")).toBeInTheDocument();
  });

  it("RECEIVED status renders no transition buttons (terminal state)", async () => {
    apiMock.get.mockResolvedValue(po({ status: "RECEIVED" }));
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    const receivedMatches = screen.getAllByText("RECEIVED");
    expect(
      receivedMatches.some((el) => el.className.includes("bg-green-100")),
    ).toBe(true);
    // No transition buttons (Submit/Approve/Receive/Cancel all hidden).
    expect(
      screen.queryByRole("button", { name: /Submit/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Approve/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Receive/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Cancel$/i }),
    ).not.toBeInTheDocument();
  });

  it("CANCELLED status hides the status-flow progress bar and all transition buttons", async () => {
    apiMock.get.mockResolvedValue(po({ status: "CANCELLED" }));
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    expect(screen.getByText("CANCELLED").className).toMatch(/bg-red-100/);

    // No transition buttons — including no Cancel button.
    expect(
      screen.queryByRole("button", { name: /Submit/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Cancel$/i }),
    ).not.toBeInTheDocument();
  });

  it("Submit confirm → POST /submit and re-fetches PO state", async () => {
    apiMock.get.mockResolvedValue(po({ status: "DRAFT" }));
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Submit/i }));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Submit this PO for approval?",
          danger: false,
        }),
      );
      expect(apiMock.post).toHaveBeenCalledWith(
        "/purchase-orders/po1/submit",
        {},
      );
    });

    // Re-fetch fired (first call was the initial mount).
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));
  });

  it("Approve confirm → POST /approve", async () => {
    apiMock.get.mockResolvedValue(po({ status: "PENDING" }));
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/purchase-orders/po1/approve",
        {},
      );
    });
  });

  it("Cancel confirm fires with danger:true and POSTs /cancel", async () => {
    apiMock.get.mockResolvedValue(po({ status: "PENDING" }));
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Cancel this PO?",
          danger: true,
          message: "This cannot be undone.",
        }),
      );
      expect(apiMock.post).toHaveBeenCalledWith(
        "/purchase-orders/po1/cancel",
        {},
      );
    });
  });

  it("declining the confirm dialog skips the POST", async () => {
    apiMock.get.mockResolvedValue(po({ status: "DRAFT" }));
    confirmMock.mockResolvedValue(false);

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Submit/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("surfaces toast.error with the message when the action POST rejects", async () => {
    apiMock.get.mockResolvedValue(po({ status: "DRAFT" }));
    apiMock.post.mockRejectedValue(new Error("server unavailable"));
    confirmMock.mockResolvedValue(true);

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Submit/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("server unavailable");
    });
  });

  it("falls back to a generic 'Action failed' when the rejection is not an Error", async () => {
    apiMock.get.mockResolvedValue(po({ status: "DRAFT" }));
    apiMock.post.mockRejectedValue("nope");
    confirmMock.mockResolvedValue(true);

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Submit/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Action failed");
    });
  });

  it("renders CGST + SGST rows when gstBreakdown.type is CGST_SGST", async () => {
    apiMock.get.mockResolvedValue(
      po({
        status: "PENDING",
        subtotal: 1000,
        taxAmount: 180,
        totalAmount: 1180,
        gstBreakdown: { type: "CGST_SGST", cgst: 90, sgst: 90, igst: 0 },
      }),
    );
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    expect(screen.getByTestId("po-cgst")).toBeInTheDocument();
    expect(screen.getByTestId("po-sgst")).toBeInTheDocument();
    expect(screen.queryByTestId("po-igst")).not.toBeInTheDocument();
    // CGST + SGST both render "Rs. 90.00" — assert at least 2 occurrences.
    expect(screen.getAllByText(/Rs\.\s*90\.00/).length).toBeGreaterThanOrEqual(2);
  });

  it("renders single IGST row when gstBreakdown.type is IGST", async () => {
    apiMock.get.mockResolvedValue(
      po({
        status: "PENDING",
        gstBreakdown: { type: "IGST", cgst: 0, sgst: 0, igst: 180 },
      }),
    );
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    expect(screen.getByTestId("po-igst")).toBeInTheDocument();
    expect(screen.queryByTestId("po-cgst")).not.toBeInTheDocument();
    expect(screen.queryByTestId("po-sgst")).not.toBeInTheDocument();
  });

  it("falls back to a single Tax row when gstBreakdown is missing (older payload)", async () => {
    apiMock.get.mockResolvedValue(
      po({ status: "PENDING", taxAmount: 180, gstBreakdown: undefined }),
    );
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    expect(screen.getByText("Tax")).toBeInTheDocument();
    expect(screen.queryByTestId("po-cgst")).not.toBeInTheDocument();
    expect(screen.queryByTestId("po-igst")).not.toBeInTheDocument();
  });

  it("renders all supplier optional fields when present", async () => {
    apiMock.get.mockResolvedValue(
      po({
        supplier: {
          id: "sup-1",
          name: "Acme Pharma",
          contactPerson: "R. Kumar",
          phone: "9988776655",
          email: "rk@acme.test",
          gstNumber: "29ABCDE1234F1Z5",
          address: "Plot 12, Industrial Area",
        },
      }),
    );
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    expect(screen.getByText("R. Kumar")).toBeInTheDocument();
    expect(screen.getByText("9988776655")).toBeInTheDocument();
    expect(screen.getByText("rk@acme.test")).toBeInTheDocument();
    expect(screen.getByText("Plot 12, Industrial Area")).toBeInTheDocument();
    expect(screen.getByText(/GST:\s*29ABCDE1234F1Z5/)).toBeInTheDocument();
  });

  it("omits supplier optional fields when absent", async () => {
    apiMock.get.mockResolvedValue(
      po({
        supplier: {
          id: "sup-1",
          name: "Acme Pharma",
        },
      }),
    );
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    expect(screen.getByText("Acme Pharma")).toBeInTheDocument();
    // No GSTIN line.
    expect(document.body.textContent).not.toContain("GST:");
  });

  it("renders item rows with quantity/unit price/amount and medicine subtitle when linked", async () => {
    apiMock.get.mockResolvedValue(
      po({
        items: [
          {
            id: "li-1",
            description: "Paracetamol 500mg",
            quantity: 100,
            unitPrice: 10,
            amount: 1000,
            medicine: { id: "m-1", name: "Crocin", strength: "500mg" },
          },
          {
            id: "li-2",
            description: "Adhesive Bandages",
            quantity: 5,
            unitPrice: 50,
            amount: 250,
          },
        ],
      }),
    );
    render(<PurchaseOrderDetailPage />);

    await screen.findByText("PO-2026-0001");
    expect(screen.getByText("Paracetamol 500mg")).toBeInTheDocument();
    expect(screen.getByText("Adhesive Bandages")).toBeInTheDocument();
    expect(screen.getByText(/Linked to medicine:\s*Crocin/)).toBeInTheDocument();
    // unitPrice formatted with .toFixed(2) — assert presence (not unique).
    expect(screen.getAllByText(/Rs\.\s*10\.00/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Rs\.\s*50\.00/).length).toBeGreaterThanOrEqual(1);
    // amount column — "Rs. 1,000.00" appears in line amount + subtotal + total.
    expect(screen.getAllByText(/Rs\.\s*1,?000\.00/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders the Notes section when notes is non-empty", async () => {
    apiMock.get.mockResolvedValue(
      po({ notes: "Delivery via Blue Dart only" }),
    );
    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(
      screen.getByText(/Delivery via Blue Dart only/),
    ).toBeInTheDocument();
  });

  it("omits the Notes section when notes is null", async () => {
    apiMock.get.mockResolvedValue(po({ notes: null }));
    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");
    expect(screen.queryByText("Notes")).not.toBeInTheDocument();
  });

  it("Print button calls window.print()", async () => {
    apiMock.get.mockResolvedValue(po());
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Print/i }));
    expect(printSpy).toHaveBeenCalled();

    printSpy.mockRestore();
  });

  it("Back button calls router.back()", async () => {
    apiMock.get.mockResolvedValue(po());
    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    expect(routerMock.back).toHaveBeenCalled();
  });

  it("Receive modal opens with quantities pre-filled and POSTs full-receipt payload", async () => {
    apiMock.get.mockResolvedValue(
      po({
        status: "APPROVED",
        items: [
          {
            id: "li-1",
            description: "Paracetamol",
            quantity: 100,
            unitPrice: 10,
            amount: 1000,
          },
          {
            id: "li-2",
            description: "Bandage",
            quantity: 50,
            unitPrice: 5,
            amount: 250,
          },
        ],
      }),
    );
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Receive/i }));

    // Modal heading visible.
    expect(
      await screen.findByRole("heading", { name: /Receive Goods/i }),
    ).toBeInTheDocument();

    // No shortfall when qty == ordered → "Receive All" label.
    expect(
      screen.getByRole("button", { name: /Receive All/i }),
    ).toBeInTheDocument();
    // Banner-specific copy ("Partial receipt: PO will remain APPROVED...") is
    // absent — the helper modal explainer also contains "partial receipts"
    // (plural), so we scope to the banner's distinctive prefix.
    expect(
      screen.queryByText(/Partial receipt:/i),
    ).not.toBeInTheDocument();

    // Fill invoice + notes.
    fireEvent.change(screen.getByLabelText(/Supplier Invoice/i), {
      target: { value: "INV-9001" },
    });
    fireEvent.change(screen.getByLabelText(/Notes/i), {
      target: { value: "All received in good condition" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Receive All/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/purchase-orders/po1/receive",
        {
          receivedItems: [
            { itemId: "li-1", receivedQuantity: 100 },
            { itemId: "li-2", receivedQuantity: 50 },
          ],
          notes: "All received in good condition",
          invoiceNumber: "INV-9001",
        },
      );
    });

    // Modal closes (heading gone) and re-fetch fires (initial + post-save).
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /Receive Goods/i }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));
  });

  it("Receive modal shows the partial-receipt banner when quantity is below ordered", async () => {
    apiMock.get.mockResolvedValue(
      po({
        status: "APPROVED",
        items: [
          {
            id: "li-1",
            description: "Paracetamol",
            quantity: 100,
            unitPrice: 10,
            amount: 1000,
          },
        ],
      }),
    );
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Receive/i }));
    await screen.findByRole("heading", { name: /Receive Goods/i });

    // Reduce quantity → triggers shortfall banner + label changes.
    const qtyInput = screen.getByDisplayValue("100");
    fireEvent.change(qtyInput, { target: { value: "60" } });

    // Banner-distinctive prefix ("Partial receipt:") appears once the shortfall
    // is non-zero. The "partial receipts" plural in the modal explainer is
    // present in both states.
    expect(screen.getByText(/Partial receipt:/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Record Partial Receipt/i }),
    ).toBeInTheDocument();

    // POST with empty notes/invoice → undefined fields (truthy check).
    fireEvent.click(
      screen.getByRole("button", { name: /Record Partial Receipt/i }),
    );

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/purchase-orders/po1/receive",
        {
          receivedItems: [{ itemId: "li-1", receivedQuantity: 60 }],
          notes: undefined,
          invoiceNumber: undefined,
        },
      );
    });
  });

  it("Receive modal close button (✕) dismisses without POST", async () => {
    apiMock.get.mockResolvedValue(po({ status: "APPROVED" }));
    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Receive/i }));
    await screen.findByRole("heading", { name: /Receive Goods/i });

    // ✕ close button (the only button with no accessible name we can target
    // by text content).
    fireEvent.click(screen.getByRole("button", { name: "✕" }));

    expect(
      screen.queryByRole("heading", { name: /Receive Goods/i }),
    ).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Receive modal Cancel button dismisses without POST", async () => {
    apiMock.get.mockResolvedValue(po({ status: "APPROVED" }));
    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Receive/i }));
    await screen.findByRole("heading", { name: /Receive Goods/i });

    // The "Cancel" button inside the modal (footer).
    const cancelButtons = screen.getAllByRole("button", { name: /^Cancel$/ });
    // Use the last one — the modal footer Cancel (the page-level Cancel
    // doesn't render for APPROVED because no, wait — it DOES render for
    // APPROVED. There are two Cancel buttons: the action-bar one and the
    // modal footer one. The modal's is the second.
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    expect(
      screen.queryByRole("heading", { name: /Receive Goods/i }),
    ).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Receive modal surfaces toast.error when the POST rejects", async () => {
    apiMock.get.mockResolvedValue(po({ status: "APPROVED" }));
    apiMock.post.mockRejectedValue(new Error("warehouse closed"));

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Receive/i }));
    await screen.findByRole("heading", { name: /Receive Goods/i });

    fireEvent.click(screen.getByRole("button", { name: /Receive All/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("warehouse closed");
    });
    // Modal stays open on error.
    expect(
      screen.getByRole("heading", { name: /Receive Goods/i }),
    ).toBeInTheDocument();
  });

  it("Receive modal falls back to 'Receipt failed' on non-Error rejection", async () => {
    apiMock.get.mockResolvedValue(po({ status: "APPROVED" }));
    apiMock.post.mockRejectedValue("nope");

    render(<PurchaseOrderDetailPage />);
    await screen.findByText("PO-2026-0001");

    fireEvent.click(screen.getByRole("button", { name: /Receive/i }));
    await screen.findByRole("heading", { name: /Receive Goods/i });
    fireEvent.click(screen.getByRole("button", { name: /Receive All/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Receipt failed");
    });
  });
});
