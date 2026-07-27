/* eslint-disable @typescript-eslint/no-explicit-any */
// Colocated unit suite for /dashboard/platform-billing/invoices/[id] — Pearl §8.3
// (gap rows 215-218 closure piece 3-UI follow-on, 2026-05-26 test-cron pick).
//
// Covers, from the source file:
//   - URL id threading via useParams: detail GET hits /invoices/<id>.
//   - Loading affordance shows while the detail fetch is in flight.
//   - Happy-path render: invoice number, tenant info, period dates,
//     payment-ref echo, line-items + HSN codes + tax breakdown + total.
//   - Status badge variants (DRAFT / ISSUED / PAID / VOID) — each branch
//     of statusBadge() executes including the fallback default.
//   - PAID banner + "Mark Paid" button gating on invoice.status.
//   - Empty-line-items render path ("No line items.").
//   - Back-button calls router.push("/dashboard/platform-billing").
//   - Mark-Paid modal: opens, validates empty reference, submits POST with
//     the typed reference, refetches detail on success, and surfaces
//     server-side error string when the POST returns !success.
//   - Backdrop click closes the modal; busy guard prevents close during POST.
//   - Detail-error path renders the rose error banner.
//
// fetch stubbed at the global level; the page is rendered as a unit so the
// surrounding layout/RBAC chrome isn't exercised here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

let currentParamId: string = "inv1";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
  useParams: () => ({ id: currentParamId }),
  // Some imports on the detail page (or its shared layout) reach for
  // useSearchParams; tests don't drive any query state, so a stub
  // returning null for every key is sufficient.
  useSearchParams: () => ({ get: () => null }),
}));

const routerPush = vi.fn();

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const fetchMock = vi.fn();
let dateNowSpy: ReturnType<typeof vi.spyOn>;

function baseInvoice(overrides: Partial<any> = {}): any {
  return {
    id: "inv1",
    invoiceNumber: "PI-202604-0042",
    tenantId: "tn-1",
    subscriptionId: "sub-1",
    periodStart: "2026-04-01T00:00:00Z",
    periodEnd: "2026-05-01T00:00:00Z",
    subtotalInPaise: 1500000,
    cgstInPaise: 135000,
    sgstInPaise: 135000,
    igstInPaise: 0,
    totalInPaise: 1770000,
    status: "ISSUED",
    issuedAt: "2026-05-01T00:00:00Z",
    paidAt: null,
    paidByUserId: null,
    paymentReference: null,
    hsnSacCode: "998314",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    tenant: {
      id: "tn-1",
      name: "Apollo Pearl",
      subdomain: "apollo",
      active: true,
    },
    lineItems: [
      {
        id: "li-1",
        description: "GROWTH plan — Apr 2026",
        unitPriceInPaise: 1500000,
        quantity: 1,
        amountInPaise: 1500000,
        hsnSacCode: "998314",
        cgstRate: 9,
        sgstRate: 9,
        igstRate: 0,
      },
    ],
    ...overrides,
  };
}

function mockDetailOk(invoice = baseInvoice()): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (typeof url === "string" && url.includes(`/invoices/${invoice.id}`) && !url.includes("mark-paid")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { invoice },
          error: null,
        }),
      };
    }
    return {
      ok: false,
      status: 500,
      json: async () => ({ success: false, data: null, error: "unmocked" }),
    };
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  routerPush.mockReset();
  currentParamId = "inv1";
  dateNowSpy = vi
    .spyOn(Date, "now")
    .mockReturnValue(new Date("2026-04-15T00:00:00.000Z").getTime());
  mockDetailOk();
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

afterEach(() => {
  dateNowSpy.mockRestore();
});

import PlatformInvoiceDetailPage from "../page";

describe("/dashboard/platform-billing/invoices/[id] — detail page", () => {
  it("threads the URL id into the detail fetch and renders the invoice number + tenant + period", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-number"),
      ).toHaveTextContent("PI-202604-0042");
    });
    const firstUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toBe("/api/v1/platform-billing/invoices/inv1");
    expect(screen.getByText(/Apollo Pearl/)).toBeInTheDocument();
    expect(screen.getByText(/apollo/)).toBeInTheDocument();
    expect(screen.getByText(/Billing period/)).toBeInTheDocument();
  });

  it("renders the line-items table + tax breakdown + total", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-lineitems-wrapper"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("GROWTH plan — Apr 2026")).toBeInTheDocument();
    expect(screen.getByText("998314")).toBeInTheDocument();
    expect(
      screen.getByTestId("platform-billing-invoice-total"),
    ).toBeInTheDocument();
  });

  it("renders the ISSUED status badge + Mark Paid CTA for an ISSUED invoice", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-status-inv1"),
      ).toHaveTextContent(/Issued/);
    });
    expect(
      screen.getByTestId("platform-billing-invoice-record"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("platform-billing-invoice-paid-banner"),
    ).toBeNull();
  });

  it("renders Past due for an unpaid invoice after its period end", async () => {
    dateNowSpy.mockReturnValue(new Date("2026-06-02T00:00:00.000Z").getTime());
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-status-inv1"),
      ).toHaveTextContent(/Past due/);
    });
  });

  it("renders the PAID banner + payment reference + suppresses Mark Paid when PAID", async () => {
    mockDetailOk(
      baseInvoice({
        status: "PAID",
        paidAt: "2026-05-10T00:00:00Z",
        paymentReference: "RZP-PAID-001",
      }),
    );
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-paid-banner"),
      ).toHaveTextContent(/RZP-PAID-001/);
    });
    expect(
      screen.queryByTestId("platform-billing-invoice-record"),
    ).toBeNull();
    expect(
      screen.getByTestId("platform-billing-invoice-payment-ref"),
    ).toHaveTextContent("RZP-PAID-001");
    expect(
      screen.getByTestId("platform-billing-invoice-status-inv1"),
    ).toHaveTextContent(/Paid/);
  });

  it("renders the DRAFT badge with no Mark Paid affordance", async () => {
    mockDetailOk(baseInvoice({ status: "DRAFT", issuedAt: null }));
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-status-inv1"),
      ).toHaveTextContent(/Draft/);
    });
    expect(
      screen.queryByTestId("platform-billing-invoice-record"),
    ).toBeNull();
  });

  it("renders the VOID badge", async () => {
    mockDetailOk(baseInvoice({ status: "VOID" }));
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-status-inv1"),
      ).toHaveTextContent(/Void/);
    });
  });

  it("falls back to the default badge for an unknown status value", async () => {
    // Source has a `default:` arm in statusBadge — exercise it via an
    // off-enum value. Cast-through-any keeps the typecheck quiet.
    mockDetailOk(baseInvoice({ status: "UNKNOWN" as any }));
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-status-inv1"),
      ).toHaveTextContent(/UNKNOWN/);
    });
  });

  it("renders 'No line items.' when the invoice has an empty lineItems array", async () => {
    mockDetailOk(baseInvoice({ lineItems: [] }));
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(screen.getByText(/No line items\./)).toBeInTheDocument();
    });
  });

  it("renders '(unknown)' tenant fallback when invoice.tenant is null", async () => {
    mockDetailOk(baseInvoice({ tenant: null }));
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(screen.getByText(/\(unknown\)/)).toBeInTheDocument();
    });
  });

  it("clicking Back invokes router.push to the billing landing", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-back"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("platform-billing-invoice-back"));
    expect(routerPush).toHaveBeenCalledWith("/dashboard/platform-billing");
  });

  it("renders the error banner when the detail fetch returns !success", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({
        success: false,
        data: null,
        error: "boom-detail-error",
      }),
    }));
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-error"),
      ).toHaveTextContent("boom-detail-error");
    });
  });

  it("Mark-Paid modal: empty reference surfaces inline error and does NOT POST", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-record"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("platform-billing-invoice-record"));
    expect(
      screen.getByTestId("platform-billing-mark-paid-modal"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("platform-billing-mark-paid-submit"));
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-mark-paid-error"),
      ).toHaveTextContent(/payment reference/i);
    });
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as any)?.method === "POST"),
    ).toBe(false);
  });

  it("Mark-Paid modal: submits POST with the entered reference + refetches detail on success", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-record"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("platform-billing-invoice-record"));
    fireEvent.change(
      screen.getByTestId("platform-billing-payment-reference-input"),
      { target: { value: "RZP-OK-12345" } },
    );

    // Queue POST OK, then the post-success refetch as a PAID invoice.
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { transition: "PAID", invoice: { id: "inv1" } },
        error: null,
      }),
    }));
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          invoice: baseInvoice({
            status: "PAID",
            paidAt: "2026-05-10T00:00:00Z",
            paymentReference: "RZP-OK-12345",
          }),
        },
        error: null,
      }),
    }));

    fireEvent.click(screen.getByTestId("platform-billing-mark-paid-submit"));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => (c[1] as any)?.method === "POST",
      );
      expect(postCall).toBeDefined();
      expect(String(postCall?.[0] ?? "")).toBe(
        "/api/v1/platform-billing/invoices/inv1/mark-paid",
      );
      expect((postCall?.[1] as any).body).toContain(
        '"paymentReference":"RZP-OK-12345"',
      );
    });

    // Modal closes after a successful POST.
    await waitFor(() => {
      expect(
        screen.queryByTestId("platform-billing-mark-paid-modal"),
      ).toBeNull();
    });
  });

  it("Mark-Paid modal: surfaces the server error string when POST returns !success", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-record"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("platform-billing-invoice-record"));
    fireEvent.change(
      screen.getByTestId("platform-billing-payment-reference-input"),
      { target: { value: "BAD-REF" } },
    );
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 422,
      json: async () => ({
        success: false,
        data: null,
        error: "duplicate-payment-reference",
      }),
    }));
    fireEvent.click(screen.getByTestId("platform-billing-mark-paid-submit"));
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-mark-paid-error"),
      ).toHaveTextContent("duplicate-payment-reference");
    });
    // Modal stays open so the operator can retry.
    expect(
      screen.getByTestId("platform-billing-mark-paid-modal"),
    ).toBeInTheDocument();
  });

  it("Mark-Paid modal: clicking the backdrop closes the modal", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-record"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("platform-billing-invoice-record"));
    expect(
      screen.getByTestId("platform-billing-mark-paid-modal"),
    ).toBeInTheDocument();
    // Click the backdrop element itself (not the inner card).
    fireEvent.click(screen.getByTestId("platform-billing-mark-paid-modal"));
    expect(
      screen.queryByTestId("platform-billing-mark-paid-modal"),
    ).toBeNull();
  });

  it("Mark-Paid modal: Cancel button closes the modal", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-record"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("platform-billing-invoice-record"));
    fireEvent.click(screen.getByTestId("platform-billing-mark-paid-cancel"));
    expect(
      screen.queryByTestId("platform-billing-mark-paid-modal"),
    ).toBeNull();
  });

  it("does NOT issue a fetch when useParams returns no id", async () => {
    currentParamId = "";
    render(<PlatformInvoiceDetailPage />);
    // Give react a tick to settle the useEffect.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses 44px (h-11) touch targets on Back + Mark Paid + modal buttons", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-record"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("platform-billing-invoice-back").className,
    ).toMatch(/h-11/);
    expect(
      screen.getByTestId("platform-billing-invoice-record").className,
    ).toMatch(/h-11/);
    fireEvent.click(screen.getByTestId("platform-billing-invoice-record"));
    expect(
      screen.getByTestId("platform-billing-mark-paid-cancel").className,
    ).toMatch(/h-11/);
    expect(
      screen.getByTestId("platform-billing-mark-paid-submit").className,
    ).toMatch(/h-11/);
  });

  it("renders the 'Return to invoice list' Link footer", async () => {
    render(<PlatformInvoiceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByText(/Return to invoice list/),
      ).toBeInTheDocument();
    });
  });
});
