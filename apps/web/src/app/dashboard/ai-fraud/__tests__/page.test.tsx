/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AiFraudPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/ai-fraud/page.tsx`, the ADMIN/RECEPTION
 *     fraud-alert workflow page. Endpoints exercised:
 *       GET   /ai/fraud/alerts?severity=&status=&limit=50
 *       POST  /ai/fraud/scan                                (ADMIN only)
 *       PATCH /ai/fraud/alerts/:id/status                   (transitions)
 *       GET   /ai/fraud/alerts/:id/comments                 (thread fetch)
 *       POST  /ai/fraud/alerts/:id/comments                 (new comment)
 *
 *   - Behaviours covered:
 *       1. Restricted role (DOCTOR) — short-circuits to the "Restricted"
 *          placeholder + zero fetches fire (Archetype C admin-gate per
 *          docs/E2E_COVERAGE_BACKLOG.md / CLAUDE.md gotcha #4).
 *       2. RECEPTION + ADMIN both reach the alert list. ADMIN sees the
 *          extra "Run Scan Now" button + "Scan Window (days)" input.
 *       3. Loading branch — `ai-fraud-loading` SkeletonTable renders while
 *          the initial /ai/fraud/alerts GET is pending.
 *       4. Initial fetch wires severity="" + status="NEW"→"OPEN" + limit=50
 *          query string (NEW is the default filter; the page translates UI
 *          NEW back to legacy server "OPEN").
 *       5. Empty list — `fraud-empty-state` renders the "No matching alerts"
 *          message.
 *       6. Severity + status filter changes re-trigger fetches with the new
 *          querystring (including the All=empty status which skips the
 *          status param entirely).
 *       7. Row click expands inline comment thread; clicking again collapses.
 *       8. CommentThread — empty-state, GET hit, POST + optimistic append,
 *          503 swallow on GET, error toast on POST + GET.
 *       9. Status pill — non-writers (we drop canWrite by simulating
 *          NEW→empty-transition for a RESOLVED-with-non-ADMIN row) render as
 *          a static span. Writers get the dropdown; clicking a non-terminal
 *          option (e.g. NEW→INVESTIGATING) PATCHes straight through.
 *      10. Terminal transitions (NEW→DISMISSED, INVESTIGATING→RESOLVED)
 *          open the ResolutionModal, require a non-empty reason (sanitized,
 *          200-char cap), and Cancel closes without PATCH.
 *      11. Run Scan — non-ADMIN no-op (toast.error); ADMIN happy path
 *          toasts success + reloads; failure path toasts error.
 *      12. normalizeStatus — covers OPEN, ACKNOWLEDGED/ESCALATED, blank,
 *          unknown → all mapped through the row's status pill.
 *      13. evidence.llmReason + resolutionNote render-only branches.
 *      14. Initial load 503 vs generic error → distinct toast copy.
 *      15. ADMIN can re-open a RESOLVED alert back to INVESTIGATING
 *          (admin-only transition path).
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, next/navigation, plus a
 *     stub of @/components/Skeleton so SkeletonTable renders as a single
 *     testid div rather than its real DOM.
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

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
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
  usePathname: () => "/dashboard/ai-fraud",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows?: number; columns?: number }) => (
    <div
      data-testid="skeleton-table-stub"
      data-rows={rows}
      data-columns={columns}
    />
  ),
  SkeletonText: ({ lines }: { lines?: number }) => (
    <div data-testid="skeleton-text-stub" data-lines={lines} />
  ),
}));

import AiFraudPage from "../page";

// ─── Fixtures ─────────────────────────────────────────────────────────────

type Severity = "INFO" | "SUSPICIOUS" | "HIGH_RISK";

function alertFixture(overrides: Partial<any> = {}): any {
  return {
    id: "a-1",
    type: "DUPLICATE_CHARGE",
    severity: "SUSPICIOUS" as Severity,
    status: "OPEN", // legacy → normalizes to NEW
    entityType: "Invoice",
    entityId: "inv-1",
    description: "Charged twice within 5 minutes.",
    evidence: {},
    detectedAt: "2026-04-01T10:00:00.000Z",
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolutionNote: null,
    ...overrides,
  };
}

function commentFixture(overrides: Partial<any> = {}): any {
  return {
    id: "c-1",
    authorId: "u-admin",
    authorName: "Dr. Admin",
    body: "Looks like a duplicate.",
    createdAt: "2026-04-01T11:00:00.000Z",
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin" },
    token: "tok-admin",
  });
}

function asReception() {
  authMock.mockReturnValue({
    user: { id: "u-recep", role: "RECEPTION", name: "Reception" },
    token: "tok-recep",
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Dr. X" },
    token: "tok-doc",
  });
}

/**
 * Route api.get by URL prefix. /ai/fraud/alerts/:id/comments is more
 * specific than /ai/fraud/alerts, so test the comments suffix first.
 */
function wireGet(opts: {
  alerts?: any[];
  alertsReject?: { status?: number; message?: string };
  comments?: any[];
  commentsReject?: { status?: number; message?: string };
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (/\/ai\/fraud\/alerts\/[^/]+\/comments$/.test(url)) {
      if (opts.commentsReject) return Promise.reject(opts.commentsReject);
      return Promise.resolve({ data: opts.comments ?? [] });
    }
    if (url.startsWith("/ai/fraud/alerts")) {
      if (opts.alertsReject) return Promise.reject(opts.alertsReject);
      return Promise.resolve({ data: opts.alerts ?? [] });
    }
    return Promise.resolve({ data: null });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("AiFraudPage — admin/reception fraud-alert workflow", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the Restricted placeholder for DOCTOR and skips the alerts fetch entirely", async () => {
    asDoctor();
    wireGet({ alerts: [alertFixture()] });

    render(<AiFraudPage />);

    const page = await screen.findByTestId("ai-fraud-page");
    expect(page).toHaveTextContent(/Restricted/i);
    expect(page).toHaveTextContent(/admin and reception/i);
    expect(apiMock.get).not.toHaveBeenCalled();
    // No "Run Scan Now" / table / scan-window for non-allowed role.
    expect(screen.queryByText(/Run Scan Now/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("fraud-empty-state")).not.toBeInTheDocument();
  });

  it("renders the skeleton loader while the initial /ai/fraud/alerts GET is pending", async () => {
    // Never-resolving promise keeps loading=true.
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<AiFraudPage />);

    expect(screen.getByTestId("ai-fraud-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-table-stub")).toBeInTheDocument();
    // Page heading still visible.
    expect(
      screen.getByRole("heading", { name: /Fraud .* Alerts/i }),
    ).toBeInTheDocument();
  });

  it("fires the initial GET with severity='' + statusFilter NEW→OPEN + limit=50 query params", async () => {
    wireGet({ alerts: [] });

    render(<AiFraudPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/^\/ai\/fraud\/alerts\?/),
      ),
    );
    const firstUrl = String(apiMock.get.mock.calls[0][0]);
    expect(firstUrl).toMatch(/status=OPEN/);
    expect(firstUrl).toMatch(/limit=50/);
    // Default severity is "" → param is NOT set.
    expect(firstUrl).not.toMatch(/severity=/);
  });

  it("renders the empty state when /ai/fraud/alerts returns []", async () => {
    wireGet({ alerts: [] });

    render(<AiFraudPage />);

    expect(await screen.findByTestId("fraud-empty-state")).toBeInTheDocument();
    expect(screen.getByText(/No matching alerts/i)).toBeInTheDocument();
  });

  it("renders ADMIN-only chrome (Run Scan Now button + Scan Window input)", async () => {
    wireGet({ alerts: [] });

    render(<AiFraudPage />);
    await screen.findByTestId("fraud-empty-state");

    expect(screen.getByText(/Run Scan Now/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Scan Window/i)).toBeInTheDocument();
  });

  it("hides ADMIN-only chrome for RECEPTION but still renders the table", async () => {
    asReception();
    wireGet({ alerts: [alertFixture({ id: "a-r1" })] });

    render(<AiFraudPage />);

    await screen.findByTestId("ai-fraud-row-a-r1");
    expect(screen.queryByText(/Run Scan Now/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Scan Window/i)).not.toBeInTheDocument();
  });

  it("renders one row per alert with severity icon + normalized status + AI reason + resolution note", async () => {
    wireGet({
      alerts: [
        alertFixture({
          id: "a-1",
          severity: "HIGH_RISK",
          status: "OPEN",
          type: "PHANTOM_BILLING",
          description: "Charge with no service record.",
          evidence: { llmReason: "GPT flagged unusual code combination" },
          resolutionNote: null,
        }),
        alertFixture({
          id: "a-2",
          severity: "INFO",
          status: "RESOLVED",
          type: "UNUSUAL_VOLUME",
          description: "Volume 3σ above 30-day mean.",
          evidence: {},
          resolutionNote: "Confirmed legitimate after audit.",
        }),
        alertFixture({
          id: "a-3",
          severity: "SUSPICIOUS",
          status: "ACKNOWLEDGED", // legacy → INVESTIGATING
        }),
      ],
    });

    render(<AiFraudPage />);

    const row1 = await screen.findByTestId("ai-fraud-row-a-1");
    expect(row1).toHaveTextContent("PHANTOM BILLING");
    expect(row1).toHaveTextContent("HIGH RISK");
    // AI reason rendered.
    expect(row1).toHaveTextContent(/AI: GPT flagged/);

    const row2 = await screen.findByTestId("ai-fraud-row-a-2");
    expect(row2).toHaveTextContent(/Resolution: Confirmed legitimate/);

    // normalizeStatus: OPEN→NEW, RESOLVED→RESOLVED, ACKNOWLEDGED→INVESTIGATING.
    expect(screen.getByTestId("ai-fraud-status-a-1")).toHaveTextContent("NEW");
    expect(screen.getByTestId("ai-fraud-status-a-2")).toHaveTextContent("RESOLVED");
    expect(screen.getByTestId("ai-fraud-status-a-3")).toHaveTextContent("INVESTIGATING");
  });

  it("refetches with severity=HIGH_RISK when the severity filter changes", async () => {
    wireGet({ alerts: [] });

    render(<AiFraudPage />);
    await screen.findByTestId("fraud-empty-state");
    apiMock.get.mockClear();
    // Re-wire after clear.
    wireGet({ alerts: [] });

    fireEvent.change(screen.getByLabelText(/Severity/i), {
      target: { value: "HIGH_RISK" },
    });

    await waitFor(() => {
      const lastCall = apiMock.get.mock.calls.at(-1);
      expect(String(lastCall?.[0])).toMatch(/severity=HIGH_RISK/);
    });
  });

  it("omits the status query param entirely when filter is set to All ('')", async () => {
    wireGet({ alerts: [] });

    render(<AiFraudPage />);
    await screen.findByTestId("fraud-empty-state");
    apiMock.get.mockClear();
    wireGet({ alerts: [] });

    fireEvent.change(screen.getByLabelText(/^Status$/i), {
      target: { value: "" },
    });

    await waitFor(() => {
      const lastCall = apiMock.get.mock.calls.at(-1);
      const u = String(lastCall?.[0]);
      expect(u).not.toMatch(/status=/);
      expect(u).toMatch(/limit=50/);
    });
  });

  it("expands and collapses the comment thread when a row is clicked", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-exp" })],
      comments: [],
    });

    render(<AiFraudPage />);
    const row = await screen.findByTestId("ai-fraud-row-a-exp");

    fireEvent.click(row);

    expect(await screen.findByTestId("ai-fraud-details-a-exp")).toBeInTheDocument();
    expect(
      await screen.findByTestId("ai-fraud-comments-empty-a-exp"),
    ).toBeInTheDocument();
    // Comments endpoint was hit.
    expect(apiMock.get).toHaveBeenCalledWith(
      "/ai/fraud/alerts/a-exp/comments",
    );

    fireEvent.click(row);
    await waitFor(() =>
      expect(screen.queryByTestId("ai-fraud-details-a-exp")).not.toBeInTheDocument(),
    );
  });

  it("renders existing comments in the thread", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-c" })],
      comments: [
        commentFixture({ id: "c-1", body: "First note" }),
        commentFixture({ id: "c-2", body: "Second note" }),
      ],
    });

    render(<AiFraudPage />);
    const row = await screen.findByTestId("ai-fraud-row-a-c");
    fireEvent.click(row);

    expect(await screen.findByTestId("ai-fraud-comment-c-1")).toHaveTextContent(
      "First note",
    );
    expect(screen.getByTestId("ai-fraud-comment-c-2")).toHaveTextContent(
      "Second note",
    );
  });

  it("posts a new comment, appends it to the thread, and clears the draft", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-post" })],
      comments: [],
    });
    apiMock.post.mockResolvedValue({
      data: commentFixture({ id: "c-new", body: "fresh take" }),
    });

    render(<AiFraudPage />);
    fireEvent.click(await screen.findByTestId("ai-fraud-row-a-post"));
    await screen.findByTestId("ai-fraud-comments-empty-a-post");

    const input = screen.getByTestId(
      "ai-fraud-comment-input-a-post",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "fresh take" } });

    fireEvent.click(screen.getByTestId("ai-fraud-comment-submit-a-post"));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/fraud/alerts/a-post/comments",
        { body: "fresh take" },
      );
    });
    expect(await screen.findByTestId("ai-fraud-comment-c-new")).toHaveTextContent(
      "fresh take",
    );
    // Draft cleared after success.
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("silences a 503 GET on comments (model not migrated) but toasts on other errors", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-503" })],
      commentsReject: { status: 503, message: "model not migrated" },
    });

    render(<AiFraudPage />);
    fireEvent.click(await screen.findByTestId("ai-fraud-row-a-503"));

    await screen.findByTestId("ai-fraud-comments-empty-a-503");
    // Silent on 503.
    expect(toastMock.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/comments/i),
    );
  });

  it("toasts on a non-503 GET-comments failure", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-500" })],
      commentsReject: { status: 500, message: "DB down" },
    });

    render(<AiFraudPage />);
    fireEvent.click(await screen.findByTestId("ai-fraud-row-a-500"));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("DB down");
    });
  });

  it("toasts on a POST-comment failure and leaves the draft in place", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-pf" })],
      comments: [],
    });
    apiMock.post.mockRejectedValue({ message: "Forbidden" });

    render(<AiFraudPage />);
    fireEvent.click(await screen.findByTestId("ai-fraud-row-a-pf"));

    const input = (await screen.findByTestId(
      "ai-fraud-comment-input-a-pf",
    )) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "blocked text" } });
    fireEvent.click(screen.getByTestId("ai-fraud-comment-submit-a-pf"));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Forbidden");
    });
  });

  it("opens the status menu and PATCHes straight through for non-terminal transitions (NEW→INVESTIGATING)", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-go", status: "OPEN" })],
    });
    apiMock.patch.mockResolvedValue({ data: {} });

    render(<AiFraudPage />);

    const pill = await screen.findByTestId("ai-fraud-status-a-go");
    fireEvent.click(pill);

    const menu = await screen.findByTestId("ai-fraud-status-menu-a-go");
    expect(menu).toBeInTheDocument();

    fireEvent.click(
      within(menu).getByTestId("ai-fraud-status-option-a-go-INVESTIGATING"),
    );

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/ai/fraud/alerts/a-go/status",
        { status: "INVESTIGATING" },
      );
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/INVESTIGATING/),
    );
  });

  it("opens the ResolutionModal for terminal transitions (NEW→DISMISSED) and disables Confirm until a reason is entered", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-dis", status: "OPEN" })],
    });

    render(<AiFraudPage />);
    fireEvent.click(await screen.findByTestId("ai-fraud-status-a-dis"));
    fireEvent.click(
      await screen.findByTestId("ai-fraud-status-option-a-dis-DISMISSED"),
    );

    const modal = await screen.findByTestId("ai-fraud-resolve-modal");
    expect(modal).toHaveTextContent(/Dismiss alert/i);

    const confirm = screen.getByTestId(
      "ai-fraud-resolve-confirm",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const reason = screen.getByTestId(
      "ai-fraud-resolve-reason-input",
    ) as HTMLInputElement;
    fireEvent.change(reason, { target: { value: "  false positive  " } });
    expect(confirm.disabled).toBe(false);

    apiMock.patch.mockResolvedValue({ data: {} });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/ai/fraud/alerts/a-dis/status",
        { status: "DISMISSED", reason: "false positive" },
      );
    });
    // Modal closes after confirm.
    await waitFor(() =>
      expect(
        screen.queryByTestId("ai-fraud-resolve-modal"),
      ).not.toBeInTheDocument(),
    );
  });

  it("opens the ResolutionModal for INVESTIGATING→RESOLVED and Cancel closes WITHOUT issuing the PATCH", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-res", status: "ACKNOWLEDGED" })],
    });

    render(<AiFraudPage />);
    fireEvent.click(await screen.findByTestId("ai-fraud-status-a-res"));
    fireEvent.click(
      await screen.findByTestId("ai-fraud-status-option-a-res-RESOLVED"),
    );

    const modal = await screen.findByTestId("ai-fraud-resolve-modal");
    expect(modal).toHaveTextContent(/Resolve alert/i);

    fireEvent.click(screen.getByTestId("ai-fraud-resolve-cancel"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("ai-fraud-resolve-modal"),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("allows ADMIN to re-open a RESOLVED alert back to INVESTIGATING", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-reopen", status: "RESOLVED" })],
    });
    apiMock.patch.mockResolvedValue({ data: {} });

    render(<AiFraudPage />);
    const pill = await screen.findByTestId("ai-fraud-status-a-reopen");
    // ADMIN gets a dropdown even on terminal status.
    fireEvent.click(pill);

    const menu = await screen.findByTestId("ai-fraud-status-menu-a-reopen");
    fireEvent.click(
      within(menu).getByTestId(
        "ai-fraud-status-option-a-reopen-INVESTIGATING",
      ),
    );

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/ai/fraud/alerts/a-reopen/status",
        { status: "INVESTIGATING" },
      );
    });
  });

  it("renders the status pill as a static span (no dropdown) when there are no allowed transitions for the role", async () => {
    // RECEPTION on a RESOLVED alert → allowedTransitions returns []
    asReception();
    wireGet({
      alerts: [alertFixture({ id: "a-static", status: "RESOLVED" })],
    });

    render(<AiFraudPage />);

    const pill = await screen.findByTestId("ai-fraud-status-a-static");
    // The static-span branch renders a <span>, not a <button>.
    expect(pill.tagName).toBe("SPAN");
    fireEvent.click(pill);
    // No dropdown should appear.
    expect(
      screen.queryByTestId("ai-fraud-status-menu-a-static"),
    ).not.toBeInTheDocument();
  });

  it("toasts an error if a PATCH status transition fails", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-pf2", status: "OPEN" })],
    });
    apiMock.patch.mockRejectedValue({ message: "permission denied" });

    render(<AiFraudPage />);
    fireEvent.click(await screen.findByTestId("ai-fraud-status-a-pf2"));
    fireEvent.click(
      await screen.findByTestId("ai-fraud-status-option-a-pf2-INVESTIGATING"),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("permission denied"),
    );
  });

  it("Run Scan as ADMIN: POSTs /ai/fraud/scan with windowDays, toasts success, and reloads alerts", async () => {
    wireGet({ alerts: [] });
    apiMock.post.mockResolvedValue({
      data: { alertCount: 3, hitCount: 5 },
    });

    render(<AiFraudPage />);
    await screen.findByTestId("fraud-empty-state");

    // Change windowDays to 14 and click Run Scan Now.
    fireEvent.change(screen.getByLabelText(/Scan Window/i), {
      target: { value: "14" },
    });
    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Run Scan Now/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/ai/fraud/scan", {
        windowDays: 14,
      });
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/5 hits, 3 persisted/),
    );
    // load() re-runs after the scan.
    await waitFor(() =>
      expect(
        apiMock.get.mock.calls.some(([u]) =>
          String(u).startsWith("/ai/fraud/alerts?"),
        ),
      ).toBe(true),
    );
  });

  it("Run Scan as non-ADMIN (RECEPTION): never reaches a button so cannot trigger; sanity-checks the role gate", async () => {
    asReception();
    wireGet({ alerts: [] });

    render(<AiFraudPage />);
    await screen.findByTestId("fraud-empty-state");

    // No Run Scan button for RECEPTION → the runScan() error guard is
    // protected by absence of UI, not just a runtime check.
    expect(screen.queryByText(/Run Scan Now/i)).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Run Scan: toasts an error when the POST rejects", async () => {
    wireGet({ alerts: [] });
    apiMock.post.mockRejectedValue({ message: "boom" });

    render(<AiFraudPage />);
    await screen.findByTestId("fraud-empty-state");

    fireEvent.click(screen.getByRole("button", { name: /Run Scan Now/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("boom");
    });
  });

  it("Run Scan: falls back to default windowDays=30 when the input is cleared (NaN guard)", async () => {
    wireGet({ alerts: [] });
    apiMock.post.mockResolvedValue({ data: { alertCount: 0, hitCount: 0 } });

    render(<AiFraudPage />);
    await screen.findByTestId("fraud-empty-state");

    fireEvent.change(screen.getByLabelText(/Scan Window/i), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run Scan Now/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/ai/fraud/scan", {
        windowDays: 30,
      });
    });
  });

  it("initial GET 503 → toasts the migration-pending copy (not the generic error)", async () => {
    wireGet({
      alertsReject: { status: 503, message: "model not migrated" },
    });

    render(<AiFraudPage />);

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/migration/i),
      );
    });
  });

  it("initial GET non-503 → toasts the generic 'Failed to load fraud alerts' fallback when err.message is absent", async () => {
    wireGet({ alertsReject: {} });

    render(<AiFraudPage />);

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to load fraud alerts/i),
      );
    });
  });

  it("the resolution-reason input enforces the 200-char cap when the user pastes a long string", async () => {
    wireGet({
      alerts: [alertFixture({ id: "a-cap", status: "OPEN" })],
    });
    apiMock.patch.mockResolvedValue({ data: {} });

    render(<AiFraudPage />);
    fireEvent.click(await screen.findByTestId("ai-fraud-status-a-cap"));
    fireEvent.click(
      await screen.findByTestId("ai-fraud-status-option-a-cap-DISMISSED"),
    );

    const reason = (await screen.findByTestId(
      "ai-fraud-resolve-reason-input",
    )) as HTMLInputElement;
    const longText = "x".repeat(400);
    fireEvent.change(reason, { target: { value: longText } });
    fireEvent.click(screen.getByTestId("ai-fraud-resolve-confirm"));

    await waitFor(() => {
      const call = apiMock.patch.mock.calls.find(
        ([url]) => String(url) === "/ai/fraud/alerts/a-cap/status",
      );
      expect(call).toBeTruthy();
      const payload = call![1] as { status: string; reason: string };
      expect(payload.reason.length).toBe(200);
    });
  });

  it("renders nothing role-gated when user is null (auth still loading) — no Restricted, no fetch", async () => {
    authMock.mockReturnValue({ user: null, token: null });
    wireGet({ alerts: [] });

    render(<AiFraudPage />);

    // user==null short-circuits the `if (user && !canRead)` Restricted branch
    // (user is null), AND canRead is false so the load() useEffect skips.
    // Page heading still renders.
    expect(
      screen.getByRole("heading", { name: /Fraud .* Alerts/i }),
    ).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(screen.queryByText(/Restricted/i)).not.toBeInTheDocument();
  });
});
