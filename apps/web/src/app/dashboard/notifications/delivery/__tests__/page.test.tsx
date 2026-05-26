/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NotificationDeliveryPage — adjacent-to-source coverage (test-cron pick 2026-05-25).
 *
 * What / which modules / why:
 *   - Verifies every branch of `apps/web/src/app/dashboard/notifications/delivery/page.tsx`,
 *     an ADMIN-only client component that lists notification delivery rows from
 *     `GET /notifications/delivery` with optional status/channel/from/to filters
 *     and offers a per-row "Retry" action (`POST /notifications/:id/retry`) when
 *     the row's deliveryStatus is FAILED.
 *   - Behaviours covered:
 *       1. Initial loading branch — `aria-busy="true"` tbody +
 *          `data-testid="notifications-delivery-loading"` rendered while the
 *          first fetch is in flight.
 *       2. Happy fetch — rows render with channel, status badge, recipient,
 *          and a Retry button ONLY on FAILED rows.
 *       3. Empty state — "No notifications match the filters." copy renders
 *          when the API returns an empty array.
 *       4. Error fallback — `api.get` rejection is swallowed by the inner
 *          try/catch, so `loading` flips to false and the empty-state row
 *          renders (no error banner; matches the page's `// ignore` contract).
 *       5. Filter interactions — changing the status/channel selects + the
 *          from/to date inputs re-issues `GET /notifications/delivery` with
 *          the matching query string params.
 *       6. Refresh button — clicking "Refresh" re-runs the fetch with the
 *          currently-selected filter state.
 *       7. Retry action — clicking Retry on a FAILED row POSTs to
 *          `/notifications/:id/retry`, fires a success toast, and reloads.
 *       8. Retry error path — POST rejection fires an error toast with the
 *            thrown message; uses the `err instanceof Error` branch.
 *       9. RBAC — non-ADMIN user (DOCTOR / PATIENT) triggers
 *          `router.push('/dashboard')`.
 *
 *   - Source under test: apps/web/src/app/dashboard/notifications/delivery/page.tsx
 *   - Mocks: @/lib/api (api.get + api.post), @/lib/store (useAuthStore),
 *            @/lib/toast (toast.success / toast.error),
 *            next/navigation (useRouter), @/components/Skeleton (SkeletonRow
 *            passthrough), @/lib/format (formatDateTime passthrough).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";

const { apiMock, authMock, routerMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    forward: vi.fn(),
  },
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
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/notifications/delivery",
}));
// Skeleton + format passthroughs — their real impls aren't under test.
vi.mock("@/components/Skeleton", () => ({
  SkeletonRow: ({ columns }: { columns?: number }) => (
    <tr data-testid="skeleton-row" data-columns={columns ?? 1}>
      <td colSpan={columns ?? 1} />
    </tr>
  ),
}));
vi.mock("@/lib/format", () => ({
  formatDateTime: (v: any) => (v == null ? "—" : String(v)),
}));

import NotificationDeliveryPage from "../page";

// Source uses `const { user } = useAuthStore()` (object-destructure, no
// selector callback) — so the mock returns the state object directly.
function setAuth(user: { id?: string; name?: string; email?: string; role?: string } | null) {
  authMock.mockReturnValue({ user });
}

function row(overrides: Partial<{
  id: string;
  type: string;
  channel: string;
  title: string;
  message: string;
  deliveryStatus: "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED";
  failureReason: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string; phone: string };
}> = {}) {
  return {
    id: "ntfn-1",
    type: "APPOINTMENT_REMINDER",
    channel: "WHATSAPP",
    title: "Reminder",
    message: "Your appointment is tomorrow",
    deliveryStatus: "DELIVERED" as const,
    failureReason: null,
    sentAt: "2026-05-24T10:00:00.000Z",
    deliveredAt: "2026-05-24T10:00:05.000Z",
    readAt: null,
    createdAt: "2026-05-24T09:59:00.000Z",
    user: {
      id: "u-asha",
      name: "Asha Iyer",
      email: "asha@example.com",
      phone: "+919876543210",
    },
    ...overrides,
  };
}

describe("NotificationDeliveryPage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerMock.push.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    authMock.mockReset();
    // Default: ADMIN user — RBAC effect is a no-op.
    setAuth({ id: "u-admin", name: "Admin", email: "a@x.com", role: "ADMIN" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the loading skeleton + aria-busy tbody while the first fetch is in flight", async () => {
    // Never-settling promise keeps the component in the loading branch.
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<NotificationDeliveryPage />);

    const loadingTbody = await screen.findByTestId(
      "notifications-delivery-loading"
    );
    expect(loadingTbody).toBeInTheDocument();
    expect(loadingTbody).toHaveAttribute("aria-busy", "true");
    // The page renders 5 SkeletonRow stubs in the loading branch.
    expect(screen.getAllByTestId("skeleton-row")).toHaveLength(5);
    // Header chrome is still present.
    expect(
      screen.getByRole("heading", { name: /notification delivery status/i })
    ).toBeInTheDocument();
  });

  it("renders fetched rows with the per-row Retry button only on FAILED rows", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        row({
          id: "ntfn-ok",
          channel: "WHATSAPP",
          deliveryStatus: "DELIVERED",
          failureReason: null,
        }),
        row({
          id: "ntfn-fail",
          channel: "SMS",
          deliveryStatus: "FAILED",
          failureReason: "Carrier rejected",
          user: {
            id: "u-bob",
            name: "Bob Tan",
            email: "bob@example.com",
            phone: "+6591234567",
          },
        }),
      ],
    });

    render(<NotificationDeliveryPage />);

    // First load uses an empty querystring (no filters yet).
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/delivery?");
    });

    // Both recipients render.
    expect(await screen.findByText("Asha Iyer")).toBeInTheDocument();
    expect(screen.getByText("Bob Tan")).toBeInTheDocument();

    // Status badges render the canonical literal.
    expect(screen.getByText("DELIVERED")).toBeInTheDocument();
    expect(screen.getByText("FAILED")).toBeInTheDocument();

    // Failure reason rendered for FAILED row, em-dash for the OK row.
    expect(screen.getByText("Carrier rejected")).toBeInTheDocument();

    // Retry button ONLY on the FAILED row → exactly one.
    const retryButtons = screen.getAllByRole("button", { name: /retry/i });
    expect(retryButtons).toHaveLength(1);

    // After the fetch settles the loading-tbody marker is gone.
    expect(
      screen.queryByTestId("notifications-delivery-loading")
    ).not.toBeInTheDocument();
  });

  it("renders the empty-state copy when the API returns an empty array", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationDeliveryPage />);

    expect(
      await screen.findByText(/no notifications match the filters\./i)
    ).toBeInTheDocument();
    // No Retry buttons in the empty state.
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("falls back to the empty state when the GET rejects (inner try/catch swallows)", async () => {
    apiMock.get.mockRejectedValue(new Error("API down"));

    render(<NotificationDeliveryPage />);

    // The page's inline `catch { /* ignore */ }` flips loading off WITHOUT
    // re-throwing — so the empty-rows branch renders.
    expect(
      await screen.findByText(/no notifications match the filters\./i)
    ).toBeInTheDocument();
    // No toast surfaces on initial-load failure.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("re-issues the fetch with the encoded querystring when status/channel/from/to filters change", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<NotificationDeliveryPage />);

    // Initial fetch (no filters).
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/delivery?")
    );

    // Change status → FAILED. (label is "Status" → htmlFor="notif-delivery-status")
    fireEvent.change(screen.getByLabelText(/^status$/i), {
      target: { value: "FAILED" },
    });
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/notifications/delivery?status=FAILED"
      )
    );

    // Change channel → SMS.
    fireEvent.change(screen.getByLabelText(/^channel$/i), {
      target: { value: "SMS" },
    });
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/notifications/delivery?status=FAILED&channel=SMS"
      )
    );

    // Change from + to date inputs.
    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "2026-05-01" },
    });
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/notifications/delivery?status=FAILED&channel=SMS&from=2026-05-01"
      )
    );

    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: "2026-05-24" },
    });
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/notifications/delivery?status=FAILED&channel=SMS&from=2026-05-01&to=2026-05-24"
      )
    );
  });

  it("the Refresh button re-runs the fetch with the current filter state", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<NotificationDeliveryPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/delivery?")
    );

    const callCountBefore = apiMock.get.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(callCountBefore)
    );
    // No new filter state → same querystring.
    expect(apiMock.get).toHaveBeenLastCalledWith("/notifications/delivery?");
  });

  it("clicking Retry on a FAILED row POSTs /notifications/:id/retry, toasts success, and reloads", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        row({
          id: "ntfn-fail",
          deliveryStatus: "FAILED",
          failureReason: "Carrier rejected",
        }),
      ],
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<NotificationDeliveryPage />);

    const retryBtn = await screen.findByRole("button", { name: /retry/i });
    const initialGetCount = apiMock.get.mock.calls.length;

    fireEvent.click(retryBtn);

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/notifications/ntfn-fail/retry")
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Retry triggered")
    );
    // Reload — at least one more GET.
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(initialGetCount)
    );
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Retry POST rejection fires an error toast carrying the thrown message", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        row({
          id: "ntfn-fail",
          deliveryStatus: "FAILED",
          failureReason: "Carrier rejected",
        }),
      ],
    });
    apiMock.post.mockRejectedValue(new Error("Network unreachable"));

    render(<NotificationDeliveryPage />);

    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Network unreachable")
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("Retry POST rejection with a non-Error rejection falls back to the generic message", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        row({
          id: "ntfn-fail",
          deliveryStatus: "FAILED",
          failureReason: "x",
        }),
      ],
    });
    // Reject with a plain string — exercises the `err instanceof Error ? … : "Retry failed"` else-branch.
    apiMock.post.mockRejectedValue("boom");

    render(<NotificationDeliveryPage />);
    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Retry failed")
    );
  });

  it("redirects non-ADMIN users (e.g. DOCTOR) to /dashboard via router.push", async () => {
    setAuth({ id: "u-doc", name: "Dr. Sharma", email: "d@x.com", role: "DOCTOR" });
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationDeliveryPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("redirects PATIENT users to /dashboard via router.push", async () => {
    setAuth({ id: "p1", name: "Asha", email: "a@x.com", role: "PATIENT" });
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationDeliveryPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("does NOT redirect when user is null (pre-auth-resolution race window)", async () => {
    setAuth(null);
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationDeliveryPage />);

    // Wait long enough for the effect to settle, then assert no push.
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/delivery?")
    );
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});
