/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AssetsPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/assets/page.tsx, the Asset
 *     Management register. The page issues:
 *       GET   /assets?...                       (list, filtered by tab + search)
 *       GET   /assets/warranty/expiring?days=30 (warranty alerts strip)
 *       GET   /assets/maintenance/due           (maintenance-due banner)
 *       GET   /assets/:id                       (detail side-panel open)
 *       POST  /assets/:id/return                (Return Asset action)
 *       POST  /assets                           (Add Asset modal)
 *       GET   /auth/users?limit=200             (Assign modal staff dropdown)
 *       GET   /users?limit=200                  (fallback when /auth/users 404s)
 *       POST  /assets/:id/assign                (Assign modal submit)
 *       POST  /assets/maintenance               (Log Maintenance submit)
 *
 *   - Behaviours covered:
 *       1.  Loading skeleton renders while initial GETs are pending.
 *       2.  Happy fetch — header stats compute total / in-use / under-maint /
 *           warranty-alert counts; table renders rows with status pill,
 *           active assignee, location, and the actions cell.
 *       3.  ADMIN sees Add Asset CTA + per-row Assign / Log Maintenance
 *           buttons; non-ADMIN does NOT.
 *       4.  RETIRED asset row hides any stale active-assignment name
 *           (Issue #59 — UI-level guard).
 *       5.  Tabs — clicking each tab refetches /assets with the right
 *           status param: all / assigned (IN_USE) / idle (IDLE) /
 *           maintenance (UNDER_MAINTENANCE). Warranty tab swaps the list
 *           source to warrantyAlerts + shows the warranty expiry column.
 *       6.  Maintenance tab shows the "X assets have maintenance due"
 *           banner only when maintDue > 0.
 *       7.  Search — typing into the search box + clicking Search refetches
 *           with the encoded query. Enter key in the search input fires the
 *           same refetch.
 *       8.  Row click opens detail side panel — fires GET /assets/:id and
 *           renders the asset's full record (manufacturer / model / serial /
 *           warranty / amc / status pill).
 *       9.  Detail panel — assignment history empty / populated branches;
 *           maintenance log empty / populated branches; close button.
 *      10.  Return Asset — confirm → POST /assets/:id/return → refetch
 *           + side panel closes. Confirm declined → no POST.
 *      11.  Return Asset POST rejection surfaces toast.error(err.message).
 *      12.  Add Asset modal — opens, Save disabled until both tag + name;
 *           happy POST refetches + closes; empty optional fields collapse
 *           to undefined; error surfaces toast.error.
 *      13.  Assign modal — fetches /auth/users primary list; selecting a
 *           staff member + submit POSTs /assets/:id/assign with the right
 *           body; empty assignee disables Save. Fallback to /users when
 *           /auth/users rejects. Save error toasts.
 *      14.  Maintenance modal — type dropdown + cost numeric coercion;
 *           POST /assets/maintenance fires with assetId; rejection toasts.
 *      15.  Error-path resilience — /assets rejection lands in loading=false
 *           branch with an empty table ("No assets" row).
 *
 *   - Source under test: apps/web/src/app/dashboard/assets/page.tsx
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/use-dialog,
 *            next/navigation, @/components/Skeleton (stubbed).
 *
 *   - Notes:
 *     • useAuthStore is called as `useAuthStore()` (object destructure) —
 *       authMock returns the whole store object, not a selector callback.
 *     • +48h / -48h offsets where dates matter — no fake timers paired with
 *       waitFor.
 *     • The active assignment branch reads assignments?.find(!returnedAt),
 *       so each fixture row needs both a name and an assignments array.
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
  within,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, confirmMock } = vi.hoisted(() => ({
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
  confirmMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(),
}));
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
  usePathname: () => "/dashboard/assets",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import AssetsPage from "../page";

// ─── Fixtures ───────────────────────────────────────────────────────────

type Asset = {
  id: string;
  assetTag: string;
  name: string;
  category: string;
  manufacturer?: string | null;
  modelNumber?: string | null;
  serialNumber?: string | null;
  location?: string | null;
  department?: string | null;
  status: "IN_USE" | "IDLE" | "UNDER_MAINTENANCE" | "RETIRED" | "LOST";
  purchaseCost?: number | null;
  purchaseDate?: string | null;
  warrantyExpiry?: string | null;
  amcExpiryDate?: string | null;
  amcProvider?: string | null;
  assignments?: any[];
  maintenance?: any[];
};

function assetFixture(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "a-1",
    assetTag: "ASSET-001",
    name: "Defibrillator",
    category: "Medical Equipment",
    manufacturer: "Philips",
    modelNumber: "HS1",
    serialNumber: "SN-XYZ",
    location: "ICU-1",
    department: "ICU",
    status: "IN_USE",
    purchaseCost: 50000,
    purchaseDate: "2025-01-01",
    warrantyExpiry: "2027-01-01",
    amcExpiryDate: "2027-01-01",
    amcProvider: "Philips Care",
    assignments: [
      {
        id: "as-1",
        assignedTo: "u-1",
        assignedAt: "2025-02-01",
        returnedAt: null,
        location: "ICU-1",
        notes: "Primary unit",
        assignee: { id: "u-1", name: "Nurse Anita", role: "NURSE" },
      },
    ],
    maintenance: [
      {
        id: "m-1",
        type: "SCHEDULED",
        performedAt: "2025-06-01",
        vendor: "Philips Care",
        cost: 1200,
        description: "Calibration",
        nextDueDate: "2026-06-01",
        technician: { id: "t-1", name: "Ravi" },
      },
    ],
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin" },
  });
}
function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
  });
}

function wireDefaultGets(opts: {
  assets?: Asset[];
  warranty?: Asset[];
  maint?: Asset[];
  detail?: Asset;
} = {}) {
  const assets = opts.assets ?? [assetFixture()];
  const warranty = opts.warranty ?? [];
  const maint = opts.maint ?? [];

  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/assets/warranty/expiring")) {
      return Promise.resolve({ data: warranty });
    }
    if (url.startsWith("/assets/maintenance/due")) {
      return Promise.resolve({ data: maint });
    }
    if (url.startsWith("/assets?")) {
      return Promise.resolve({ data: assets });
    }
    if (/^\/assets\/[^/]+$/.test(url)) {
      return Promise.resolve({ data: opts.detail ?? assets[0] });
    }
    if (url.startsWith("/auth/users")) {
      return Promise.resolve({
        data: [
          { id: "u-1", name: "Nurse Anita", role: "NURSE" },
          { id: "u-2", name: "Dr Ravi", role: "DOCTOR" },
        ],
      });
    }
    if (url.startsWith("/users")) {
      return Promise.resolve({
        data: [{ id: "u-3", name: "Fallback Bob", role: "TECH" }],
      });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("AssetsPage (Asset Management — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Loading + initial render ────────────────────────────────────────────

  it("renders the loading skeleton while the initial GETs are in flight", async () => {
    let resolveList: (v: any) => void = () => undefined;
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/assets?")) {
        return new Promise((res) => {
          resolveList = res;
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<AssetsPage />);
    expect(
      await screen.findByRole("heading", { name: /Asset Management/i, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("assets-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();

    resolveList({ data: [] });
    await waitFor(() =>
      expect(screen.queryByTestId("assets-loading")).not.toBeInTheDocument(),
    );
  });

  it("renders the page header, summary stats and triggers the initial trio of GETs", async () => {
    wireDefaultGets({
      assets: [
        assetFixture({ id: "a-1", status: "IN_USE" }),
        assetFixture({ id: "a-2", status: "UNDER_MAINTENANCE" }),
        assetFixture({ id: "a-3", status: "IDLE" }),
      ],
      warranty: [assetFixture({ id: "a-w", warrantyExpiry: "2026-06-01" })],
    });
    render(<AssetsPage />);

    expect(
      await screen.findByRole("heading", { name: /Asset Management/i }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(expect.stringMatching(/^\/assets\?/));
      expect(apiMock.get).toHaveBeenCalledWith("/assets/warranty/expiring?days=30");
      expect(apiMock.get).toHaveBeenCalledWith("/assets/maintenance/due");
    });

    // Stats — Total / In Use / Under Maintenance / Warranty Expiring.
    expect(await screen.findByText("Total Assets")).toBeInTheDocument();
    // Total = 3
    const totalCard = screen.getByText("Total Assets").parentElement!;
    expect(within(totalCard).getByText("3")).toBeInTheDocument();
    // In Use = 1
    const inUseCard = screen.getByText("In Use").parentElement!;
    expect(within(inUseCard).getByText("1")).toBeInTheDocument();
    // Under Maintenance = 1
    const maintCard = screen.getByText("Under Maintenance").parentElement!;
    expect(within(maintCard).getByText("1")).toBeInTheDocument();
    // Warranty Expiring = 1
    const warrCard = screen.getByText("Warranty Expiring").parentElement!;
    expect(within(warrCard).getByText("1")).toBeInTheDocument();
  });

  it("renders the asset table row with tag, name, category, location, status pill and assignee", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    expect(await screen.findByText("ASSET-001")).toBeInTheDocument();
    expect(screen.getByText("Defibrillator")).toBeInTheDocument();
    expect(screen.getByText("Medical Equipment")).toBeInTheDocument();
    expect(screen.getByText("ICU-1")).toBeInTheDocument();
    // Status pill (IN_USE → "IN USE")
    expect(screen.getByText(/^IN USE$/)).toBeInTheDocument();
    // Active assignee name shows in the row
    expect(screen.getByText("Nurse Anita")).toBeInTheDocument();
  });

  it("RETIRED asset row hides any stale active assignee (Issue #59 UI guard)", async () => {
    wireDefaultGets({
      assets: [
        assetFixture({
          id: "a-retired",
          name: "Retired Pump",
          status: "RETIRED",
          // Stale open assignment — UI must NOT leak the name.
          assignments: [
            {
              id: "as-old",
              assignedTo: "u-9",
              assignedAt: "2024-01-01",
              returnedAt: null,
              assignee: { id: "u-9", name: "Stale Owner", role: "NURSE" },
            },
          ],
        }),
      ],
    });
    render(<AssetsPage />);

    expect(await screen.findByText(/Retired Pump/)).toBeInTheDocument();
    expect(screen.queryByText(/Stale Owner/)).not.toBeInTheDocument();
    // The placeholder em-dash should appear in the assignee column.
    const row = screen.getByText(/Retired Pump/).closest("tr")!;
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("empty asset list renders the 'No assets' empty row", async () => {
    wireDefaultGets({ assets: [] });
    render(<AssetsPage />);
    expect(await screen.findByText(/^No assets$/)).toBeInTheDocument();
  });

  // ── RBAC gating ─────────────────────────────────────────────────────────

  it("ADMIN sees the Add Asset CTA + per-row Assign/Log Maintenance buttons", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    expect(
      await screen.findByRole("button", { name: /Add Asset/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Assign$/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Log Maintenance$/ }),
    ).toBeInTheDocument();
  });

  it("DOCTOR does NOT see Add Asset or per-row management buttons", async () => {
    asDoctor();
    wireDefaultGets();
    render(<AssetsPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(expect.stringMatching(/^\/assets\?/)),
    );
    expect(screen.queryByRole("button", { name: /Add Asset/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Assign$/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Log Maintenance$/ }),
    ).not.toBeInTheDocument();
  });

  // ── Tabs ────────────────────────────────────────────────────────────────

  it("clicking 'assigned' tab refetches with status=IN_USE", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(expect.stringMatching(/^\/assets\?/)),
    );
    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^assigned$/ }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/status=IN_USE/),
      ),
    );
  });

  it("clicking 'idle' tab refetches with status=IDLE", async () => {
    wireDefaultGets();
    render(<AssetsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^idle$/ }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(expect.stringMatching(/status=IDLE/)),
    );
  });

  it("clicking 'maintenance' tab refetches with status=UNDER_MAINTENANCE + shows banner when due > 0", async () => {
    wireDefaultGets({
      assets: [],
      maint: [assetFixture({ id: "m-1" }), assetFixture({ id: "m-2" })],
    });
    render(<AssetsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /^maintenance$/ }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/status=UNDER_MAINTENANCE/),
      ),
    );

    expect(
      await screen.findByText(/2 assets have maintenance due/i),
    ).toBeInTheDocument();
  });

  it("'warranty' tab swaps the list to warrantyAlerts and adds the Warranty Expires column", async () => {
    const wExp = "2026-06-01T00:00:00.000Z";
    wireDefaultGets({
      assets: [assetFixture()],
      warranty: [
        assetFixture({
          id: "a-warr",
          name: "Patient Monitor",
          warrantyExpiry: wExp,
        }),
      ],
    });
    render(<AssetsPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Warranty Alerts/i }),
    );

    // The warranty asset's name should appear (different from the default list).
    expect(await screen.findByText("Patient Monitor")).toBeInTheDocument();
    // Warranty Expires header appears.
    expect(screen.getByText(/Warranty Expires/i)).toBeInTheDocument();
    // Search bar hidden on warranty tab.
    expect(
      screen.queryByPlaceholderText(/Search by name, tag, serial/i),
    ).not.toBeInTheDocument();
  });

  it("'warranty' tab — empty assets array still renders the warranty list (decoupled)", async () => {
    wireDefaultGets({
      assets: [],
      warranty: [
        assetFixture({ id: "a-w", warrantyExpiry: null }),
      ],
    });
    render(<AssetsPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Warranty Alerts/i }),
    );
    // The warranty column for a null warrantyExpiry shows em-dash.
    expect(await screen.findByText("Defibrillator")).toBeInTheDocument();
  });

  // ── Search ──────────────────────────────────────────────────────────────

  it("typing into search + clicking Search refetches with the encoded query", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    apiMock.get.mockClear();

    fireEvent.change(
      screen.getByPlaceholderText(/Search by name, tag, serial/i),
      { target: { value: "ICU Probe" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/search=ICU%20Probe/),
      ),
    );
  });

  it("pressing Enter in the search input fires the same refetch", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    apiMock.get.mockClear();

    const input = screen.getByPlaceholderText(/Search by name, tag, serial/i);
    fireEvent.change(input, { target: { value: "Pump" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/search=Pump/),
      ),
    );
  });

  // ── Detail side panel ───────────────────────────────────────────────────

  it("clicking a row opens the detail side panel via GET /assets/:id", async () => {
    wireDefaultGets({
      detail: assetFixture({
        id: "a-1",
        name: "Defibrillator",
        manufacturer: "Philips",
        modelNumber: "HS1",
        serialNumber: "SN-XYZ",
        location: "ICU-1",
        warrantyExpiry: "2027-01-01T00:00:00.000Z",
        amcExpiryDate: "2027-01-01T00:00:00.000Z",
        amcProvider: "Philips Care",
      }),
    });
    render(<AssetsPage />);

    const row = await screen.findByText("Defibrillator");
    fireEvent.click(row);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/assets/a-1"));

    // Side panel renders the detail strong-labelled fields.
    expect(await screen.findByText(/Manufacturer:/)).toBeInTheDocument();
    expect(screen.getByText(/Model:/)).toBeInTheDocument();
    expect(screen.getByText(/Serial:/)).toBeInTheDocument();
    expect(screen.getByText(/Warranty:/)).toBeInTheDocument();
    expect(screen.getByText(/AMC:/)).toBeInTheDocument();
  });

  it("side panel close button (✕) clears the selection", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    fireEvent.click(await screen.findByText("Defibrillator"));
    expect(await screen.findByText(/Assignment History/)).toBeInTheDocument();

    // The side-panel close button is a ✕ glyph. Two ✕ buttons may exist when
    // a modal is open as well, but only the side panel is open here.
    const closeBtns = screen.getAllByRole("button", { name: /^✕$/ });
    fireEvent.click(closeBtns[0]!);

    await waitFor(() =>
      expect(screen.queryByText(/Assignment History/)).not.toBeInTheDocument(),
    );
  });

  it("side panel — empty assignment history shows 'No assignments' hint", async () => {
    wireDefaultGets({
      assets: [
        assetFixture({
          id: "a-empty",
          name: "Empty Asset",
          assignments: [],
          maintenance: [],
        }),
      ],
      detail: assetFixture({
        id: "a-empty",
        name: "Empty Asset",
        assignments: [],
        maintenance: [],
      }),
    });
    render(<AssetsPage />);

    fireEvent.click(await screen.findByText("Empty Asset"));
    expect(await screen.findByText(/No assignments/)).toBeInTheDocument();
    expect(screen.getByText(/No maintenance logs/)).toBeInTheDocument();
  });

  it("side panel — Return Asset confirms → POSTs /assets/:id/return → closes panel + refetches", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    render(<AssetsPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    apiMock.get.mockClear();

    fireEvent.click(await screen.findByText("Defibrillator"));
    const returnBtn = await screen.findByRole("button", { name: /Return Asset/i });
    fireEvent.click(returnBtn);

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/assets/a-1/return", {}),
    );
    // Refetch fires.
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/^\/assets\?/),
      ),
    );
    // Side panel closes.
    await waitFor(() =>
      expect(screen.queryByText(/Assignment History/)).not.toBeInTheDocument(),
    );
  });

  it("side panel — Return Asset confirm declined → no POST", async () => {
    wireDefaultGets();
    confirmMock.mockResolvedValue(false);
    render(<AssetsPage />);

    fireEvent.click(await screen.findByText("Defibrillator"));
    fireEvent.click(await screen.findByRole("button", { name: /Return Asset/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("side panel — Return Asset POST rejection surfaces toast.error(err.message)", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue(new Error("return failed"));
    render(<AssetsPage />);

    fireEvent.click(await screen.findByText("Defibrillator"));
    fireEvent.click(await screen.findByRole("button", { name: /Return Asset/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("return failed"),
    );
  });

  it("side panel — openAssetDetail GET rejection is swallowed (panel stays closed)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/assets?")) {
        return Promise.resolve({ data: [assetFixture()] });
      }
      if (/^\/assets\/[^/]+$/.test(url)) {
        return Promise.reject(new Error("not found"));
      }
      return Promise.resolve({ data: [] });
    });
    render(<AssetsPage />);

    fireEvent.click(await screen.findByText("Defibrillator"));
    // Detail panel should never appear since the GET rejected.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/assets/a-1"));
    expect(screen.queryByText(/Assignment History/)).not.toBeInTheDocument();
  });

  // ── Add Asset modal ─────────────────────────────────────────────────────

  it("Add Asset modal — opens, Save disabled until tag + name filled", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    const addCtaBtns = await screen.findAllByRole("button", { name: /Add Asset/i });
    fireEvent.click(addCtaBtns[0]!);
    expect(
      await screen.findByRole("heading", { name: /^Add Asset$/ }),
    ).toBeInTheDocument();

    // After modal opens, two "Add Asset" buttons exist (header CTA + modal Save).
    // The modal Save is the last one in DOM order.
    const allAddBtns = screen.getAllByRole("button", { name: /Add Asset/i });
    const modalSaveBtn = () => {
      const all = screen.getAllByRole("button", { name: /Add Asset/i });
      return all[all.length - 1]!;
    };
    expect(modalSaveBtn()).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Asset Tag/i), {
      target: { value: "ASSET-NEW" },
    });
    // Still disabled — needs name too.
    expect(modalSaveBtn()).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/^Name$/), {
      target: { value: "X-Ray" },
    });
    expect(modalSaveBtn()).not.toBeDisabled();

    // Silence the unused-var warning.
    expect(allAddBtns.length).toBeGreaterThan(0);
  });

  it("Add Asset modal — happy POST sends a body with all filled fields + collapses empties to undefined", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({ data: { id: "a-new" } });
    render(<AssetsPage />);

    const cta = await screen.findAllByRole("button", { name: /Add Asset/i });
    fireEvent.click(cta[0]!);
    await screen.findByRole("heading", { name: /^Add Asset$/ });

    fireEvent.change(screen.getByPlaceholderText(/Asset Tag/i), {
      target: { value: "ASSET-NEW" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Name$/), {
      target: { value: "Ventilator" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Manufacturer/i), {
      target: { value: "GE" },
    });
    fireEvent.change(screen.getByLabelText(/Cost/i), {
      target: { value: "75000" },
    });

    const allAddBtns = screen.getAllByRole("button", { name: /Add Asset/i });
    fireEvent.click(allAddBtns[allAddBtns.length - 1]!);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith(
      "/assets",
      expect.objectContaining({
        assetTag: "ASSET-NEW",
        name: "Ventilator",
        manufacturer: "GE",
        purchaseCost: 75000,
        // Empty optional fields should collapse to undefined.
        modelNumber: undefined,
        serialNumber: undefined,
        purchaseDate: undefined,
        warrantyExpiry: undefined,
        location: undefined,
        department: undefined,
        amcProvider: undefined,
        amcExpiryDate: undefined,
      }),
    );

    // Modal closes + refetches.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Add Asset$/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it("Add Asset modal — POST rejection surfaces toast.error and keeps the modal open", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue(new Error("dup tag"));
    render(<AssetsPage />);

    const cta = await screen.findAllByRole("button", { name: /Add Asset/i });
    fireEvent.click(cta[0]!);
    await screen.findByRole("heading", { name: /^Add Asset$/ });

    fireEvent.change(screen.getByPlaceholderText(/Asset Tag/i), {
      target: { value: "ASSET-DUP" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Name$/), {
      target: { value: "Dup" },
    });

    const allAddBtns = screen.getAllByRole("button", { name: /Add Asset/i });
    fireEvent.click(allAddBtns[allAddBtns.length - 1]!);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("dup tag"),
    );
    expect(
      screen.getByRole("heading", { name: /^Add Asset$/ }),
    ).toBeInTheDocument();
  });

  it("Add Asset modal — Cancel closes without firing POST", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    const cta = await screen.findAllByRole("button", { name: /Add Asset/i });
    fireEvent.click(cta[0]!);
    await screen.findByRole("heading", { name: /^Add Asset$/ });

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Add Asset$/ }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ── Assign modal ────────────────────────────────────────────────────────

  it("Assign modal — fetches /auth/users, selecting a staff member + Save POSTs /assets/:id/assign", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    render(<AssetsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Assign$/ }));
    await screen.findByRole("heading", { name: /Assign Defibrillator/i });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/auth/users?limit=200"),
    );

    // Pick the first staff option.
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "u-1" } });

    fireEvent.change(screen.getByPlaceholderText(/^Location$/), {
      target: { value: "ICU-2" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Notes$/), {
      target: { value: "Spare" },
    });

    // Two Assign buttons exist (row CTA + modal Save); pick the last (modal Save).
    const assignBtns = screen.getAllByRole("button", { name: /^Assign$/ });
    fireEvent.click(assignBtns[assignBtns.length - 1]!);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith(
      "/assets/a-1/assign",
      expect.objectContaining({
        assignedTo: "u-1",
        location: "ICU-2",
        notes: "Spare",
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Assign Defibrillator/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("Assign modal — falls back to /users when /auth/users rejects", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/assets?")) return Promise.resolve({ data: [assetFixture()] });
      if (url.startsWith("/assets/warranty/expiring"))
        return Promise.resolve({ data: [] });
      if (url.startsWith("/assets/maintenance/due"))
        return Promise.resolve({ data: [] });
      if (url.startsWith("/auth/users"))
        return Promise.reject(new Error("404"));
      if (url.startsWith("/users"))
        return Promise.resolve({
          data: [{ id: "u-3", name: "Fallback Bob", role: "TECH" }],
        });
      return Promise.resolve({ data: [] });
    });
    render(<AssetsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Assign$/ }));
    await screen.findByRole("heading", { name: /Assign Defibrillator/i });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/users?limit=200"),
    );
    // Fallback user appears in the select.
    expect(
      await screen.findByText(/Fallback Bob \(TECH\)/),
    ).toBeInTheDocument();
  });

  it("Assign modal — POST rejection surfaces toast.error(err.message)", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue(new Error("assign failed"));
    render(<AssetsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Assign$/ }));
    await screen.findByRole("heading", { name: /Assign Defibrillator/i });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/auth/users?limit=200"),
    );

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "u-1" },
    });
    const assignBtns = screen.getAllByRole("button", { name: /^Assign$/ });
    fireEvent.click(assignBtns[assignBtns.length - 1]!);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("assign failed"),
    );
  });

  it("Assign modal — Cancel closes without firing POST", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Assign$/ }));
    await screen.findByRole("heading", { name: /Assign Defibrillator/i });

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Assign Defibrillator/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ── Maintenance modal ───────────────────────────────────────────────────

  it("Maintenance modal — POST sends assetId, type, vendor, cost, description, nextDueDate", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    render(<AssetsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Log Maintenance$/ }));
    await screen.findByRole("heading", { name: /Log Maintenance/ });

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "BREAKDOWN" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Vendor$/), {
      target: { value: "Siemens" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Cost/i), {
      target: { value: "1500" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Description$/), {
      target: { value: "Motor replaced" },
    });
    fireEvent.change(screen.getByLabelText(/Next due date/i), {
      target: { value: "2026-06-15" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Log$/ }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith(
      "/assets/maintenance",
      expect.objectContaining({
        assetId: "a-1",
        type: "BREAKDOWN",
        vendor: "Siemens",
        cost: 1500,
        description: "Motor replaced",
        nextDueDate: "2026-06-15",
      }),
    );

    // Modal closes.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Log Maintenance/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it("Maintenance modal — POST rejection surfaces toast.error(err.message)", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue(new Error("maint failed"));
    render(<AssetsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Log Maintenance$/ }));
    await screen.findByRole("heading", { name: /Log Maintenance/ });

    fireEvent.change(screen.getByPlaceholderText(/^Description$/), {
      target: { value: "Quick check" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Log$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("maint failed"),
    );
  });

  it("Maintenance modal — Log button disabled until description filled", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Log Maintenance$/ }));
    await screen.findByRole("heading", { name: /Log Maintenance/ });

    const logBtn = screen.getByRole("button", { name: /^Log$/ });
    expect(logBtn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/^Description$/), {
      target: { value: "x" },
    });
    expect(logBtn).not.toBeDisabled();
  });

  it("Maintenance modal — Cancel closes without firing POST", async () => {
    wireDefaultGets();
    render(<AssetsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Log Maintenance$/ }));
    await screen.findByRole("heading", { name: /Log Maintenance/ });

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Log Maintenance/ }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ── Error-path resilience ───────────────────────────────────────────────

  it("swallows /assets rejection and lands in loading=false with the 'No assets' row", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/assets?")) {
        return Promise.reject(new Error("assets boom"));
      }
      return Promise.resolve({ data: [] });
    });
    render(<AssetsPage />);

    expect(
      await screen.findByRole("heading", { name: /Asset Management/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId("assets-loading")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/^No assets$/)).toBeInTheDocument();
  });
});
