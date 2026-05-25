/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * HolidaysPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/holidays/page.tsx, the ADMIN-only
 *     hospital-holidays surface. Endpoints the page hits:
 *       GET    /hr-ops/holidays?year=YYYY        (list)
 *       POST   /hr-ops/holidays                  (create)
 *       PATCH  /hr-ops/holidays/:id              (update, Issue #692)
 *       DELETE /hr-ops/holidays/:id              (Issue #726)
 *
 *   - Behaviours covered:
 *       1. RBAC — non-ADMIN role (NURSE) triggers router.push("/dashboard"),
 *          render short-circuits to null, and the GET never fires.
 *       2. Loading branch — SkeletonTable renders inside `holidays-loading`
 *          while the initial GET is pending.
 *       3. Happy fetch — one row per Holiday with name + type pill + edit /
 *          delete affordances; querystring carries the current year.
 *       4. Empty branch — "No holidays configured for {year}" copy when [].
 *       5. Error-path resilience — initial GET rejection still flips loading
 *          off and renders the empty branch (silent — no error toast).
 *       6. Year filter — changing the <select> refetches with the new year.
 *       7. Add Holiday — modal opens, validates required date, validates
 *          XSS/empty name via sanitizeUserInput (rejects "<script>" payload),
 *          posts a clean body on the happy path, closes modal, reloads.
 *       8. Edit Holiday (Issue #692) — opens the same form pre-populated,
 *          locks into PATCH mode, toasts the "Updated …" copy.
 *       9. Cancel button — closes the modal AND clears editingHoliday state.
 *      10. Delete Holiday (Issue #726) — confirms via useConfirm, toasts on
 *          success, toasts on rejection, no-ops when user cancels.
 *      11. Validation field-errors (Issue #293) — server zod errors render
 *          inline next to the offending input via extractFieldErrors.
 *      12. Server-side rejection of POST without field-errors surfaces a
 *          generic toast.error and keeps the modal open for retry.
 *      13. Import Template — opens confirm, posts N holidays, toasts the
 *          add/skip summary, reloads. Skips existing same-date entries.
 *      14. Import Template — confirm dialog cancelled is a no-op.
 *
 *   - Mocks: @/lib/api (api.{get,post,patch,delete}), @/lib/store
 *            (useAuthStore — supports both bare-call and selector usage),
 *            @/lib/toast (toast.{success,error}), @/lib/use-dialog
 *            (useConfirm wired to a per-test queue), next/navigation
 *            (useRouter), @/components/Skeleton (passthrough stub).
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
  usePrompt: () => vi.fn(async () => ""),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/holidays",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import HolidaysPage from "../page";

type Holiday = {
  id: string;
  date: string;
  name: string;
  type: string;
  description?: string | null;
};

const HOLIDAYS: Holiday[] = [
  {
    id: "h1",
    date: "2026-01-26T00:00:00.000Z",
    name: "Republic Day",
    type: "PUBLIC",
    description: "National holiday",
  },
  {
    id: "h2",
    date: "2026-08-15T00:00:00.000Z",
    name: "Independence Day",
    type: "OPTIONAL",
  },
  {
    id: "h3",
    date: "2026-12-25T00:00:00.000Z",
    name: "Christmas",
    type: "RESTRICTED",
    description: null,
  },
];

function asAdmin() {
  authMock.mockImplementation((sel?: any) => {
    const state = {
      user: { id: "u-admin", name: "Admin", email: "a@test.local", role: "ADMIN" },
    };
    return typeof sel === "function" ? sel(state) : state;
  });
}

function asNurse() {
  authMock.mockImplementation((sel?: any) => {
    const state = {
      user: { id: "u-nurse", name: "Nurse", email: "n@test.local", role: "NURSE" },
    };
    return typeof sel === "function" ? sel(state) : state;
  });
}

describe("Holidays dashboard page (admin-only holiday calendar)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
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

  it("redirects non-ADMIN (NURSE) to /dashboard and never fires the holidays GET", async () => {
    apiMock.get.mockResolvedValue({ data: HOLIDAYS });
    asNurse();

    render(<HolidaysPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
    // Non-ADMIN: render returns null after the redirect short-circuits.
    expect(
      screen.queryByRole("heading", { name: /^Holidays$/ }),
    ).not.toBeInTheDocument();
    // The load() useEffect is role-gated, so no fetch should fire.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the SkeletonTable loading branch while the initial GET is pending", () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));

    render(<HolidaysPage />);

    expect(
      screen.getByRole("heading", { name: /^Holidays$/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("holidays-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("hits /hr-ops/holidays?year=… on mount and renders one row per Holiday with the type pill", async () => {
    apiMock.get.mockResolvedValue({ data: HOLIDAYS });

    render(<HolidaysPage />);

    // Wait for all three rows.
    expect(await screen.findByText("Republic Day")).toBeInTheDocument();
    expect(screen.getByText("Independence Day")).toBeInTheDocument();
    expect(screen.getByText("Christmas")).toBeInTheDocument();

    // Querystring contract: year param matches the year-select default
    // (current calendar year). We accept any 4-digit year so the test
    // is robust against the clock.
    const call = apiMock.get.mock.calls.find((c) =>
      (c[0] as string).startsWith("/hr-ops/holidays?year="),
    );
    expect(call).toBeTruthy();
    expect(call?.[0]).toMatch(/^\/hr-ops\/holidays\?year=\d{4}$/);

    // Type pills rendered (one per row).
    expect(screen.getByText("PUBLIC")).toBeInTheDocument();
    expect(screen.getByText("OPTIONAL")).toBeInTheDocument();
    expect(screen.getByText("RESTRICTED")).toBeInTheDocument();

    // Description column: "National holiday" for h1, "—" for h3 (null desc).
    expect(screen.getByText("National holiday")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);

    // Per-row edit/delete affordances exist for every row.
    expect(screen.getByTestId("holiday-edit-h1")).toBeInTheDocument();
    expect(screen.getByTestId("holiday-delete-h1")).toBeInTheDocument();
    expect(screen.getByTestId("holiday-edit-h2")).toBeInTheDocument();
    expect(screen.getByTestId("holiday-delete-h2")).toBeInTheDocument();
  });

  it('renders "No holidays configured" empty-state when the list is []', async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<HolidaysPage />);

    expect(
      await screen.findByText(/no holidays configured/i),
    ).toBeInTheDocument();
  });

  it("silently swallows the initial GET rejection and renders the empty branch", async () => {
    apiMock.get.mockRejectedValue(new Error("server down"));

    render(<HolidaysPage />);

    expect(
      await screen.findByText(/no holidays configured/i),
    ).toBeInTheDocument();
    // The try/catch is silent — no error toast.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("refetches with the new year when the year <select> changes", async () => {
    apiMock.get.mockResolvedValue({ data: HOLIDAYS });

    render(<HolidaysPage />);
    await screen.findByText("Republic Day");

    apiMock.get.mockClear();

    // The year selector is the first <select> in the page chrome
    // (modal is closed so there's no second select around).
    const yearSelect = document.querySelector("select") as HTMLSelectElement;
    expect(yearSelect).toBeTruthy();

    // Year options are [now-2 … now+2]; pick the smallest non-current option
    // so we don't have to know "this year" exactly.
    const otherYear = Array.from(yearSelect.options).find(
      (o) => o.value !== yearSelect.value,
    )?.value;
    expect(otherYear).toBeTruthy();

    fireEvent.change(yearSelect, { target: { value: otherYear } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        `/hr-ops/holidays?year=${otherYear}`,
      ),
    );
  });

  it("opens the Add Holiday modal, validates a missing date, and never POSTs", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<HolidaysPage />);
    await screen.findByText(/no holidays configured/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Holiday/i }));

    expect(
      await screen.findByRole("heading", { name: /^Add Holiday$/ }),
    ).toBeInTheDocument();

    // Save without any input → date required + name required errors.
    fireEvent.click(screen.getByTestId("holiday-save"));

    expect(await screen.findByTestId("error-date")).toHaveTextContent(
      /Date is required/i,
    );
    // Name validation is from sanitizeUserInput — empty string returns
    // "Name cannot be empty" (NOT "Name is required") for typeof === "string".
    expect(screen.getByTestId("error-name")).toBeInTheDocument();

    // No POST issued.
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects an XSS payload in the Name field via sanitizeUserInput (Issue #292)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<HolidaysPage />);
    await screen.findByText(/no holidays configured/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Holiday/i }));

    const dateInput = screen.getByTestId("holiday-date") as HTMLInputElement;
    const nameInput = screen.getByTestId("holiday-name") as HTMLInputElement;

    fireEvent.change(dateInput, { target: { value: "2026-07-04" } });
    fireEvent.change(nameInput, {
      target: { value: 'Test <script>alert(1)</script>' },
    });

    fireEvent.click(screen.getByTestId("holiday-save"));

    const nameErr = await screen.findByTestId("error-name");
    expect(nameErr.textContent).toMatch(/aren't allowed|HTML tags|< >/i);
    // No POST issued — the user-side guard short-circuited.
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submits a clean body on the happy path, closes the modal, and reloads", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<HolidaysPage />);
    await screen.findByText(/no holidays configured/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Holiday/i }));

    fireEvent.change(screen.getByTestId("holiday-date"), {
      target: { value: "2026-07-04" },
    });
    fireEvent.change(screen.getByTestId("holiday-name"), {
      target: { value: "Founder's Day" },
    });
    // Type select — flip to OPTIONAL via the modal's <select id="add-holiday-type">.
    const typeSelect = document.getElementById(
      "add-holiday-type",
    ) as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: "OPTIONAL" } });
    // Description (optional) — fill it in to cover the branch.
    fireEvent.change(
      document.getElementById("add-holiday-description") as HTMLTextAreaElement,
      { target: { value: "First-year anniversary" } },
    );

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("holiday-save"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));

    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/hr-ops/holidays");
    expect(body).toMatchObject({
      date: "2026-07-04",
      name: "Founder's Day",
      type: "OPTIONAL",
      description: "First-year anniversary",
    });

    // Modal closed.
    await waitFor(() =>
      expect(
        screen.queryByTestId("holiday-form-modal"),
      ).not.toBeInTheDocument(),
    );
    // List reload.
    expect(apiMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/hr-ops\/holidays\?year=\d{4}$/),
    );
  });

  it("omits an empty description from the POST body", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<HolidaysPage />);
    await screen.findByText(/no holidays configured/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Holiday/i }));
    fireEvent.change(screen.getByTestId("holiday-date"), {
      target: { value: "2026-07-04" },
    });
    fireEvent.change(screen.getByTestId("holiday-name"), {
      target: { value: "Founder's Day" },
    });
    fireEvent.click(screen.getByTestId("holiday-save"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0];
    expect((body as any).description).toBeUndefined();
  });

  it("Edit flow (Issue #692) — pre-populates form, PATCHes /:id, toasts 'Updated …'", async () => {
    apiMock.get.mockResolvedValue({ data: HOLIDAYS });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<HolidaysPage />);
    await screen.findByText("Republic Day");

    fireEvent.click(screen.getByTestId("holiday-edit-h1"));

    // Heading flips to the edit copy.
    expect(
      await screen.findByRole("heading", {
        name: /Edit Holiday — Republic Day/i,
      }),
    ).toBeInTheDocument();

    // Fields pre-filled. Date is sliced to "YYYY-MM-DD" so the <input
    // type="date"> accepts it.
    expect(
      (screen.getByTestId("holiday-date") as HTMLInputElement).value,
    ).toBe("2026-01-26");
    expect(
      (screen.getByTestId("holiday-name") as HTMLInputElement).value,
    ).toBe("Republic Day");

    // Save button copy.
    expect(screen.getByTestId("holiday-save")).toHaveTextContent(
      /Update Holiday/i,
    );

    fireEvent.click(screen.getByTestId("holiday-save"));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/hr-ops/holidays/h1",
        expect.objectContaining({ name: "Republic Day" }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Updated "Republic Day"/i),
    );

    // Modal closed.
    await waitFor(() =>
      expect(
        screen.queryByTestId("holiday-form-modal"),
      ).not.toBeInTheDocument(),
    );
  });

  it("Cancel button closes the modal and clears the editing-row state", async () => {
    apiMock.get.mockResolvedValue({ data: HOLIDAYS });

    render(<HolidaysPage />);
    await screen.findByText("Republic Day");

    // Open in edit mode so we exercise the editingHoliday-clearing branch.
    fireEvent.click(screen.getByTestId("holiday-edit-h1"));
    expect(
      screen.getByRole("heading", { name: /Edit Holiday — Republic Day/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() =>
      expect(
        screen.queryByTestId("holiday-form-modal"),
      ).not.toBeInTheDocument(),
    );

    // Re-open via Add → heading is the create-copy now (editingHoliday cleared).
    fireEvent.click(screen.getByRole("button", { name: /Add Holiday/i }));
    expect(
      await screen.findByRole("heading", { name: /^Add Holiday$/ }),
    ).toBeInTheDocument();
  });

  it("surfaces server zod field-errors inline (Issue #293)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    // Build an ApiError-like rejection that extractFieldErrors will parse.
    const apiError = Object.assign(new Error("Validation failed"), {
      payload: {
        details: [{ field: "date", message: "Invalid date" }],
      },
    });
    apiMock.post.mockRejectedValue(apiError);

    render(<HolidaysPage />);
    await screen.findByText(/no holidays configured/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Holiday/i }));
    fireEvent.change(screen.getByTestId("holiday-date"), {
      target: { value: "2026-07-04" },
    });
    fireEvent.change(screen.getByTestId("holiday-name"), {
      target: { value: "Founder's Day" },
    });
    fireEvent.click(screen.getByTestId("holiday-save"));

    // humanizeZodMessage turns "Invalid date" → "Enter a valid date".
    const dateErr = await screen.findByTestId("error-date");
    expect(dateErr.textContent).toMatch(/Enter a valid date/i);
    // Modal stays open so the user can correct + retry.
    expect(screen.getByTestId("holiday-form-modal")).toBeInTheDocument();
  });

  it("surfaces a non-field server error via toast.error and keeps the modal open", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockRejectedValue(new Error("server boom"));

    render(<HolidaysPage />);
    await screen.findByText(/no holidays configured/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Holiday/i }));
    fireEvent.change(screen.getByTestId("holiday-date"), {
      target: { value: "2026-07-04" },
    });
    fireEvent.change(screen.getByTestId("holiday-name"), {
      target: { value: "Founder's Day" },
    });
    fireEvent.click(screen.getByTestId("holiday-save"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server boom"),
    );
    // Modal stays open.
    expect(screen.getByTestId("holiday-form-modal")).toBeInTheDocument();
  });

  it("Delete (Issue #726) — confirms, calls DELETE, toasts success, reloads", async () => {
    apiMock.get.mockResolvedValue({ data: HOLIDAYS });
    apiMock.delete.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<HolidaysPage />);
    await screen.findByText("Republic Day");

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("holiday-delete-h1"));

    await waitFor(() =>
      expect(apiMock.delete).toHaveBeenCalledWith("/hr-ops/holidays/h1"),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Deleted "Republic Day"/i),
    );
    // Reload fired.
    expect(apiMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/hr-ops\/holidays\?year=\d{4}$/),
    );
  });

  it("Delete — useConfirm rejection is a no-op (no DELETE, no toast)", async () => {
    apiMock.get.mockResolvedValue({ data: HOLIDAYS });
    confirmMock.mockResolvedValue(false);

    render(<HolidaysPage />);
    await screen.findByText("Republic Day");

    fireEvent.click(screen.getByTestId("holiday-delete-h1"));

    // Confirm prompt fired, but no DELETE/toast follow-through.
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.delete).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Delete — DELETE rejection surfaces a toast.error", async () => {
    apiMock.get.mockResolvedValue({ data: HOLIDAYS });
    apiMock.delete.mockRejectedValue(new Error("delete-blew-up"));
    confirmMock.mockResolvedValue(true);

    render(<HolidaysPage />);
    await screen.findByText("Republic Day");

    fireEvent.click(screen.getByTestId("holiday-delete-h1"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("delete-blew-up"),
    );
  });

  it("Import Template — confirms, POSTs each, skips existing same-date entries, toasts summary", async () => {
    // Seed the year with 2 existing holidays whose dates collide with the
    // template — those should be SKIPPED, not re-POSTed.
    const yearNow = new Date().getFullYear();
    const existing: Holiday[] = [
      {
        id: "ex-1",
        date: `${yearNow}-01-26T00:00:00.000Z`,
        name: "Republic Day",
        type: "PUBLIC",
      },
      {
        id: "ex-2",
        date: `${yearNow}-08-15T00:00:00.000Z`,
        name: "Independence Day",
        type: "PUBLIC",
      },
    ];
    apiMock.get.mockResolvedValue({ data: existing });
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<HolidaysPage />);
    await screen.findByText("Republic Day");

    apiMock.post.mockClear();
    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Import Template/i }));

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringMatching(/Added \d+ holidays\. Skipped \d+/i),
      ),
    );

    // Template has 15 entries. 2 collide (01-26, 08-15) → 13 POSTs, 2 skipped.
    expect(apiMock.post).toHaveBeenCalledTimes(13);
    // Each POST hit the holidays endpoint with a date string of YYYY-MM-DD.
    for (const [url, body] of apiMock.post.mock.calls) {
      expect(url).toBe("/hr-ops/holidays");
      expect((body as any).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof (body as any).name).toBe("string");
      expect(typeof (body as any).type).toBe("string");
    }
    // The summary toast specifically reflects 13 added / 2 skipped.
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining("Added 13 holidays. Skipped 2"),
    );
    // Reload triggered.
    expect(apiMock.get).toHaveBeenCalled();
  });

  it("Import Template — POST rejection on individual rows counts as a skip", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    // First POST rejects, the rest succeed → 14 added / 1 skipped.
    apiMock.post
      .mockRejectedValueOnce(new Error("boom on first row"))
      .mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<HolidaysPage />);
    await screen.findByText(/no holidays configured/i);

    fireEvent.click(screen.getByRole("button", { name: /Import Template/i }));

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringContaining("Added 14 holidays. Skipped 1"),
      ),
    );
  });

  it("Import Template — confirm cancelled is a no-op", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    confirmMock.mockResolvedValue(false);

    render(<HolidaysPage />);
    await screen.findByText(/no holidays configured/i);

    fireEvent.click(screen.getByRole("button", { name: /Import Template/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // No POSTs and no toast — the user dismissed the prompt.
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("typing in the date input clears the inline date error", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<HolidaysPage />);
    await screen.findByText(/no holidays configured/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Holiday/i }));
    // Trigger validation to surface error-date.
    fireEvent.click(screen.getByTestId("holiday-save"));
    expect(await screen.findByTestId("error-date")).toBeInTheDocument();

    // Type a date — the onChange handler clears the date error eagerly.
    fireEvent.change(screen.getByTestId("holiday-date"), {
      target: { value: "2026-07-04" },
    });

    await waitFor(() =>
      expect(screen.queryByTestId("error-date")).not.toBeInTheDocument(),
    );
  });

  it("typing in the name input clears the inline name error", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<HolidaysPage />);
    await screen.findByText(/no holidays configured/i);

    fireEvent.click(screen.getByRole("button", { name: /Add Holiday/i }));
    fireEvent.click(screen.getByTestId("holiday-save"));
    expect(await screen.findByTestId("error-name")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("holiday-name"), {
      target: { value: "Founder's Day" },
    });

    await waitFor(() =>
      expect(screen.queryByTestId("error-name")).not.toBeInTheDocument(),
    );
  });
});
