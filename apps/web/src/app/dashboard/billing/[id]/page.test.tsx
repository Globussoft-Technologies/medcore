/* eslint-disable @typescript-eslint/no-explicit-any */
// Regression tests for Issues #42, #43, #44 (billing invoice view).
//
//  #42 — Invoice header must render a real hospital phone pulled from the
//        /billing/hospital-profile endpoint, NOT the hardcoded
//        "+91-XXXXXXXXXX" placeholder.
//  #43 — Line-item table and totals block must show CGST + SGST columns and
//        an HSN/SAC code per line, computed from the shared helper when
//        Invoice.taxAmount is zero.
//  #44 — Add Line Item form must auto-derive the Category when the
//        description changes (via `categorizeService`), while still letting
//        the user manually override.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, toastMock, confirmMock } = vi.hoisted(() => ({
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
  confirmMock: vi.fn(async () => true),
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  openPrintEndpoint: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "inv-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/billing/inv-1",
}));

import InvoiceDetailPage from "./page";

const invoiceFixture = {
  id: "inv-1",
  invoiceNumber: "INV-TST-001",
  totalAmount: 1710,
  subtotal: 1500,
  // taxAmount intentionally 0 to force the per-line-computed fallback
  // (simulates an older invoice saved before the GST-aware totals landed).
  taxAmount: 0,
  discountAmount: 0,
  paymentStatus: "PENDING",
  lateFeeAmount: 0,
  lateFeeAppliedAt: null,
  notes: null,
  createdAt: "2026-04-10T09:00:00.000Z",
  patient: {
    id: "p1",
    mrNumber: "MR-500",
    age: 42,
    gender: "MALE",
    user: {
      name: "Arjun Verma",
      phone: "+91-99999-00000",
      email: "arjun@example.com",
    },
  },
  appointment: {
    date: "2026-04-10T09:00:00.000Z",
    doctor: { user: { name: "Dr. Gupta" }, specialization: "Physician" },
  },
  items: [
    {
      id: "it-1",
      description: "CBC Panel",
      category: "LAB",
      quantity: 1,
      unitPrice: 500,
      amount: 500,
    },
    {
      id: "it-2",
      description: "Minor Surgery",
      category: "SURGERY",
      quantity: 1,
      unitPrice: 1000,
      amount: 1000,
    },
  ],
  payments: [],
};

const hospitalProfileFixture = {
  name: "MedCore Demo Hospital",
  address: "42 Demo Road, Bengaluru, Karnataka 560001",
  phone: "+91-80-2345-6789",
  email: "demo@medcore.test",
  gstin: "29AABCU9603R1ZM",
  registration: "KA/BLR/2024/HC-0001",
  tagline: "Care first.",
  logoUrl: "",
};

function seedApi() {
  apiMock.get.mockImplementation(async (url: string) => {
    if (url.startsWith("/billing/invoices/")) return { data: invoiceFixture };
    if (url.startsWith("/billing/discount-approvals")) return { data: [] };
    if (url.startsWith("/billing/hospital-profile"))
      return { data: hospitalProfileFixture };
    return { data: null };
  });
}

describe("InvoiceDetailPage — Issue #42 (hospital header)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    seedApi();
  });

  it("does NOT render the +91-XXXXXXXXXX placeholder", async () => {
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByText("INV-TST-001")).toBeInTheDocument()
    );
    expect(screen.queryByText(/\+91-XXXXXXXXXX/)).not.toBeInTheDocument();
  });

  it("renders hospital name, phone and GSTIN from /billing/hospital-profile", async () => {
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByText("MedCore Demo Hospital")).toBeInTheDocument()
    );
    expect(screen.getByText(/\+91-80-2345-6789/)).toBeInTheDocument();
    expect(screen.getByText(/29AABCU9603R1ZM/)).toBeInTheDocument();
  });
});

describe("InvoiceDetailPage — Issue #43 (GST line breakdown)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    seedApi();
  });

  it("shows HSN/SAC, CGST and SGST column headers", async () => {
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByText("INV-TST-001")).toBeInTheDocument()
    );
    // Column headers (text appears in <th>). Multiple CGST/SGST occurrences
    // are expected (headers + totals block), so getAllByText is safer.
    expect(screen.getByText("HSN/SAC")).toBeInTheDocument();
    expect(screen.getAllByText("CGST").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SGST").length).toBeGreaterThan(0);
    // SAC 9993 applies to both LAB + SURGERY in the fixture
    const sacCells = screen.getAllByText("9993");
    expect(sacCells.length).toBeGreaterThanOrEqual(2);
  });

  it("computes per-line CGST + SGST using the shared helper", async () => {
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByText("INV-TST-001")).toBeInTheDocument()
    );
    // Line 1: LAB Rs 500 × 12% = 60 GST → CGST 30 / SGST 30
    // Line 2: SURGERY Rs 1000 × 18% = 180 GST → CGST 90 / SGST 90
    // Totals: CGST = 120, SGST = 120
    const cgstTotal = screen.getByTestId("totals-cgst");
    const sgstTotal = screen.getByTestId("totals-sgst");
    expect(cgstTotal.textContent).toMatch(/120\.00/);
    expect(sgstTotal.textContent).toMatch(/120\.00/);
  });
});

describe("InvoiceDetailPage — Issue #44 (auto category)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    seedApi();
  });

  it("auto-selects RADIOLOGY when the user types an X-Ray service", async () => {
    const user = userEvent.setup();
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByText("INV-TST-001")).toBeInTheDocument()
    );

    const descInput = screen.getByLabelText(/description/i) as HTMLInputElement;
    const categorySelect = screen.getByLabelText(/category/i) as HTMLSelectElement;

    // Default before typing
    expect(categorySelect.value).toBe("CONSULTATION");

    await user.type(descInput, "X-Ray Chest");
    expect(categorySelect.value).toBe("RADIOLOGY");
  });

  it("respects a manual category override and does not overwrite on subsequent typing", async () => {
    const user = userEvent.setup();
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByText("INV-TST-001")).toBeInTheDocument()
    );

    const descInput = screen.getByLabelText(/description/i) as HTMLInputElement;
    const categorySelect = screen.getByLabelText(/category/i) as HTMLSelectElement;

    // User picks OTHER manually first
    await user.selectOptions(categorySelect, "OTHER");
    expect(categorySelect.value).toBe("OTHER");

    // Typing an X-Ray description should NOT overwrite the manual pick
    await user.type(descInput, "X-Ray Chest");
    expect(categorySelect.value).toBe("OTHER");
  });
});

describe("InvoiceDetailPage — Issue #223 (per-field validation errors)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.error.mockReset();
    seedApi();
  });

  it("renders zod field-level messages from /billing/payments instead of a single generic toast", async () => {
    const user = userEvent.setup();
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByText("INV-TST-001")).toBeInTheDocument()
    );

    // Open the Record Payment modal — the button pre-fills the amount with
    // the outstanding balance, which is fine: we just need the modal open
    // and the submit to round-trip through the API.
    await user.click(screen.getByRole("button", { name: /record payment/i }));
    // Sanity: the modal rendered the amount input
    expect(screen.getByTestId("payment-amount")).toBeInTheDocument();

    // Mock the server returning the canonical zod-shaped 400 envelope.
    apiMock.post.mockRejectedValueOnce(
      Object.assign(new Error("Validation failed"), {
        status: 400,
        payload: {
          error: "Validation failed",
          details: [
            { field: "amount", message: "Amount must be greater than 0" },
            { field: "mode", message: "Mode is required" },
          ],
        },
      })
    );

    await user.click(screen.getByRole("button", { name: /save payment/i }));

    // Field-level inline error nodes are surfaced under each input.
    expect(
      await screen.findByTestId("error-payment-amount")
    ).toHaveTextContent(/amount must be greater than 0/i);
    expect(screen.getByTestId("error-payment-mode")).toHaveTextContent(
      /mode is required/i
    );

    // The toast surfaces the FIRST field message — not the generic
    // "Validation failed" fallback the page used to render.
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/amount must be greater than 0/i)
    );
    expect(toastMock.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/^validation failed$/i)
    );
  });
});
