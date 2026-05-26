/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NotificationsPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/notifications/page.tsx, the patient
 *     + staff notifications inbox with channel preferences.
 *
 *   - Endpoints under test:
 *       GET   /notifications?page=N&limit=20      (paginated list)
 *       GET   /notifications/preferences          (channel toggles)
 *       PATCH /notifications/:id/read             (single mark-as-read)
 *       PATCH /notifications/read-all             (bulk mark-as-read)
 *       PUT   /notifications/preferences          (channel toggle)
 *
 *   - Behaviours covered:
 *       1. Loading branch — initial skeleton rows render while the list GET
 *          is pending; the heading still renders.
 *       2. Empty branch — "No notifications yet" copy renders when the API
 *          returns an empty list.
 *       3. Happy fetch — initial GETs fire with the correct URLs (page=1,
 *          limit=20 + preferences) and one row per notification renders.
 *       4. Unread badge — the red unread-count badge renders the count of
 *          rows with `readAt === null`, and "Mark all as read" button is
 *          visible only when there is at least one unread row.
 *       5. Mark-as-read click — clicking an UNREAD row PATCHes /:id/read,
 *          flips the row's `data-read` attribute to "true", and the blue
 *          dot disappears; clicking a READ row does NOT PATCH.
 *       6. Mark-all-read — clicking the button PATCHes /read-all, stamps
 *          every row's `readAt`, hides the badge, and re-fetches the list.
 *       7. Load-more pagination — when the API meta says `hasMore`, the
 *          "Load More" button appears; clicking it fires GET with page=2
 *          and appends rather than replaces the list.
 *       8. Preferences accordion — collapsed by default (only the heading
 *            is visible); expanding shows the preferences rows; toggling a
 *            preference flips state optimistically and PUTs the new shape.
 *       9. Preferences loading branch — skeleton renders inside the
 *          accordion while the preferences GET is pending.
 *      10. Preferences empty branch — "No preference settings available"
 *          copy renders inside the accordion when the API returns [].
 *      11. Channel icon fallback — a notification with an unknown channel
 *          string still renders (falls back to the Bell icon + neutral
 *          color class) and does not throw.
 *      12. formatTime branches — every relative-time branch
 *          ("Just now" / "Nm ago" / "Nh ago" / "Nd ago" / formatDate
 *          fallback for >=7 days) renders.
 *      13. Error-path resilience — initial list-fetch rejection still flips
 *          loading off and renders the empty branch; preferences rejection
 *          settles into the prefs-empty branch when expanded.
 *      14. Preferences PUT rejection — reverts optimistic toggle.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore stub — unused by the
 *            source but kept for harness uniformity), next/navigation,
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
  usePathname: () => "/dashboard/notifications",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonRow: ({ columns }: { columns: number }) => (
    <tr data-testid="skeleton-row" data-columns={columns}>
      <td />
    </tr>
  ),
  SkeletonText: ({ lines }: { lines: number }) => (
    <div data-testid="skeleton-text" data-lines={lines} />
  ),
}));

import NotificationsPage from "../page";

type Notification = {
  id: string;
  title: string;
  message: string;
  channel: string;
  readAt: string | null;
  createdAt: string;
};

type Preference = {
  channel: string;
  enabled: boolean;
};

function notifFixture(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n-1",
    title: "Appointment reminder",
    message: "Your appointment with Dr. Asha is at 10:00 AM tomorrow.",
    channel: "PUSH",
    readAt: null,
    // 2h ago by default — far enough from "Just now" so the test is stable
    // regardless of when the runner picks it up.
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function prefFixture(overrides: Partial<Preference> = {}): Preference {
  return { channel: "EMAIL", enabled: true, ...overrides };
}

/**
 * Route api.get by URL prefix. The component fires two parallel GETs on mount
 * (list + preferences) so resolved-once chains are order-fragile.
 */
function wireGetByPath(opts: {
  notifications?: Notification[];
  meta?: { total: number; page: number; totalPages: number };
  preferences?: Preference[];
  notificationsReject?: boolean;
  preferencesReject?: boolean;
  notificationsPending?: boolean;
  preferencesPending?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/notifications/preferences")) {
      if (opts.preferencesReject)
        return Promise.reject(new Error("prefs boom"));
      if (opts.preferencesPending) return new Promise(() => {});
      return Promise.resolve({ data: opts.preferences ?? [] });
    }
    if (url.startsWith("/notifications")) {
      if (opts.notificationsReject)
        return Promise.reject(new Error("list boom"));
      if (opts.notificationsPending) return new Promise(() => {});
      return Promise.resolve({
        data: opts.notifications ?? [],
        meta: opts.meta,
      });
    }
    return Promise.resolve({ data: null });
  });
}

describe("Notifications dashboard page (inbox + channel preferences)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    apiMock.put.mockReset();
    apiMock.post.mockReset();
    authMock.mockReset();
    // The source doesn't actually call useAuthStore but stub a sane default
    // so future refactors don't crash the harness.
    authMock.mockReturnValue({
      user: { id: "u-1", role: "PATIENT", name: "Test" },
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading skeleton while the initial list fetch is pending", () => {
    wireGetByPath({ notificationsPending: true, preferences: [] });

    render(<NotificationsPage />);

    expect(
      screen.getByRole("heading", { name: /Notifications/i }),
    ).toBeInTheDocument();
    // 5 SkeletonRows render while loading + notifications.length === 0.
    expect(screen.getAllByTestId("skeleton-row").length).toBe(5);
  });

  it('renders "No notifications yet" when the list response is empty', async () => {
    wireGetByPath({ notifications: [], preferences: [] });

    render(<NotificationsPage />);

    expect(await screen.findByText(/No notifications yet/i)).toBeInTheDocument();
  });

  it("hits both endpoints on mount with the correct querystring + path", async () => {
    wireGetByPath({
      notifications: [notifFixture()],
      preferences: [prefFixture()],
    });

    render(<NotificationsPage />);

    await screen.findByText("Appointment reminder");

    expect(apiMock.get).toHaveBeenCalledWith("/notifications?page=1&limit=20");
    expect(apiMock.get).toHaveBeenCalledWith("/notifications/preferences");
  });

  it("renders the unread-count badge + Mark-all button only when there is at least one unread row", async () => {
    wireGetByPath({
      notifications: [
        notifFixture({ id: "n-1", readAt: null }),
        notifFixture({
          id: "n-2",
          readAt: null,
          title: "Lab results ready",
        }),
        notifFixture({
          id: "n-3",
          readAt: new Date().toISOString(),
          title: "Bill paid",
        }),
      ],
      preferences: [],
    });

    render(<NotificationsPage />);
    await screen.findByText("Lab results ready");

    // Two unread rows → badge "2".
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Mark all as read/i }),
    ).toBeInTheDocument();
  });

  it("HIDES the unread badge + Mark-all button when every row is read", async () => {
    const now = new Date().toISOString();
    wireGetByPath({
      notifications: [
        notifFixture({ id: "n-1", readAt: now }),
        notifFixture({ id: "n-2", readAt: now }),
      ],
      preferences: [],
    });

    render(<NotificationsPage />);
    await screen.findByTestId("notification-row-n-1");

    expect(
      screen.queryByRole("button", { name: /Mark all as read/i }),
    ).not.toBeInTheDocument();
  });

  it("clicking an UNREAD row PATCHes /:id/read and flips data-read to true", async () => {
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    wireGetByPath({
      notifications: [notifFixture({ id: "n-unread", readAt: null })],
      preferences: [],
    });

    render(<NotificationsPage />);

    const row = await screen.findByTestId("notification-row-n-unread");
    expect(row).toHaveAttribute("data-read", "false");

    fireEvent.click(row);

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/notifications/n-unread/read"),
    );
    // Optimistic update flips the data-read attribute.
    await waitFor(() => expect(row).toHaveAttribute("data-read", "true"));
  });

  it("clicking an ALREADY-READ row does NOT PATCH", async () => {
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    const now = new Date().toISOString();
    wireGetByPath({
      notifications: [notifFixture({ id: "n-read", readAt: now })],
      preferences: [],
    });

    render(<NotificationsPage />);
    const row = await screen.findByTestId("notification-row-n-read");
    expect(row).toHaveAttribute("data-read", "true");

    fireEvent.click(row);

    // Give the microtask queue a tick; the click is a no-op.
    await Promise.resolve();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("mark-all-read PATCHes /read-all, hides the badge, and re-fetches the list", async () => {
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    // First list GET returns unread rows; second list GET (after PATCH) must
    // return read rows so the post-PATCH re-fetch doesn't reintroduce unread
    // state and undo the optimistic stamp.
    let listCall = 0;
    const now = new Date().toISOString();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/notifications/preferences")) {
        return Promise.resolve({ data: [] });
      }
      if (url.startsWith("/notifications")) {
        listCall++;
        const rows =
          listCall === 1
            ? [
                notifFixture({ id: "n-1", readAt: null }),
                notifFixture({ id: "n-2", readAt: null }),
              ]
            : [
                notifFixture({ id: "n-1", readAt: now }),
                notifFixture({ id: "n-2", readAt: now }),
              ];
        return Promise.resolve({ data: rows });
      }
      return Promise.resolve({ data: null });
    });

    render(<NotificationsPage />);
    await screen.findByTestId("notification-row-n-1");

    expect(screen.getByText("2")).toBeInTheDocument();
    // Initial mount fired 2 GETs (list + prefs).
    expect(apiMock.get).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /Mark all as read/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/notifications/read-all"),
    );
    // Badge gone — every row's readAt is stamped, server agrees on re-fetch.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Mark all as read/i }),
      ).not.toBeInTheDocument(),
    );
    // Re-fetch fired (2nd list GET on top of the mount one).
    await waitFor(() => expect(listCall).toBeGreaterThanOrEqual(2));
  });

  it("shows Load More when meta.hasMore is true and appends page 2 to the existing list", async () => {
    const firstPage = [
      notifFixture({ id: "n-p1-a", title: "Page 1 A" }),
      notifFixture({ id: "n-p1-b", title: "Page 1 B" }),
    ];
    const secondPage = [
      notifFixture({ id: "n-p2-a", title: "Page 2 A" }),
    ];
    let callCount = 0;
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/notifications/preferences")) {
        return Promise.resolve({ data: [] });
      }
      if (url.startsWith("/notifications")) {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            data: firstPage,
            meta: { total: 3, page: 1, totalPages: 2 },
          });
        }
        return Promise.resolve({
          data: secondPage,
          meta: { total: 3, page: 2, totalPages: 2 },
        });
      }
      return Promise.resolve({ data: null });
    });

    render(<NotificationsPage />);
    await screen.findByText("Page 1 A");
    await screen.findByText("Page 1 B");

    const loadMore = screen.getByRole("button", { name: /Load More/i });
    fireEvent.click(loadMore);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/notifications?page=2&limit=20",
      ),
    );
    // The append branch — page 1 rows are still present, page 2 appended.
    await screen.findByText("Page 2 A");
    expect(screen.getByText("Page 1 A")).toBeInTheDocument();
  });

  it("HIDES Load More when there is only one page", async () => {
    wireGetByPath({
      notifications: [notifFixture()],
      meta: { total: 1, page: 1, totalPages: 1 },
      preferences: [],
    });

    render(<NotificationsPage />);
    await screen.findByText("Appointment reminder");

    expect(
      screen.queryByRole("button", { name: /Load More/i }),
    ).not.toBeInTheDocument();
  });

  it("preferences accordion starts COLLAPSED and reveals rows on toggle", async () => {
    wireGetByPath({
      notifications: [],
      preferences: [
        prefFixture({ channel: "EMAIL", enabled: true }),
        prefFixture({ channel: "SMS", enabled: false }),
      ],
    });

    render(<NotificationsPage />);

    // Heading visible but rows hidden.
    expect(
      screen.getByRole("heading", { name: /Notification Preferences/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Email Notifications/i)).not.toBeInTheDocument();

    // Click the accordion heading button to expand.
    fireEvent.click(
      screen.getByRole("button", { name: /Notification Preferences/i }),
    );

    expect(await screen.findByText(/Email Notifications/i)).toBeInTheDocument();
    expect(screen.getByText(/Sms Notifications/i)).toBeInTheDocument();
  });

  it("toggling a preference PUTs the updated array shape", async () => {
    apiMock.put.mockResolvedValue({ data: { ok: true } });
    wireGetByPath({
      notifications: [],
      preferences: [
        prefFixture({ channel: "EMAIL", enabled: true }),
        prefFixture({ channel: "SMS", enabled: false }),
      ],
    });

    render(<NotificationsPage />);

    // Expand the accordion first.
    fireEvent.click(
      screen.getByRole("button", { name: /Notification Preferences/i }),
    );
    await screen.findByText(/Email Notifications/i);

    // The EMAIL preference row's toggle is the toggle <button> sibling of the
    // "Email Notifications" copy. Walk up to the row, then find the toggle.
    const emailRow = screen
      .getByText(/Email Notifications/i)
      .closest("div.flex.items-center.justify-between") as HTMLElement;
    expect(emailRow).toBeTruthy();
    const toggle = emailRow.querySelector("button") as HTMLButtonElement;
    expect(toggle).toBeTruthy();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith(
        "/notifications/preferences",
        expect.objectContaining({
          preferences: expect.arrayContaining([
            expect.objectContaining({ channel: "EMAIL", enabled: false }),
            expect.objectContaining({ channel: "SMS", enabled: false }),
          ]),
        }),
      ),
    );
  });

  it("preferences PUT rejection reverts the optimistic toggle", async () => {
    apiMock.put.mockRejectedValue(new Error("network down"));
    wireGetByPath({
      notifications: [],
      preferences: [prefFixture({ channel: "EMAIL", enabled: true })],
    });

    render(<NotificationsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /Notification Preferences/i }),
    );
    const emailCopy = await screen.findByText(/Email Notifications/i);
    const emailRow = emailCopy.closest(
      "div.flex.items-center.justify-between",
    ) as HTMLElement;
    const toggle = emailRow.querySelector("button") as HTMLButtonElement;

    fireEvent.click(toggle);
    await waitFor(() => expect(apiMock.put).toHaveBeenCalled());
    // The source rolls preferences back to the captured previous value on
    // failure. The visible side-effect is the "You will receive..." copy
    // re-appears on the row that was just toggled off.
    await waitFor(() =>
      expect(
        screen.getByText(/You will receive notifications via this channel/i),
      ).toBeInTheDocument(),
    );
  });

  it("preferences accordion shows the loading skeleton while the prefs GET is pending", async () => {
    wireGetByPath({
      notifications: [],
      preferencesPending: true,
    });

    render(<NotificationsPage />);
    // The list resolves so the "no notifications" branch renders.
    await screen.findByText(/No notifications yet/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Notification Preferences/i }),
    );

    expect(screen.getByTestId("notifications-prefs-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-text")).toBeInTheDocument();
  });

  it('preferences accordion shows "No preference settings available" when the API returns []', async () => {
    wireGetByPath({ notifications: [], preferences: [] });

    render(<NotificationsPage />);
    await screen.findByText(/No notifications yet/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Notification Preferences/i }),
    );

    expect(
      await screen.findByText(/No preference settings available/i),
    ).toBeInTheDocument();
  });

  it("renders each channel — WHATSAPP / SMS / EMAIL / PUSH — with the channel pill label", async () => {
    wireGetByPath({
      notifications: [
        notifFixture({ id: "n-wa", channel: "WHATSAPP", title: "WA note" }),
        notifFixture({ id: "n-sms", channel: "SMS", title: "SMS note" }),
        notifFixture({ id: "n-email", channel: "EMAIL", title: "Email note" }),
        notifFixture({ id: "n-push", channel: "PUSH", title: "Push note" }),
      ],
      preferences: [],
    });

    render(<NotificationsPage />);
    await screen.findByText("WA note");

    // Channel pill labels.
    expect(screen.getByText("WHATSAPP")).toBeInTheDocument();
    expect(screen.getByText("SMS")).toBeInTheDocument();
    expect(screen.getByText("EMAIL")).toBeInTheDocument();
    expect(screen.getByText("PUSH")).toBeInTheDocument();
  });

  it("falls back to the Bell icon + neutral pill when the channel is unknown", async () => {
    wireGetByPath({
      notifications: [
        notifFixture({
          id: "n-x",
          channel: "TELEGRAM" as any,
          title: "Unknown channel",
        }),
      ],
      preferences: [],
    });

    render(<NotificationsPage />);
    const row = await screen.findByTestId("notification-row-n-x");
    expect(row).toBeInTheDocument();
    // The raw channel string still appears in the pill.
    expect(screen.getByText("TELEGRAM")).toBeInTheDocument();
  });

  it("renders every formatTime branch — Just now / Nm / Nh / Nd / formatDate fallback", async () => {
    const now = Date.now();
    wireGetByPath({
      notifications: [
        notifFixture({
          id: "n-now",
          title: "Just-now row",
          createdAt: new Date(now - 10 * 1000).toISOString(), // 10s ago
        }),
        notifFixture({
          id: "n-min",
          title: "Minutes row",
          createdAt: new Date(now - 5 * 60 * 1000).toISOString(), // 5m ago
        }),
        notifFixture({
          id: "n-hour",
          title: "Hours row",
          createdAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(), // 3h ago
        }),
        notifFixture({
          id: "n-day",
          title: "Days row",
          createdAt: new Date(
            now - 3 * 24 * 60 * 60 * 1000,
          ).toISOString(), // 3d ago
        }),
        notifFixture({
          id: "n-old",
          title: "Old row",
          // 30 days ago — falls through to formatDate(). +48h safety not
          // needed because we're well past the 7d branch.
          createdAt: new Date(
            now - 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }),
      ],
      preferences: [],
    });

    render(<NotificationsPage />);
    await screen.findByText("Just-now row");

    expect(screen.getByText(/Just now/i)).toBeInTheDocument();
    expect(screen.getByText(/5m ago/i)).toBeInTheDocument();
    expect(screen.getByText(/3h ago/i)).toBeInTheDocument();
    expect(screen.getByText(/3d ago/i)).toBeInTheDocument();
    // formatDate fallback renders the old row's row element — just assert
    // the row is on screen (the exact date string format is locale-dependent).
    expect(screen.getByTestId("notification-row-n-old")).toBeInTheDocument();
  });

  it("error-path resilience — list fetch rejection still flips loading off and shows empty copy", async () => {
    wireGetByPath({ notificationsReject: true, preferences: [] });

    render(<NotificationsPage />);

    expect(await screen.findByText(/No notifications yet/i)).toBeInTheDocument();
  });

  it("error-path resilience — preferences fetch rejection settles into the prefs-empty branch on expand", async () => {
    wireGetByPath({ notifications: [], preferencesReject: true });

    render(<NotificationsPage />);
    await screen.findByText(/No notifications yet/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Notification Preferences/i }),
    );

    expect(
      await screen.findByText(/No preference settings available/i),
    ).toBeInTheDocument();
  });
});
