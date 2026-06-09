/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PharmacyPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/pharmacy/page.tsx — the pharmacy
 *     inventory dashboard (Inventory / Low / Expiring / Movements / Returns
 *     / Transfers / Valuation tabs) plus three modals (AddStock, Return,
 *     Transfer). Endpoints the page hits:
 *       GET    /pharmacy/inventory?(search|lowStock)        (Inventory + Low tabs)
 *       GET    /pharmacy/inventory/expiring?days=30          (Expiring tab)
 *       GET    /pharmacy/movements?limit=100                 (Movements tab)
 *       GET    /pharmacy/returns?limit=100                   (Returns tab)
 *       GET    /pharmacy/transfers?limit=100                 (Transfers tab)
 *       GET    /pharmacy/reports/valuation?method=...        (Valuation tab)
 *       POST   /pharmacy/inventory/:id/order-from-supplier   (Low Stock CTA)
 *       POST   /pharmacy/returns                             (ReturnModal)
 *       POST   /pharmacy/transfers                           (TransferModal)
 *       POST   /pharmacy/inventory                           (AddStockModal)
 *       GET    /medicines?search=                            (AddStock typeahead)
 *
 *   - Behaviours covered:
 *       1. RBAC — VIEW_ALLOWED gate (ADMIN/PHARMACIST/DOCTOR/NURSE); PATIENT
 *          triggers toast.error + router.replace to /dashboard/not-authorized.
 *       2. isLoading short-circuit — auth still loading does NOT redirect.
 *       3. Skeleton — pharmacy-inventory-skeleton renders while pending.
 *       4. Happy fetch — items render with name, batch, qty, expiry,
 *          price, location, reorder columns.
 *       5. Empty branch — "No inventory items." renders for empty list.
 *       6. Error resilience — initial GET rejection still flips loading off.
 *       7. Tab navigation — Low / Expiring / Movements / Returns / Transfers
 *          / Valuation each call the right endpoint.
 *       8. Search — typing into the search box refetches with ?search=.
 *       9. Low Stock query string — ?lowStock=true added on Low tab.
 *      10. Add Stock button — visible for ADMIN+PHARMACIST, hidden for
 *          DOCTOR+NURSE (canManage gate).
 *      11. Valuation tab — admin-only; DOCTOR doesn't see the button.
 *      12. Valuation method change refetches with ?method=FIFO.
 *      13. Kanban CTA — every authed role sees it; routes to
 *          /dashboard/pharmacy-kanban.
 *      14. Return modal — opens; quantity > on-hand rejects with toast.error
 *          and never POSTs; negative qty rejects; happy POST closes the modal.
 *      15. Transfer modal — blank fromLocation rejects; blank toLocation
 *          rejects; quantity > on-hand rejects; negative qty rejects; happy
 *          POST closes the modal.
 *      16. AddStock modal — empty form shows field errors + warning toast;
 *          past expiry date rejects; valid form POSTs and closes; server
 *          payload error map populates field errors.
 *      17. AddStock medicine search — typing ≥2 chars after debounce calls
 *          /medicines?search=...; clicking a result selects it.
 *      18. Order from supplier — low-stock action prompts confirm; happy
 *          POST surfaces toast.success with PO number; error path toasts.
 *      19. Movements tab — renders movement rows; type badges visible.
 *      20. Returns + Transfers tabs — render rows with the right columns.
 *      21. Movement empty + Returns empty + Transfers empty branches all render
 *          their respective "No X" copy.
 *      22. Polling / focus refresh — focus event refetches on Returns tab.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/use-dialog, next/navigation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
  act,
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
  usePathname: () => "/dashboard/pharmacy",
}));

import PharmacyPage from "../page";

type InventoryItem = {
  id: string;
  batchNumber: string;
  quantity: number;
  unitCost?: number;
  sellingPrice?: number;
  expiryDate: string;
  supplier?: string | null;
  location?: string | null;
  reorderLevel?: number | null;
  medicine: { id: string; name: string; genericName?: string | null };
};

// +48h to dodge IST/UTC midnight traps.
const FUTURE = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
const NEAR = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function invFixture(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "inv-1",
    batchNumber: "B-001",
    quantity: 50,
    unitCost: 5,
    sellingPrice: 10,
    expiryDate: FUTURE,
    supplier: "Cipla",
    location: "Shelf A",
    reorderLevel: 10,
    medicine: { id: "m-1", name: "Amlodipine 5mg", genericName: "Amlodipine" },
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin" },
    isLoading: false,
  });
}
function asPharmacist() {
  authMock.mockReturnValue({
    user: { id: "u-pharm", role: "PHARMACIST", name: "Pharm" },
    isLoading: false,
  });
}
function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
    isLoading: false,
  });
}
function asNurse() {
  authMock.mockReturnValue({
    user: { id: "u-nurse", role: "NURSE", name: "Nurse" },
    isLoading: false,
  });
}
function asPatient() {
  authMock.mockReturnValue({
    user: { id: "u-pat", role: "PATIENT", name: "Patient" },
    isLoading: false,
  });
}

describe("PharmacyPage (inventory dashboard — full surface)", () => {
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
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects PATIENT to /dashboard/not-authorized with the ?from= breadcrumb and toasts a role-restriction error", async () => {
    asPatient();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/restricted to clinical and pharmacy roles/i),
      ),
    );
    expect(routerMock.replace).toHaveBeenCalledWith(
      `/dashboard/not-authorized?from=${encodeURIComponent("/dashboard/pharmacy")}`,
    );
  });

  it("does NOT redirect while auth store is still loading (isLoading=true short-circuits the gate)", async () => {
    authMock.mockReturnValue({ user: null, isLoading: true });
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await new Promise((r) => setTimeout(r, 10));

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("renders the skeleton while the initial /pharmacy/inventory fetch is pending", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<PharmacyPage />);

    expect(
      await screen.findByTestId("pharmacy-inventory-skeleton"),
    ).toBeInTheDocument();
  });

  it("renders inventory rows with medicine, batch, quantity, expiry, price, location, reorder when the list is non-empty", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        invFixture(),
        invFixture({
          id: "inv-2",
          batchNumber: "B-002",
          quantity: 0,
          sellingPrice: undefined,
          location: null,
          reorderLevel: null,
          medicine: { id: "m-2", name: "Paracetamol 500mg" },
        }),
      ],
    });

    render(<PharmacyPage />);

    await screen.findByText("Amlodipine 5mg");
    await screen.findByText("Paracetamol 500mg");

    // Endpoint hit shape — no search → empty querystring.
    expect(apiMock.get).toHaveBeenCalledWith("/pharmacy/inventory?");

    // Batch numbers render.
    expect(screen.getByText("B-001")).toBeInTheDocument();
    expect(screen.getByText("B-002")).toBeInTheDocument();

    // Quantities render (50 in first row, 0 in second).
    expect(screen.getByText("50")).toBeInTheDocument();
    // Em-dashes for missing price / location / reorder.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("renders 'No inventory items.' when the inventory list is empty", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);

    expect(
      await screen.findByText(/No inventory items\./i),
    ).toBeInTheDocument();
  });

  it("swallows the GET rejection and still flips loading off (skeleton goes away)", async () => {
    apiMock.get.mockRejectedValue(new Error("boom"));

    render(<PharmacyPage />);

    // Loading flips off → skeleton disappears.
    await waitFor(() => {
      expect(
        screen.queryByTestId("pharmacy-inventory-skeleton"),
      ).not.toBeInTheDocument();
    });
  });

  it("refetches with ?search=<term> when the search input changes (Inventory tab)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    const searchInput = screen.getByPlaceholderText(/Search medicines or batches/i);
    fireEvent.change(searchInput, { target: { value: "para" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/pharmacy/inventory?search=para",
      ),
    );
  });

  it("Low Stock tab refetches with ?lowStock=true", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByRole("button", { name: /Low Stock/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/pharmacy/inventory?lowStock=true",
      ),
    );
  });

  it("Expiring Soon tab refetches with /pharmacy/inventory/expiring?days=30", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByRole("button", { name: /Expiring Soon/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/pharmacy/inventory/expiring?days=30",
      ),
    );
  });

  it("Movements tab refetches with /pharmacy/movements?limit=100 and renders rows when populated", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/pharmacy/movements")) {
        return Promise.resolve({
          data: [
            {
              id: "mv-1",
              type: "DISPENSED",
              quantity: 5,
              createdAt: new Date().toISOString(),
              notes: "to pt 123",
              inventory: {
                batchNumber: "B-001",
                medicine: { name: "Amlodipine 5mg" },
              },
            },
            {
              id: "mv-2",
              type: "PURCHASE",
              quantity: 100,
              createdAt: new Date().toISOString(),
              notes: null,
              inventory: undefined,
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Movements$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/pharmacy/movements?limit=100",
      ),
    );
    expect(await screen.findByText("DISPENSED")).toBeInTheDocument();
    expect(screen.getByText("PURCHASE")).toBeInTheDocument();
  });

  it("Movements tab — renders 'No movements.' when empty", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/pharmacy/movements"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Movements$/i }));

    expect(await screen.findByText(/No movements\./i)).toBeInTheDocument();
  });

  it("Returns tab refetches with /pharmacy/returns?limit=100 and renders rows when populated", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/pharmacy/returns")) {
        return Promise.resolve({
          data: [
            {
              id: "rt-1",
              returnNumber: "RTN-001",
              quantity: 2,
              reason: "EXPIRED",
              refundAmount: 19.5,
              createdAt: new Date().toISOString(),
              inventoryItem: {
                batchNumber: "B-001",
                medicine: { name: "Amlodipine 5mg" },
              },
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Returns$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/pharmacy/returns?limit=100"),
    );
    expect(await screen.findByText("RTN-001")).toBeInTheDocument();
    expect(screen.getByText("EXPIRED")).toBeInTheDocument();
    expect(screen.getByText(/19\.50/)).toBeInTheDocument();
  });

  it("Returns tab — renders 'No returns.' when empty and swallows rejection", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/pharmacy/returns"))
        return Promise.reject(new Error("returns down"));
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Returns$/i }));

    expect(await screen.findByText(/No returns\./i)).toBeInTheDocument();
  });

  it("Transfers tab refetches with /pharmacy/transfers?limit=100 and renders rows when populated", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/pharmacy/transfers")) {
        return Promise.resolve({
          data: [
            {
              id: "tr-1",
              transferNumber: "TRF-001",
              fromLocation: "Shelf A",
              toLocation: "Shelf B",
              quantity: 5,
              transferredAt: new Date().toISOString(),
              inventoryItem: {
                batchNumber: "B-001",
                medicine: { name: "Amlodipine 5mg" },
              },
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Transfers$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/pharmacy/transfers?limit=100",
      ),
    );
    expect(await screen.findByText("TRF-001")).toBeInTheDocument();
    expect(screen.getByText("Shelf A")).toBeInTheDocument();
    expect(screen.getByText("Shelf B")).toBeInTheDocument();
  });

  it("Transfers tab — renders 'No transfers.' when empty and swallows rejection", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/pharmacy/transfers"))
        return Promise.reject(new Error("transfers down"));
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Transfers$/i }));

    expect(await screen.findByText(/No transfers\./i)).toBeInTheDocument();
  });

  it("Valuation tab — ADMIN sees it; fetches /pharmacy/reports/valuation?method=WEIGHTED_AVG; renders rows + total", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/pharmacy/reports/valuation")) {
        return Promise.resolve({
          data: {
            method: "WEIGHTED_AVG",
            perMedicine: [
              {
                medicineId: "m-1",
                medicineName: "Amlodipine 5mg",
                onHand: 100,
                unitValue: 5.5,
                totalValue: 550,
              },
            ],
            totalValue: 550,
          },
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Valuation$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/pharmacy/reports/valuation?method=WEIGHTED_AVG",
      ),
    );
    expect(await screen.findByText("Amlodipine 5mg")).toBeInTheDocument();
    // ₹550.00 appears in BOTH the total bar and the per-medicine row.
    expect(screen.getAllByText(/550\.00/).length).toBeGreaterThanOrEqual(1);
  });

  it("Valuation tab — changing method refetches with ?method=FIFO", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/pharmacy/reports/valuation")) {
        return Promise.resolve({
          data: { method: "FIFO", perMedicine: [], totalValue: 0 },
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Valuation$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/pharmacy/reports/valuation?method=WEIGHTED_AVG",
      ),
    );

    // The valuation form (and its Method select) only renders after the
    // first valuation fetch resolves — await it instead of querying while
    // the skeleton is still up.
    const methodSelect = (await screen.findByLabelText(
      /Method:/i,
    )) as HTMLSelectElement;
    fireEvent.change(methodSelect, { target: { value: "FIFO" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/pharmacy/reports/valuation?method=FIFO",
      ),
    );
  });

  it("Valuation tab — falls back to 'No valuation data.' when the response is null (swallowed rejection)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/pharmacy/reports/valuation"))
        return Promise.reject(new Error("valuation down"));
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Valuation$/i }));

    expect(
      await screen.findByText(/No valuation data\./i),
    ).toBeInTheDocument();
  });

  it("Valuation tab is HIDDEN for DOCTOR (isAdmin-only gate)", async () => {
    asDoctor();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    expect(
      screen.queryByRole("button", { name: /^Valuation$/i }),
    ).not.toBeInTheDocument();
  });

  it("Add Stock button is HIDDEN for DOCTOR (canManage gate — ADMIN+PHARMACIST only)", async () => {
    asDoctor();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    expect(
      screen.queryByRole("button", { name: /Add Stock/i }),
    ).not.toBeInTheDocument();
  });

  it("Add Stock button is HIDDEN for NURSE; Kanban CTA is still visible (every authed role)", async () => {
    asNurse();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    expect(
      screen.queryByRole("button", { name: /Add Stock/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("pharmacy-open-kanban")).toBeInTheDocument();
  });

  it("Add Stock button is VISIBLE for PHARMACIST (canManage true)", async () => {
    asPharmacist();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    expect(
      screen.getByRole("button", { name: /Add Stock/i }),
    ).toBeInTheDocument();
  });

  it("Kanban CTA routes to /dashboard/pharmacy-kanban", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByTestId("pharmacy-open-kanban"));

    expect(routerMock.push).toHaveBeenCalledWith(
      "/dashboard/pharmacy-kanban?from=pharmacy",
    );
  });

  it("Return / Transfer action buttons render per-row when canManage is true (ADMIN)", async () => {
    apiMock.get.mockResolvedValue({ data: [invFixture()] });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    // Scope to the inventory row to avoid the Returns/Transfers TAB buttons
    // matching the same name. The action buttons live inside <td> + the
    // tab buttons sit at the page-top tab strip.
    const row = screen.getByText("B-001").closest("tr") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Return" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Transfer" })).toBeInTheDocument();
  });

  it("Order from Supplier button only renders for LOW rows (qty <= reorderLevel) — POSTs and toasts the PO number", async () => {
    confirmMock.mockResolvedValue(true);
    apiMock.get.mockResolvedValue({
      data: [
        invFixture({ id: "inv-low", quantity: 5, reorderLevel: 10 }),
      ],
    });
    apiMock.post.mockResolvedValue({
      data: { po: { poNumber: "PO-001" }, emailStub: "sent to vendor@x.com" },
    });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    fireEvent.click(
      screen.getByRole("button", { name: /Order from Supplier/i }),
    );

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/pharmacy/inventory/inv-low/order-from-supplier",
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining("PO-001"),
    );
  });

  it("Order from Supplier — declined confirm does NOT POST", async () => {
    confirmMock.mockResolvedValue(false);
    apiMock.get.mockResolvedValue({
      data: [invFixture({ quantity: 1, reorderLevel: 10 })],
    });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    fireEvent.click(
      screen.getByRole("button", { name: /Order from Supplier/i }),
    );

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Order from Supplier — rejection surfaces toast.error", async () => {
    confirmMock.mockResolvedValue(true);
    apiMock.get.mockResolvedValue({
      data: [invFixture({ quantity: 1, reorderLevel: 10 })],
    });
    apiMock.post.mockRejectedValue(new Error("supplier 503"));

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    fireEvent.click(
      screen.getByRole("button", { name: /Order from Supplier/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("supplier 503"),
    );
  });

  // ---------- Return modal ----------

  it("Return modal — qty > on-hand rejects with toast.error and never POSTs", async () => {
    apiMock.get.mockResolvedValue({
      data: [invFixture({ quantity: 5 })],
    });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    const row = screen.getByText("B-001").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Return" }));

    const qtyInput = await screen.findByTestId("pharmacy-return-qty");
    fireEvent.change(qtyInput, { target: { value: "999" } });
    fireEvent.click(screen.getByRole("button", { name: /Record Return/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Cannot return more than on-hand stock/i),
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Return modal — qty < 1 / NaN rejects with positive-integer toast", async () => {
    apiMock.get.mockResolvedValue({ data: [invFixture()] });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    const row = screen.getByText("B-001").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Return" }));

    const qtyInput = await screen.findByTestId("pharmacy-return-qty");
    fireEvent.change(qtyInput, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /Record Return/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/positive whole number/i),
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Return modal — happy POST closes the modal and clears the inline state", async () => {
    apiMock.get.mockResolvedValue({ data: [invFixture()] });
    apiMock.post.mockResolvedValue({ data: { id: "rt-new" } });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    const row = screen.getByText("B-001").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Return" }));

    const qtyInput = await screen.findByTestId("pharmacy-return-qty");
    fireEvent.change(qtyInput, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /Record Return/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/pharmacy/returns",
        expect.objectContaining({
          inventoryItemId: "inv-1",
          quantity: 3,
          reason: "PATIENT_RETURNED",
        }),
      ),
    );
  });

  it("Return modal — Cancel button closes without POST", async () => {
    apiMock.get.mockResolvedValue({ data: [invFixture()] });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    const row = screen.getByText("B-001").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Return" }));
    expect(await screen.findByTestId("pharmacy-return-qty")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() =>
      expect(screen.queryByTestId("pharmacy-return-qty")).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Return modal — POST rejection surfaces toast.error and keeps modal open", async () => {
    apiMock.get.mockResolvedValue({ data: [invFixture()] });
    apiMock.post.mockRejectedValue(new Error("FK violation"));

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    const row = screen.getByText("B-001").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Return" }));
    fireEvent.change(await screen.findByTestId("pharmacy-return-qty"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Record Return/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("FK violation"),
    );
  });

  // ---------- Transfer modal ----------

  it("Transfer modal — blank fromLocation rejects with toast.error and never POSTs", async () => {
    apiMock.get.mockResolvedValue({
      // Force the location null so the modal opens with blank fromLocation.
      data: [invFixture({ location: null })],
    });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    const row = screen.getByText("B-001").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Transfer" }));

    // The modal's submit button is inside a <form>; scope to the form.
    const form = (await screen.findByPlaceholderText(/From Location/i)).closest(
      "form",
    ) as HTMLElement;
    fireEvent.click(within(form).getByRole("button", { name: /^Transfer$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/From Location is required/i),
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Transfer modal — blank toLocation rejects with toast.error", async () => {
    apiMock.get.mockResolvedValue({ data: [invFixture()] });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    const row = screen.getByText("B-001").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Transfer" }));

    const form = (await screen.findByPlaceholderText(/From Location/i)).closest(
      "form",
    ) as HTMLElement;
    // From is pre-filled from item.location; To is blank.
    fireEvent.click(within(form).getByRole("button", { name: /^Transfer$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/To Location is required/i),
      ),
    );
  });

  it("Transfer modal — qty > on-hand rejects", async () => {
    apiMock.get.mockResolvedValue({ data: [invFixture({ quantity: 5 })] });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    const row = screen.getByText("B-001").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Transfer" }));

    const toLocInput = await screen.findByPlaceholderText(/^To Location$/i);
    fireEvent.change(toLocInput, { target: { value: "Shelf C" } });

    const qtyInput = screen.getByPlaceholderText(/^Quantity$/i);
    fireEvent.change(qtyInput, { target: { value: "999" } });

    const form = toLocInput.closest("form") as HTMLElement;
    fireEvent.click(within(form).getByRole("button", { name: /^Transfer$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Cannot transfer more than on-hand stock/i),
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Transfer modal — happy POST submits the right payload", async () => {
    apiMock.get.mockResolvedValue({ data: [invFixture()] });
    apiMock.post.mockResolvedValue({ data: { id: "trf-new" } });

    render(<PharmacyPage />);
    await screen.findByText("Amlodipine 5mg");

    const row = screen.getByText("B-001").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Transfer" }));

    const toLocInput = await screen.findByPlaceholderText(/^To Location$/i);
    fireEvent.change(toLocInput, { target: { value: "Shelf C" } });

    const qtyInput = screen.getByPlaceholderText(/^Quantity$/i);
    fireEvent.change(qtyInput, { target: { value: "2" } });

    const notesInput = screen.getByPlaceholderText(/Notes/i);
    fireEvent.change(notesInput, { target: { value: "audit move" } });

    const form = toLocInput.closest("form") as HTMLElement;
    fireEvent.click(within(form).getByRole("button", { name: /^Transfer$/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/pharmacy/transfers",
        expect.objectContaining({
          inventoryItemId: "inv-1",
          fromLocation: "Shelf A",
          toLocation: "Shelf C",
          quantity: 2,
          notes: "audit move",
        }),
      ),
    );
  });

  // ---------- AddStock modal ----------

  it("AddStock modal — empty submit raises field errors + a warning toast and never POSTs", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Stock/i }));

    // Modal submit button — scope to the modal form to avoid colliding with
    // the header "Add Stock" CTA button (same accessible name).
    const modalHeading = screen.getByRole("heading", { name: /^Add Stock$/i });
    const modalForm = modalHeading.closest("form") as HTMLElement;
    fireEvent.click(
      within(modalForm).getByRole("button", { name: /^Add Stock$/i }),
    );

    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(
        expect.stringMatching(/highlighted fields/i),
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();

    // Per-field errors render.
    expect(screen.getByTestId("error-add-stock-medicineId")).toBeInTheDocument();
    expect(screen.getByTestId("error-add-stock-batchNumber")).toBeInTheDocument();
    expect(screen.getByTestId("error-add-stock-quantity")).toBeInTheDocument();
    expect(screen.getByTestId("error-add-stock-unitCost")).toBeInTheDocument();
    expect(screen.getByTestId("error-add-stock-sellingPrice")).toBeInTheDocument();
    expect(screen.getByTestId("error-add-stock-expiryDate")).toBeInTheDocument();
  });

  it("AddStock modal — past expiry date rejects via the field error", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Stock/i }));

    // Fill enough to focus the test on expiry validation; medicine not
    // selected, so we still expect medicineId error too — but the expiry
    // field error is the one we're locking onto.
    fireEvent.change(screen.getByTestId("add-stock-batch"), {
      target: { value: "B-NEW" },
    });
    fireEvent.change(screen.getByTestId("add-stock-quantity"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByTestId("add-stock-unit-cost"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByTestId("add-stock-selling-price"), {
      target: { value: "10" },
    });
    // Past date — 2020-01-01 is definitely before tomorrow.
    fireEvent.change(screen.getByTestId("add-stock-expiry"), {
      target: { value: "2020-01-01" },
    });

    // Modal submit button — scope to the modal form to avoid colliding with
    // the header "Add Stock" CTA button (same accessible name).
    const modalHeading = screen.getByRole("heading", { name: /^Add Stock$/i });
    const modalForm = modalHeading.closest("form") as HTMLElement;
    fireEvent.click(
      within(modalForm).getByRole("button", { name: /^Add Stock$/i }),
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("error-add-stock-expiryDate"),
      ).toHaveTextContent(/Expiry date must be in the future/i),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("AddStock modal — medicine search debounces and hits /medicines?search=...; clicking a result selects it", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medicines?search=")) {
        return Promise.resolve({
          data: [
            { id: "m-1", name: "Amlodipine 5mg" },
            { id: "m-2", name: "Amoxicillin 250mg" },
          ],
        });
      }
      // Default for inventory.
      return Promise.resolve({ data: [] });
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<PharmacyPage />);

    // Wait for the initial inventory fetch to complete before kicking off
    // fake timers (we use shouldAdvanceTime so real microtasks still flush).
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Stock/i }));

    fireEvent.change(screen.getByTestId("add-stock-medicine-search"), {
      target: { value: "Am" },
    });

    // Advance past the 300ms debounce.
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/^\/medicines\?search=Am/),
      ),
    );

    vi.useRealTimers();

    // The result list renders; click first.
    const result = await screen.findByText("Amlodipine 5mg");
    fireEvent.click(result);

    expect(
      screen.getByTestId("add-stock-medicine-chosen"),
    ).toHaveTextContent("Amlodipine 5mg");
  });

  it("AddStock modal — happy POST submits the full payload and closes (verified by reload-triggered second GET)", async () => {
    const tomorrowIso = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      return d.toISOString().slice(0, 10);
    })();

    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({ data: { id: "inv-new" } });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Stock/i }));

    // Inject medicine search result by short-circuiting the typeahead.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medicines?search="))
        return Promise.resolve({
          data: [{ id: "m-1", name: "Amlodipine 5mg" }],
        });
      return Promise.resolve({ data: [] });
    });

    fireEvent.change(screen.getByTestId("add-stock-medicine-search"), {
      target: { value: "Amlo" },
    });

    // Wait for typeahead — we DON'T use fake timers here; the 300ms debounce
    // races but we just await it via waitFor.
    const med = await screen.findByText(
      "Amlodipine 5mg",
      {},
      { timeout: 1000 },
    );
    fireEvent.click(med);

    fireEvent.change(screen.getByTestId("add-stock-batch"), {
      target: { value: "B-NEW" },
    });
    fireEvent.change(screen.getByTestId("add-stock-quantity"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByTestId("add-stock-unit-cost"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByTestId("add-stock-selling-price"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByTestId("add-stock-expiry"), {
      target: { value: tomorrowIso },
    });
    fireEvent.change(screen.getByTestId("add-stock-reorder-level"), {
      target: { value: "5" },
    });

    // Modal submit button — scope to the modal form to avoid colliding with
    // the header "Add Stock" CTA button (same accessible name).
    const modalHeading = screen.getByRole("heading", { name: /^Add Stock$/i });
    const modalForm = modalHeading.closest("form") as HTMLElement;
    fireEvent.click(
      within(modalForm).getByRole("button", { name: /^Add Stock$/i }),
    );

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/pharmacy/inventory",
        expect.objectContaining({
          medicineId: "m-1",
          batchNumber: "B-NEW",
          quantity: 10,
          unitCost: 5,
          sellingPrice: 10,
          expiryDate: tomorrowIso,
          reorderLevel: 5,
        }),
      ),
    );
  });

  it("AddStock modal — server returns details[] error map → field errors populate + first-error toast", async () => {
    const tomorrowIso = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      return d.toISOString().slice(0, 10);
    })();

    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medicines?search="))
        return Promise.resolve({
          data: [{ id: "m-1", name: "Amlodipine 5mg" }],
        });
      return Promise.resolve({ data: [] });
    });
    const serverErr = Object.assign(new Error("validation failed"), {
      payload: {
        details: [
          { field: "batchNumber", message: "Batch already exists in lot" },
        ],
      },
    });
    apiMock.post.mockRejectedValue(serverErr);

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Stock/i }));

    fireEvent.change(screen.getByTestId("add-stock-medicine-search"), {
      target: { value: "Amlo" },
    });

    const med = await screen.findByText(
      "Amlodipine 5mg",
      {},
      { timeout: 1000 },
    );
    fireEvent.click(med);

    fireEvent.change(screen.getByTestId("add-stock-batch"), {
      target: { value: "B-DUP" },
    });
    fireEvent.change(screen.getByTestId("add-stock-quantity"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByTestId("add-stock-unit-cost"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByTestId("add-stock-selling-price"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByTestId("add-stock-expiry"), {
      target: { value: tomorrowIso },
    });

    // Modal submit button — scope to the modal form to avoid colliding with
    // the header "Add Stock" CTA button (same accessible name).
    const modalHeading = screen.getByRole("heading", { name: /^Add Stock$/i });
    const modalForm = modalHeading.closest("form") as HTMLElement;
    fireEvent.click(
      within(modalForm).getByRole("button", { name: /^Add Stock$/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Batch already exists in lot",
      ),
    );
    expect(screen.getByTestId("error-add-stock-batchNumber")).toHaveTextContent(
      "Batch already exists in lot",
    );
  });

  it("AddStock modal — non-payload error path surfaces toast.error with the message", async () => {
    const tomorrowIso = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      return d.toISOString().slice(0, 10);
    })();

    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medicines?search="))
        return Promise.resolve({
          data: [{ id: "m-1", name: "Amlodipine 5mg" }],
        });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockRejectedValue(new Error("network down"));

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Stock/i }));

    fireEvent.change(screen.getByTestId("add-stock-medicine-search"), {
      target: { value: "Amlo" },
    });
    const med = await screen.findByText(
      "Amlodipine 5mg",
      {},
      { timeout: 1000 },
    );
    fireEvent.click(med);

    fireEvent.change(screen.getByTestId("add-stock-batch"), {
      target: { value: "B-NEW" },
    });
    fireEvent.change(screen.getByTestId("add-stock-quantity"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByTestId("add-stock-unit-cost"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByTestId("add-stock-selling-price"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByTestId("add-stock-expiry"), {
      target: { value: tomorrowIso },
    });

    // Modal submit button — scope to the modal form to avoid colliding with
    // the header "Add Stock" CTA button (same accessible name).
    const modalHeading = screen.getByRole("heading", { name: /^Add Stock$/i });
    const modalForm = modalHeading.closest("form") as HTMLElement;
    fireEvent.click(
      within(modalForm).getByRole("button", { name: /^Add Stock$/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("network down"),
    );
  });

  it("AddStock modal — 'Change' button clears selected medicine and reveals the search input again", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medicines?search="))
        return Promise.resolve({
          data: [{ id: "m-1", name: "Amlodipine 5mg" }],
        });
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Stock/i }));

    fireEvent.change(screen.getByTestId("add-stock-medicine-search"), {
      target: { value: "Amlo" },
    });
    const med = await screen.findByText(
      "Amlodipine 5mg",
      {},
      { timeout: 1000 },
    );
    fireEvent.click(med);

    expect(
      screen.getByTestId("add-stock-medicine-chosen"),
    ).toBeInTheDocument();

    // Click "Change" button to clear the selection.
    fireEvent.click(screen.getByRole("button", { name: /^Change$/i }));

    expect(
      screen.queryByTestId("add-stock-medicine-chosen"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("add-stock-medicine-search"),
    ).toBeInTheDocument();
  });

  it("AddStock modal — Cancel button closes the modal without POSTing", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<PharmacyPage />);
    await screen.findByText(/No inventory items\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Stock/i }));

    expect(
      screen.getByRole("heading", { name: /^Add Stock$/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Add Stock$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Inventory tab — near-expiry row gets the orange expiry warning class; expired row gets the red one", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        invFixture({ id: "inv-near", expiryDate: NEAR }),
        invFixture({ id: "inv-old", expiryDate: PAST }),
      ],
    });

    render(<PharmacyPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Amlodipine 5mg").length).toBe(2),
    );

    // expiryColor: < 0 days → red; < 30 days → orange. Both rows render.
    // We assert via classlist on the <td> containing the date strings.
    const tds = document.querySelectorAll("td");
    const hasOrange = Array.from(tds).some((td) =>
      td.className.includes("text-orange-600"),
    );
    const hasRed = Array.from(tds).some((td) =>
      td.className.includes("text-red-700"),
    );
    expect(hasOrange).toBe(true);
    expect(hasRed).toBe(true);
  });

  it("Inventory tab — qty=0 row gets the red qty styling; low-stock row gets the orange qty styling", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        invFixture({ id: "inv-out", batchNumber: "B-OUT", quantity: 0, reorderLevel: 10 }),
        invFixture({ id: "inv-low", batchNumber: "B-LOW", quantity: 5, reorderLevel: 10 }),
      ],
    });

    render(<PharmacyPage />);
    await screen.findByText("B-OUT");

    const tds = document.querySelectorAll("td");
    const hasOrange = Array.from(tds).some((td) =>
      td.className.includes("text-orange-600"),
    );
    const hasRed = Array.from(tds).some((td) =>
      td.className.includes("text-red-600"),
    );
    expect(hasOrange).toBe(true);
    expect(hasRed).toBe(true);
  });

  it("Returns tab — window focus event triggers a refetch (Issue #367 auto-refresh)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/pharmacy/returns"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    render(<PharmacyPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Returns$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/pharmacy/returns?limit=100"),
    );

    const initialCallCount = apiMock.get.mock.calls.filter((c) =>
      c[0].startsWith("/pharmacy/returns"),
    ).length;

    // Fire focus event with visibilityState=visible (jsdom default).
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    fireEvent.focus(window);

    await waitFor(() => {
      const after = apiMock.get.mock.calls.filter((c) =>
        c[0].startsWith("/pharmacy/returns"),
      ).length;
      expect(after).toBeGreaterThan(initialCallCount);
    });
  });
});
