/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BroadcastsPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/broadcasts/page.tsx, the admin-only
 *     announcement composer + send + history surface. Endpoints under test:
 *       GET  /notifications/broadcasts   (history list)
 *       GET  /chat/users                 (staff picker source)
 *       POST /notifications/broadcast    (send action)
 *
 *   - Behaviours covered:
 *       1. RBAC — non-ADMIN user is redirected to /dashboard, render
 *          short-circuits to null, and the two GETs never fire.
 *       2. Loading branch — `broadcasts-loading` skeleton renders while the
 *          initial Promise.all is pending; heading + composer chrome still
 *          render.
 *       3. Happy fetch — broadcasts render in the history table with title,
 *          message, audience parse, sent + failed counts; staff list is
 *          available for SPECIFIC_USERS picker.
 *       4. Empty history — "No broadcasts sent yet." copy renders when list
 *          is empty.
 *       5. Compose validation — Send button is disabled until title +
 *            message + at least one channel are present.
 *       6. Channel chips — toggling SMS/EMAIL/WHATSAPP/PUSH flips
 *          aria-pressed and updates the preview panel (SMS / EMAIL / WHATSAPP
 *          / PUSH branches all render).
 *       7. Audience switch — selecting SPECIFIC_USERS reveals the staff
 *          picker; checking a user updates the "(N selected)" copy.
 *       8. Audience role mapping — submitting with ROLE_DOCTOR posts
 *            `{ audience: { roles: ["DOCTOR"] } }`; SPECIFIC_USERS posts
 *            `{ audience: { userIds: [...] } }`.
 *       9. Send happy path — POST fires with title/message/channels/audience;
 *            composer resets; broadcasts list re-fetched.
 *      10. Send error — POST rejection surfaces a toast.error with the
 *            error message and the composer state is preserved.
 *      11. Schedule-later — checking the box reveals the datetime input;
 *            sending forwards `scheduledFor` as an ISO string.
 *      12. History — message truncation: long body shows "More" toggle and
 *            expanding it reveals the full text.
 *      13. History — audience cell parses JSON userIds → "N users",
 *            JSON roles → comma-joined, malformed raw → fallback.
 *      14. Failed-count styling — zero-failed cell uses neutral class;
 *            non-zero uses the red class (verifies #75 styling).
 *      15. Channel preview empty state — with no channels selected the
 *          "Select channels to see previews." copy renders.
 *      16. Error-path resilience — initial fetch rejection still flips
 *          loading off and renders the empty-history copy.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            next/navigation, @/components/Skeleton (stubbed to a div).
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
  usePathname: () => "/dashboard/broadcasts",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import BroadcastsPage from "../page";

type Broadcast = {
  id: string;
  title: string;
  message: string;
  audience: string;
  sentCount: number;
  failedCount: number;
  createdBy: string;
  createdAt: string;
};

type Staff = { id: string; name: string; role: string };

function broadcastFixture(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    id: "b-1",
    title: "System Update",
    message: "Maintenance window tonight at 10pm.",
    audience: JSON.stringify({ roles: ["DOCTOR", "NURSE"] }),
    sentCount: 24,
    failedCount: 0,
    createdBy: "u-admin",
    createdAt: "2026-04-01T10:00:00.000Z",
    ...overrides,
  };
}

function staffFixture(overrides: Partial<Staff> = {}): Staff {
  return {
    id: "u-1",
    name: "Dr. Asha",
    role: "DOCTOR",
    ...overrides,
  };
}

/**
 * Route api.get by URL prefix. The component fires Promise.all([broadcasts,
 * users]) so resolved-once-chains are order-fragile.
 */
function wireGetByPath(opts: {
  broadcasts?: Broadcast[];
  staff?: Staff[];
  broadcastsReject?: boolean;
  staffReject?: boolean;
  broadcastsPending?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/notifications/broadcasts")) {
      if (opts.broadcastsReject)
        return Promise.reject(new Error("broadcasts boom"));
      if (opts.broadcastsPending) return new Promise(() => {});
      return Promise.resolve({ data: opts.broadcasts ?? [] });
    }
    if (url.startsWith("/chat/users")) {
      if (opts.staffReject) return Promise.reject(new Error("staff boom"));
      return Promise.resolve({ data: opts.staff ?? [] });
    }
    return Promise.resolve({ data: null });
  });
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", userId: "u-admin", role: "ADMIN", name: "Admin" },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", userId: "u-doc", role: "DOCTOR", name: "Doc" },
    isLoading: false,
  });
}

describe("Broadcasts dashboard page (admin announcement composer + history)", () => {
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

  it("redirects non-ADMIN to /dashboard, returns null, and never fires the list/staff fetches", async () => {
    wireGetByPath({ broadcasts: [broadcastFixture()], staff: [staffFixture()] });
    asDoctor();

    render(<BroadcastsPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
    // The render path is `return null` for non-ADMIN — heading absent.
    expect(
      screen.queryByRole("heading", { name: /Broadcasts/i }),
    ).not.toBeInTheDocument();
    // Guard prevents the load() from kicking off.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the loading skeleton while the initial Promise.all is pending", async () => {
    wireGetByPath({ broadcastsPending: true, staff: [] });

    render(<BroadcastsPage />);

    expect(
      screen.getByRole("heading", { name: /Broadcasts/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("broadcasts-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("issues both GETs on mount and renders one row per broadcast", async () => {
    wireGetByPath({
      broadcasts: [
        broadcastFixture({ id: "b-1", title: "Maintenance" }),
        broadcastFixture({
          id: "b-2",
          title: "Holiday Notice",
          audience: JSON.stringify({ userIds: ["u1", "u2", "u3"] }),
          sentCount: 3,
          failedCount: 1,
        }),
      ],
      staff: [staffFixture()],
    });

    render(<BroadcastsPage />);

    await screen.findByText("Maintenance");
    await screen.findByText("Holiday Notice");

    expect(apiMock.get).toHaveBeenCalledWith("/notifications/broadcasts");
    expect(apiMock.get).toHaveBeenCalledWith("/chat/users");

    // Audience parse — JSON userIds → "3 users", JSON roles → comma-joined.
    expect(screen.getByText("3 users")).toBeInTheDocument();
    expect(screen.getByText("DOCTOR, NURSE")).toBeInTheDocument();

    // History container renders.
    expect(screen.getByTestId("broadcast-history")).toBeInTheDocument();
  });

  it('renders "No broadcasts sent yet." when the list is empty', async () => {
    wireGetByPath({ broadcasts: [], staff: [] });

    render(<BroadcastsPage />);

    expect(
      await screen.findByText(/No broadcasts sent yet/i),
    ).toBeInTheDocument();
  });

  it("disables Send until title + message + at least one channel are present", async () => {
    wireGetByPath({ broadcasts: [], staff: [] });

    render(<BroadcastsPage />);
    await screen.findByText(/No broadcasts sent yet/i);

    const sendBtn = screen.getByTestId("broadcast-send") as HTMLButtonElement;
    expect(sendBtn).toBeDisabled();

    const title = document.getElementById(
      "broadcast-title",
    ) as HTMLInputElement;
    const message = document.getElementById(
      "broadcast-message",
    ) as HTMLTextAreaElement;

    fireEvent.change(title, { target: { value: "Hello" } });
    expect(sendBtn).toBeDisabled();

    fireEvent.change(message, { target: { value: "World" } });
    // Default channel includes PUSH so the button should now be enabled.
    expect(sendBtn).not.toBeDisabled();

    // Toggle PUSH off — back to disabled.
    fireEvent.click(screen.getByTestId("channel-chip-PUSH"));
    expect(sendBtn).toBeDisabled();
  });

  it("toggles channel chips and renders each channel preview branch", async () => {
    wireGetByPath({ broadcasts: [], staff: [] });

    render(<BroadcastsPage />);
    await screen.findByText(/No broadcasts sent yet/i);

    const title = document.getElementById(
      "broadcast-title",
    ) as HTMLInputElement;
    const message = document.getElementById(
      "broadcast-message",
    ) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "Title-X" } });
    fireEvent.change(message, { target: { value: "Body-Y" } });

    // PUSH starts active.
    const pushChip = screen.getByTestId("channel-chip-PUSH");
    expect(pushChip).toHaveAttribute("aria-pressed", "true");

    // Toggle SMS, EMAIL, WHATSAPP all on.
    fireEvent.click(screen.getByTestId("channel-chip-SMS"));
    fireEvent.click(screen.getByTestId("channel-chip-EMAIL"));
    fireEvent.click(screen.getByTestId("channel-chip-WHATSAPP"));

    expect(screen.getByTestId("channel-chip-SMS")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("channel-chip-EMAIL")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("channel-chip-WHATSAPP")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Each preview branch's distinctive copy.
    expect(screen.getByText(/SMS preview/i)).toBeInTheDocument();
    expect(screen.getByText(/Email preview/i)).toBeInTheDocument();
    expect(screen.getByText(/WhatsApp preview/i)).toBeInTheDocument();
    expect(screen.getByText(/Push preview/i)).toBeInTheDocument();
    // "Subject: " line proves the EMAIL branch took the title.
    expect(screen.getByText(/Subject:/i)).toBeInTheDocument();
  });

  it('renders "Select channels to see previews." when all channels are toggled off', async () => {
    wireGetByPath({ broadcasts: [], staff: [] });

    render(<BroadcastsPage />);
    await screen.findByText(/No broadcasts sent yet/i);

    fireEvent.click(screen.getByTestId("channel-chip-PUSH"));

    expect(
      screen.getByText(/Select channels to see previews/i),
    ).toBeInTheDocument();
  });

  it("reveals the staff picker when audience is SPECIFIC_USERS, and tracks selection count", async () => {
    wireGetByPath({
      broadcasts: [],
      staff: [
        staffFixture({ id: "u-1", name: "Dr. Asha", role: "DOCTOR" }),
        staffFixture({ id: "u-2", name: "Nurse Ben", role: "NURSE" }),
      ],
    });

    render(<BroadcastsPage />);
    await screen.findByText(/No broadcasts sent yet/i);

    const audience = document.getElementById(
      "broadcast-audience",
    ) as HTMLSelectElement;
    fireEvent.change(audience, { target: { value: "SPECIFIC_USERS" } });

    // Both staff rows rendered.
    expect(screen.getByText("Dr. Asha")).toBeInTheDocument();
    expect(screen.getByText("Nurse Ben")).toBeInTheDocument();
    // 0 selected initially.
    expect(screen.getByText(/0 selected/i)).toBeInTheDocument();

    // Check one — count flips to 1.
    const ashaCheckbox = screen
      .getByText("Dr. Asha")
      .closest("label")!
      .querySelector("input[type='checkbox']") as HTMLInputElement;
    fireEvent.click(ashaCheckbox);
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();

    // Uncheck (toggle off) — back to 0.
    fireEvent.click(ashaCheckbox);
    expect(screen.getByText(/0 selected/i)).toBeInTheDocument();
  });

  it("send happy path — POSTs the audience-roles payload, resets composer, and refetches", async () => {
    wireGetByPath({ broadcasts: [], staff: [] });
    apiMock.post.mockResolvedValueOnce({ data: { id: "new-b" } });

    render(<BroadcastsPage />);
    await screen.findByText(/No broadcasts sent yet/i);

    const title = document.getElementById(
      "broadcast-title",
    ) as HTMLInputElement;
    const message = document.getElementById(
      "broadcast-message",
    ) as HTMLTextAreaElement;
    const audience = document.getElementById(
      "broadcast-audience",
    ) as HTMLSelectElement;

    fireEvent.change(title, { target: { value: "Reminder" } });
    fireEvent.change(message, { target: { value: "Stand-up at 10" } });
    fireEvent.change(audience, { target: { value: "ROLE_DOCTOR" } });

    // Pre-arm the post-send refetch with one new broadcast so we can prove
    // the list re-mounts.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/notifications/broadcasts")) {
        return Promise.resolve({
          data: [
            broadcastFixture({
              id: "b-fresh",
              title: "Reminder",
              message: "Stand-up at 10",
            }),
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    fireEvent.click(screen.getByTestId("broadcast-send"));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/notifications/broadcast",
        expect.objectContaining({
          title: "Reminder",
          message: "Stand-up at 10",
          channels: ["PUSH"],
          audience: { roles: ["DOCTOR"] },
        }),
      ),
    );

    // Composer reset — title cleared after send.
    await waitFor(() => expect(title.value).toBe(""));
    expect(message.value).toBe("");

    // Refetch fired (refresh-after-send).
    await screen.findByText("Reminder");
  });

  it("send with SPECIFIC_USERS POSTs the userIds shape", async () => {
    wireGetByPath({
      broadcasts: [],
      staff: [staffFixture({ id: "u-77", name: "Picked One" })],
    });
    apiMock.post.mockResolvedValueOnce({ data: { id: "new-b" } });

    render(<BroadcastsPage />);
    await screen.findByText(/No broadcasts sent yet/i);

    const title = document.getElementById(
      "broadcast-title",
    ) as HTMLInputElement;
    const message = document.getElementById(
      "broadcast-message",
    ) as HTMLTextAreaElement;
    const audience = document.getElementById(
      "broadcast-audience",
    ) as HTMLSelectElement;

    fireEvent.change(title, { target: { value: "Targeted" } });
    fireEvent.change(message, { target: { value: "Specific note" } });
    fireEvent.change(audience, { target: { value: "SPECIFIC_USERS" } });

    const userCheckbox = screen
      .getByText("Picked One")
      .closest("label")!
      .querySelector("input[type='checkbox']") as HTMLInputElement;
    fireEvent.click(userCheckbox);

    fireEvent.click(screen.getByTestId("broadcast-send"));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/notifications/broadcast",
        expect.objectContaining({
          audience: { userIds: ["u-77"] },
        }),
      ),
    );
  });

  it("send error surfaces a toast.error with the message", async () => {
    wireGetByPath({ broadcasts: [], staff: [] });
    apiMock.post.mockRejectedValueOnce(new Error("Network down"));

    render(<BroadcastsPage />);
    await screen.findByText(/No broadcasts sent yet/i);

    const title = document.getElementById(
      "broadcast-title",
    ) as HTMLInputElement;
    const message = document.getElementById(
      "broadcast-message",
    ) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "Hi" } });
    fireEvent.change(message, { target: { value: "Hello" } });

    fireEvent.click(screen.getByTestId("broadcast-send"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Network down"),
    );
    // Title preserved on error.
    expect(title.value).toBe("Hi");
  });

  it("send error falls back to 'Send failed' when the throw is not an Error", async () => {
    wireGetByPath({ broadcasts: [], staff: [] });
    apiMock.post.mockRejectedValueOnce("string-thrown");

    render(<BroadcastsPage />);
    await screen.findByText(/No broadcasts sent yet/i);

    const title = document.getElementById(
      "broadcast-title",
    ) as HTMLInputElement;
    const message = document.getElementById(
      "broadcast-message",
    ) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "A" } });
    fireEvent.change(message, { target: { value: "B" } });

    fireEvent.click(screen.getByTestId("broadcast-send"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Send failed"),
    );
  });

  it("schedule-later — checking the box reveals the datetime input and forwards scheduledFor as ISO", async () => {
    wireGetByPath({ broadcasts: [], staff: [] });
    apiMock.post.mockResolvedValueOnce({ data: { id: "new-b" } });

    render(<BroadcastsPage />);
    await screen.findByText(/No broadcasts sent yet/i);

    const title = document.getElementById(
      "broadcast-title",
    ) as HTMLInputElement;
    const message = document.getElementById(
      "broadcast-message",
    ) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "Future" } });
    fireEvent.change(message, { target: { value: "Tomorrow" } });

    // Toggle the schedule-later checkbox.
    const sched = screen.getByLabelText(/Schedule for later/i);
    fireEvent.click(sched);

    // Future date (+48h to avoid IST/UTC midnight traps).
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const localStr = future.toISOString().slice(0, 16);
    const dt = document.getElementById(
      "broadcast-scheduled-for",
    ) as HTMLInputElement;
    fireEvent.change(dt, { target: { value: localStr } });

    // Button label flips to "Schedule".
    expect(screen.getByTestId("broadcast-send")).toHaveTextContent(/Schedule/i);

    fireEvent.click(screen.getByTestId("broadcast-send"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    const [, body] = apiMock.post.mock.calls[0];
    expect((body as any).scheduledFor).toBeTruthy();
    // ISO 8601 stamp.
    expect((body as any).scheduledFor).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    );
  });

  it("send guard — the button disabled state mirrors the source guard exactly", async () => {
    // The source-side `send()` guard `if (!title || !message || channels.length === 0)`
    // is intentionally double-bonded to the button's `disabled` prop, which
    // is the same boolean. React will not dispatch onClick on a disabled
    // <button>, so the guard is effectively unreachable from a normal UI
    // path — this test pins the disabled-state contract instead.
    wireGetByPath({ broadcasts: [], staff: [] });

    render(<BroadcastsPage />);
    await screen.findByText(/No broadcasts sent yet/i);

    const send = screen.getByTestId("broadcast-send") as HTMLButtonElement;
    const message = document.getElementById(
      "broadcast-message",
    ) as HTMLTextAreaElement;

    // Initially disabled — empty title + empty message.
    expect(send).toBeDisabled();

    fireEvent.change(message, { target: { value: "Body only" } });
    // Still disabled — title empty.
    expect(send).toBeDisabled();

    // Clicking a disabled button never fires onClick, so guard is not
    // exercised and POST is not called.
    fireEvent.click(send);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("history truncates long messages and toggles More/Less", async () => {
    const longMessage = "L".repeat(120); // > 80 char limit
    wireGetByPath({
      broadcasts: [broadcastFixture({ id: "b-long", message: longMessage })],
      staff: [],
    });

    render(<BroadcastsPage />);
    await screen.findByText("System Update");

    const toggle = screen.getByTestId("broadcast-toggle-b-long");
    expect(toggle).toHaveTextContent("More");

    // The truncated cell content shows an ellipsis.
    const cell = screen.getByTestId("broadcast-message-b-long");
    expect(cell.textContent).toContain("…");

    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("Less");
    // Full body now contained in the cell.
    expect(cell.textContent).toContain(longMessage);

    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("More");
  });

  it("history audience cell — malformed JSON falls back to the raw string", async () => {
    wireGetByPath({
      broadcasts: [
        broadcastFixture({
          id: "b-raw",
          title: "RawAud",
          audience: "not-json-at-all",
        }),
      ],
      staff: [],
    });

    render(<BroadcastsPage />);
    await screen.findByText("RawAud");

    // The raw string surfaces in the row.
    expect(screen.getByText("not-json-at-all")).toBeInTheDocument();
  });

  it("history audience cell — JSON with neither userIds nor roles falls back to em-dash", async () => {
    wireGetByPath({
      broadcasts: [
        broadcastFixture({
          id: "b-empty",
          title: "EmptyAud",
          audience: JSON.stringify({ other: "data" }),
        }),
      ],
      staff: [],
    });

    render(<BroadcastsPage />);
    const row = (await screen.findByText("EmptyAud")).closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("history failed-count cell — styles zero-failed neutrally and non-zero in red", async () => {
    wireGetByPath({
      broadcasts: [
        broadcastFixture({ id: "b-ok", title: "Ok", failedCount: 0 }),
        broadcastFixture({ id: "b-bad", title: "Bad", failedCount: 3 }),
      ],
      staff: [],
    });

    render(<BroadcastsPage />);
    await screen.findByText("Ok");
    await screen.findByText("Bad");

    const okCell = screen.getByTestId("broadcast-failed-b-ok");
    const badCell = screen.getByTestId("broadcast-failed-b-bad");

    expect(okCell.className).toContain("text-gray-500");
    expect(badCell.className).toContain("text-red-600");
  });

  it("history audience cell — short message that does NOT need truncation has no More toggle", async () => {
    wireGetByPath({
      broadcasts: [broadcastFixture({ id: "b-short", message: "tiny" })],
      staff: [],
    });

    render(<BroadcastsPage />);
    await screen.findByText("System Update");

    expect(
      screen.queryByTestId("broadcast-toggle-b-short"),
    ).not.toBeInTheDocument();
  });

  it("error-path resilience — broadcasts fetch rejection still flips loading off and shows empty copy", async () => {
    wireGetByPath({ broadcastsReject: true, staff: [] });

    render(<BroadcastsPage />);

    // The silent try/catch leaves loading=false, broadcasts=[].
    expect(
      await screen.findByText(/No broadcasts sent yet/i),
    ).toBeInTheDocument();
  });
});
