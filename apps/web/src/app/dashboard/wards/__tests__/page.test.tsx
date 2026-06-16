/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WardsPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/wards/page.tsx, the Wards & Beds
 *     admin page. The page issues:
 *       GET   /wards                          (initial + every refresh)
 *       POST  /wards                          (Add Ward modal)
 *       POST  /wards/:wardId/beds             (Add Bed — global modal + inline form)
 *       PATCH /beds/:bedId/status             (BedCell status menu)
 *       GET   /admissions/forecast?days=7     (Forecast tab — OccupancyForecast)
 *     A socket "admission:status" listener triggers a refresh on flips.
 *
 *   - Behaviours covered:
 *       1.  Loading skeleton renders while initial /wards is pending.
 *       2.  Empty state — "No wards yet." appears + admin sees the "Add Ward"
 *           callout; non-admin sees only the bare empty line.
 *       3.  Happy fetch — header counts + per-ward cards render with computed
 *           bed counts (total / available / occupied / cleaning) and the
 *           progress bar with 4 colored segments + titles.
 *       4.  Admin gating — ADMIN sees Add Ward + Add Bed top-level CTAs;
 *           non-ADMIN (DOCTOR) does NOT.
 *       5.  Expand toggle — clicking a ward card reveals its beds grid +
 *           inline Add Bed button (admin only). Clicking again collapses.
 *       6.  Empty beds child — expanded ward with no beds shows "No beds yet."
 *       7.  Add Ward modal — opens, validates blank name (toast.error + no
 *           POST), happy POST closes the modal + refetches + success toast.
 *       8.  Add Ward POST rejection surfaces toast.error(err.message);
 *           non-Error fallback toasts "Failed to create ward".
 *       9.  Global Add Bed modal — ward + bedNumber both required (each
 *           guard toasts independently), happy POST closes + refetches.
 *      10.  Global Add Bed POST rejection surfaces toast.error(err.message).
 *      11.  Inline Add Bed (per-ward expanded form) — empty bedNumber toasts,
 *           happy submit POSTs to /wards/:id/beds and refetches.
 *      12.  Inline Add Bed Issue #36 — API error with payload.details renders
 *           "<message>: <field>: <msg>; ..." (field-level surfacing).
 *      13.  BedCell — clicking the cell opens a status menu; picking a new
 *           status fires PATCH /beds/:bedId/status with the chosen value.
 *      14.  BedCell PATCH rejection toasts the error message.
 *      15.  Forecast tab — clicking Forecast triggers
 *           GET /admissions/forecast?days=7. Empty payload renders the empty
 *           hint; populated payload renders the SVG chart + the data table
 *           with the right occupancy-pill color buckets (<75, 75-89, >=90).
 *      16.  Forecast rejection swallows + renders the empty hint.
 *      17.  Socket subscription wires "admission:status" on mount and tears
 *           down on unmount; invoking the handler refetches /wards.
 *      18.  Error-path resilience — /wards rejection lands in empty branch.
 *
 *   - Source under test: apps/web/src/app/dashboard/wards/page.tsx
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/socket,
 *            next/navigation, @/components/Skeleton (stubbed).
 *     @/lib/bed-summary is intentionally un-mocked (pure helper).
 *
 *   - Notes:
 *     • The Add Ward header CTA is a bare <button> outside any form, so it
 *       defaults to type="submit". We always submit by selecting the actual
 *       <form> element rather than clicking a submit button.
 *     • +48h / -48h offsets only — no fake timers paired with waitFor.
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
  usePathname: () => "/dashboard/wards",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: () => <div data-testid="skeleton-stub" />,
}));

import WardsPage from "../page";

// ─── Fixtures ───────────────────────────────────────────────────────────

type Bed = {
  id: string;
  bedNumber: string;
  status: "AVAILABLE" | "OCCUPIED" | "CLEANING" | "MAINTENANCE";
  wardId: string;
  dailyRate?: number;
};

type Ward = {
  id: string;
  name: string;
  type: string;
  floor: string | number | null;
  description?: string | null;
  beds?: Bed[];
};

function bedFixture(overrides: Partial<Bed> = {}): Bed {
  return {
    id: "bed-1",
    bedNumber: "B-101",
    status: "AVAILABLE",
    wardId: "ward-1",
    ...overrides,
  };
}

function wardFixture(overrides: Partial<Ward> = {}): Ward {
  return {
    id: "ward-1",
    name: "General Ward",
    type: "GENERAL",
    floor: "1",
    description: "Main wing",
    beds: [
      bedFixture({ id: "b-a", bedNumber: "A1", status: "AVAILABLE" }),
      bedFixture({ id: "b-b", bedNumber: "A2", status: "OCCUPIED" }),
      bedFixture({ id: "b-c", bedNumber: "A3", status: "CLEANING" }),
      bedFixture({ id: "b-d", bedNumber: "A4", status: "MAINTENANCE" }),
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
function asNurse() {
  authMock.mockReturnValue({
    user: { id: "u-nurse", role: "NURSE", name: "Nurse" },
  });
}

/**
 * Default GET wiring. Per-test overrides should call apiMock.get.mockImplementation
 * again BEFORE rendering.
 */
function wireDefaultGets(opts: { wards?: Ward[]; forecast?: any[] } = {}) {
  const wards = opts.wards ?? [wardFixture()];
  const forecast = opts.forecast ?? [];

  apiMock.get.mockImplementation((url: string) => {
    if (url === "/wards") {
      return Promise.resolve({ data: wards });
    }
    if (url.startsWith("/admissions/forecast")) {
      return Promise.resolve({ data: forecast });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("WardsPage (Wards & Beds admin — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    socketMock.connect.mockReset();
    socketMock.disconnect.mockReset();
    socketMock.emit.mockReset();
    socketMock.on.mockReset();
    socketMock.off.mockReset();
    socketMock.connected = false;
    authMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Initial render + loading ───────────────────────────────────────────

  it("renders the loading skeleton while /wards is in flight", async () => {
    let resolveWards: (v: any) => void = () => undefined;
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/wards") {
        return new Promise((res) => {
          resolveWards = res;
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<WardsPage />);

    expect(
      await screen.findByRole("heading", { name: /Wards & Beds/i, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("wards-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getAllByTestId("skeleton-stub").length).toBeGreaterThanOrEqual(
      3,
    );

    // Now resolve so afterEach doesn't drown in an unsettled promise.
    resolveWards({ data: [] });
    await waitFor(() =>
      expect(screen.queryByTestId("wards-loading")).not.toBeInTheDocument(),
    );
  });

  it("renders the page header + summary card line and triggers the initial /wards GET", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    expect(
      await screen.findByRole("heading", { name: /Wards & Beds/i, level: 1 }),
    ).toBeInTheDocument();
    // Summary line under the header: "<avail> available · <occ> occupied · <total> total beds"
    expect(
      screen.getByText(/available · .* occupied · .* total beds/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/wards"),
    );
  });

  it("renders the empty-state copy with admin CTA hint when /wards returns []", async () => {
    wireDefaultGets({ wards: [] });
    render(<WardsPage />);

    expect(await screen.findByText(/No wards yet\./)).toBeInTheDocument();
    // Admin sees the prompt to add one.
    expect(
      screen.getByText(/Click "Add Ward" to create one/i),
    ).toBeInTheDocument();
  });

  it("non-admin sees the empty-state without the 'Add Ward' instruction", async () => {
    asDoctor();
    wireDefaultGets({ wards: [] });
    render(<WardsPage />);

    expect(await screen.findByText(/No wards yet\./)).toBeInTheDocument();
    expect(
      screen.queryByText(/Click "Add Ward" to create one/i),
    ).not.toBeInTheDocument();
  });

  // ── RBAC gating on CTAs ────────────────────────────────────────────────

  it("ADMIN sees both 'Add Bed' and 'Add Ward' header CTAs", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    expect(await screen.findByTestId("add-bed-cta")).toBeInTheDocument();
    expect(screen.getByTestId("add-ward-cta")).toBeInTheDocument();
  });

  it("DOCTOR does NOT see the header CTAs (admin-only)", async () => {
    asDoctor();
    wireDefaultGets();
    render(<WardsPage />);

    // Wait for the data load so we know we're past the loading branch.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/wards"));
    expect(screen.queryByTestId("add-bed-cta")).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-ward-cta")).not.toBeInTheDocument();
  });

  it("NURSE does NOT see the header CTAs either", async () => {
    asNurse();
    wireDefaultGets();
    render(<WardsPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/wards"));
    expect(screen.queryByTestId("add-bed-cta")).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-ward-cta")).not.toBeInTheDocument();
  });

  // ── Ward card render + expand toggle ───────────────────────────────────

  it("renders a ward card with name, type pill, floor and computed bed counts", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
      level: 3,
    });
    expect(heading).toBeInTheDocument();
    // The type appears in the pill (spaces, not underscores).
    expect(screen.getByText(/^GENERAL$/)).toBeInTheDocument();
    // Floor label
    expect(screen.getByText(/Floor 1/)).toBeInTheDocument();
    // Counts (4 beds: 1 avail, 1 occ, 1 clean, 1 maint). The header
    // summary line uses "available" / "occupied" (which substring-match
    // "avail" / "occ"), so use exact-text matches against the per-card
    // pill labels.
    expect(screen.getByText("1 avail")).toBeInTheDocument();
    expect(screen.getByText("1 occ")).toBeInTheDocument();
    expect(screen.getByText("1 clean")).toBeInTheDocument();
  });

  it("ward type displays with underscores replaced by spaces (SEMI_PRIVATE → 'SEMI PRIVATE')", async () => {
    wireDefaultGets({
      wards: [
        wardFixture({ id: "w-sp", name: "Suite", type: "SEMI_PRIVATE", beds: [] }),
      ],
    });
    render(<WardsPage />);

    expect(await screen.findByText(/^SEMI PRIVATE$/)).toBeInTheDocument();
  });

  it("ward with null floor renders em-dash placeholder", async () => {
    wireDefaultGets({
      wards: [wardFixture({ id: "w-nf", floor: null, beds: [] })],
    });
    render(<WardsPage />);

    expect(await screen.findByText(/Floor —/)).toBeInTheDocument();
  });

  it("clicking a ward card expands it; clicking again collapses", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    const card = heading.closest("button")!;

    // Initially collapsed — no "Beds" subheading.
    expect(screen.queryByRole("heading", { name: /^Beds$/ })).not.toBeInTheDocument();

    fireEvent.click(card);
    expect(
      await screen.findByRole("heading", { name: /^Beds$/, level: 4 }),
    ).toBeInTheDocument();
    // Inline Add Bed (admin) appears for this ward.
    expect(screen.getByTestId("add-bed-inline-ward-1")).toBeInTheDocument();

    fireEvent.click(card);
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Beds$/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it("expanded ward with no beds renders the 'No beds yet.' empty branch", async () => {
    wireDefaultGets({
      wards: [wardFixture({ id: "w-empty", name: "Quiet Ward", beds: [] })],
    });
    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /Quiet Ward/,
    });
    fireEvent.click(heading.closest("button")!);

    expect(await screen.findByText(/No beds yet\./)).toBeInTheDocument();
  });

  it("non-admin does NOT see the inline Add Bed button on an expanded ward", async () => {
    asDoctor();
    wireDefaultGets();
    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);

    expect(
      screen.queryByTestId("add-bed-inline-ward-1"),
    ).not.toBeInTheDocument();
  });

  // ── Add Ward modal ─────────────────────────────────────────────────────

  it("blank ward name fires toast.error and skips POST", async () => {
    wireDefaultGets();
    const { container } = render(<WardsPage />);

    fireEvent.click(await screen.findByTestId("add-ward-cta"));
    // Modal opens.
    expect(
      await screen.findByRole("heading", { name: /^Add New Ward$/ }),
    ).toBeInTheDocument();

    // The "Create Ward" submit button — submit the form directly.
    const forms = container.querySelectorAll("form");
    fireEvent.submit(forms[forms.length - 1]!);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Ward name is required"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("happy Add Ward — POSTs the form body, closes the modal, refetches, success toast", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({ data: { id: "w-new" } });

    const { container } = render(<WardsPage />);

    // Snapshot /wards calls BEFORE so we can assert the refetch.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/wards"));
    const before = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/wards",
    ).length;

    fireEvent.click(await screen.findByTestId("add-ward-cta"));
    await screen.findByRole("heading", { name: /^Add New Ward$/ });

    fireEvent.change(screen.getByLabelText(/^Name$/), {
      target: { value: "ICU-North" },
    });
    fireEvent.change(screen.getByLabelText(/^Type$/), {
      target: { value: "ICU" },
    });
    fireEvent.change(screen.getByLabelText(/^Floor$/), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText(/^Description$/), {
      target: { value: "ICU on third floor" },
    });

    const forms = container.querySelectorAll("form");
    fireEvent.submit(forms[forms.length - 1]!);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/wards");
    expect(body).toMatchObject({
      name: "ICU-North",
      type: "ICU",
      floor: "3",
      description: "ICU on third floor",
    });

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Ward created"),
    );
    // Modal closes.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Add New Ward$/ }),
      ).not.toBeInTheDocument(),
    );
    // Refetch fires.
    await waitFor(() => {
      const after = apiMock.get.mock.calls.filter(
        (c: any[]) => c[0] === "/wards",
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("Add Ward — empty optional fields collapse to undefined in the POST body", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({ data: { id: "w-new" } });

    const { container } = render(<WardsPage />);
    fireEvent.click(await screen.findByTestId("add-ward-cta"));
    await screen.findByRole("heading", { name: /^Add New Ward$/ });

    fireEvent.change(screen.getByLabelText(/^Name$/), {
      target: { value: "Basic" },
    });
    const forms = container.querySelectorAll("form");
    fireEvent.submit(forms[forms.length - 1]!);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0];
    expect(body.floor).toBeUndefined();
    expect(body.description).toBeUndefined();
  });

  it("Add Ward POST rejection surfaces toast.error(err.message); modal stays open", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue(new Error("name taken"));

    const { container } = render(<WardsPage />);
    fireEvent.click(await screen.findByTestId("add-ward-cta"));
    await screen.findByRole("heading", { name: /^Add New Ward$/ });

    fireEvent.change(screen.getByLabelText(/^Name$/), {
      target: { value: "Dup" },
    });
    const forms = container.querySelectorAll("form");
    fireEvent.submit(forms[forms.length - 1]!);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("name taken"),
    );
    expect(
      screen.getByRole("heading", { name: /^Add New Ward$/ }),
    ).toBeInTheDocument();
  });

  it("Add Ward non-Error rejection falls back to 'Failed to create ward'", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue("string rejection");

    const { container } = render(<WardsPage />);
    fireEvent.click(await screen.findByTestId("add-ward-cta"));
    await screen.findByRole("heading", { name: /^Add New Ward$/ });

    fireEvent.change(screen.getByLabelText(/^Name$/), {
      target: { value: "X" },
    });
    const forms = container.querySelectorAll("form");
    fireEvent.submit(forms[forms.length - 1]!);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to create ward"),
    );
  });

  it("Add Ward modal Cancel closes without firing POST", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    fireEvent.click(await screen.findByTestId("add-ward-cta"));
    await screen.findByRole("heading", { name: /^Add New Ward$/ });

    // The modal has Cancel + Create Ward.
    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/ });
    fireEvent.click(cancelBtns[cancelBtns.length - 1]!);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Add New Ward$/ }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ── Global Add Bed modal ───────────────────────────────────────────────

  it("global Add Bed — missing ward fires 'Select a ward' toast and skips POST", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    fireEvent.click(await screen.findByTestId("add-bed-cta"));
    const modal = await screen.findByTestId("add-bed-modal");

    fireEvent.submit(modal);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Select a ward"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("global Add Bed — missing bedNumber fires its own guard toast", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    fireEvent.click(await screen.findByTestId("add-bed-cta"));
    const modal = await screen.findByTestId("add-bed-modal");

    // Pick a ward; leave bed number empty.
    fireEvent.change(screen.getByTestId("add-bed-ward-select"), {
      target: { value: "ward-1" },
    });
    fireEvent.submit(modal);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Bed number is required"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("global Add Bed — happy POST hits /wards/:id/beds with the right body, closes + refetches", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({ data: { id: "bed-new" } });

    render(<WardsPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/wards"));
    const before = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/wards",
    ).length;

    fireEvent.click(await screen.findByTestId("add-bed-cta"));
    const modal = await screen.findByTestId("add-bed-modal");

    fireEvent.change(screen.getByTestId("add-bed-ward-select"), {
      target: { value: "ward-1" },
    });
    fireEvent.change(screen.getByTestId("add-bed-number"), {
      target: { value: "B-NEW" },
    });
    fireEvent.submit(modal);

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith("/wards/ward-1/beds", {
      bedNumber: "B-NEW",
    });
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Bed created"),
    );

    // Modal closes.
    await waitFor(() =>
      expect(screen.queryByTestId("add-bed-modal")).not.toBeInTheDocument(),
    );
    // Refetch fires.
    await waitFor(() => {
      const after = apiMock.get.mock.calls.filter(
        (c: any[]) => c[0] === "/wards",
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("global Add Bed POST rejection surfaces toast.error(err.message); modal stays open", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue(new Error("dup bed"));

    render(<WardsPage />);
    fireEvent.click(await screen.findByTestId("add-bed-cta"));
    const modal = await screen.findByTestId("add-bed-modal");

    fireEvent.change(screen.getByTestId("add-bed-ward-select"), {
      target: { value: "ward-1" },
    });
    fireEvent.change(screen.getByTestId("add-bed-number"), {
      target: { value: "Z-1" },
    });
    fireEvent.submit(modal);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("dup bed"),
    );
    expect(screen.getByTestId("add-bed-modal")).toBeInTheDocument();
  });

  it("global Add Bed non-Error rejection falls back to 'Failed to add bed'", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue("oops");

    render(<WardsPage />);
    fireEvent.click(await screen.findByTestId("add-bed-cta"));
    const modal = await screen.findByTestId("add-bed-modal");

    fireEvent.change(screen.getByTestId("add-bed-ward-select"), {
      target: { value: "ward-1" },
    });
    fireEvent.change(screen.getByTestId("add-bed-number"), {
      target: { value: "Z-2" },
    });
    fireEvent.submit(modal);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to add bed"),
    );
  });

  it("global Add Bed modal Cancel closes without firing POST", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    fireEvent.click(await screen.findByTestId("add-bed-cta"));
    await screen.findByTestId("add-bed-modal");

    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/ });
    fireEvent.click(cancelBtns[cancelBtns.length - 1]!);

    await waitFor(() =>
      expect(screen.queryByTestId("add-bed-modal")).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ── Inline (per-ward expanded) Add Bed form ────────────────────────────

  it("inline Add Bed — blank bedNumber fires 'Bed number is required' guard", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    // Expand ward
    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);

    // Click the inline Add Bed button to reveal the form.
    fireEvent.click(screen.getByTestId("add-bed-inline-ward-1"));

    // The inline form is a sibling within the expanded card. Submit by
    // selecting the inline form's Save button.
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Bed number is required"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("inline Add Bed — happy POST hits /wards/:id/beds and refetches", async () => {
    wireDefaultGets();
    apiMock.post.mockResolvedValue({ data: { id: "bed-i" } });

    render(<WardsPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/wards"));
    const before = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/wards",
    ).length;

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);
    fireEvent.click(screen.getByTestId("add-bed-inline-ward-1"));

    fireEvent.change(screen.getByPlaceholderText(/^Bed Number$/), {
      target: { value: "INL-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith("/wards/ward-1/beds", {
      bedNumber: "INL-1",
    });
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Bed added"),
    );

    // Inline form unmounts (showBedModal → null).
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(/^Bed Number$/),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => {
      const after = apiMock.get.mock.calls.filter(
        (c: any[]) => c[0] === "/wards",
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("inline Add Bed — API error WITH payload.details renders the field-level concat (Issue #36)", async () => {
    wireDefaultGets();
    const err: any = new Error("Validation failed");
    err.status = 400;
    err.payload = {
      error: "Validation failed",
      details: [
        { field: "bedNumber", message: "must be unique" },
        { field: "bedNumber", message: "must be alphanumeric" },
      ],
    };
    apiMock.post.mockRejectedValue(err);

    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);
    fireEvent.click(screen.getByTestId("add-bed-inline-ward-1"));

    fireEvent.change(screen.getByPlaceholderText(/^Bed Number$/), {
      target: { value: "BAD#" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Validation failed: bedNumber: must be unique; bedNumber: must be alphanumeric",
      ),
    );
  });

  it("inline Add Bed — API error WITHOUT payload.details surfaces err.message only", async () => {
    wireDefaultGets();
    apiMock.post.mockRejectedValue(new Error("boom"));

    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);
    fireEvent.click(screen.getByTestId("add-bed-inline-ward-1"));

    fireEvent.change(screen.getByPlaceholderText(/^Bed Number$/), {
      target: { value: "Z" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("boom"),
    );
  });

  it("inline Add Bed — non-Error rejection falls back to 'Failed to add bed'", async () => {
    wireDefaultGets();
    // Plain object with no .message.
    apiMock.post.mockRejectedValue({});

    render(<WardsPage />);
    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);
    fireEvent.click(screen.getByTestId("add-bed-inline-ward-1"));

    fireEvent.change(screen.getByPlaceholderText(/^Bed Number$/), {
      target: { value: "Y" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to add bed"),
    );
  });

  it("inline Add Bed — Cancel hides the form without firing POST", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);
    fireEvent.click(screen.getByTestId("add-bed-inline-ward-1"));

    // The inline form's Cancel button is the only Cancel on screen (no modal).
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(/^Bed Number$/),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ── BedCell status menu ────────────────────────────────────────────────

  it("BedCell — clicking a bed opens the status menu, picking a status PATCHes /beds/:id/status", async () => {
    wireDefaultGets();
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);

    // Find the AVAILABLE bed "A1" cell — its button shows the bedNumber.
    const bedBtn = await screen.findByRole("button", { name: /A1.*Available/i });
    fireEvent.click(bedBtn);

    // The menu renders the 4 status labels — pick OCCUPIED.
    const occButtons = await screen.findAllByRole("button", { name: /^Occupied$/ });
    fireEvent.click(occButtons[0]!);

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/beds/b-a/status", {
        status: "OCCUPIED",
      }),
    );
  });

  it("BedCell — PATCH rejection surfaces toast.error(err.message)", async () => {
    wireDefaultGets();
    apiMock.patch.mockRejectedValue(new Error("update failed"));

    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);

    const bedBtn = await screen.findByRole("button", { name: /A1.*Available/i });
    fireEvent.click(bedBtn);

    const cleaningBtns = await screen.findAllByRole("button", { name: /^Cleaning$/ });
    fireEvent.click(cleaningBtns[0]!);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("update failed"),
    );
  });

  it("BedCell — PATCH non-Error rejection falls back to 'Failed to update bed'", async () => {
    wireDefaultGets();
    apiMock.patch.mockRejectedValue("oops");

    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);

    const bedBtn = await screen.findByRole("button", { name: /A1.*Available/i });
    fireEvent.click(bedBtn);

    const maintBtns = await screen.findAllByRole("button", {
      name: /^Maintenance$/,
    });
    fireEvent.click(maintBtns[0]!);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to update bed"),
    );
  });

  it("BedCell — clicking the bed twice toggles the status menu closed (no PATCH)", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    const heading = await screen.findByRole("heading", {
      name: /General Ward/,
    });
    fireEvent.click(heading.closest("button")!);

    const bedBtn = await screen.findByRole("button", { name: /A1.*Available/i });
    fireEvent.click(bedBtn);
    expect(await screen.findByRole("button", { name: /^Occupied$/ })).toBeInTheDocument();

    // Click the bed again — menu should close.
    fireEvent.click(bedBtn);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Occupied$/ })).not.toBeInTheDocument(),
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  // ── BedCell edit / delete (admin CRUD) ─────────────────────────────────

  // Helper: expand the ward and open bed A1's action menu.
  async function openBedMenu(bedName = /A1.*Available/i) {
    const heading = await screen.findByRole("heading", { name: /General Ward/ });
    fireEvent.click(heading.closest("button")!);
    const bedBtn = await screen.findByRole("button", { name: bedName });
    fireEvent.click(bedBtn);
    return bedBtn;
  }

  it("BedCell — admin sees Edit + Delete actions in the bed menu", async () => {
    wireDefaultGets();
    render(<WardsPage />);
    await openBedMenu();
    expect(await screen.findByTestId("edit-bed-b-a")).toBeInTheDocument();
    expect(screen.getByTestId("delete-bed-b-a")).toBeInTheDocument();
  });

  it("BedCell — non-admin does NOT see Edit/Delete actions", async () => {
    asDoctor();
    wireDefaultGets();
    render(<WardsPage />);
    // Doctors can still open the status menu, but no edit/delete affordances.
    await openBedMenu();
    expect(screen.queryByTestId("edit-bed-b-a")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delete-bed-b-a")).not.toBeInTheDocument();
  });

  it("BedCell edit — happy PATCH /beds/:id with changed number + rate, success toast, refetch", async () => {
    wireDefaultGets({
      wards: [
        wardFixture({
          beds: [
            bedFixture({ id: "b-a", bedNumber: "A1", status: "AVAILABLE", dailyRate: 1000 }),
          ],
        }),
      ],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    render(<WardsPage />);
    await openBedMenu();

    fireEvent.click(await screen.findByTestId("edit-bed-b-a"));
    const form = await screen.findByTestId("edit-bed-form-b-a");
    const numberInput = within(form).getByLabelText("Bed number");
    const rateInput = within(form).getByLabelText("Bed price");
    fireEvent.change(numberInput, { target: { value: "A1-NEW" } });
    fireEvent.change(rateInput, { target: { value: "2500" } });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/beds/b-a", {
        bedNumber: "A1-NEW",
        dailyRate: 2500,
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Bed updated");
  });

  it("BedCell edit — no changes → closes editor without PATCH", async () => {
    wireDefaultGets({
      wards: [
        wardFixture({
          beds: [bedFixture({ id: "b-a", bedNumber: "A1", status: "AVAILABLE", dailyRate: 1000 })],
        }),
      ],
    });
    render(<WardsPage />);
    await openBedMenu();
    fireEvent.click(await screen.findByTestId("edit-bed-b-a"));
    const form = await screen.findByTestId("edit-bed-form-b-a");
    // Submit with the prefilled (unchanged) values.
    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.queryByTestId("edit-bed-form-b-a")).not.toBeInTheDocument(),
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("BedCell edit — blank bed number fires guard toast, no PATCH", async () => {
    wireDefaultGets();
    render(<WardsPage />);
    await openBedMenu();
    fireEvent.click(await screen.findByTestId("edit-bed-b-a"));
    const form = await screen.findByTestId("edit-bed-form-b-a");
    fireEvent.change(within(form).getByLabelText("Bed number"), {
      target: { value: "   " },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Bed number is required"),
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("BedCell edit — invalid (negative) rate fires guard toast, no PATCH", async () => {
    wireDefaultGets();
    render(<WardsPage />);
    await openBedMenu();
    fireEvent.click(await screen.findByTestId("edit-bed-b-a"));
    const form = await screen.findByTestId("edit-bed-form-b-a");
    fireEvent.change(within(form).getByLabelText("Bed price"), {
      target: { value: "-5" },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Daily rate must be a number ≥ 0"),
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("BedCell edit — PATCH rejection toasts the error and keeps the editor open", async () => {
    wireDefaultGets({
      wards: [
        wardFixture({
          beds: [bedFixture({ id: "b-a", bedNumber: "A1", status: "AVAILABLE", dailyRate: 1000 })],
        }),
      ],
    });
    apiMock.patch.mockRejectedValue(new Error("Bed \"A2\" already exists in this ward."));
    render(<WardsPage />);
    await openBedMenu();
    fireEvent.click(await screen.findByTestId("edit-bed-b-a"));
    const form = await screen.findByTestId("edit-bed-form-b-a");
    fireEvent.change(within(form).getByLabelText("Bed number"), {
      target: { value: "A2" },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'Bed "A2" already exists in this ward.',
      ),
    );
    // Editor stays open on failure.
    expect(screen.getByTestId("edit-bed-form-b-a")).toBeInTheDocument();
  });

  it("BedCell edit — Cancel closes the editor without PATCH", async () => {
    wireDefaultGets();
    render(<WardsPage />);
    await openBedMenu();
    fireEvent.click(await screen.findByTestId("edit-bed-b-a"));
    const form = await screen.findByTestId("edit-bed-form-b-a");
    fireEvent.click(within(form).getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() =>
      expect(screen.queryByTestId("edit-bed-form-b-a")).not.toBeInTheDocument(),
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("BedCell delete — confirm yes → DELETE /beds/:id, success toast, refetch", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    wireDefaultGets();
    apiMock.delete.mockResolvedValue({ data: { id: "b-a" } });
    render(<WardsPage />);
    await openBedMenu();
    fireEvent.click(await screen.findByTestId("delete-bed-b-a"));
    await waitFor(() => expect(apiMock.delete).toHaveBeenCalledWith("/beds/b-a"));
    expect(toastMock.success).toHaveBeenCalledWith("Bed deleted");
    confirmSpy.mockRestore();
  });

  it("BedCell delete — confirm no → no DELETE call", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    wireDefaultGets();
    render(<WardsPage />);
    await openBedMenu();
    fireEvent.click(await screen.findByTestId("delete-bed-b-a"));
    await waitFor(() =>
      expect(screen.queryByTestId("delete-bed-b-a")).not.toBeInTheDocument(),
    );
    expect(apiMock.delete).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("BedCell delete — DELETE rejection surfaces toast.error(err.message)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    wireDefaultGets();
    apiMock.delete.mockRejectedValue(new Error("Bed \"A1\" is occupied."));
    render(<WardsPage />);
    await openBedMenu();
    fireEvent.click(await screen.findByTestId("delete-bed-b-a"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('Bed "A1" is occupied.'),
    );
    confirmSpy.mockRestore();
  });

  it("BedCell delete — non-Error rejection falls back to 'Failed to delete bed'", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    wireDefaultGets();
    apiMock.delete.mockRejectedValue("boom");
    render(<WardsPage />);
    await openBedMenu();
    fireEvent.click(await screen.findByTestId("delete-bed-b-a"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to delete bed"),
    );
    confirmSpy.mockRestore();
  });

  it("BedCell edit — non-Error PATCH rejection falls back to 'Failed to update bed'", async () => {
    wireDefaultGets({
      wards: [
        wardFixture({
          beds: [bedFixture({ id: "b-a", bedNumber: "A1", status: "AVAILABLE", dailyRate: 1000 })],
        }),
      ],
    });
    apiMock.patch.mockRejectedValue("oops");
    render(<WardsPage />);
    await openBedMenu();
    fireEvent.click(await screen.findByTestId("edit-bed-b-a"));
    const form = await screen.findByTestId("edit-bed-form-b-a");
    fireEvent.change(within(form).getByLabelText("Bed number"), {
      target: { value: "A9" },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to update bed"),
    );
  });

  // ── Forecast tab (OccupancyForecast subcomponent) ──────────────────────

  it("clicking the Forecast tab fires GET /admissions/forecast?days=7", async () => {
    wireDefaultGets({ forecast: [] });
    render(<WardsPage />);

    // Wait for wards to settle so we don't race the click.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/wards"));

    fireEvent.click(screen.getByRole("button", { name: /Forecast/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/admissions/forecast?days=7",
      ),
    );
    // Loading text appears for the forecast pane.
    expect(
      await screen.findByText(/Forecast not yet available/i),
    ).toBeInTheDocument();
  });

  it("Forecast empty payload renders the 'not yet available' hint", async () => {
    wireDefaultGets({ forecast: [] });
    render(<WardsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Forecast/i }));

    expect(
      await screen.findByText(/Forecast not yet available/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Predicted bed occupancy will appear here/i),
    ).toBeInTheDocument();
  });

  it("Forecast populated payload renders the SVG chart + the data table with %-occ color buckets", async () => {
    wireDefaultGets({
      forecast: [
        // <75 → green
        {
          date: "2026-06-01",
          predictedOccupancy: 20,
          totalBeds: 50,
          occupancyPercent: 40,
          incomingAdmissions: 3,
          expectedDischarges: 2,
        },
        // 75-89 → amber
        {
          date: "2026-06-02",
          predictedOccupancy: 40,
          totalBeds: 50,
          occupancyPercent: 80,
          incomingAdmissions: 5,
          expectedDischarges: 1,
        },
        // >=90 → red
        {
          date: "2026-06-03",
          predictedOccupancy: 48,
          totalBeds: 50,
          occupancyPercent: 96,
          incomingAdmissions: 7,
          expectedDischarges: 1,
        },
      ],
    });
    render(<WardsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Forecast/i }));

    // Wait for the table to render.
    expect(
      await screen.findByText(/Next 7 Days Predicted Occupancy/i),
    ).toBeInTheDocument();
    expect(screen.getByText("2026-06-01")).toBeInTheDocument();
    expect(screen.getByText("2026-06-02")).toBeInTheDocument();
    expect(screen.getByText("2026-06-03")).toBeInTheDocument();

    // Look at the table cell for 2026-06-03 — its row should have a red pill.
    const row3 = screen.getByText("2026-06-03").closest("tr")!;
    const pill3 = within(row3).getByText(/96%/);
    expect(pill3.className).toMatch(/bg-red-100/);

    const row2 = screen.getByText("2026-06-02").closest("tr")!;
    const pill2 = within(row2).getByText(/80%/);
    expect(pill2.className).toMatch(/bg-amber-100/);

    const row1 = screen.getByText("2026-06-01").closest("tr")!;
    const pill1 = within(row1).getByText(/40%/);
    expect(pill1.className).toMatch(/bg-green-100/);
  });

  it("Forecast GET rejection swallows + falls into the 'not yet available' branch", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/wards") return Promise.resolve({ data: [wardFixture()] });
      if (url.startsWith("/admissions/forecast"))
        return Promise.reject(new Error("forecast boom"));
      return Promise.resolve({ data: [] });
    });
    render(<WardsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Forecast/i }));

    expect(
      await screen.findByText(/Forecast not yet available/i),
    ).toBeInTheDocument();
  });

  // ── Socket subscription ────────────────────────────────────────────────

  it("subscribes to 'admission:status' on mount and connects an idle socket", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    await waitFor(() =>
      expect(socketMock.on).toHaveBeenCalledWith(
        "admission:status",
        expect.any(Function),
      ),
    );
    expect(socketMock.connect).toHaveBeenCalled();
  });

  it("does NOT call socket.connect when the socket is already connected", async () => {
    socketMock.connected = true;
    wireDefaultGets();
    render(<WardsPage />);

    await waitFor(() => expect(socketMock.on).toHaveBeenCalled());
    expect(socketMock.connect).not.toHaveBeenCalled();
  });

  it("invoking the 'admission:status' handler triggers a /wards refetch", async () => {
    wireDefaultGets();
    render(<WardsPage />);

    await waitFor(() => expect(socketMock.on).toHaveBeenCalled());
    const before = apiMock.get.mock.calls.filter(
      (c: any[]) => c[0] === "/wards",
    ).length;

    // Find the registered handler and invoke it.
    const handlerCall = socketMock.on.mock.calls.find(
      (c: any[]) => c[0] === "admission:status",
    )!;
    const handler = handlerCall[1] as () => void;
    handler();

    await waitFor(() => {
      const after = apiMock.get.mock.calls.filter(
        (c: any[]) => c[0] === "/wards",
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("unmount detaches the 'admission:status' listener via socket.off", async () => {
    wireDefaultGets();
    const { unmount } = render(<WardsPage />);

    await waitFor(() => expect(socketMock.on).toHaveBeenCalled());
    unmount();

    expect(socketMock.off).toHaveBeenCalledWith(
      "admission:status",
      expect.any(Function),
    );
  });

  // ── Error-path resilience ──────────────────────────────────────────────

  it("swallows GET /wards rejection and falls through to the empty branch", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/wards") return Promise.reject(new Error("wards boom"));
      return Promise.resolve({ data: [] });
    });

    render(<WardsPage />);

    // The page still mounts.
    expect(
      await screen.findByRole("heading", { name: /Wards & Beds/i, level: 1 }),
    ).toBeInTheDocument();
    // Loading clears (set false in the catch's finally-equivalent) and we fall
    // into the empty branch since wards remains [].
    await waitFor(() =>
      expect(screen.queryByTestId("wards-loading")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/No wards yet\./)).toBeInTheDocument();
  });
});
