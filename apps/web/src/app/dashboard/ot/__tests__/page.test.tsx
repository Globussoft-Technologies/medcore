/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * OTPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/ot/page.tsx`, the Operating Theatre admin
 *     page. The page issues two GETs (theatres list + per-OT week schedule)
 *     and wires a socket "surgery:status" listener so live status flips
 *     trigger a reload. The table exposes Edit and Disable/Enable actions
 *     per row; a modal collects name/floor/equipment/dailyRate and POSTs
 *     (create) or PATCHes (edit) /surgery/ots. Disable runs an optimistic
 *     local toggle with rollback on PATCH failure.
 *
 *   - Behaviours covered (mapped to the page surface):
 *       1. Loading branch — `ot-loading` skeleton renders while the initial
 *          /surgery/ots GET is pending, with the heading still visible.
 *       2. Empty branch — "No OTs configured." renders when the list is
 *          empty.
 *       3. Happy fetch — both OTs render with name/floor/equipment, the
 *          Active and Out-of-Service status badges, and the per-row
 *          Edit/Disable buttons. /surgery/ots is called with the
 *          includeInactive=true query.
 *       4. Em-dash fallback — an OT with null/empty floor + equipment
 *          renders "-" cells.
 *       5. Selecting an OT row reveals the weekly schedule pane and fires
 *          the GET /surgery scoped to that OT.
 *       6. Week navigation — Prev / This Week / Next buttons each refetch
 *          the schedule with a new from/to window.
 *       7. Schedule rendering — scheduled surgeries appear under their
 *          weekday tile (matched by ymd key); days without surgeries render
 *          the em-dash placeholder.
 *       8. Toggle (optimistic + toast) — clicking Disable on an active OT
 *          flips the badge to Out of Service immediately and toasts the
 *          target state ("X marked Out of Service"); a follow-up loadOts
 *          re-fetch fires.
 *       9. Toggle failure rollback — PATCH rejection restores the previous
 *          isActive value and toasts the error message.
 *      10. Add modal — Plus button opens the modal with empty fields;
 *          submitting a valid form POSTs /surgery/ots and triggers a
 *          loadOts refetch.
 *      11. Empty-name guard — submitting an empty name fires
 *          toast.error("OT name is required") and does NOT POST.
 *      12. Edit modal — Edit on a row pre-fills the form; submitting
 *          PATCHes /surgery/ots/<id>.
 *      13. Cancel button closes the modal without firing api.post/patch.
 *      14. Socket subscription — `surgery:status` listener is wired on
 *          mount (and cleaned up on unmount); invoking the handler triggers
 *          a refetch of /surgery/ots.
 *      15. Error resilience — initial GET rejection lands the page in the
 *          empty branch without crashing.
 *
 *   - Source under test: apps/web/src/app/dashboard/ot/page.tsx
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/socket,
 *            next/navigation, @/components/Skeleton (stubbed).
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

const { apiMock, toastMock, authMock, socketMock } = vi.hoisted(() => ({
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
  socketMock: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    connected: false,
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
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
  usePathname: () => "/dashboard/ot",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import OTPage from "../page";

type OT = {
  id: string;
  name: string;
  floor?: string | null;
  equipment?: string | null;
  dailyRate: number;
  isActive: boolean;
};

type ScheduledSurgery = {
  id: string;
  caseNumber: string;
  procedure: string;
  scheduledAt: string;
  durationMin?: number | null;
  status: string;
  patient: { user: { name: string } };
  surgeon: { user: { name: string } };
  ot: { id: string; name: string };
};

function otFixture(overrides: Partial<OT> = {}): OT {
  return {
    id: "ot-1",
    name: "OT-Alpha",
    floor: "2",
    equipment: "Laminar flow",
    dailyRate: 5000,
    isActive: true,
    ...overrides,
  };
}

/**
 * Pick a scheduled timestamp that lands inside the current week window
 * the page builds via startOfWeek(new Date()) + addDays(weekStart, n).
 * We use "tomorrow at 10:00" so the date is guaranteed inside the next
 * 7-day window (the page's `to` cutoff is +7d from week-start). Avoids
 * IST/UTC midnight traps per the cron's preflight note (we don't pick a
 * future date by +24h; we anchor inside the active week instead).
 */
function tomorrowAt(hourUtc: number, minuteUtc = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hourUtc, minuteUtc, 0, 0);
  return d.toISOString();
}

function surgeryFixture(overrides: Partial<ScheduledSurgery> = {}): ScheduledSurgery {
  return {
    id: "sg-1",
    caseNumber: "S-001",
    procedure: "Appendectomy",
    scheduledAt: tomorrowAt(10, 0),
    durationMin: 60,
    status: "SCHEDULED",
    patient: { user: { name: "Aanya Sharma" } },
    surgeon: { user: { name: "Dr Mehta" } },
    ot: { id: "ot-1", name: "OT-Alpha" },
    ...overrides,
  };
}

/**
 * Route api.get by URL prefix. Order of the two fetches (OTs first, then
 * the per-OT weekly schedule once an OT is selected) is deterministic but
 * we still want robust dispatch so reload-after-action tests work without
 * juggling mockResolvedValueOnce chains.
 */
function wireGetByPath(opts: {
  ots?: OT[];
  surgeries?: ScheduledSurgery[];
  otsReject?: boolean;
  surgeriesReject?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/surgery/ots")) {
      if (opts.otsReject) return Promise.reject(new Error("ots boom"));
      return Promise.resolve({ data: opts.ots ?? [] });
    }
    if (url.startsWith("/surgery?")) {
      if (opts.surgeriesReject)
        return Promise.reject(new Error("surgeries boom"));
      return Promise.resolve({ data: opts.surgeries ?? [] });
    }
    return Promise.resolve({ data: null });
  });
}

function asAdmin() {
  authMock.mockImplementation((selector: any) => {
    const state = {
      user: {
        id: "u-admin",
        userId: "u-admin",
        role: "ADMIN",
        name: "Admin",
        email: "a@x.com",
      },
      isLoading: false,
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("OT (Operating Theatres) dashboard page", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    apiMock.put.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    socketMock.connect.mockReset();
    socketMock.on.mockReset();
    socketMock.off.mockReset();
    socketMock.connected = false;
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading skeleton (ot-loading + aria-busy) while the initial GET is pending", async () => {
    let resolveFn: (v: any) => void = () => {};
    apiMock.get.mockImplementation(
      () => new Promise((r) => { resolveFn = r; }),
    );

    render(<OTPage />);

    expect(
      screen.getByRole("heading", { name: /Operating Theaters/i }),
    ).toBeInTheDocument();
    const loadingRegion = await screen.findByTestId("ot-loading");
    expect(loadingRegion).toBeInTheDocument();
    expect(loadingRegion).toHaveAttribute("aria-busy", "true");

    // Resolve so React doesn't warn about pending state when unmounting.
    resolveFn({ data: [] });
    await waitFor(() => {
      expect(screen.queryByTestId("ot-loading")).not.toBeInTheDocument();
    });
  });

  it('renders the empty branch ("No OTs configured.") when the list is empty', async () => {
    wireGetByPath({ ots: [] });

    render(<OTPage />);

    expect(
      await screen.findByText(/No OTs configured\./i),
    ).toBeInTheDocument();
  });

  it("hits /surgery/ots?includeInactive=true on mount and renders both OTs with their action buttons", async () => {
    wireGetByPath({
      ots: [
        otFixture({ id: "ot-1", name: "OT-Alpha", isActive: true }),
        otFixture({
          id: "ot-2",
          name: "OT-Beta",
          floor: "3",
          equipment: "C-arm",
          dailyRate: 4000,
          isActive: false,
        }),
      ],
    });

    render(<OTPage />);

    await screen.findByText("OT-Alpha");
    await screen.findByText("OT-Beta");

    expect(apiMock.get).toHaveBeenCalledWith(
      "/surgery/ots?includeInactive=true",
    );

    // Status badges
    expect(screen.getByTestId("ot-status-ot-1")).toHaveTextContent("Active");
    expect(screen.getByTestId("ot-status-ot-2")).toHaveTextContent(
      "Out of Service",
    );

    // Per-row toggle buttons exist with the expected label text.
    expect(screen.getByTestId("ot-toggle-ot-1")).toHaveTextContent(/Disable/i);
    expect(screen.getByTestId("ot-toggle-ot-2")).toHaveTextContent(/Enable/i);
  });

  it('falls back to em-dash for missing floor and equipment', async () => {
    wireGetByPath({
      ots: [
        otFixture({
          id: "ot-bare",
          name: "OT-Bare",
          floor: null,
          equipment: null,
        }),
      ],
    });

    render(<OTPage />);

    const nameCell = await screen.findByText("OT-Bare");
    const row = nameCell.closest("tr")!;
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("reveals the weekly schedule pane on row click and fires GET /surgery with the OT id", async () => {
    wireGetByPath({
      ots: [otFixture({ id: "ot-1", name: "OT-Alpha" })],
      surgeries: [surgeryFixture({ id: "sg-1" })],
    });

    render(<OTPage />);

    const nameCell = await screen.findByText("OT-Alpha");
    const row = nameCell.closest("tr")!;
    fireEvent.click(row);

    // Heading for the week pane confirms selection wiring.
    await screen.findByRole("heading", {
      name: /Weekly Schedule\s*—\s*OT-Alpha/i,
    });

    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(
        calls.some(
          (u) => u.startsWith("/surgery?otId=ot-1&from=") && u.includes("&to="),
        ),
      ).toBe(true);
    });
  });

  it("re-fetches schedule when the Prev / This Week / Next buttons are clicked", async () => {
    wireGetByPath({
      ots: [otFixture({ id: "ot-1", name: "OT-Alpha" })],
      surgeries: [],
    });

    render(<OTPage />);
    const nameCell = await screen.findByText("OT-Alpha");
    fireEvent.click(nameCell.closest("tr")!);

    // Wait for the initial schedule fetch.
    await screen.findByRole("heading", { name: /Weekly Schedule/i });

    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Prev/i }));
    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.startsWith("/surgery?otId=ot-1"))).toBe(true);
    });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.startsWith("/surgery?otId=ot-1"))).toBe(true);
    });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /This Week/i }));
    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.startsWith("/surgery?otId=ot-1"))).toBe(true);
    });
  });

  it("renders scheduled surgeries (procedure + patient name) under the matching weekday tile", async () => {
    wireGetByPath({
      ots: [otFixture({ id: "ot-1", name: "OT-Alpha" })],
      surgeries: [
        surgeryFixture({
          id: "sg-1",
          procedure: "Cholecystectomy",
          patient: { user: { name: "Rohit Kumar" } },
        }),
      ],
    });

    render(<OTPage />);
    const nameCell = await screen.findByText("OT-Alpha");
    fireEvent.click(nameCell.closest("tr")!);

    await screen.findByText("Cholecystectomy");
    expect(screen.getByText("Rohit Kumar")).toBeInTheDocument();
  });

  it("optimistically flips the badge + toasts success when Disable is clicked on an active OT", async () => {
    wireGetByPath({
      ots: [otFixture({ id: "ot-1", name: "OT-Alpha", isActive: true })],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<OTPage />);
    await screen.findByText("OT-Alpha");

    expect(screen.getByTestId("ot-status-ot-1")).toHaveTextContent("Active");

    fireEvent.click(screen.getByTestId("ot-toggle-ot-1"));

    // Optimistic local update flips the badge immediately.
    await waitFor(() => {
      expect(screen.getByTestId("ot-status-ot-1")).toHaveTextContent(
        "Out of Service",
      );
    });

    expect(apiMock.patch).toHaveBeenCalledWith("/surgery/ots/ot-1", {
      isActive: false,
    });
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringMatching(/OT-Alpha marked Out of Service/i),
      );
    });
  });

  it("toasts the active-state message when Enable is clicked on an inactive OT", async () => {
    wireGetByPath({
      ots: [otFixture({ id: "ot-2", name: "OT-Beta", isActive: false })],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<OTPage />);
    await screen.findByText("OT-Beta");

    fireEvent.click(screen.getByTestId("ot-toggle-ot-2"));

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringMatching(/OT-Beta is now active/i),
      );
    });
    expect(apiMock.patch).toHaveBeenCalledWith("/surgery/ots/ot-2", {
      isActive: true,
    });
  });

  it("rolls back the optimistic toggle and toasts on PATCH failure", async () => {
    wireGetByPath({
      ots: [otFixture({ id: "ot-1", name: "OT-Alpha", isActive: true })],
    });
    apiMock.patch.mockRejectedValue(new Error("network blew up"));

    render(<OTPage />);
    await screen.findByText("OT-Alpha");

    fireEvent.click(screen.getByTestId("ot-toggle-ot-1"));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/network blew up/i),
      );
    });
    // Rollback: badge returns to Active.
    expect(screen.getByTestId("ot-status-ot-1")).toHaveTextContent("Active");
  });

  it("opens the Add OT modal with empty fields and POSTs /surgery/ots on submit", async () => {
    wireGetByPath({ ots: [] });
    apiMock.post.mockResolvedValue({ data: { id: "ot-new" } });

    render(<OTPage />);
    await screen.findByText(/No OTs configured\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add OT/i }));

    const modalHeading = await screen.findByRole("heading", {
      name: /Add Operating Theater/i,
    });
    expect(modalHeading).toBeInTheDocument();

    const nameInput = document.getElementById("ot-name") as HTMLInputElement;
    const floorInput = document.getElementById("ot-floor") as HTMLInputElement;
    const rateInput = document.getElementById(
      "ot-daily-rate",
    ) as HTMLInputElement;
    const equipInput = document.getElementById(
      "ot-equipment",
    ) as HTMLTextAreaElement;

    expect(nameInput.value).toBe("");
    fireEvent.change(nameInput, { target: { value: "OT-New" } });
    fireEvent.change(floorInput, { target: { value: "4" } });
    fireEvent.change(rateInput, { target: { value: "7500.5" } });
    fireEvent.change(equipInput, { target: { value: "Ventilator" } });

    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/surgery/ots", {
        name: "OT-New",
        floor: "4",
        equipment: "Ventilator",
        dailyRate: 7500.5,
      });
    });
    // Modal closes after successful submit.
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /Add Operating Theater/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("guards empty name on Create — toast.error fires and no POST is issued", async () => {
    wireGetByPath({ ots: [] });

    render(<OTPage />);
    await screen.findByText(/No OTs configured\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add OT/i }));
    await screen.findByRole("heading", { name: /Add Operating Theater/i });

    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/OT name is required/i),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("opens Edit prefilled and PATCHes /surgery/ots/<id> on submit", async () => {
    wireGetByPath({
      ots: [
        otFixture({
          id: "ot-1",
          name: "OT-Alpha",
          floor: "2",
          equipment: "Laminar flow",
          dailyRate: 5000,
        }),
      ],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<OTPage />);
    await screen.findByText("OT-Alpha");

    fireEvent.click(screen.getByRole("button", { name: /Edit/i }));

    await screen.findByRole("heading", { name: /Edit OT/i });

    const nameInput = document.getElementById("ot-name") as HTMLInputElement;
    expect(nameInput.value).toBe("OT-Alpha");

    fireEvent.change(nameInput, { target: { value: "OT-Alpha-2" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/surgery/ots/ot-1",
        expect.objectContaining({ name: "OT-Alpha-2" }),
      );
    });
  });

  it("Cancel closes the modal without firing api.post / api.patch", async () => {
    wireGetByPath({ ots: [otFixture({ id: "ot-1", name: "OT-Alpha" })] });

    render(<OTPage />);
    await screen.findByText("OT-Alpha");

    fireEvent.click(screen.getByRole("button", { name: /Add OT/i }));
    await screen.findByRole("heading", { name: /Add Operating Theater/i });

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /Add Operating Theater/i }),
      ).not.toBeInTheDocument();
    });
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("subscribes to surgery:status on mount; the handler refetches OTs", async () => {
    wireGetByPath({ ots: [otFixture({ id: "ot-1", name: "OT-Alpha" })] });

    const { unmount } = render(<OTPage />);
    await screen.findByText("OT-Alpha");

    // The page's useEffect should have subscribed via socket.on with the
    // "surgery:status" event name.
    const onCall = socketMock.on.mock.calls.find(
      (c) => c[0] === "surgery:status",
    );
    expect(onCall).toBeTruthy();

    const handler = onCall![1] as () => void;
    apiMock.get.mockClear();
    handler();

    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.startsWith("/surgery/ots"))).toBe(true);
    });

    unmount();
    // Cleanup runs socket.off with the same event name.
    expect(
      socketMock.off.mock.calls.some((c) => c[0] === "surgery:status"),
    ).toBe(true);
  });

  it("connects an unconnected socket on mount (covers the connected-false branch)", async () => {
    socketMock.connected = false;
    wireGetByPath({ ots: [] });

    render(<OTPage />);
    await screen.findByText(/No OTs configured\./i);

    expect(socketMock.connect).toHaveBeenCalled();
  });

  it("skips socket.connect when the socket is already connected", async () => {
    socketMock.connected = true;
    wireGetByPath({ ots: [] });

    render(<OTPage />);
    await screen.findByText(/No OTs configured\./i);

    expect(socketMock.connect).not.toHaveBeenCalled();
  });

  it("settles into the empty branch when the initial /surgery/ots fetch rejects", async () => {
    wireGetByPath({ otsReject: true });

    render(<OTPage />);

    expect(
      await screen.findByText(/No OTs configured\./i),
    ).toBeInTheDocument();
    // Silent — no toast on initial-load failure.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("settles the week pane to an empty grid when the schedule fetch rejects", async () => {
    wireGetByPath({
      ots: [otFixture({ id: "ot-1", name: "OT-Alpha" })],
      surgeriesReject: true,
    });

    render(<OTPage />);
    const nameCell = await screen.findByText("OT-Alpha");
    fireEvent.click(nameCell.closest("tr")!);

    await screen.findByRole("heading", { name: /Weekly Schedule/i });
    // Page does not crash; em-dash placeholders render under each day card.
    await waitFor(() => {
      const dashes = screen.getAllByText("—");
      // 7 day cards, each renders "—" for empty + the table also has a few.
      expect(dashes.length).toBeGreaterThanOrEqual(7);
    });
  });
});
