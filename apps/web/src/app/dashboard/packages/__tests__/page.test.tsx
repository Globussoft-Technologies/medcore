/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PackagesPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/packages/page.tsx, the health
 *     packages catalog + purchase ledger. Endpoints the page hits:
 *       GET    /packages?category=                   (catalog list w/ filter)
 *       GET    /packages/purchases?active=           (purchase ledger)
 *       GET    /patients?search=&limit=10            (sell-modal patient search)
 *       POST   /packages                             (admin: create package)
 *       POST   /packages/purchase                    (admin/reception: sell)
 *
 *   - Behaviours covered (the page has no client-side VIEW_ALLOWED gate per
 *     CLAUDE.md gotcha #7 — security is API-side; we exercise role-projection
 *     branches for the two header buttons only):
 *       1. Loading branch — both tabs' skeletons render while pending.
 *       2. Happy fetch — package cards render with name, category chip,
 *          price/discountPrice branch, services chips, validity, purchase
 *          count.
 *       3. Empty-list branch — "No packages found" and "No purchases found".
 *       4. Error-path resilience — both GET rejections still settle into
 *          empty branches.
 *       5. Category filter — refetches /packages?category=<X>.
 *       6. Purchases tab — initial GET, "All" filter, "Active" filter
 *          (?active=true querystring), "Expired" filter (client-side filter
 *          on expiresAt).
 *       7. Purchase row — status badge branches: active / expired / used.
 *       8. Role gating for header buttons:
 *          - ADMIN: both "Sell Package" + "Add Package" visible.
 *          - RECEPTION: "Sell Package" only.
 *          - DOCTOR: neither button (no canSell, no canAdminPkg).
 *       9. Add Package modal:
 *          - Opens via header button.
 *          - Validates blank name (inline error).
 *          - Validates blank services.
 *          - Validates price < 1.
 *          - Validates discount price malformed.
 *          - Validates validity < 1.
 *          - Happy POST /packages with normalized body, optional fields
 *            included only when present, closes + reloads.
 *          - POST rejection surfaces error message inline.
 *          - Cancel + X close without POST.
 *      10. Sell Package modal:
 *          - Opens via header button (RECEPTION can open too).
 *          - Validates "Select a package".
 *          - Validates "Select a patient".
 *          - Validates amount < 0.01.
 *          - Patient search short-circuits at <2 chars.
 *          - Patient search debounces 300ms then fires /patients?search=.
 *          - Patient search rejection swallowed (list stays empty).
 *          - Picking a patient hides the input; "Change" clears selection.
 *          - Picking a package auto-fills the amount with discountPrice
 *            (falls back to price when no discount).
 *          - Happy POST /packages/purchase, then onSold switches tab to
 *            purchases.
 *          - POST rejection surfaces error inline.
 *          - Cancel + X close without POST.
 *
 *   - Mocks: @/lib/api, @/lib/store, next/navigation, @/components/Skeleton.
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

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/packages",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: () => <div data-testid="skeleton-card-stub" />,
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-table-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import PackagesPage from "../page";

type PkgRecord = {
  id: string;
  name: string;
  description?: string | null;
  services: string;
  price: number;
  discountPrice?: number | null;
  validityDays: number;
  category?: string | null;
  isActive: boolean;
  _count?: { purchases: number };
};

type PkgPurchase = {
  id: string;
  purchaseNumber: string;
  amountPaid: number;
  purchasedAt: string;
  expiresAt: string;
  isFullyUsed: boolean;
  package: { name: string; price: number; discountPrice?: number | null };
  patient: { user: { name: string; phone: string } };
};

type PatientRecord = {
  id: string;
  mrNumber: string;
  user: { name: string; phone: string };
};

function pkgFixture(overrides: Partial<PkgRecord> = {}): PkgRecord {
  return {
    id: "pkg-1",
    name: "Master Health Checkup",
    description: "Comprehensive checkup",
    services: "CBC, LFT, KFT, Consultation",
    price: 5000,
    discountPrice: 4000,
    validityDays: 365,
    category: "Master Health Checkup",
    isActive: true,
    _count: { purchases: 12 },
    ...overrides,
  };
}

// +48h to avoid IST/UTC midnight traps per CLAUDE.md guidance.
const FUTURE_ISO = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
const PAST_ISO = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

function purchaseFixture(overrides: Partial<PkgPurchase> = {}): PkgPurchase {
  return {
    id: "pu-1",
    purchaseNumber: "PKG-2026-0001",
    amountPaid: 4000,
    purchasedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    expiresAt: FUTURE_ISO,
    isFullyUsed: false,
    package: { name: "Master Health Checkup", price: 5000, discountPrice: 4000 },
    patient: { user: { name: "Asha Kumar", phone: "9000011111" } },
    ...overrides,
  };
}

function patientFixture(overrides: Partial<PatientRecord> = {}): PatientRecord {
  return {
    id: "pat-1",
    mrNumber: "MR-001",
    user: { name: "Asha Kumar", phone: "9000011111" },
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

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
    isLoading: false,
  });
}

describe("PackagesPage (health packages catalog + purchase ledger — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    authMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading skeleton while the initial /packages fetch is pending", () => {
    apiMock.get.mockImplementation(() => new Promise(() => {})); // never resolves

    render(<PackagesPage />);

    expect(screen.getByTestId("packages-loading")).toBeInTheDocument();
    expect(screen.getAllByTestId("skeleton-card-stub").length).toBe(3);
  });

  it("renders one card per package with name, category chip, discount price strikethrough branch, services chips, validity, and purchase count", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        pkgFixture({ id: "pkg-1", name: "Master Health Checkup" }),
        pkgFixture({
          id: "pkg-2",
          name: "Diabetes Package",
          description: null,
          discountPrice: null,
          category: null,
          price: 2500,
          services: "HbA1c, Fasting Sugar, PP",
          _count: undefined,
        }),
      ],
    });

    render(<PackagesPage />);

    // Both names also appear as <option> text inside the category <select>.
    // Locate the card-side <h3> heading text specifically.
    await waitFor(() =>
      expect(
        screen.getAllByRole("heading", { name: "Master Health Checkup" }),
      ).toHaveLength(1),
    );
    expect(
      screen.getAllByRole("heading", { name: "Diabetes Package" }),
    ).toHaveLength(1);

    // Querystring contract — no category filter -> bare URL.
    expect(apiMock.get).toHaveBeenCalledWith("/packages");

    // Discount branch: pkg-1 has discountPrice -> strike-through 5000 + green 4000.
    expect(screen.getByText("Rs. 5000")).toBeInTheDocument();
    expect(screen.getByText("Rs. 4000")).toBeInTheDocument();
    // Non-discount branch: pkg-2 has only price -> "Rs. 2500".
    expect(screen.getByText("Rs. 2500")).toBeInTheDocument();

    // Services chips render trimmed for both rows.
    expect(screen.getByText("CBC")).toBeInTheDocument();
    expect(screen.getByText("HbA1c")).toBeInTheDocument();
    expect(screen.getByText("Consultation")).toBeInTheDocument();

    // Validity + sold count — multiple cards, so check at least one of each.
    expect(screen.getAllByText(/365 days validity/i).length).toBe(2);
    // pkg-1 had 12 sold; pkg-2 had no _count -> "0 sold".
    expect(screen.getByText(/12 sold/i)).toBeInTheDocument();
    expect(screen.getByText(/0 sold/i)).toBeInTheDocument();
  });

  it("renders 'No packages found' when the list comes back empty", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);

    expect(await screen.findByText(/No packages found/i)).toBeInTheDocument();
  });

  it("swallows /packages fetch errors and settles into the empty branch", async () => {
    apiMock.get.mockRejectedValue(new Error("boom"));

    render(<PackagesPage />);

    expect(await screen.findByText(/No packages found/i)).toBeInTheDocument();
  });

  it("refetches with ?category=<X> URL-encoded when the category select changes", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    // The header has only one <select> while modals are closed — the category filter.
    const categorySelect = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(categorySelect, { target: { value: "Diabetes Package" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        `/packages?category=${encodeURIComponent("Diabetes Package")}`,
      ),
    );
  });

  it("switches to the Purchases tab and renders the purchase table with status badges (active branch)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/packages/purchases")) {
        return Promise.resolve({ data: [purchaseFixture()] });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Purchases/i }));

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/packages/purchases"));
    await screen.findByText("PKG-2026-0001");
    expect(screen.getByText("Asha Kumar")).toBeInTheDocument();
    expect(screen.getByText("Master Health Checkup")).toBeInTheDocument();
    expect(screen.getByText("Rs. 4000.00")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("renders the 'used' status branch when isFullyUsed=true", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/packages/purchases")) {
        return Promise.resolve({
          data: [purchaseFixture({ id: "pu-used", isFullyUsed: true })],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Purchases/i }));
    await screen.findByText("PKG-2026-0001");

    expect(screen.getByText("used")).toBeInTheDocument();
  });

  it("renders 'No purchases found' when the ledger is empty + skeleton during load", async () => {
    let resolveLoad: (val: { data: PkgPurchase[] }) => void = () => {};
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/packages/purchases")) {
        return new Promise((res) => {
          resolveLoad = res as (val: { data: PkgPurchase[] }) => void;
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Purchases/i }));

    // Skeleton render branch.
    expect(await screen.findByTestId("package-purchases-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-table-stub")).toBeInTheDocument();

    resolveLoad({ data: [] });
    expect(await screen.findByText(/No purchases found/i)).toBeInTheDocument();
  });

  it("swallows /packages/purchases fetch errors and settles into the empty branch", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/packages/purchases")) {
        return Promise.reject(new Error("ledger down"));
      }
      return Promise.resolve({ data: [] });
    });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Purchases/i }));

    expect(await screen.findByText(/No purchases found/i)).toBeInTheDocument();
  });

  it("active filter sends ?active=true and expired filter client-filters to expired rows only", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/packages/purchases")) {
        return Promise.resolve({
          data: [
            purchaseFixture({ id: "pu-active", expiresAt: FUTURE_ISO }),
            purchaseFixture({
              id: "pu-expired",
              purchaseNumber: "PKG-2026-0002",
              expiresAt: PAST_ISO,
            }),
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Purchases/i }));
    await screen.findByText("PKG-2026-0001");

    // Active filter -> querystring ?active=true.
    fireEvent.click(screen.getByRole("button", { name: /^Active$/i }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/packages/purchases?active=true"),
    );

    // Expired filter — re-fetches bare URL (no ?active=true) then client-filters
    // to only rows whose expiresAt is in the past.
    fireEvent.click(screen.getByRole("button", { name: /^Expired$/i }));
    await waitFor(() => {
      expect(screen.queryByText("PKG-2026-0001")).not.toBeInTheDocument();
    });
    expect(screen.getByText("PKG-2026-0002")).toBeInTheDocument();
    expect(screen.getByText("expired")).toBeInTheDocument();
  });

  it("ADMIN sees both 'Sell Package' and 'Add Package' header buttons", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    expect(screen.getByRole("button", { name: /Sell Package/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add Package/i })).toBeInTheDocument();
  });

  it("RECEPTION sees 'Sell Package' but NOT 'Add Package' (canAdminPkg=false)", async () => {
    asReception();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    expect(screen.getByRole("button", { name: /Sell Package/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Add Package/i }),
    ).not.toBeInTheDocument();
  });

  it("DOCTOR sees neither 'Sell Package' nor 'Add Package' (canSell=false, canAdminPkg=false)", async () => {
    asDoctor();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    expect(
      screen.queryByRole("button", { name: /Sell Package/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Add Package/i }),
    ).not.toBeInTheDocument();
  });

  // ---- Add Package modal ----

  it("Add Package modal — rejects blank Name with inline error and never POSTs", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Package/i }));
    fireEvent.click(screen.getByRole("button", { name: /Create Package/i }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Package modal — rejects blank Services with inline error", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Package/i }));
    fireEvent.change(screen.getByLabelText(/^Name \*$/i), {
      target: { value: "New Pkg" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Package/i }));

    expect(await screen.findByText("Services are required")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Package modal — rejects price < 1 (NaN/zero) with inline error", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Package/i }));
    fireEvent.change(screen.getByLabelText(/^Name \*$/i), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByLabelText(/^Services .* \*$/i), {
      target: { value: "CBC" },
    });
    // Leave Price blank -> parseFloat("") -> NaN -> rejected.
    fireEvent.click(screen.getByRole("button", { name: /Create Package/i }));

    expect(await screen.findByText("Price must be at least 1")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Package modal — rejects negative discount price with inline error", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Package/i }));
    fireEvent.change(screen.getByLabelText(/^Name \*$/i), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByLabelText(/^Services .* \*$/i), {
      target: { value: "CBC" },
    });
    fireEvent.change(screen.getByLabelText(/^Price \*$/i), {
      target: { value: "100" },
    });
    // Negative values parse cleanly (jsdom keeps the string) and trip the
    // `discountNum < 0` branch of the source's guard.
    fireEvent.change(screen.getByLabelText(/^Discount Price$/i), {
      target: { value: "-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Package/i }));

    expect(
      await screen.findByText("Discount price must be 0 or greater"),
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Package modal — rejects validity < 1 with inline error", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Package/i }));
    fireEvent.change(screen.getByLabelText(/^Name \*$/i), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByLabelText(/^Services .* \*$/i), {
      target: { value: "CBC" },
    });
    fireEvent.change(screen.getByLabelText(/^Price \*$/i), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText(/^Validity \(days\)$/i), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Package/i }));

    expect(
      await screen.findByText("Validity must be at least 1 day"),
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Package modal — happy POST /packages with normalized body and optional fields included only when present, then closes + reloads", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({ data: { id: "pkg-new" } });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Package/i }));
    fireEvent.change(screen.getByLabelText(/^Name \*$/i), {
      target: { value: "Health Plus" },
    });
    fireEvent.change(screen.getByLabelText(/^Category$/i), {
      target: { value: "Preventive" },
    });
    fireEvent.change(screen.getByLabelText(/^Description$/i), {
      target: { value: "Plus tier" },
    });
    fireEvent.change(screen.getByLabelText(/^Services .* \*$/i), {
      target: { value: "CBC, LFT" },
    });
    fireEvent.change(screen.getByLabelText(/^Price \*$/i), {
      target: { value: "3500" },
    });
    fireEvent.change(screen.getByLabelText(/^Discount Price$/i), {
      target: { value: "3000" },
    });
    fireEvent.change(screen.getByLabelText(/^Validity \(days\)$/i), {
      target: { value: "180" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Create Package/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/packages",
        expect.objectContaining({
          name: "Health Plus",
          services: "CBC, LFT",
          price: 3500,
          discountPrice: 3000,
          validityDays: 180,
          description: "Plus tier",
          category: "Preventive",
        }),
      ),
    );
    // Modal closes -> heading gone.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Add Health Package/i }),
      ).not.toBeInTheDocument(),
    );
    // Reload fired — /packages was hit at least twice (initial + after save).
    const calls = apiMock.get.mock.calls.filter(
      (c: any) => c[0] === "/packages",
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("Add Package modal — POST rejection surfaces the error message inline (modal stays open)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockRejectedValue(new Error("server is down"));

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Package/i }));
    fireEvent.change(screen.getByLabelText(/^Name \*$/i), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByLabelText(/^Services .* \*$/i), {
      target: { value: "CBC" },
    });
    fireEvent.change(screen.getByLabelText(/^Price \*$/i), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Package/i }));

    expect(await screen.findByText("server is down")).toBeInTheDocument();
    // Modal still open.
    expect(
      screen.getByRole("heading", { name: /Add Health Package/i }),
    ).toBeInTheDocument();
  });

  it("Add Package modal — Cancel button closes without POST", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Package/i }));
    expect(
      screen.getByRole("heading", { name: /Add Health Package/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Add Health Package/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Package modal — X icon button closes without POST", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PackagesPage />);
    await screen.findByText(/No packages found/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Package/i }));
    const modalHeader = screen
      .getByRole("heading", { name: /Add Health Package/i })
      .parentElement as HTMLElement;
    // The X close button is the second button in the header row (the only
    // button there, actually — Add was clicked from outside).
    const closeBtn = within(modalHeader).getByRole("button");
    fireEvent.click(closeBtn);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Add Health Package/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ---- Sell Package modal ----

  it("Sell Package modal — validates 'Select a package' first", async () => {
    apiMock.get.mockResolvedValue({ data: [pkgFixture()] });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));
    // The Complete Purchase button is disabled until a patient is picked.
    // Force-submit via the form's native submit — find it via a known control.
    const form = (screen.getByLabelText(/^Package \*$/i) as HTMLElement).closest(
      "form",
    ) as HTMLFormElement;
    expect(form).toBeTruthy();
    fireEvent.submit(form);

    // "Select a package" matches both the <option> placeholder AND the error
    // banner. Wait for the error banner specifically by class.
    await waitFor(() => {
      const errors = screen.getAllByText("Select a package");
      expect(errors.some((el) => el.className.includes("bg-red-50"))).toBe(true);
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Sell Package modal — validates 'Select a patient' after package is chosen", async () => {
    apiMock.get.mockResolvedValue({ data: [pkgFixture()] });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));
    fireEvent.change(screen.getByLabelText(/^Package \*$/i), {
      target: { value: "pkg-1" },
    });

    const form = (screen.getByLabelText(/^Package \*$/i) as HTMLElement).closest(
      "form",
    ) as HTMLFormElement;
    expect(form).toBeTruthy();
    fireEvent.submit(form);

    expect(await screen.findByText("Select a patient")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Sell Package modal — patient search short-circuits at <2 chars (no API call)", async () => {
    apiMock.get.mockResolvedValue({ data: [pkgFixture()] });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));

    const searchInput = screen.getByPlaceholderText(/Search by name/i);
    fireEvent.change(searchInput, { target: { value: "a" } });

    // Wait > 300ms debounce.
    await new Promise((r) => setTimeout(r, 350));
    expect(
      apiMock.get.mock.calls.find((c: any) => String(c[0]).startsWith("/patients")),
    ).toBeUndefined();
  });

  it("Sell Package modal — patient search debounces 300ms then fires /patients?search=&limit=10 and renders results", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({ data: [patientFixture()] });
      }
      return Promise.resolve({ data: [pkgFixture()] });
    });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));

    const searchInput = screen.getByPlaceholderText(/Search by name/i);
    fireEvent.change(searchInput, { target: { value: "asha" } });

    await waitFor(
      () =>
        expect(apiMock.get).toHaveBeenCalledWith(
          `/patients?search=${encodeURIComponent("asha")}&limit=10`,
        ),
      { timeout: 1500 },
    );

    // Result list — patient name shows once in the dropdown.
    await screen.findByText("MR-001 • 9000011111");
  });

  it("Sell Package modal — patient search rejection swallowed (list stays empty)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.reject(new Error("patients down"));
      }
      return Promise.resolve({ data: [pkgFixture()] });
    });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));

    const searchInput = screen.getByPlaceholderText(/Search by name/i);
    fireEvent.change(searchInput, { target: { value: "asha" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        `/patients?search=${encodeURIComponent("asha")}&limit=10`,
      ),
    );
    // No "MR-" row appears.
    expect(screen.queryByText(/MR-/)).not.toBeInTheDocument();
  });

  it("Sell Package modal — picking a patient hides the input + Change button clears the selection", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({ data: [patientFixture()] });
      }
      return Promise.resolve({ data: [pkgFixture()] });
    });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));

    fireEvent.change(screen.getByPlaceholderText(/Search by name/i), {
      target: { value: "asha" },
    });
    const row = await screen.findByText("MR-001 • 9000011111");
    fireEvent.click(row);

    // Input is replaced by the picked-patient panel + Change button.
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(/Search by name/i),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Change/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Change/i }));
    // Input is back.
    expect(screen.getByPlaceholderText(/Search by name/i)).toBeInTheDocument();
  });

  it("Sell Package modal — picking a package auto-fills amount with discountPrice when present", async () => {
    apiMock.get.mockResolvedValue({ data: [pkgFixture()] });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));
    fireEvent.change(screen.getByLabelText(/^Package \*$/i), {
      target: { value: "pkg-1" },
    });

    await waitFor(() => {
      const amt = screen.getByLabelText(/^Amount Paid \*$/i) as HTMLInputElement;
      expect(amt.value).toBe("4000");
    });
    expect(
      screen.getByText(/Valid for 365 days from today/i),
    ).toBeInTheDocument();
  });

  it("Sell Package modal — picking a package without discountPrice falls back to price", async () => {
    apiMock.get.mockResolvedValue({
      data: [pkgFixture({ id: "pkg-1", discountPrice: null, price: 2500 })],
    });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));
    fireEvent.change(screen.getByLabelText(/^Package \*$/i), {
      target: { value: "pkg-1" },
    });

    await waitFor(() => {
      const amt = screen.getByLabelText(/^Amount Paid \*$/i) as HTMLInputElement;
      expect(amt.value).toBe("2500");
    });
  });

  it("Sell Package modal — rejects amount < 0.01 with inline error", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({ data: [patientFixture()] });
      }
      return Promise.resolve({ data: [pkgFixture()] });
    });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));
    fireEvent.change(screen.getByLabelText(/^Package \*$/i), {
      target: { value: "pkg-1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Search by name/i), {
      target: { value: "asha" },
    });
    fireEvent.click(await screen.findByText("MR-001 • 9000011111"));

    // Wait for the package auto-fill to land...
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/^Amount Paid \*$/i) as HTMLInputElement).value,
      ).toBe("4000");
    });
    // ...then zero it out.
    fireEvent.change(screen.getByLabelText(/^Amount Paid \*$/i), {
      target: { value: "0" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Complete Purchase/i }));

    expect(
      await screen.findByText("Amount paid must be at least 0.01"),
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Sell Package modal — happy POST /packages/purchase, then onSold switches to Purchases tab", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({ data: [patientFixture()] });
      }
      if (url.startsWith("/packages/purchases")) {
        return Promise.resolve({ data: [purchaseFixture()] });
      }
      return Promise.resolve({ data: [pkgFixture()] });
    });
    apiMock.post.mockResolvedValue({ data: { id: "pu-new" } });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));
    fireEvent.change(screen.getByLabelText(/^Package \*$/i), {
      target: { value: "pkg-1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Search by name/i), {
      target: { value: "asha" },
    });
    fireEvent.click(await screen.findByText("MR-001 • 9000011111"));

    fireEvent.click(screen.getByRole("button", { name: /Complete Purchase/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/packages/purchase", {
        packageId: "pkg-1",
        patientId: "pat-1",
        amountPaid: 4000,
      }),
    );
    // Switched to Purchases tab — purchase number renders.
    await screen.findByText("PKG-2026-0001");
  });

  it("Sell Package modal — POST rejection surfaces the error message inline (modal stays open)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({ data: [patientFixture()] });
      }
      return Promise.resolve({ data: [pkgFixture()] });
    });
    apiMock.post.mockRejectedValue(new Error("payment failed"));

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));
    fireEvent.change(screen.getByLabelText(/^Package \*$/i), {
      target: { value: "pkg-1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Search by name/i), {
      target: { value: "asha" },
    });
    fireEvent.click(await screen.findByText("MR-001 • 9000011111"));

    fireEvent.click(screen.getByRole("button", { name: /Complete Purchase/i }));

    expect(await screen.findByText("payment failed")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /^Sell Package$/i }),
    ).toBeInTheDocument();
  });

  it("Sell Package modal — Cancel button closes without POST", async () => {
    apiMock.get.mockResolvedValue({ data: [pkgFixture()] });

    render(<PackagesPage />);
    await screen.findByText("Master Health Checkup");

    fireEvent.click(screen.getByRole("button", { name: /Sell Package/i }));
    expect(
      screen.getByRole("heading", { name: /^Sell Package$/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Sell Package$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Sell Package modal — non-string services field on a fixture doesn't crash the catalog (defensive split branch)", async () => {
    // Even though typing says string, runtime defends with `typeof === "string"`.
    apiMock.get.mockResolvedValue({
      data: [pkgFixture({ services: null as unknown as string })],
    });

    render(<PackagesPage />);
    // Card still renders with the package name; the defensive `?? ""` path
    // simply yields zero chips.
    await screen.findByText("Master Health Checkup");
  });
});
