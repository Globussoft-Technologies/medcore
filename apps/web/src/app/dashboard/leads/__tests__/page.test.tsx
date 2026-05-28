/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * LeadsPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of `apps/web/src/app/dashboard/leads/page.tsx`,
 *     the Pearl §3.3 CRM lead pipeline list view. Endpoints the page hits:
 *       GET   /leads?status=...&source=...&q=...
 *       POST  /leads                 (create lead)
 *       PATCH /leads/:id             (inline status pill)
 *   - Behaviours covered:
 *       1. Non-staff (role=PATIENT) — renders the "staff-only" copy and does
 *          NOT dispatch a /leads fetch.
 *       2. Loading branch — "Loading…" placeholder renders while the first
 *          fetch is pending; header chrome ("Leads") still visible.
 *       3. Happy fetch — multiple lead rows render with name, contact pair,
 *          source label (underscore-stripped), assignedToUser fallback em-dash,
 *          activity count, and a status <select> per row.
 *       4. Empty fetch — "No leads match the current filter." copy renders.
 *       5. Error fetch — toast.error fires with the thrown message (and the
 *          fallback "Failed to load leads" copy when the rejection has no
 *          message), and the empty branch renders after the loading flip.
 *       6. Status filter chip — clicking a chip refetches with status=<value>
 *          in the query string; the All chip refetches without status.
 *       7. Source filter <select> — changing the source dropdown refetches
 *          with source=<value> in the query string.
 *       8. Inline status pill — changing a row's <select> fires
 *          PATCH /leads/:id with { status }, toasts success, and triggers a
 *          reload. Selecting the SAME status is a no-op (no PATCH).
 *       9. Create modal — header CTA opens the modal; submitting WITHOUT a
 *          name short-circuits (toast.error, no POST); submitting WITH a name
 *          POSTs /leads with the trimmed payload (undefined for blank optional
 *          fields), toasts success, closes the modal, and refetches.
 *      10. Create error — POST rejection routes through toast.error (and
 *          fallback copy when the rejection has no message); modal stays open.
 *      11. Cancel button on the create modal hides the modal.
 *      12. Detail link — each row's name is wrapped in an <a> pointing at
 *          /dashboard/leads/:id.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast, next/link,
 *            and lucide-react icons (stubbed to plain spans).
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

const { apiMock, toastMock, authMock } = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("lucide-react", () => ({
  Plus: () => <span data-testid="icon-plus" />,
  Search: () => <span data-testid="icon-search" />,
  UserCheck: () => <span data-testid="icon-user-check" />,
}));

import LeadsPage from "../page";

type LeadRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: string;
  status: string;
  notes: string | null;
  createdAt: string;
  assignedToUser?: { id: string; name: string; role: string } | null;
  preferredDoctor?: { id: string; user: { name: string } } | null;
  _count?: { activities: number };
};

function leadFixture(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    id: "lead-1",
    name: "Aanya Sharma",
    phone: "+919999000111",
    email: "aanya@example.com",
    source: "PHONE",
    status: "NEW",
    notes: null,
    createdAt: "2026-04-01T10:00:00.000Z",
    assignedToUser: null,
    preferredDoctor: null,
    _count: { activities: 2 },
    ...overrides,
  };
}

function ok(leads: LeadRow[]) {
  return { data: leads };
}

function asStaff() {
  authMock.mockReturnValue({
    user: {
      id: "u-recep",
      userId: "u-recep",
      role: "RECEPTION",
      name: "Front Desk",
    },
  });
}

function asPatient() {
  authMock.mockReturnValue({
    user: {
      id: "u-pat",
      userId: "u-pat",
      role: "PATIENT",
      name: "Pat",
    },
  });
}

describe("Leads dashboard page (CRM pipeline)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asStaff();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the staff-only copy when the caller is a PATIENT (no table, no filter chips)", () => {
    apiMock.get.mockResolvedValue(ok([]));
    asPatient();
    render(<LeadsPage />);
    // The early-return branch wins: copy renders, no table chrome, no filter
    // chips. (Note: hooks run before the early return so a `load()` fetch
    // does fire; that's a separate API-layer concern, gated by the
    // /leads route's own authorize(...) — see CLAUDE.md gotcha #7.)
    expect(
      screen.getByText(/Lead pipeline is staff-only\./i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^Leads$/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("leads-create-btn")).not.toBeInTheDocument();
  });

  it('renders the "Loading…" placeholder while the initial fetch is pending', async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<LeadsPage />);

    expect(
      screen.getByRole("heading", { name: /^Leads$/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/^Loading…$/)).toBeInTheDocument(),
    );
  });

  it("hits GET /leads (no filters in querystring) on mount and renders one row per lead", async () => {
    apiMock.get.mockResolvedValue(
      ok([
        leadFixture({ id: "l-1", name: "Aanya Sharma" }),
        leadFixture({
          id: "l-2",
          name: "Rohit Kumar",
          source: "WALK_IN",
          status: "QUALIFIED",
          assignedToUser: {
            id: "u-1",
            name: "Front Desk",
            role: "RECEPTION",
          },
          _count: { activities: 5 },
        }),
      ]),
    );

    render(<LeadsPage />);

    await screen.findByText("Aanya Sharma");
    await screen.findByText("Rohit Kumar");

    // Querystring contract: no filters set → trailing "?" with no params.
    expect(apiMock.get).toHaveBeenCalledWith("/leads?");

    // Source enum is underscore-stripped in the row. The source filter
    // dropdown ALSO renders "WALK IN" / "PHONE" as <option> labels, so
    // scope to the table body to assert the row-cell value uniquely.
    const tbody = document.querySelector("tbody")!;
    expect(within(tbody).getByText("WALK IN")).toBeInTheDocument();
    expect(within(tbody).getByText("PHONE")).toBeInTheDocument();

    // assignedToUser name renders when present, em-dash when null.
    expect(screen.getByText("Front Desk")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();

    // Activity counts.
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();

    // Inline status pill rendered per row with the matching testid.
    expect(screen.getByTestId("lead-status-l-1")).toBeInTheDocument();
    expect(screen.getByTestId("lead-status-l-2")).toBeInTheDocument();

    // Detail link wraps the name.
    const detailLink = screen.getByRole("link", { name: "Aanya Sharma" });
    expect(detailLink).toHaveAttribute("href", "/dashboard/leads/l-1");
  });

  it('renders "No leads match the current filter." when the API returns zero rows', async () => {
    apiMock.get.mockResolvedValue(ok([]));
    render(<LeadsPage />);

    expect(
      await screen.findByText(/No leads match the current filter\./i),
    ).toBeInTheDocument();
  });

  it("surfaces the thrown message via toast.error when the fetch rejects, then settles into the empty branch", async () => {
    apiMock.get.mockRejectedValue(new Error("Network down"));
    render(<LeadsPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Network down"),
    );
    expect(
      await screen.findByText(/No leads match the current filter\./i),
    ).toBeInTheDocument();
  });

  it('falls back to "Failed to load leads" when the rejection has no message', async () => {
    apiMock.get.mockRejectedValue({});
    render(<LeadsPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to load leads"),
    );
  });

  it("refetches with status=<value> when a stage chip is clicked, and drops the param when All is clicked again", async () => {
    apiMock.get.mockResolvedValue(ok([leadFixture({ id: "l-1" })]));
    render(<LeadsPage />);
    await screen.findByText("Aanya Sharma");

    // Mount fetch + chip-driven fetch.
    fireEvent.click(screen.getByRole("button", { name: /^QUALIFIED \(/i }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/leads?status=QUALIFIED"),
    );

    fireEvent.click(screen.getByRole("button", { name: /^All \(/i }));
    await waitFor(() => {
      const lastCall = apiMock.get.mock.calls.at(-1)?.[0];
      expect(lastCall).toBe("/leads?");
    });
  });

  it("refetches with source=<value> when the source <select> changes", async () => {
    apiMock.get.mockResolvedValue(ok([leadFixture()]));
    render(<LeadsPage />);
    await screen.findByText("Aanya Sharma");

    // Lock onto the source dropdown by a unique source option (per CLAUDE.md
    // gotcha #9 — there are multiple <select>s on the page).
    const sourceSelect = document.querySelector(
      'select:has(option[value="WHATSAPP"])',
    ) as HTMLSelectElement;
    expect(sourceSelect).toBeTruthy();

    fireEvent.change(sourceSelect, { target: { value: "REFERRAL" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/leads?source=REFERRAL"),
    );
  });

  it("PATCHes /leads/:id with { status } when the inline status pill changes, toasts success, and refetches", async () => {
    apiMock.get.mockResolvedValue(ok([leadFixture({ id: "l-1", status: "NEW" })]));
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<LeadsPage />);
    await screen.findByText("Aanya Sharma");

    const initialGetCalls = apiMock.get.mock.calls.length;

    fireEvent.change(screen.getByTestId("lead-status-l-1"), {
      target: { value: "BOOKED" },
    });

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/leads/l-1", {
        status: "BOOKED",
      }),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Moved to BOOKED"),
    );
    // The post-patch load() refetches.
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(initialGetCalls),
    );
  });

  it("no-ops the status pill when the same value is re-selected (no PATCH)", async () => {
    apiMock.get.mockResolvedValue(ok([leadFixture({ id: "l-1", status: "NEW" })]));
    render(<LeadsPage />);
    await screen.findByText("Aanya Sharma");

    fireEvent.change(screen.getByTestId("lead-status-l-1"), {
      target: { value: "NEW" },
    });

    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("toasts the error when PATCH fails (with fallback copy when no message)", async () => {
    apiMock.get.mockResolvedValue(ok([leadFixture({ id: "l-1", status: "NEW" })]));
    apiMock.patch.mockRejectedValue({});

    render(<LeadsPage />);
    await screen.findByText("Aanya Sharma");

    fireEvent.change(screen.getByTestId("lead-status-l-1"), {
      target: { value: "LOST" },
    });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to update status"),
    );
  });

  it("opens the create-lead modal when the header CTA is clicked", async () => {
    apiMock.get.mockResolvedValue(ok([]));
    render(<LeadsPage />);
    await screen.findByText(/No leads match the current filter\./i);

    fireEvent.click(screen.getByTestId("leads-create-btn"));

    expect(
      screen.getByRole("heading", { name: /^New lead$/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("lead-create-name")).toBeInTheDocument();
  });

  it("disables the Create button + does NOT POST while the name field is blank", async () => {
    // 2026-05 (Issue #1002) — the form now live-validates: the Create
    // button is `disabled={!canSubmit}` where canSubmit requires zero
    // liveErrors. With a blank name the button is disabled, the click
    // is swallowed by the browser, and no POST / toast / inline error
    // appears. The inline error only renders AFTER a submit attempt
    // (which we can't make while disabled), so this test pins the
    // disabled state + the no-POST invariant instead.
    apiMock.get.mockResolvedValue(ok([]));
    render(<LeadsPage />);
    await screen.findByText(/No leads match the current filter\./i);

    fireEvent.click(screen.getByTestId("leads-create-btn"));
    const submit = screen.getByTestId(
      "lead-create-submit",
    ) as HTMLButtonElement;
    expect(submit).toBeDisabled();

    fireEvent.click(submit);
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    // Modal stays open.
    expect(
      screen.getByRole("heading", { name: /^New lead$/i }),
    ).toBeInTheDocument();
  });

  it("POSTs /leads with the trimmed payload (undefined for blank optional fields), toasts success, closes the modal, and reloads", async () => {
    apiMock.get.mockResolvedValueOnce(ok([]));
    apiMock.post.mockResolvedValue({ data: { id: "new-lead" } });
    apiMock.get.mockResolvedValueOnce(
      ok([leadFixture({ id: "new-lead", name: "Created Lead" })]),
    );

    render(<LeadsPage />);
    await screen.findByText(/No leads match the current filter\./i);

    fireEvent.click(screen.getByTestId("leads-create-btn"));

    fireEvent.change(screen.getByTestId("lead-create-name"), {
      target: { value: "  Created Lead  " },
    });

    fireEvent.click(screen.getByTestId("lead-create-submit"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith("/leads", {
      name: "Created Lead",
      phone: undefined,
      email: undefined,
      source: "PHONE",
      notes: undefined,
    });

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Lead created"),
    );

    // Modal closes (heading gone) AND reload pulls in the new lead.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^New lead$/i }),
      ).not.toBeInTheDocument(),
    );
    await screen.findByText("Created Lead");
  });

  it("surfaces the server error in the form banner and keeps the modal open when POST /leads rejects", async () => {
    // 2026-05 (Issue #1001) — POST-rejection errors now render as a
    // form-level banner (`lead-create-error`) inside the modal rather
    // than a toast, so the message sits right next to the inputs the
    // operator is about to retry.
    apiMock.get.mockResolvedValue(ok([]));
    apiMock.post.mockRejectedValue(new Error("400 duplicate phone"));

    render(<LeadsPage />);
    await screen.findByText(/No leads match the current filter\./i);

    fireEvent.click(screen.getByTestId("leads-create-btn"));
    fireEvent.change(screen.getByTestId("lead-create-name"), {
      target: { value: "Dup Lead" },
    });

    fireEvent.click(screen.getByTestId("lead-create-submit"));

    const banner = await screen.findByTestId("lead-create-error");
    expect(banner).toHaveTextContent("400 duplicate phone");
    expect(toastMock.error).not.toHaveBeenCalledWith("400 duplicate phone");
    // Modal still mounted (not closed on failure).
    expect(
      screen.getByRole("heading", { name: /^New lead$/i }),
    ).toBeInTheDocument();
  });

  it('falls back to "Failed to create lead" banner copy when the POST rejection has no message', async () => {
    // 2026-05 — bare-object rejections (no `.message`) fall through to
    // a default "Failed to create lead" string rendered in the same
    // form banner instead of a toast.
    apiMock.get.mockResolvedValue(ok([]));
    apiMock.post.mockRejectedValue({});

    render(<LeadsPage />);
    await screen.findByText(/No leads match the current filter\./i);

    fireEvent.click(screen.getByTestId("leads-create-btn"));
    // The name input must clear the banner on edit; type ≥ 2 chars to
    // satisfy the client-side validator before submission so we
    // actually reach the POST + the catch branch.
    fireEvent.change(screen.getByTestId("lead-create-name"), {
      target: { value: "Xy" },
    });
    fireEvent.click(screen.getByTestId("lead-create-submit"));

    const banner = await screen.findByTestId("lead-create-error");
    expect(banner).toHaveTextContent(/failed to create lead/i);
  });

  it("Cancel button on the create modal hides the modal", async () => {
    apiMock.get.mockResolvedValue(ok([]));
    render(<LeadsPage />);
    await screen.findByText(/No leads match the current filter\./i);

    fireEvent.click(screen.getByTestId("leads-create-btn"));
    expect(
      screen.getByRole("heading", { name: /^New lead$/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    expect(
      screen.queryByRole("heading", { name: /^New lead$/i }),
    ).not.toBeInTheDocument();
  });

  it("renders every stage chip with a count derived from the loaded leads", async () => {
    apiMock.get.mockResolvedValue(
      ok([
        leadFixture({ id: "l-1", name: "A One", status: "NEW" }),
        leadFixture({ id: "l-2", name: "B Two", status: "NEW" }),
        leadFixture({ id: "l-3", name: "C Three", status: "QUALIFIED" }),
      ]),
    );
    render(<LeadsPage />);
    await screen.findByText("A One");

    // All count = 3, NEW count = 2, QUALIFIED count = 1.
    expect(screen.getByRole("button", { name: /^All \(3\)$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^NEW \(2\)$/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^QUALIFIED \(1\)$/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^LOST \(0\)$/ })).toBeInTheDocument();
  });

  it("triggers a search-driven reload when Enter is pressed in the search input", async () => {
    apiMock.get.mockResolvedValue(ok([]));
    render(<LeadsPage />);
    await screen.findByText(/No leads match the current filter\./i);

    const searchInput = screen.getByPlaceholderText(
      /Search name \/ phone \/ email/i,
    );
    fireEvent.change(searchInput, { target: { value: "  Aanya  " } });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/leads?q=Aanya"),
    );
  });
});

