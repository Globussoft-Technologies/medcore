/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MedicationDashboardPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every branch of `apps/web/src/app/dashboard/medication-dashboard/page.tsx`,
 *     an IPD medication-administration client component that lists due/overdue
 *     medication administrations from `GET /medication/administrations/due`
 *     (optional `?wardId=` filter), groups them per-admission, and offers four
 *     status-update actions (Administer / Missed / Refused / Hold) that
 *     PATCH `/medication/administrations/:id` — with the latter three first
 *     prompting the user for a reason via the global `usePrompt()` modal.
 *   - Behaviours covered:
 *       1. Initial loading branch — `aria-busy="true"` skeleton container
 *          (`data-testid="medication-dashboard-loading"`) renders while the
 *          first fetch is in flight; header chrome + filter select are still
 *          visible.
 *       2. Happy fetch — grouped admission cards render with patient name,
 *          MR number, ward/bed copy, and one row per due administration.
 *       3. Ward filter — the wards-list call populates the <select>;
 *          choosing a ward re-issues GET with `?wardId=<id>`.
 *       4. Refresh button — manual click re-runs the fetch with current
 *          filter state.
 *       5. Empty state — "No medications due." copy renders when the API
 *          returns an empty array.
 *       6. Error fallback — `api.get` rejection is swallowed by the inner
 *          try/catch, so `loading` flips to false and the empty-state copy
 *          renders (no toast on initial-load failure).
 *       7. Administer action — clicking "Administer" PATCHes with status
 *          ADMINISTERED and no notes (no prompt for the OK path).
 *       8. Missed / Refused / Hold actions — each prompts the user for a
 *          reason, then PATCHes with the entered notes; cancelling the
 *          prompt aborts the PATCH entirely.
 *       9. PATCH error path — rejection fires an error toast with the
 *          thrown message; uses the `err instanceof Error` branch.
 *      10. Urgency labels — overdue / due-soon / upcoming labels render
 *          based on `scheduledAt` vs `Date.now()` (tested via fake timers).
 *      11. Auto-refresh — the 60-second interval re-fires the fetch.
 *
 *   - Source under test: apps/web/src/app/dashboard/medication-dashboard/page.tsx
 *   - Mocks: @/lib/api (api.get + api.patch), @/lib/toast (toast.error),
 *            @/lib/use-dialog (usePrompt), @/components/Skeleton
 *            (SkeletonCard passthrough), lucide-react (icon stubs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, promptMock } = vi.hoisted(() => ({
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
  promptMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({ usePrompt: () => promptMock, useConfirm: () => async () => true }));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));
// Stub lucide icons so they don't require SVG runtime + so the buttons /
// headings remain queryable by accessible-name without icon interference.
vi.mock("lucide-react", () => ({
  Syringe: () => <span data-testid="icon-syringe" />,
  RefreshCw: () => <span data-testid="icon-refresh" />,
}));

import MedicationDashboardPage from "../page";

type Admin = {
  id: string;
  scheduledAt: string;
  status?: string;
  order: {
    id: string;
    dosage: string;
    route: string;
    medicine: { name: string; genericName?: string | null };
    admission: {
      id: string;
      patient: { user: { name: string }; mrNumber?: string };
      bed?: { bedNumber: string; ward: { id: string; name: string } };
    };
  };
};

function adminFixture(overrides: Partial<Admin> = {}): Admin {
  return {
    id: "adm-1",
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h → Upcoming
    status: "DUE",
    order: {
      id: "ord-1",
      dosage: "500mg",
      route: "PO",
      medicine: { name: "Paracetamol", genericName: null },
      admission: {
        id: "adm-row-1",
        patient: { user: { name: "Asha Iyer" }, mrNumber: "MR-001" },
        bed: { bedNumber: "12B", ward: { id: "ward-1", name: "Ward A" } },
      },
    },
    ...overrides,
  };
}

// Set up: api.get is called for two distinct endpoints (administrations + wards).
// This helper wires up both based on URL prefix so tests don't have to manage
// call-order sequencing.
function wireGet(opts: {
  admins?: Admin[] | Error;
  wards?: { id: string; name: string }[] | Error;
} = {}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/medication/administrations/due")) {
      if (opts.admins instanceof Error) return Promise.reject(opts.admins);
      return Promise.resolve({ data: opts.admins ?? [] });
    }
    if (url.startsWith("/wards")) {
      if (opts.wards instanceof Error) return Promise.reject(opts.wards);
      return Promise.resolve({ data: opts.wards ?? [] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("MedicationDashboardPage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    promptMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the loading skeleton while the first fetch is in flight", async () => {
    // Never-settling promise on the admins endpoint pins the loading branch.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medication/administrations/due")) {
        return new Promise(() => {});
      }
      return Promise.resolve({ data: [] });
    });

    render(<MedicationDashboardPage />);

    const loading = await screen.findByTestId("medication-dashboard-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByTestId("skeleton-card")).toHaveLength(3);
    // Header chrome stays.
    expect(
      screen.getByRole("heading", { name: /medication administration/i })
    ).toBeInTheDocument();
    // Ward select is rendered with the default "All Wards" option.
    expect(
      screen.getByRole("option", { name: /all wards/i })
    ).toBeInTheDocument();
  });

  it("renders grouped admission cards with patient name + MR + ward/bed copy on happy fetch", async () => {
    wireGet({
      admins: [
        adminFixture({ id: "a1", order: { ...adminFixture().order, id: "o1" } }),
        adminFixture({
          id: "a2",
          order: {
            ...adminFixture().order,
            id: "o2",
            medicine: { name: "Ibuprofen", genericName: null },
            admission: {
              id: "adm-row-2",
              patient: { user: { name: "Bob Tan" }, mrNumber: "MR-002" },
              bed: { bedNumber: "5A", ward: { id: "ward-2", name: "Ward B" } },
            },
          },
        }),
      ],
    });

    render(<MedicationDashboardPage />);

    // Initial admins fetch uses no querystring.
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/medication/administrations/due")
    );

    expect(await screen.findByText("Asha Iyer")).toBeInTheDocument();
    expect(screen.getByText("Bob Tan")).toBeInTheDocument();

    // MR + ward/bed copy renders for each admission.
    expect(screen.getByText(/MR: MR-001 · Ward A \/ Bed 12B/)).toBeInTheDocument();
    expect(screen.getByText(/MR: MR-002 · Ward B \/ Bed 5A/)).toBeInTheDocument();

    // Medicine names render.
    expect(screen.getByText("Paracetamol")).toBeInTheDocument();
    expect(screen.getByText("Ibuprofen")).toBeInTheDocument();

    // Each row has the four action buttons.
    expect(screen.getAllByRole("button", { name: /^administer$/i })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^missed$/i })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^refused$/i })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^hold$/i })).toHaveLength(2);

    // Loading marker is gone.
    expect(
      screen.queryByTestId("medication-dashboard-loading")
    ).not.toBeInTheDocument();
  });

  it("renders the dash placeholder when admission.bed is missing", async () => {
    wireGet({
      admins: [
        adminFixture({
          id: "a-no-bed",
          order: {
            ...adminFixture().order,
            admission: {
              id: "adm-no-bed",
              patient: { user: { name: "No Bed Patient" }, mrNumber: "MR-X" },
              bed: undefined,
            },
          },
        }),
      ],
    });

    render(<MedicationDashboardPage />);

    expect(await screen.findByText("No Bed Patient")).toBeInTheDocument();
    // The page renders an em-dash when bed is absent.
    expect(screen.getByText(/MR: MR-X · —/)).toBeInTheDocument();
  });

  it("populates the ward filter <select> from /wards and re-issues admins fetch with ?wardId=", async () => {
    wireGet({
      admins: [],
      wards: [
        { id: "ward-1", name: "Ward A" },
        { id: "ward-2", name: "Ward B" },
      ],
    });

    render(<MedicationDashboardPage />);

    // Wait for ward options to render.
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Ward A" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "Ward B" })).toBeInTheDocument();

    // Pick Ward A.
    const wardSelect = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(wardSelect, { target: { value: "ward-1" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/medication/administrations/due?wardId=ward-1"
      )
    );
  });

  it("Refresh button re-runs the admins fetch with current filter state", async () => {
    wireGet({ admins: [] });
    render(<MedicationDashboardPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/medication/administrations/due")
    );

    const before = apiMock.get.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(before)
    );
    // No filter set, so the most-recent admins call has no querystring.
    const lastAdminCall = [...apiMock.get.mock.calls]
      .reverse()
      .find(([url]) => (url as string).startsWith("/medication/administrations/due"));
    expect(lastAdminCall?.[0]).toBe("/medication/administrations/due");
  });

  it("renders the empty-state copy when the API returns an empty array", async () => {
    wireGet({ admins: [] });

    render(<MedicationDashboardPage />);

    expect(
      await screen.findByText(/no medications due\./i)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^administer$/i })
    ).not.toBeInTheDocument();
  });

  it("falls back to the empty-state when the GET rejects (inner try/catch swallows)", async () => {
    wireGet({ admins: new Error("API down") });

    render(<MedicationDashboardPage />);

    expect(
      await screen.findByText(/no medications due\./i)
    ).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Administer click PATCHes with ADMINISTERED status and no prompt", async () => {
    wireGet({ admins: [adminFixture({ id: "adm-administer" })] });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<MedicationDashboardPage />);

    const btn = await screen.findByRole("button", { name: /^administer$/i });
    const getCountBefore = apiMock.get.mock.calls.length;
    fireEvent.click(btn);

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/medication/administrations/adm-administer",
        { status: "ADMINISTERED", notes: undefined }
      )
    );
    // No prompt for the OK path.
    expect(promptMock).not.toHaveBeenCalled();
    // Reload fires.
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(getCountBefore)
    );
  });

  it("Missed click prompts for reason then PATCHes with status=MISSED + notes", async () => {
    wireGet({ admins: [adminFixture({ id: "adm-miss" })] });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    promptMock.mockResolvedValue("Patient asleep");

    render(<MedicationDashboardPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^missed$/i }));

    await waitFor(() => expect(promptMock).toHaveBeenCalledTimes(1));
    // Verify the prompt options carry the right title + multiline flag.
    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringMatching(/missed/i),
        multiline: true,
      })
    );

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/medication/administrations/adm-miss",
        { status: "MISSED", notes: "Patient asleep" }
      )
    );
  });

  it("Refused click with empty-string reason PATCHes with notes=undefined", async () => {
    wireGet({ admins: [adminFixture({ id: "adm-ref" })] });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    // Source: `notes = reason || undefined` — empty string becomes undefined.
    promptMock.mockResolvedValue("");

    render(<MedicationDashboardPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^refused$/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/medication/administrations/adm-ref",
        { status: "REFUSED", notes: undefined }
      )
    );
  });

  it("Hold prompt cancellation (returns null) ABORTS the PATCH", async () => {
    wireGet({ admins: [adminFixture({ id: "adm-hold" })] });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    promptMock.mockResolvedValue(null); // User clicked Cancel.

    render(<MedicationDashboardPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^hold$/i }));

    await waitFor(() => expect(promptMock).toHaveBeenCalled());
    // PATCH must NOT fire.
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("PATCH rejection fires an error toast carrying the thrown message", async () => {
    wireGet({ admins: [adminFixture({ id: "adm-err" })] });
    apiMock.patch.mockRejectedValue(new Error("Network unreachable"));

    render(<MedicationDashboardPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^administer$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Network unreachable")
    );
  });

  it("PATCH rejection with a non-Error value falls back to the generic message", async () => {
    wireGet({ admins: [adminFixture({ id: "adm-err2" })] });
    apiMock.patch.mockRejectedValue("boom");

    render(<MedicationDashboardPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^administer$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to update")
    );
  });

  it("renders the Overdue / Due soon / Upcoming urgency labels based on scheduledAt", async () => {
    // No fake timers — `findByText` polling uses real time and would hang under
    // vi.useFakeTimers(). Date.now() is real, so we anchor scheduledAt relative
    // to it; the urgency thresholds (< 0 / ≤ 30 min / else) are stable.
    const now = Date.now();

    wireGet({
      admins: [
        // Overdue (scheduled 30 min ago).
        adminFixture({
          id: "a-over",
          scheduledAt: new Date(now - 30 * 60 * 1000).toISOString(),
          order: {
            ...adminFixture().order,
            id: "o-over",
            medicine: { name: "OverdueMed", genericName: null },
            admission: {
              id: "adm-over",
              patient: { user: { name: "Overdue Patient" }, mrNumber: "MR-O" },
              bed: { bedNumber: "1", ward: { id: "w1", name: "W1" } },
            },
          },
        }),
        // Due soon (in 10 min).
        adminFixture({
          id: "a-soon",
          scheduledAt: new Date(now + 10 * 60 * 1000).toISOString(),
          order: {
            ...adminFixture().order,
            id: "o-soon",
            medicine: { name: "SoonMed", genericName: null },
            admission: {
              id: "adm-soon",
              patient: { user: { name: "Soon Patient" }, mrNumber: "MR-S" },
              bed: { bedNumber: "2", ward: { id: "w2", name: "W2" } },
            },
          },
        }),
        // Upcoming (in 2 hours).
        adminFixture({
          id: "a-up",
          scheduledAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
          order: {
            ...adminFixture().order,
            id: "o-up",
            medicine: { name: "UpMed", genericName: null },
            admission: {
              id: "adm-up",
              patient: { user: { name: "Up Patient" }, mrNumber: "MR-U" },
              bed: { bedNumber: "3", ward: { id: "w3", name: "W3" } },
            },
          },
        }),
      ],
    });

    render(<MedicationDashboardPage />);

    expect(await screen.findByText("Overdue Patient")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("Due soon")).toBeInTheDocument();
    expect(screen.getByText("Upcoming")).toBeInTheDocument();
  });

  it("re-fires the admins fetch every 60 seconds via the setInterval auto-refresh", async () => {
    vi.useFakeTimers();
    wireGet({ admins: [] });

    render(<MedicationDashboardPage />);

    // Drain microtasks queued by the initial load promise.
    await vi.waitFor(() => {
      const adminsCalls = apiMock.get.mock.calls.filter(([u]) =>
        (u as string).startsWith("/medication/administrations/due")
      );
      expect(adminsCalls.length).toBeGreaterThanOrEqual(1);
    });

    const beforeTick = apiMock.get.mock.calls.filter(([u]) =>
      (u as string).startsWith("/medication/administrations/due")
    ).length;

    // Advance the 60s interval.
    vi.advanceTimersByTime(60_000);

    await vi.waitFor(() => {
      const adminsCalls = apiMock.get.mock.calls.filter(([u]) =>
        (u as string).startsWith("/medication/administrations/due")
      ).length;
      expect(adminsCalls).toBeGreaterThan(beforeTick);
    });
  });

  it("orders the buttons inside each admission card consistently per row", async () => {
    wireGet({ admins: [adminFixture({ id: "adm-order" })] });

    render(<MedicationDashboardPage />);

    const heading = await screen.findByText("Asha Iyer");
    // Walk up to the admission card container.
    const card = heading.closest("div.rounded-xl") as HTMLElement;
    expect(card).not.toBeNull();
    const cardScope = within(card);
    const buttons = cardScope
      .getAllByRole("button")
      .map((b) => b.textContent?.trim());
    expect(buttons).toEqual(["Administer", "Missed", "Refused", "Hold"]);
  });
});
