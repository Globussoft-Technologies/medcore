// Smoke tests for the patient PWA "Invoice detail" page (Pearl §6.1 +
// §4.1 + §4.2 — gap #5 piece 3g of 4). Asserts:
//   • Renders header / line-items table / payments / outstanding sections
//     with mocked invoice data.
//   • Outstanding section shows Pay-now CTA only when due > 0.
//   • NHCX stub stepper renders when insuranceClaims[0] is present; hidden
//     otherwise. Active stage matches the claim status mapping.
//   • GST download anchor points at /billing/invoices/:id/pdf?format=pdf.
//   • 404 surface renders when the API returns 404.
//   • Unauth 401 surface renders the sign-in nudge.
//   • 44px touch-target invariant on Back + Pay-now + Download CTAs.
//
// Mirrors the vi.hoisted api-mock pattern from the list page test (piece
// 3d) per CLAUDE.md gotcha #2 (singleFork vitest pattern). useParams is
// stubbed via vi.mock to drive the [id] route param without a real router.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

const { apiGetMock, useParamsMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  useParamsMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useParams: useParamsMock,
}));

import PatientBillDetailPage from "../page";

interface InvoiceFixture {
  id?: string;
  invoiceNumber?: string;
  totalAmount?: number;
  paymentStatus?: "PENDING" | "PAID" | "PARTIAL" | "REFUNDED";
  subtotal?: number;
  taxAmount?: number;
  discountAmount?: number;
  dueDate?: string | null;
  createdAt?: string;
  items?: Array<{
    id: string;
    description: string;
    category: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    cgst?: number;
    sgst?: number;
    hsnSac?: string | null;
  }>;
  payments?: Array<{
    id: string;
    amount: number;
    mode: string;
    status?: string;
    transactionId?: string | null;
    paidAt?: string;
  }>;
  insuranceClaims?: Array<{
    id: string;
    status: string;
    insuranceProvider?: string | null;
    claimAmount?: number | null;
    approvedAmount?: number | null;
  }> | null;
}

function makeInvoice(opts: InvoiceFixture = {}) {
  return {
    id: opts.id ?? "inv-1",
    invoiceNumber: opts.invoiceNumber ?? "INV000100",
    patientId: "p1",
    subtotal: opts.subtotal ?? 1000,
    taxAmount: opts.taxAmount ?? 180,
    discountAmount: opts.discountAmount ?? 0,
    totalAmount: opts.totalAmount ?? 1180,
    paymentStatus: opts.paymentStatus ?? "PENDING",
    dueDate: opts.dueDate ?? "2099-12-31",
    createdAt: opts.createdAt ?? "2026-05-10T10:00:00Z",
    items: opts.items ?? [
      {
        id: "it-1",
        description: "Consultation — General",
        category: "consultation",
        quantity: 1,
        unitPrice: 500,
        amount: 500,
        cgst: 45,
        sgst: 45,
        hsnSac: "999315",
      },
      {
        id: "it-2",
        description: "Paracetamol 500 mg",
        category: "medicine",
        quantity: 10,
        unitPrice: 50,
        amount: 500,
        cgst: 45,
        sgst: 45,
        hsnSac: "3004",
      },
    ],
    payments: opts.payments ?? [],
    insuranceClaims: opts.insuranceClaims ?? null,
  };
}

function ok<T>(data: T) {
  return { success: true, data, error: null };
}

function rejectedWithStatus(status: number) {
  return Promise.reject(Object.assign(new Error("nope"), { status }));
}

beforeEach(() => {
  apiGetMock.mockReset();
  useParamsMock.mockReset();
  useParamsMock.mockReturnValue({ id: "inv-1" });
});

describe("Patient bill detail page — gap #5 piece 3g", () => {
  it("renders the header, line items table, payments, and outstanding sections", async () => {
    apiGetMock.mockResolvedValueOnce(
      ok(
        makeInvoice({
          paymentStatus: "PARTIAL",
          payments: [
            {
              id: "pay-1",
              amount: 500,
              mode: "UPI",
              status: "CAPTURED",
              transactionId: "rzp_test_1",
              paidAt: "2026-05-11T10:00:00Z",
            },
          ],
        }),
      ),
    );

    render(<PatientBillDetailPage />);

    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-detail")).toBeInTheDocument(),
    );

    // Header surfaces invoice number + total + status pill.
    expect(screen.getByTestId("patient-bill-detail-number")).toHaveTextContent(
      "INV000100",
    );
    expect(screen.getByTestId("patient-bill-detail-total")).toHaveTextContent(
      /1,180/,
    );
    expect(screen.getByTestId("patient-bill-detail-status")).toHaveTextContent(
      "PARTIAL",
    );

    // Line items: 2 rows + footer (subtotal + tax + grand total).
    const itemRows = screen.getAllByTestId("patient-bill-detail-item-row");
    expect(itemRows).toHaveLength(2);
    expect(screen.getByTestId("patient-bill-detail-subtotal")).toHaveTextContent(
      /1,000/,
    );
    expect(screen.getByTestId("patient-bill-detail-tax")).toHaveTextContent(
      /180/,
    );
    expect(
      screen.getByTestId("patient-bill-detail-grand-total"),
    ).toHaveTextContent(/1,180/);

    // Payments: 1 row with UPI mode pill + reference.
    expect(
      screen.getAllByTestId("patient-bill-detail-payment-row"),
    ).toHaveLength(1);
    expect(
      screen.getByTestId("patient-bill-detail-payment-mode"),
    ).toHaveTextContent("UPI");

    // Outstanding: paid 500, due 680.
    expect(screen.getByTestId("patient-bill-detail-paid")).toHaveTextContent(
      /500/,
    );
    expect(
      screen.getByTestId("patient-bill-detail-due-amount"),
    ).toHaveTextContent(/680/);
  });

  it("shows the Pay-now CTA only when due > 0", async () => {
    // Case 1: due > 0 (PARTIAL with 500 paid against 1180 total).
    apiGetMock.mockResolvedValueOnce(
      ok(
        makeInvoice({
          paymentStatus: "PARTIAL",
          payments: [
            {
              id: "pay-1",
              amount: 500,
              mode: "UPI",
            },
          ],
        }),
      ),
    );
    const { unmount } = render(<PatientBillDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-detail")).toBeInTheDocument(),
    );
    const payBtn = screen.getByTestId("patient-bill-detail-pay-btn");
    expect(payBtn).toHaveAttribute("href", "/patient/bills/inv-1/pay");
    unmount();

    // Case 2: fully paid → no Pay-now.
    apiGetMock.mockResolvedValueOnce(
      ok(
        makeInvoice({
          paymentStatus: "PAID",
          payments: [
            { id: "pay-full", amount: 1180, mode: "CASH" },
          ],
        }),
      ),
    );
    render(<PatientBillDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-detail")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("patient-bill-detail-pay-btn"),
    ).not.toBeInTheDocument();
  });

  it("renders the NHCX cashless stub stepper when insuranceClaims[0] is present and hides otherwise", async () => {
    // With claim — SUBMITTED → stage index 2 active.
    apiGetMock.mockResolvedValueOnce(
      ok(
        makeInvoice({
          insuranceClaims: [
            {
              id: "claim-1",
              status: "SUBMITTED",
              insuranceProvider: "Star Health",
              claimAmount: 1000,
              approvedAmount: null,
            },
          ],
        }),
      ),
    );
    const { unmount } = render(<PatientBillDetailPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("patient-bill-detail-stepper"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("patient-bill-detail-stepper-stage-2"),
    ).toHaveAttribute("data-active", "true");
    expect(
      screen.getByTestId("patient-bill-detail-stepper-provider"),
    ).toHaveTextContent(/Star Health/);
    unmount();

    // No claim → stepper hidden.
    apiGetMock.mockResolvedValueOnce(ok(makeInvoice({ insuranceClaims: null })));
    render(<PatientBillDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-detail")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("patient-bill-detail-stepper"),
    ).not.toBeInTheDocument();
  });

  it("GST download anchor points at /billing/invoices/:id/pdf?format=pdf", async () => {
    apiGetMock.mockResolvedValueOnce(ok(makeInvoice({ id: "inv-gst-1" })));
    useParamsMock.mockReturnValue({ id: "inv-gst-1" });
    render(<PatientBillDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-detail")).toBeInTheDocument(),
    );
    const gstLink = screen.getByTestId("patient-bill-detail-gst-btn");
    const href = gstLink.getAttribute("href") ?? "";
    expect(href).toContain("/billing/invoices/inv-gst-1/pdf");
    expect(href).toContain("format=pdf");
    expect(gstLink).toHaveAttribute("target", "_blank");
    expect(gstLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders the not-found surface when /billing/invoices/:id returns 404", async () => {
    apiGetMock.mockReturnValueOnce(rejectedWithStatus(404));
    render(<PatientBillDetailPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("patient-bill-detail-not-found"),
      ).toBeInTheDocument(),
    );
    // Back-to-bills link still 44px touch target.
    const backLink = screen.getByTestId("patient-bill-detail-back-empty");
    expect(backLink).toHaveAttribute("href", "/patient/bills");
    expect(backLink.className).toMatch(/\bh-11\b/);
    expect(backLink.className).toMatch(/min-w-\[44px\]/);
  });

  it("renders the unauthed sign-in surface when the API returns 401", async () => {
    apiGetMock.mockReturnValueOnce(rejectedWithStatus(401));
    render(<PatientBillDetailPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("patient-bill-detail-unauth"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("patient-bill-detail-signin-cta"),
    ).toHaveAttribute("href", "/patient/login");
  });

  it("every interactive CTA carries h-11 + min-w-[44px] (Pearl §6.2 touch-target floor)", async () => {
    apiGetMock.mockResolvedValueOnce(
      ok(
        makeInvoice({
          paymentStatus: "PARTIAL",
          payments: [{ id: "p", amount: 100, mode: "CASH" }],
        }),
      ),
    );
    render(<PatientBillDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-detail")).toBeInTheDocument(),
    );

    for (const testId of [
      "patient-bill-detail-back",
      "patient-bill-detail-pay-btn",
      "patient-bill-detail-gst-btn",
    ]) {
      const el = screen.getByTestId(testId);
      expect(el.className, `${testId} must include h-11`).toMatch(/\bh-11\b/);
      expect(el.className, `${testId} must include min-w-[44px]`).toMatch(
        /min-w-\[44px\]/,
      );
    }
  });

  it("payments list shows the empty-state when no payments are recorded", async () => {
    apiGetMock.mockResolvedValueOnce(ok(makeInvoice({ payments: [] })));
    render(<PatientBillDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-detail")).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("patient-bill-detail-payments-empty"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("patient-bill-detail-payment-row"),
    ).not.toBeInTheDocument();
  });

  it("renders the HSN/SAC column when items carry it", async () => {
    apiGetMock.mockResolvedValueOnce(
      ok(
        makeInvoice({
          items: [
            {
              id: "it-1",
              description: "Antibiotic",
              category: "medicine",
              quantity: 1,
              unitPrice: 200,
              amount: 200,
              cgst: 18,
              sgst: 18,
              hsnSac: "3004",
            },
          ],
        }),
      ),
    );
    render(<PatientBillDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-detail")).toBeInTheDocument(),
    );
    const hsn = screen.getAllByTestId("patient-bill-detail-item-hsn");
    expect(hsn[0]).toHaveTextContent("3004");
  });
});
