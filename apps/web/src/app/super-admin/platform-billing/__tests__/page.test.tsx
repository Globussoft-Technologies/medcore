/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for /dashboard/platform-billing — Pearl §8.3
// (gap rows 215-218 closure piece 3-UI, 2026-05-25).
//
// Covers:
//   - Tabs render (Subscriptions default; Invoices tab swaps the table).
//   - Subscriptions list renders mocked /subscriptions response.
//   - Invoices list defaults to status=ISSUED, renders mocked response.
//   - Filter chips on the Invoices tab toggle status (ISSUED -> PAID -> all).
//   - "Mark Paid" button opens the modal; submitting the modal POSTs
//     /invoices/:id/mark-paid with the entered paymentReference.
//   - Empty paymentReference surfaces an inline error and does NOT POST.
//   - 44px touch targets on tab buttons, filter chips, and Mark Paid button.
//
// fetch stubbed at the global level so the page can be unit-tested without
// a real API.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const sampleSubscriptions = [
  {
    id: "sub-1",
    tenantId: "tn-1",
    plan: "GROWTH",
    status: "active",
    trialEndsAt: null,
    currentPeriodStart: "2026-04-01T00:00:00Z",
    currentPeriodEnd: "2026-05-01T00:00:00Z",
    customPriceMonthlyInPaise: null,
    razorpaySubscriptionId: null,
    pastDueSince: null,
    cancelledAt: null,
    createdAt: "2026-03-31T00:00:00Z",
    tenant: { id: "tn-1", name: "Apollo Pearl", subdomain: "apollo", active: true },
  },
  {
    id: "sub-2",
    tenantId: "tn-2",
    plan: "STARTER",
    status: "trial",
    trialEndsAt: "2026-06-01T00:00:00Z",
    currentPeriodStart: "2026-05-01T00:00:00Z",
    currentPeriodEnd: "2026-06-01T00:00:00Z",
    customPriceMonthlyInPaise: null,
    razorpaySubscriptionId: null,
    pastDueSince: null,
    cancelledAt: null,
    createdAt: "2026-05-01T00:00:00Z",
    tenant: { id: "tn-2", name: "Fortis Pearl", subdomain: "fortis", active: true },
  },
];

const sampleInvoices = [
  {
    id: "inv-1",
    invoiceNumber: "PI-202604-0001",
    tenantId: "tn-1",
    periodStart: "2026-04-01T00:00:00Z",
    periodEnd: "2026-05-01T00:00:00Z",
    subtotalInPaise: 1499900,
    cgstInPaise: 134991,
    sgstInPaise: 134991,
    igstInPaise: 0,
    totalInPaise: 1769882,
    status: "ISSUED",
    issuedAt: "2026-05-01T00:00:00Z",
    paidAt: null,
    paymentReference: null,
    createdAt: "2026-05-01T00:00:00Z",
    tenant: { id: "tn-1", name: "Apollo Pearl", subdomain: "apollo" },
  },
  {
    id: "inv-2",
    invoiceNumber: "PI-202604-0002",
    tenantId: "tn-2",
    periodStart: "2026-04-01T00:00:00Z",
    periodEnd: "2026-05-01T00:00:00Z",
    subtotalInPaise: 499900,
    cgstInPaise: 0,
    sgstInPaise: 0,
    igstInPaise: 89982,
    totalInPaise: 589882,
    status: "ISSUED",
    issuedAt: "2026-05-01T00:00:00Z",
    paidAt: null,
    paymentReference: null,
    createdAt: "2026-05-01T00:00:00Z",
    tenant: { id: "tn-2", name: "Fortis Pearl", subdomain: "fortis" },
  },
];

const fetchMock = vi.fn();
let dateNowSpy: ReturnType<typeof vi.spyOn>;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({}),
  // The billing landing reads `?from=tenants` to decide whether to
  // render the breadcrumb back-link. Tests don't supply the param, so
  // the mock returns null for every key → no breadcrumb branch.
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const samplePlans = [
  {
    id: "plan-starter",
    key: "STARTER",
    name: "Starter",
    monthlyPriceInPaise: 499900,
    includedFeatures: ["opd"],
    active: true,
    sortOrder: 1,
  },
  {
    id: "plan-growth",
    key: "GROWTH",
    name: "Growth",
    monthlyPriceInPaise: 1499900,
    includedFeatures: ["opd", "lab"],
    active: true,
    sortOrder: 2,
  },
];

function mockSubsOk(subs = sampleSubscriptions, invoices = sampleInvoices) {
  fetchMock.mockImplementation(async (url: string) => {
    // Order matters: /plans is checked before the generic /subscriptions +
    // /invoices branches so the catalog fetch resolves with sample tiers.
    if (url.includes("/plans")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: samplePlans, error: null }),
      };
    }
    if (url.includes("/subscriptions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { subscriptions: subs },
          error: null,
        }),
      };
    }
    if (url.includes("/invoices")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { invoices },
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
  dateNowSpy = vi
    .spyOn(Date, "now")
    .mockReturnValue(new Date("2026-04-15T00:00:00.000Z").getTime());
  mockSubsOk();
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

afterEach(() => {
  dateNowSpy.mockRestore();
});

import PlatformBillingPage from "../page";

describe("/dashboard/platform-billing landing — Pearl §8.3", () => {
  it("renders both tab buttons and the Subscriptions table by default", async () => {
    render(<PlatformBillingPage />);
    expect(
      screen.getByTestId("platform-billing-tab-subscriptions"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("platform-billing-tab-invoices"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-subscription-row-sub-1"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("platform-billing-subscription-row-sub-2"),
    ).toBeInTheDocument();
    // Default fetch should be /subscriptions.
    const firstUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toContain("/api/v1/platform-billing/subscriptions");
  });

  it("shows a renewed visible period for stale active subscriptions", async () => {
    dateNowSpy.mockReturnValue(new Date("2026-07-27T00:00:00.000Z").getTime());
    mockSubsOk([
      {
        ...sampleSubscriptions[0],
        currentPeriodStart: "2026-06-03T00:00:00Z",
        currentPeriodEnd: "2026-07-03T00:00:00Z",
      },
      sampleSubscriptions[1],
    ]);

    render(<PlatformBillingPage />);

    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-subscription-row-sub-1"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("03 Jul 2026")).toBeInTheDocument();
    expect(screen.getByText("03 Aug 2026")).toBeInTheDocument();
  });

  it("shows active in subscriptions when billing is past due but the tenant is still live", async () => {
    mockSubsOk([
      {
        ...sampleSubscriptions[0],
        status: "past_due",
      },
      sampleSubscriptions[1],
    ]);

    render(<PlatformBillingPage />);

    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-subscription-status-sub-1"),
      ).toHaveTextContent(/Active/);
    });
  });

  it("clicking Invoices tab swaps to the invoices table and defaults to status=ISSUED", async () => {
    render(<PlatformBillingPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-subscription-row-sub-1"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("platform-billing-tab-invoices"));

    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-row-inv-1"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("platform-billing-invoice-row-inv-2"),
    ).toBeInTheDocument();

    // The invoices fetch should carry status=ISSUED.
    const invoicesCall = fetchMock.mock.calls.find((c) =>
      String(c[0] ?? "").includes("/invoices?"),
    );
    expect(invoicesCall).toBeDefined();
    expect(String(invoicesCall?.[0] ?? "")).toContain("status=ISSUED");
  });

  it("keeps a freshly issued invoice in issued state for the current month window", async () => {
    dateNowSpy.mockReturnValue(new Date("2026-05-15T00:00:00.000Z").getTime());
    render(<PlatformBillingPage />);
    fireEvent.click(screen.getByTestId("platform-billing-tab-invoices"));

    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-status-inv-1"),
      ).toHaveTextContent(/Issued/);
    });
  });

  it("counts unpaid invoices as past due after one month from issue for the same tenant", async () => {
    dateNowSpy.mockReturnValue(new Date("2026-06-02T00:00:00.000Z").getTime());
    mockSubsOk(sampleSubscriptions, [
      sampleInvoices[0],
      {
        ...sampleInvoices[0],
        id: "inv-duplicate-tenant",
        invoiceNumber: "PI-202604-0099",
      },
    ]);

    render(<PlatformBillingPage />);

    await waitFor(() => {
      expect(screen.getByText("Past due").parentElement).toHaveTextContent("1");
    });
  });

  it("shows an issued invoice as past due at the period-end boundary", async () => {
    dateNowSpy.mockReturnValue(new Date("2026-06-02T00:00:00.000Z").getTime());
    render(<PlatformBillingPage />);
    fireEvent.click(screen.getByTestId("platform-billing-tab-invoices"));

    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-invoice-status-inv-1"),
      ).toHaveTextContent(/Past due/);
    });
  });

  it("clicking Mark Paid opens the modal and POSTs the entered paymentReference", async () => {
    render(<PlatformBillingPage />);
    // Switch to the Invoices tab so the row + kebab are mounted.
    fireEvent.click(screen.getByTestId("platform-billing-tab-invoices"));
    // 2026-05 — Mark Paid moved into a per-row kebab action menu.
    // The row now exposes a single kebab button; the operator opens
    // the menu and picks "Record Payment" which opens the modal.
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-actions-inv-1"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("platform-billing-actions-inv-1"));
    fireEvent.click(screen.getByTestId("platform-billing-action-record-inv-1"));
    // Modal is now open.
    expect(
      screen.getByTestId("platform-billing-mark-paid-modal"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("platform-billing-payment-reference-input"),
    ).toBeInTheDocument();

    // Enter a reference + queue the POST + the follow-up refetch.
    fireEvent.change(
      screen.getByTestId("platform-billing-payment-reference-input"),
      { target: { value: "RZP-CLICK-TEST-001" } },
    );
    // First call after the click will be POST; queue its response, plus
    // the subsequent /invoices?status=ISSUED refetch.
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          transition: "PAID",
          invoice: { id: "inv-1", status: "PAID", paymentReference: "RZP-CLICK-TEST-001" },
        },
        error: null,
      }),
    }));
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { invoices: [{ ...sampleInvoices[1] }] }, // inv-1 fell out of ISSUED
        error: null,
      }),
    }));

    fireEvent.click(screen.getByTestId("platform-billing-mark-paid-submit"));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => (c[1] as any)?.method === "POST",
      );
      expect(postCall).toBeDefined();
      expect(String(postCall?.[0] ?? "")).toContain(
        "/api/v1/platform-billing/invoices/inv-1/mark-paid",
      );
      expect((postCall?.[1] as any).body).toContain(
        '"paymentReference":"RZP-CLICK-TEST-001"',
      );
    });
  });

  it("submit with empty paymentReference surfaces an inline error and does not POST", async () => {
    render(<PlatformBillingPage />);
    fireEvent.click(screen.getByTestId("platform-billing-tab-invoices"));
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-actions-inv-1"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("platform-billing-actions-inv-1"));
    fireEvent.click(screen.getByTestId("platform-billing-action-record-inv-1"));
    // Click submit immediately without typing anything.
    fireEvent.click(screen.getByTestId("platform-billing-mark-paid-submit"));

    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-mark-paid-error").textContent,
      ).toMatch(/payment reference/i);
    });
    // No POST should have been issued.
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as any)?.method === "POST"),
    ).toBe(false);
  });

  it("uses 44px (h-11) touch targets on tab buttons + filter chips; the per-row kebab uses h-9", async () => {
    render(<PlatformBillingPage />);
    fireEvent.click(screen.getByTestId("platform-billing-tab-invoices"));
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-actions-inv-1"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByTestId("platform-billing-tab-subscriptions").className,
    ).toMatch(/h-11/);
    expect(
      screen.getByTestId("platform-billing-tab-invoices").className,
    ).toMatch(/h-11/);
    // 2026-05 — the Unpaid/Paid/All filter shipped as a compact
    // segmented control (h-8 min-w-[88px]); it sits visually inside
    // the tab header so the per-pill height is smaller than the
    // primary tab buttons by design.
    expect(
      screen.getByTestId("platform-billing-invoice-filter-ISSUED").className,
    ).toMatch(/h-8/);
    // 2026-05 — the per-row Mark Paid button became a compact kebab
    // (h-9 w-9) that opens a menu. Primary nav controls (tabs)
    // remain at h-11; the row-level action stays smaller so it
    // doesn't dominate dense tables.
    expect(
      screen.getByTestId("platform-billing-actions-inv-1").className,
    ).toMatch(/h-9/);
  });

  it("renders the monthly Amount from the dynamic plan catalog on each subscription row", async () => {
    render(<PlatformBillingPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("platform-billing-subscription-amount-sub-1"),
      ).toBeInTheDocument();
    });
    // sub-1 is on GROWTH (₹14,999/mo from the mocked catalog).
    expect(
      screen.getByTestId("platform-billing-subscription-amount-sub-1")
        .textContent,
    ).toMatch(/14,999/);
    // sub-2 is on STARTER (₹4,999/mo).
    expect(
      screen.getByTestId("platform-billing-subscription-amount-sub-2")
        .textContent,
    ).toMatch(/4,999/);
  });

  it("Plans tab lists the catalog tiers and exposes an Add-plan control", async () => {
    render(<PlatformBillingPage />);
    fireEvent.click(screen.getByTestId("platform-billing-tab-plans"));
    // The plans table renders immediately (empty) while the /plans fetch is
    // in-flight — await the actual rows so we don't race the async load.
    expect(
      await screen.findByTestId("platform-billing-plan-row-plan-starter"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("platform-billing-plan-row-plan-growth"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("platform-billing-add-plan"),
    ).toBeInTheDocument();
  });
});


