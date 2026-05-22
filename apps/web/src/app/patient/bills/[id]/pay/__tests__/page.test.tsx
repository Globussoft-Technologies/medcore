// Smoke tests for the patient PWA "Pay invoice" Razorpay handoff page
// (Pearl §6.1 + §6.3 — gap #5 piece 3h of 4). Asserts:
//   • Renders the initial summary card with mocked invoice + due rupees.
//   • Click Pay button calls openRazorpayCheckout with the right shape.
//   • Success state renders after the wrapper's onSuccess callback fires.
//   • Cancelled state renders when wrapper's onFailure fires "Payment
//     cancelled".
//   • Error state renders when wrapper's onFailure fires anything else.
//   • Already-paid invoice → not-payable surface (Pay button hidden).
//   • Razorpay-disabled → not-payable surface.
//   • 404 / 403 from the invoice fetch → not-found surface.
//   • 401 → sign-in nudge to /patient/login.
//   • Every CTA carries the 44px touch-target invariant (h-11 + min-w-[44px]).
//
// Mock layer: same vi.hoisted pattern as pieces 3b–3g (api mock + useParams
// mock + per-test razorpay-lib mock). openRazorpayCheckout is the only
// surface that touches window.Razorpay, so we stub it directly — no need
// to also stub the global. fetchRazorpayConfig is stubbed for the
// enabled/disabled split.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const {
  apiGetMock,
  useParamsMock,
  fetchRazorpayConfigMock,
  openRazorpayCheckoutMock,
} = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  useParamsMock: vi.fn(),
  fetchRazorpayConfigMock: vi.fn(),
  openRazorpayCheckoutMock: vi.fn(),
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

vi.mock("@/lib/razorpay", () => ({
  fetchRazorpayConfig: fetchRazorpayConfigMock,
  openRazorpayCheckout: openRazorpayCheckoutMock,
}));

vi.mock("next/navigation", () => ({
  useParams: useParamsMock,
}));

import PatientBillPayPage from "../page";

interface InvoiceFixture {
  id?: string;
  invoiceNumber?: string;
  totalAmount?: number;
  paymentStatus?: "PENDING" | "PAID" | "PARTIAL" | "REFUNDED";
  payments?: Array<{
    id: string;
    amount: number;
    mode: string;
    status?: string;
  }>;
}

function makeInvoice(opts: InvoiceFixture = {}) {
  return {
    id: opts.id ?? "inv-1",
    invoiceNumber: opts.invoiceNumber ?? "INV000100",
    patientId: "p1",
    totalAmount: opts.totalAmount ?? 1180,
    paymentStatus: opts.paymentStatus ?? "PENDING",
    payments: opts.payments ?? [],
  };
}

function ok<T>(data: T) {
  return { success: true, data, error: null };
}

function rejectedWithStatus(status: number) {
  return Promise.reject(Object.assign(new Error("nope"), { status }));
}

const ME_FIXTURE = {
  id: "u1",
  name: "Asha Patil",
  email: "asha@example.com",
  phone: "+919999900000",
};

function primeFetches(opts: {
  invoice?: ReturnType<typeof makeInvoice> | null;
  invoiceStatus?: number;
  meStatus?: number;
  configEnabled?: boolean;
}) {
  apiGetMock.mockImplementation((endpoint: string) => {
    if (endpoint.startsWith("/billing/invoices/")) {
      if (opts.invoiceStatus) return rejectedWithStatus(opts.invoiceStatus);
      return Promise.resolve(ok(opts.invoice ?? makeInvoice()));
    }
    if (endpoint.startsWith("/auth/me")) {
      if (opts.meStatus) return rejectedWithStatus(opts.meStatus);
      return Promise.resolve(ok(ME_FIXTURE));
    }
    return Promise.resolve(ok(null));
  });
  fetchRazorpayConfigMock.mockResolvedValue({
    enabled: opts.configEnabled ?? true,
    isTestMode: true,
  });
}

beforeEach(() => {
  apiGetMock.mockReset();
  useParamsMock.mockReset();
  fetchRazorpayConfigMock.mockReset();
  openRazorpayCheckoutMock.mockReset();
  useParamsMock.mockReturnValue({ id: "inv-1" });
});

describe("Patient bill pay page — gap #5 piece 3h", () => {
  it("renders the initial summary card with invoice number + due rupees", async () => {
    primeFetches({});
    render(<PatientBillPayPage />);

    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-pay")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("patient-bill-pay-number")).toHaveTextContent(
      "INV000100",
    );
    expect(screen.getByTestId("patient-bill-pay-due")).toHaveTextContent(
      /1,180/,
    );
    const btn = screen.getByTestId("patient-bill-pay-btn");
    expect(btn).toHaveTextContent(/Pay/);
    expect(btn).toHaveTextContent(/1,180/);
    expect(btn).not.toBeDisabled();
  });

  it("click Pay button invokes openRazorpayCheckout with the invoice + prefill shape", async () => {
    primeFetches({});
    // Resolve the wrapper synchronously so the test doesn't need to wait
    // on a real Razorpay modal.
    openRazorpayCheckoutMock.mockImplementation(async (opts: any) => {
      opts.onSuccess?.();
    });

    render(<PatientBillPayPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-pay")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("patient-bill-pay-btn"));

    await waitFor(() => {
      expect(openRazorpayCheckoutMock).toHaveBeenCalledTimes(1);
    });

    const call = openRazorpayCheckoutMock.mock.calls[0][0];
    expect(call.invoiceId).toBe("inv-1");
    expect(call.invoiceNumber).toBe("INV000100");
    expect(call.patient).toEqual({
      name: "Asha Patil",
      email: "asha@example.com",
      phone: "+919999900000",
    });
    expect(typeof call.onSuccess).toBe("function");
    expect(typeof call.onFailure).toBe("function");
  });

  it("renders the success surface after the wrapper invokes onSuccess", async () => {
    primeFetches({});
    openRazorpayCheckoutMock.mockImplementation(async (opts: any) => {
      opts.onSuccess?.();
    });

    render(<PatientBillPayPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-pay-btn")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("patient-bill-pay-btn"));

    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-pay-success")).toBeInTheDocument(),
    );
    const cta = screen.getByTestId("patient-bill-pay-success-cta");
    expect(cta).toHaveAttribute("href", "/patient/bills");
  });

  it("renders the cancelled surface when wrapper signals 'Payment cancelled'", async () => {
    primeFetches({});
    openRazorpayCheckoutMock.mockImplementation(async (opts: any) => {
      opts.onFailure?.("Payment cancelled");
    });

    render(<PatientBillPayPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-pay-btn")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("patient-bill-pay-btn"));

    await waitFor(() =>
      expect(
        screen.getByTestId("patient-bill-pay-cancelled"),
      ).toBeInTheDocument(),
    );
    // Pay button still visible so the user can retry inline.
    expect(screen.getByTestId("patient-bill-pay-btn")).toBeInTheDocument();
  });

  it("renders the error banner when wrapper fires onFailure with a real reason", async () => {
    primeFetches({});
    openRazorpayCheckoutMock.mockImplementation(async (opts: any) => {
      opts.onFailure?.("Verification failed");
    });

    render(<PatientBillPayPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-pay-btn")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("patient-bill-pay-btn"));

    await waitFor(() =>
      expect(
        screen.getByTestId("patient-bill-pay-error-banner"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("patient-bill-pay-error-banner"),
    ).toHaveTextContent(/Verification failed/);
  });

  it("renders the not-payable surface when the invoice is already fully paid", async () => {
    primeFetches({
      invoice: makeInvoice({
        paymentStatus: "PAID",
        payments: [{ id: "p1", amount: 1180, mode: "CASH" }],
      }),
    });

    render(<PatientBillPayPage />);

    await waitFor(() =>
      expect(
        screen.getByTestId("patient-bill-pay-not-payable"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("patient-bill-pay-btn")).not.toBeInTheDocument();
    expect(screen.getByTestId("patient-bill-pay-back-detail")).toHaveAttribute(
      "href",
      "/patient/bills/inv-1",
    );
  });

  it("renders the not-payable surface when Razorpay isn't configured", async () => {
    primeFetches({ configEnabled: false });

    render(<PatientBillPayPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("patient-bill-pay-not-payable"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("patient-bill-pay-btn")).not.toBeInTheDocument();
  });

  it("renders the not-found surface when the invoice fetch returns 404", async () => {
    primeFetches({ invoiceStatus: 404 });
    render(<PatientBillPayPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("patient-bill-pay-not-found"),
      ).toBeInTheDocument(),
    );
  });

  it("renders the not-found surface when the invoice fetch returns 403", async () => {
    primeFetches({ invoiceStatus: 403 });
    render(<PatientBillPayPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("patient-bill-pay-not-found"),
      ).toBeInTheDocument(),
    );
  });

  it("renders the unauthed sign-in surface when /auth/me returns 401", async () => {
    primeFetches({ meStatus: 401 });
    render(<PatientBillPayPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("patient-bill-pay-unauth"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("patient-bill-pay-signin-cta")).toHaveAttribute(
      "href",
      "/patient/login",
    );
  });

  it("every interactive CTA carries h-11 + min-w-[44px] (Pearl §6.2 touch-target floor)", async () => {
    primeFetches({});
    render(<PatientBillPayPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-bill-pay")).toBeInTheDocument(),
    );

    for (const testId of ["patient-bill-pay-back", "patient-bill-pay-btn"]) {
      const el = screen.getByTestId(testId);
      expect(el.className, `${testId} must include h-11`).toMatch(/\bh-11\b/);
      expect(el.className, `${testId} must include min-w-\\[44px\\]`).toMatch(
        /min-w-\[44px\]/,
      );
    }
  });
});
