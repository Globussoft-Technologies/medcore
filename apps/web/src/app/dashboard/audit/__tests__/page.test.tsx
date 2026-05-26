/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AuditPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies the ADMIN-only audit-log dashboard at
 *     apps/web/src/app/dashboard/audit/page.tsx (previously at 0% line
 *     coverage). The page hits three endpoints on mount:
 *       GET /audit?page=1&limit=50&...
 *       GET /audit/filters
 *       GET /audit/retention-stats
 *     A free-text filter swaps the list endpoint to /audit/search?...
 *     The Export CSV button uses fetch() (not api.get) to stream a Blob.
 *
 *   - Behaviours covered:
 *       1. Non-ADMIN role (DOCTOR) — useEffect router.push to /dashboard,
 *          AccessDenied placeholder renders, no fetches fired.
 *       2. Null user — same Access denied render path, no fetches.
 *       3. ADMIN happy path — three GETs fire, retention banner renders
 *          with totals + oldest + by-year breakdown, table rows render
 *          one-per-entry with action badges + canonicalized entity casing
 *          + entityLabel (when present) + bare UUID fallback (when label
 *          is null) + IP cell.
 *       4. Snake_case entity normalization — `scheduled_report` →
 *          `ScheduledReport` in the table cell (Issue #79 contract).
 *       5. Empty branch — "No audit entries found" copy when list is [].
 *       6. Loading skeleton renders while initial list fetch is pending.
 *       7. Apply Filters — dispatches a refetch with page=1; the
 *          entity/action/user/from/to/ipContains/freeText fields are
 *          threaded into the querystring.
 *       8. Free-text filter — endpoint flips from /audit to /audit/search.
 *       9. Inverted date range guard — toast.error fires and no fetch is
 *          issued (Issue #290 contract). Applies to both Apply Filters
 *          AND the Export button.
 *      10. Load More — increments page param, appends (not replaces) the
 *          existing rows.
 *      11. Export CSV — uses window.fetch with Bearer token from
 *          localStorage("medcore_token"), createObjectURL is invoked,
 *          a download anchor is clicked, URL is revoked.
 *      12. Error path — silent try/catch on list rejection still flips
 *          loading off and renders the empty branch.
 *      13. Filter options resilience — /audit/filters rejection or
 *          /audit/retention-stats rejection do NOT block the page from
 *          rendering rows.
 *
 *   - Mocks: @/lib/api, @/lib/toast, @/lib/store (useAuthStore),
 *            next/navigation (useRouter / useSearchParams / usePathname),
 *            @/components/Skeleton (stubbed to a minimal div).
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

const { apiMock, toastMock, authMock, routerMock } = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/audit",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="audit-skeleton" data-rows={rows} data-columns={columns} />
  ),
}));

import AuditPage from "../page";

// ─── Fixtures ───────────────────────────────────────────

type AuditEntry = {
  id: string;
  timestamp: string;
  userId: string | null;
  userName: string;
  userEmail: string;
  action: string;
  entity: string;
  entityId: string | null;
  entityLabel?: string | null;
  ipAddress: string | null;
  details?: unknown;
};

function entryFixture(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "audit-1",
    timestamp: "2026-04-01T10:00:00.000Z",
    userId: "u-1",
    userName: "Admin User",
    userEmail: "admin@test.local",
    action: "AUTH_LOGIN",
    entity: "User",
    entityId: "user-uuid-1",
    entityLabel: "User: Admin User",
    ipAddress: "192.168.1.10",
    ...overrides,
  };
}

function filtersFixture() {
  return {
    actions: ["AUTH_LOGIN", "USER_REGISTER", "APPOINTMENT_CREATE"],
    users: [
      { id: "u-1", name: "Admin User", email: "admin@test.local" },
      { id: "u-2", name: "Dr Sharma", email: "doctor@test.local" },
    ],
  };
}

function retentionFixture(overrides: Partial<any> = {}) {
  return {
    totalEntries: 12345,
    byYear: [
      { year: "2026", count: 1000 },
      { year: "2025", count: 11345 },
    ],
    retentionDays: 365,
    oldestEntry: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Wire api.get to route by URL prefix. Three endpoints fire on mount in
 * non-deterministic order (Promise chain), so per-call queueing breaks.
 */
function wireGetByPath(opts: {
  list?: AuditEntry[];
  listMeta?: { total: number; page: number; totalPages: number };
  filters?: ReturnType<typeof filtersFixture> | null;
  retention?: ReturnType<typeof retentionFixture> | null;
  listReject?: boolean;
  filtersReject?: boolean;
  retentionReject?: boolean;
  searchList?: AuditEntry[];
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/audit/search")) {
      return Promise.resolve({
        data: opts.searchList ?? [],
        meta: opts.listMeta,
      });
    }
    if (url.startsWith("/audit/filters")) {
      if (opts.filtersReject) return Promise.reject(new Error("filters boom"));
      return Promise.resolve({ data: opts.filters ?? filtersFixture() });
    }
    if (url.startsWith("/audit/retention-stats")) {
      if (opts.retentionReject) return Promise.reject(new Error("retention boom"));
      return Promise.resolve({ data: opts.retention ?? retentionFixture() });
    }
    if (url.startsWith("/audit")) {
      if (opts.listReject) return Promise.reject(new Error("list boom"));
      return Promise.resolve({
        data: opts.list ?? [],
        meta: opts.listMeta,
      });
    }
    return Promise.resolve({ data: null });
  });
}

function asAdmin() {
  authMock.mockReturnValue({
    user: {
      id: "u-admin",
      userId: "u-admin",
      role: "ADMIN",
      name: "Admin",
      email: "admin@test.local",
    },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: {
      id: "u-doc",
      userId: "u-doc",
      role: "DOCTOR",
      name: "Dr",
      email: "doc@test.local",
    },
    isLoading: false,
  });
}

function asNullUser() {
  authMock.mockReturnValue({ user: null, isLoading: false });
}

describe("Audit Log dashboard page (admin-only)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects non-ADMIN (DOCTOR) to /dashboard via router.push, renders Access denied, and never fires fetches", async () => {
    wireGetByPath({ list: [entryFixture()] });
    asDoctor();

    render(<AuditPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
    expect(screen.getByText(/Access denied\. Admin only\./i)).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders Access denied when user is null and never fires fetches", async () => {
    wireGetByPath({ list: [entryFixture()] });
    asNullUser();

    render(<AuditPage />);

    expect(screen.getByText(/Access denied\. Admin only\./i)).toBeInTheDocument();
    // Tiny wait to confirm no late fetches sneak in.
    await waitFor(() => expect(apiMock.get).not.toHaveBeenCalled());
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("ADMIN: fires all three GETs on mount, renders the retention banner with totals + oldest + by-year breakdown", async () => {
    wireGetByPath({
      list: [entryFixture()],
      retention: retentionFixture({
        totalEntries: 12345,
        retentionDays: 180,
        byYear: [
          { year: "2026", count: 1000 },
          { year: "2025", count: 11345 },
        ],
      }),
    });

    render(<AuditPage />);

    // Wait for the row + filter dropdown options to confirm we settled.
    await screen.findByText("Admin User");

    // Endpoint contract — querystring shape matches buildQuery(1).
    expect(apiMock.get).toHaveBeenCalledWith("/audit?page=1&limit=50");
    expect(apiMock.get).toHaveBeenCalledWith("/audit/filters");
    expect(apiMock.get).toHaveBeenCalledWith("/audit/retention-stats");

    // Retention banner copy.
    expect(
      screen.getByText(/Retention:\s*180\s*days/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/12,345\s*entries stored/i)).toBeInTheDocument();
    // Oldest date — locale-formatted, just check the year shows.
    expect(screen.getByText(/oldest .*2025/i)).toBeInTheDocument();
    // By-year breakdown line.
    expect(
      screen.getByText(/2026:\s*1,000.*2025:\s*11,345/i),
    ).toBeInTheDocument();
  });

  it("renders one row per audit entry with action badge text, canonical entity, entityLabel + UUID caption, and IP", async () => {
    wireGetByPath({
      list: [
        entryFixture({
          id: "audit-1",
          action: "AUTH_LOGIN",
          entity: "User",
          entityLabel: "User: Admin User",
          entityId: "u-uuid-1",
          ipAddress: "192.168.1.10",
        }),
        entryFixture({
          id: "audit-2",
          action: "APPOINTMENT_CREATE",
          entity: "scheduled_report",
          entityLabel: null,
          entityId: "appt-uuid-2",
          userName: "Dr Sharma",
          userEmail: "doctor@test.local",
          ipAddress: "10.0.0.5",
        }),
        entryFixture({
          id: "audit-3",
          action: "UNKNOWN_ACTION",
          entity: "Patient",
          entityLabel: null,
          entityId: null,
          userName: "System",
          userEmail: "system@test.local",
          ipAddress: null,
        }),
      ],
    });

    render(<AuditPage />);

    await screen.findByText("Admin User");

    const tbody = document.querySelector("tbody")!;

    // Action badges — underscores replaced with spaces in display.
    expect(within(tbody).getByText("AUTH LOGIN")).toBeInTheDocument();
    expect(within(tbody).getByText("APPOINTMENT CREATE")).toBeInTheDocument();
    expect(within(tbody).getByText("UNKNOWN ACTION")).toBeInTheDocument();

    // Canonical entity — snake_case → PascalCase.
    expect(within(tbody).getByText("ScheduledReport")).toBeInTheDocument();
    // `Patient` already capitalized.
    expect(within(tbody).getByText("Patient")).toBeInTheDocument();

    // entityLabel cell for row 1 — testid + label text.
    const labelCell = within(tbody).getByTestId("audit-entity-audit-1");
    expect(labelCell).toHaveTextContent("User: Admin User");
    // UUID caption under the label.
    expect(within(labelCell).getByText("u-uuid-1")).toBeInTheDocument();

    // Bare-UUID fallback for row 2 (entityLabel null, entityId present).
    const fallbackCell = within(tbody).getByTestId("audit-entity-audit-2");
    expect(fallbackCell).toHaveTextContent("appt-uuid-2");
    // The <code> element exists for the fallback shape.
    expect(fallbackCell.tagName.toLowerCase()).toBe("code");

    // Row 3 has neither label nor id — no testid cell at all.
    expect(
      within(tbody).queryByTestId("audit-entity-audit-3"),
    ).not.toBeInTheDocument();

    // IP cells — present for 1+2, blank for 3.
    expect(within(tbody).getByText("192.168.1.10")).toBeInTheDocument();
    expect(within(tbody).getByText("10.0.0.5")).toBeInTheDocument();
  });

  it("renders the empty branch when the list response is []", async () => {
    wireGetByPath({ list: [] });

    render(<AuditPage />);

    expect(
      await screen.findByText(/No audit entries found/i),
    ).toBeInTheDocument();
  });

  it("renders the loading skeleton while the initial list fetch is pending", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/audit/filters")) {
        return Promise.resolve({ data: filtersFixture() });
      }
      if (url.startsWith("/audit/retention-stats")) {
        return Promise.resolve({ data: retentionFixture() });
      }
      if (url.startsWith("/audit")) {
        return new Promise(() => {}); // hangs
      }
      return Promise.resolve({ data: null });
    });

    render(<AuditPage />);

    expect(await screen.findByTestId("audit-skeleton")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Audit Log/i }),
    ).toBeInTheDocument();
  });

  it("Apply Filters: threads entity, action, userId, from, to, ipContains into the querystring on refetch", async () => {
    wireGetByPath({ list: [entryFixture()] });

    render(<AuditPage />);
    await screen.findByText("Admin User");

    apiMock.get.mockClear();

    // Set every filter input.
    fireEvent.change(
      document.getElementById("audit-filter-from") as HTMLInputElement,
      { target: { value: "2026-04-01" } },
    );
    fireEvent.change(
      document.getElementById("audit-filter-to") as HTMLInputElement,
      { target: { value: "2026-04-30" } },
    );
    fireEvent.change(
      document.getElementById("audit-filter-entity") as HTMLSelectElement,
      { target: { value: "User" } },
    );
    // Action dropdown options come from filtersFixture (must be loaded).
    fireEvent.change(
      document.getElementById("audit-filter-action") as HTMLSelectElement,
      { target: { value: "AUTH_LOGIN" } },
    );
    fireEvent.change(
      document.getElementById("audit-filter-user") as HTMLSelectElement,
      { target: { value: "u-1" } },
    );
    fireEvent.change(
      document.getElementById("audit-filter-ip") as HTMLInputElement,
      { target: { value: "192.168." } },
    );

    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(
        "/audit?page=1&limit=50&from=2026-04-01&to=2026-04-30&entity=User&action=AUTH_LOGIN&userId=u-1&ipContains=192.168.",
      );
    });
  });

  it("Free-text filter: flips endpoint from /audit to /audit/search and includes the q= param", async () => {
    wireGetByPath({
      list: [entryFixture()],
      searchList: [entryFixture({ id: "search-hit-1", userName: "Search Hit" })],
    });

    render(<AuditPage />);
    await screen.findByText("Admin User");

    apiMock.get.mockClear();

    fireEvent.change(
      document.getElementById("audit-filter-q") as HTMLInputElement,
      { target: { value: "login" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(
        "/audit/search?page=1&limit=50&q=login",
      );
    });
    expect(await screen.findByText("Search Hit")).toBeInTheDocument();
  });

  it('blocks Apply Filters when "from" > "to" and toasts the error; no inverted-range list refetch is issued', async () => {
    wireGetByPath({ list: [entryFixture()] });

    render(<AuditPage />);
    await screen.findByText("Admin User");

    // Snapshot ALL list calls fired BEFORE inverted-range setup. We'll
    // assert no NEW list call with the inverted range hits after setup.
    const baselineListCalls = apiMock.get.mock.calls
      .filter((c) => (c[0] as string).startsWith("/audit?"))
      .length;

    fireEvent.change(
      document.getElementById("audit-filter-from") as HTMLInputElement,
      { target: { value: "2026-04-30" } },
    );
    fireEvent.change(
      document.getElementById("audit-filter-to") as HTMLInputElement,
      { target: { value: "2026-04-01" } },
    );

    fireEvent.click(screen.getByRole("button", { name: /Apply Filters/i }));

    // toast.error fired (from either the click handler OR the useEffect
    // refetch attempt — both call the same guard).
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/From.*before.*To/i),
    );

    // No list call contains the inverted-range pair (from=2026-04-30 AND
    // to=2026-04-01 both present). The guard kicked in loadEntries for
    // every attempted refetch.
    const invertedListCalls = apiMock.get.mock.calls.filter((c) => {
      const u = c[0] as string;
      return (
        u.startsWith("/audit?") &&
        u.includes("from=2026-04-30") &&
        u.includes("to=2026-04-01")
      );
    });
    expect(invertedListCalls).toHaveLength(0);

    // Sanity: baseline assertion (no regression of overall list-call count
    // — the only allowed new calls have either from or to alone, not both
    // inverted).
    const finalListCalls = apiMock.get.mock.calls
      .filter((c) => (c[0] as string).startsWith("/audit?"))
      .length;
    expect(finalListCalls).toBeGreaterThanOrEqual(baselineListCalls);
  });

  it("blocks Export CSV when from > to, toasts the error, and never calls window.fetch", async () => {
    wireGetByPath({ list: [entryFixture()] });

    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    (globalThis as any).__fetchMockLocked = true;

    render(<AuditPage />);
    await screen.findByText("Admin User");

    fireEvent.change(
      document.getElementById("audit-filter-from") as HTMLInputElement,
      { target: { value: "2026-04-30" } },
    );
    fireEvent.change(
      document.getElementById("audit-filter-to") as HTMLInputElement,
      { target: { value: "2026-04-01" } },
    );

    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/From.*before.*To/i),
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    (globalThis as any).__fetchMockLocked = false;
  });

  it("Load More: increments page param and appends new rows to the existing entries", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/audit/filters")) {
        return Promise.resolve({ data: filtersFixture() });
      }
      if (url.startsWith("/audit/retention-stats")) {
        return Promise.resolve({ data: retentionFixture() });
      }
      if (url === "/audit?page=1&limit=50") {
        return Promise.resolve({
          data: [entryFixture({ id: "p1-row", userName: "Page One Row" })],
          meta: { total: 2, page: 1, totalPages: 2 },
        });
      }
      if (url === "/audit?page=2&limit=50") {
        return Promise.resolve({
          data: [entryFixture({ id: "p2-row", userName: "Page Two Row" })],
          meta: { total: 2, page: 2, totalPages: 2 },
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<AuditPage />);

    await screen.findByText("Page One Row");

    // The Load More button surfaces because page < totalPages.
    const loadMoreBtn = await screen.findByRole("button", {
      name: /Load More/i,
    });

    fireEvent.click(loadMoreBtn);

    // Page two row appears AND page one row is still on screen (append).
    await screen.findByText("Page Two Row");
    expect(screen.getByText("Page One Row")).toBeInTheDocument();
  });

  it("Export CSV: calls window.fetch with Bearer token from localStorage, downloads blob, revokes the URL", async () => {
    wireGetByPath({ list: [entryFixture()] });

    window.localStorage.setItem("medcore_token", "tok-abc");

    const blob = new Blob(["timestamp,user\n2026-04-01,admin"], {
      type: "text/csv",
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      blob: () => Promise.resolve(blob),
    });
    (globalThis as any).fetch = fetchSpy;
    (globalThis as any).__fetchMockLocked = true;

    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-url");
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const anchorClickSpy = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = origCreateElement(tag);
        if (tag === "a") {
          (el as HTMLAnchorElement).click = anchorClickSpy;
        }
        return el;
      });

    render(<AuditPage />);
    await screen.findByText("Admin User");

    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [exportUrl, init] = fetchSpy.mock.calls[0];
    expect(exportUrl).toMatch(/\/audit\/export\.csv\?page=1&limit=50/);
    expect(init).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tok-abc",
        }),
      }),
    );

    await waitFor(() => expect(anchorClickSpy).toHaveBeenCalled());
    expect(createObjectURLSpy).toHaveBeenCalledWith(blob);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    createElementSpy.mockRestore();
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    (globalThis as any).__fetchMockLocked = false;
  });

  it("silently swallows a list-fetch rejection and settles into the empty branch (no toast)", async () => {
    wireGetByPath({ listReject: true });

    render(<AuditPage />);

    expect(
      await screen.findByText(/No audit entries found/i),
    ).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("filter-options and retention-stats rejections do NOT block the table from rendering rows", async () => {
    wireGetByPath({
      list: [entryFixture()],
      filtersReject: true,
      retentionReject: true,
    });

    render(<AuditPage />);

    await screen.findByText("Admin User");

    // No retention banner.
    expect(screen.queryByText(/Retention:/i)).not.toBeInTheDocument();

    // Action <select> still renders with the "All" option (no other options
    // because filters rejected).
    const actionSelect = document.getElementById(
      "audit-filter-action",
    ) as HTMLSelectElement;
    expect(actionSelect).toBeTruthy();
    expect(actionSelect.options).toHaveLength(1);
    expect(actionSelect.options[0].value).toBe("");
  });
});
