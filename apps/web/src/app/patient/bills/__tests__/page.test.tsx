// Smoke tests for the patient PWA "My Bills" page (Pearl §6.1 — gap #5
// piece 3d of 4). Asserts:
//   • Renders Open + Paid sections with mocked data (PENDING / PARTIAL /
//     overdue-PENDING / PAID).
//   • Empty state when both buckets are empty.
//   • Pay-now CTA hidden on Paid rows; visible on Open rows.
//   • NHCX cashless stepper renders when insuranceClaims is present;
//     hidden otherwise.
//   • Every CTA carries the 44px touch-target invariant (h-11 + min-w-[44px]).
//   • GST download link uses /billing/invoices/:id/pdf?format=pdf.
//   • Unauth 401 surface renders the sign-in nudge.
//
// Uses vi.hoisted for the api mock per CLAUDE.md gotcha #2 (singleFork
// vitest pattern — same shape as the appointments + prescriptions page
// tests in pieces 3b + 3c).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";

const { apiGetMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
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

import PatientBillsPage from "../page";

interface InvoiceFixture {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  paymentStatus: "PENDING" | "PAID" | "PARTIAL" | "REFUNDED";
  dueDate?: string | null;
  createdAt?: string;
  payments?: Array<{ amount: number; status?: string }>;
  insuranceClaims?: Array<{ id: string; status: string }>;
}

function makeRow(opts: InvoiceFixture) {
  return {
    id: opts.id,
    invoiceNumber: opts.invoiceNumber,
    patientId: "p1",
    totalAmount: opts.totalAmount,
    paymentStatus: opts.paymentStatus,
    dueDate: opts.dueDate ?? null,
    createdAt: opts.createdAt ?? "2026-05-10T10:00:00Z",
    payments: opts.payments ?? [],
    insuranceClaims: opts.insuranceClaims ?? null,
  };
}

function listOk<T>(data: T[], total?: number) {
  return {
    success: true,
    data,
    error: null,
    meta: { page: 1, limit: 20, total: total ?? data.length },
  };
}

function rejectedWithStatus(status: number) {
  return Promise.reject(Object.assign(new Error("nope"), { status }));
}

// Helper: the page fires TWO parallel api.get calls (open + paid). The
// mock implementation routes by query string so tests can vary each
// bucket independently without caring which order the page calls them.
function mockBuckets(opts: {
  open: ReturnType<typeof listOk> | Promise<unknown>;
  paid: ReturnType<typeof listOk> | Promise<unknown>;
}) {
  apiGetMock.mockImplementation((endpoint: string) => {
    if (endpoint.includes("status=PENDING,PARTIAL")) {
      return opts.open instanceof Promise ? opts.open : Promise.resolve(opts.open);
    }
    if (endpoint.includes("status=PAID")) {
      return opts.paid instanceof Promise ? opts.paid : Promise.resolve(opts.paid);
    }
    return Promise.resolve(listOk([]));
  });
}

describe("Patient bills page — gap #5 piece 3d", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  it("renders Open + Paid sections with mixed mock data", async () => {
    mockBuckets({
      open: listOk([
        makeRow({
          id: "inv-pending",
          invoiceNumber: "INV000100",
          totalAmount: 2500,
          paymentStatus: "PENDING",
          dueDate: "2099-12-31",
        }),
        makeRow({
          id: "inv-partial",
          invoiceNumber: "INV000101",
          totalAmount: 5000,
          paymentStatus: "PARTIAL",
          dueDate: "2099-12-31",
          payments: [{ amount: 2000, status: "CAPTURED" }],
        }),
        makeRow({
          id: "inv-overdue",
          invoiceNumber: "INV000102",
          totalAmount: 1200,
          paymentStatus: "PENDING",
          dueDate: "2020-01-01", // long-past → overdue
        }),
      ]),
      paid: listOk([
        makeRow({
          id: "inv-paid",
          invoiceNumber: "INV000050",
          totalAmount: 750,
          paymentStatus: "PAID",
          createdAt: "2026-04-10T10:00:00Z",
        }),
      ]),
    });

    render(<PatientBillsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("patient-bills")).toBeInTheDocument(),
    );

    // Open section visible with 3 rows.
    const openSection = screen.getByTestId("patient-bills-open");
    expect(
      within(openSection).getAllByTestId("patient-bills-row"),
    ).toHaveLength(3);

    // Count badge reflects open rows.
    expect(screen.getByTestId("patient-bills-open-count")).toHaveTextContent(
      "3 open",
    );

    // Outstanding total visible (1200 + 2500 + (5000-2000) = 6700).
    expect(
      screen.getByTestId("patient-bills-outstanding-total"),
    ).toHaveTextContent(/6,700/);

    // Paid section header rendered; the list is collapsed by default.
    expect(screen.getByTestId("patient-bills-paid")).toBeInTheDocument();
    expect(
      screen.queryByTestId("patient-bills-paid-list"),
    ).not.toBeInTheDocument();

    // Expand paid bucket and confirm 1 paid row appears.
    fireEvent.click(screen.getByTestId("patient-bills-paid-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("patient-bills-paid-list")).toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId("patient-bills-paid-list")).getAllByTestId(
        "patient-bills-row",
      ),
    ).toHaveLength(1);
  });

  it("renders the empty state when both buckets are empty", async () => {
    mockBuckets({ open: listOk([], 0), paid: listOk([], 0) });
    render(<PatientBillsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bills-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("patient-bills-row")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("patient-bills-outstanding-total"),
    ).not.toBeInTheDocument();
  });

  it("shows Pay-now on Open rows and hides it on Paid rows", async () => {
    mockBuckets({
      open: listOk([
        makeRow({
          id: "inv-open-1",
          invoiceNumber: "INV000200",
          totalAmount: 1000,
          paymentStatus: "PENDING",
          dueDate: "2099-12-31",
        }),
      ]),
      paid: listOk([
        makeRow({
          id: "inv-paid-1",
          invoiceNumber: "INV000050",
          totalAmount: 500,
          paymentStatus: "PAID",
        }),
      ]),
    });

    render(<PatientBillsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bills")).toBeInTheDocument(),
    );

    // Open row has Pay-now visible + targets the /pay placeholder route.
    const openRow = within(
      screen.getByTestId("patient-bills-open"),
    ).getByTestId("patient-bills-row");
    const pay = within(openRow).getByTestId("patient-bills-pay-btn");
    expect(pay).toHaveAttribute("href", "/patient/bills/inv-open-1/pay");

    // Expand paid and confirm no Pay-now CTA on that row.
    fireEvent.click(screen.getByTestId("patient-bills-paid-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("patient-bills-paid-list")).toBeInTheDocument(),
    );
    const paidRow = within(
      screen.getByTestId("patient-bills-paid-list"),
    ).getByTestId("patient-bills-row");
    expect(
      within(paidRow).queryByTestId("patient-bills-pay-btn"),
    ).not.toBeInTheDocument();
    // View detail + GST download still present on paid rows.
    expect(
      within(paidRow).getByTestId("patient-bills-view-btn"),
    ).toBeInTheDocument();
    expect(
      within(paidRow).getByTestId("patient-bills-gst-btn"),
    ).toBeInTheDocument();
  });

  it("renders the NHCX cashless stub stepper when insuranceClaims is attached", async () => {
    mockBuckets({
      open: listOk([
        makeRow({
          id: "inv-with-claim",
          invoiceNumber: "INV000300",
          totalAmount: 10000,
          paymentStatus: "PARTIAL",
          dueDate: "2099-12-31",
          insuranceClaims: [{ id: "claim-1", status: "SUBMITTED" }],
        }),
        makeRow({
          id: "inv-no-claim",
          invoiceNumber: "INV000301",
          totalAmount: 500,
          paymentStatus: "PENDING",
          dueDate: "2099-12-31",
        }),
      ]),
      paid: listOk([]),
    });

    render(<PatientBillsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bills")).toBeInTheDocument(),
    );

    const rows = screen.getAllByTestId("patient-bills-row");
    const withClaim = rows.find(
      (r) => r.getAttribute("data-invoice-id") === "inv-with-claim",
    )!;
    const noClaim = rows.find(
      (r) => r.getAttribute("data-invoice-id") === "inv-no-claim",
    )!;

    // Stepper visible on the claim row.
    expect(
      within(withClaim).getByTestId("patient-bills-row-stepper"),
    ).toBeInTheDocument();
    // Stage 2 (Claim submitted) is the active one for SUBMITTED claim status.
    expect(
      within(withClaim).getByTestId("patient-bills-row-stepper-stage-2"),
    ).toHaveAttribute("data-active", "true");

    // Hidden on the no-claim row.
    expect(
      within(noClaim).queryByTestId("patient-bills-row-stepper"),
    ).not.toBeInTheDocument();
  });

  it("every interactive CTA carries h-11 + min-w-[44px] (Pearl §6.2 touch-target floor)", async () => {
    mockBuckets({
      open: listOk([
        makeRow({
          id: "inv-cta",
          invoiceNumber: "INV000400",
          totalAmount: 1000,
          paymentStatus: "PENDING",
          dueDate: "2099-12-31",
        }),
      ]),
      paid: listOk([
        makeRow({
          id: "inv-cta-paid",
          invoiceNumber: "INV000045",
          totalAmount: 500,
          paymentStatus: "PAID",
        }),
      ]),
    });

    render(<PatientBillsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bills")).toBeInTheDocument(),
    );

    for (const testId of [
      "patient-bills-pay-btn",
      "patient-bills-view-btn",
      "patient-bills-gst-btn",
      "patient-bills-paid-toggle",
    ]) {
      const el = screen.getByTestId(testId);
      expect(el.className, `${testId} must include h-11`).toMatch(/\bh-11\b/);
      expect(el.className, `${testId} must include min-w-[44px]`).toMatch(
        /min-w-\[44px\]/,
      );
    }
  });

  it("GST download link uses the /billing/invoices/:id/pdf?format=pdf shape", async () => {
    mockBuckets({
      open: listOk([
        makeRow({
          id: "inv-gst-1",
          invoiceNumber: "INV000500",
          totalAmount: 1000,
          paymentStatus: "PENDING",
          dueDate: "2099-12-31",
        }),
      ]),
      paid: listOk([]),
    });

    render(<PatientBillsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bills")).toBeInTheDocument(),
    );

    const gstLink = screen.getByTestId("patient-bills-gst-btn");
    const href = gstLink.getAttribute("href") ?? "";
    expect(href).toContain("/billing/invoices/inv-gst-1/pdf");
    expect(href).toContain("format=pdf");
    expect(gstLink).toHaveAttribute("target", "_blank");
    expect(gstLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders the unauthed sign-in surface when /billing/invoices returns 401", async () => {
    mockBuckets({
      open: rejectedWithStatus(401),
      paid: rejectedWithStatus(401),
    });
    render(<PatientBillsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bills-unauth")).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("patient-bills-signin-cta"),
    ).toHaveAttribute("href", "/patient/login");
  });
});
