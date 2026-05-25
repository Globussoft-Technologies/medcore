// Coverage tests for the Immunization Schedule dashboard page.
// Modules under test: apps/web/src/app/dashboard/immunization-schedule/page.tsx —
//   fetches /ehr/immunizations/schedule?filter=<key> on mount and on every
//   filter-chip click, renders a SkeletonTable while loading, an empty
//   placeholder when the API returns no rows, and a table row per immunization
//   with patient name + MR number + dose + last given + next due + a coloured
//   "days until next due" relative date label.
// Why: page was at 0% coverage; these assertions lock in the rendered surface
// (loading, happy fetch, empty, error, filter-chip refetch, days-until colour
// branches, null/blank field tolerance) so future refactors can't silently
// regress the wire contract (Issue #426 stale-closure regression class).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

const { apiGetMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import ImmunizationSchedulePage from "../page";

// Row fixture factory — keeps assertions terse and intent-revealing.
function row(overrides: Partial<any> = {}) {
  return {
    id: "imm-0001",
    patientId: "pat-0001",
    vaccine: "MMR",
    doseNumber: 1,
    dateGiven: "2026-04-10T00:00:00.000Z",
    nextDueDate: "2026-05-30T00:00:00.000Z",
    patient: {
      id: "pat-0001",
      mrNumber: "MR-100",
      user: { name: "Asha Patel", phone: "9876543210" },
    },
    ...overrides,
  };
}

// The page calls `res.data` on the api.get return value — so the mock must
// return `{ data: ScheduleRow[] }` shape (NOT the envelope shape used by some
// other endpoints).
function getOk(rows: any[]) {
  return { data: rows };
}

// Source reads `new Date()` then `setHours(0,0,0,0)` to compute "today" for
// the days-until-due colour branches. We can't use vi.useFakeTimers() because
// it also fakes the timers waitFor() uses internally — which deadlocks every
// async assertion in this file. Instead, build fixture nextDueDate values
// RELATIVE to the real current day at noon UTC so the math is always exact
// regardless of when the suite runs.
function daysFromNow(offsetDays: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
}

describe("Immunization Schedule dashboard page", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  it("renders the page header and the three filter chips with 'week' active by default", async () => {
    apiGetMock.mockResolvedValue(getOk([]));
    render(<ImmunizationSchedulePage />);

    expect(
      screen.getByRole("heading", { name: /Immunization Schedule/i }),
    ).toBeInTheDocument();

    // All three filter chips render.
    expect(screen.getByTestId("immunization-filter-week")).toBeInTheDocument();
    expect(screen.getByTestId("immunization-filter-month")).toBeInTheDocument();
    expect(
      screen.getByTestId("immunization-filter-overdue"),
    ).toBeInTheDocument();

    // Default active chip is "week".
    expect(
      screen.getByTestId("immunization-filter-week").getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("immunization-filter-month")
        .getAttribute("data-active"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("immunization-filter-overdue")
        .getAttribute("data-active"),
    ).toBe("false");
  });

  it("shows the SkeletonTable loading state while the fetch is pending", async () => {
    // Never resolves — page should stay on the loading branch.
    apiGetMock.mockImplementation(() => new Promise(() => {}));
    render(<ImmunizationSchedulePage />);

    const loading = await screen.findByTestId("immunization-schedule-loading");
    expect(loading).toBeInTheDocument();
    expect(loading.getAttribute("aria-busy")).toBe("true");

    // The data table is not rendered yet.
    expect(screen.queryByRole("table")).toBeInTheDocument(); // skeleton uses <table>
    // But the actual data <thead> Patient column is absent.
    expect(screen.queryByText(/^Patient$/)).not.toBeInTheDocument();
  });

  it("fetches /ehr/immunizations/schedule?filter=week on mount and renders a row per result", async () => {
    apiGetMock.mockResolvedValue(
      getOk([
        row({
          id: "imm-001",
          patientId: "pat-1",
          vaccine: "MMR",
          doseNumber: 1,
          patient: {
            id: "pat-1",
            mrNumber: "MR-001",
            user: { name: "Asha Patel", phone: "9876543210" },
          },
        }),
        row({
          id: "imm-002",
          patientId: "pat-2",
          vaccine: "DPT",
          doseNumber: 3,
          patient: {
            id: "pat-2",
            mrNumber: "MR-002",
            user: { name: "Vikram Singh", phone: "9123456780" },
          },
        }),
      ]),
    );

    render(<ImmunizationSchedulePage />);

    // Wait for the data table to surface (loading skeleton removed).
    await waitFor(() =>
      expect(
        screen.queryByTestId("immunization-schedule-loading"),
      ).not.toBeInTheDocument(),
    );

    // API contract — exact endpoint + querystring.
    expect(apiGetMock).toHaveBeenCalledWith(
      "/ehr/immunizations/schedule?filter=week",
    );

    // One <tr> per fixture row (under the <tbody>).
    const tbody = document.querySelector("tbody");
    expect(tbody).toBeTruthy();
    const dataRows = tbody!.querySelectorAll("tr");
    expect(dataRows).toHaveLength(2);

    // Patient names + MR numbers + phone all surfaced.
    expect(screen.getByText("Asha Patel")).toBeInTheDocument();
    expect(screen.getByText("Vikram Singh")).toBeInTheDocument();
    expect(screen.getByText("MR-001")).toBeInTheDocument();
    expect(screen.getByText("MR-002")).toBeInTheDocument();
    expect(screen.getByText("9876543210")).toBeInTheDocument();
    expect(screen.getByText("9123456780")).toBeInTheDocument();

    // Vaccine name rendered.
    expect(screen.getByText("MMR")).toBeInTheDocument();
    expect(screen.getByText("DPT")).toBeInTheDocument();

    // Dose number rendered.
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();

    // Patient name renders inside a <Link> to /dashboard/patients/<patientId>.
    const links = screen.getAllByRole("link");
    const ashaLink = links.find((l) => l.textContent === "Asha Patel");
    expect(ashaLink).toBeTruthy();
    expect(ashaLink!.getAttribute("href")).toBe("/dashboard/patients/pat-1");
  });

  it("renders the empty placeholder when the API returns no rows", async () => {
    apiGetMock.mockResolvedValue(getOk([]));
    render(<ImmunizationSchedulePage />);

    expect(
      await screen.findByText(/No immunizations match this filter/i),
    ).toBeInTheDocument();
    // No data table rendered (only the loading skeleton uses <table>, and
    // loading is done by now).
    expect(
      screen.queryByTestId("immunization-schedule-loading"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/^Patient$/)).not.toBeInTheDocument();
  });

  it("falls back to the empty placeholder when the fetch rejects (catch branch)", async () => {
    apiGetMock.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    render(<ImmunizationSchedulePage />);

    // Source's catch block sets rows to [] and toggles loading=false, so the
    // empty placeholder surfaces.
    expect(
      await screen.findByText(/No immunizations match this filter/i),
    ).toBeInTheDocument();
    // Header chrome is independent of fetch outcome.
    expect(
      screen.getByRole("heading", { name: /Immunization Schedule/i }),
    ).toBeInTheDocument();
  });

  it("refetches with the new filter when a different chip is clicked (Issue #426 stale-closure regression guard)", async () => {
    // Mount fetch (week) and post-click fetch (month) each return distinct rows.
    apiGetMock.mockResolvedValueOnce(
      getOk([row({ id: "imm-week", vaccine: "MMR" })]),
    );
    apiGetMock.mockResolvedValueOnce(
      getOk([row({ id: "imm-month", vaccine: "Hepatitis B" })]),
    );

    render(<ImmunizationSchedulePage />);

    // Initial week row surfaces.
    expect(await screen.findByText("MMR")).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenNthCalledWith(
      1,
      "/ehr/immunizations/schedule?filter=week",
    );

    // Click the "month" chip.
    fireEvent.click(screen.getByTestId("immunization-filter-month"));

    // Active chip flips immediately, week chip de-activates.
    await waitFor(() =>
      expect(
        screen
          .getByTestId("immunization-filter-month")
          .getAttribute("data-active"),
      ).toBe("true"),
    );
    expect(
      screen.getByTestId("immunization-filter-week").getAttribute("data-active"),
    ).toBe("false");

    // Second fetch issued with the new filter.
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(2));
    expect(apiGetMock).toHaveBeenNthCalledWith(
      2,
      "/ehr/immunizations/schedule?filter=month",
    );

    // Month row surfaces; week row gone.
    expect(await screen.findByText("Hepatitis B")).toBeInTheDocument();
    expect(screen.queryByText("MMR")).not.toBeInTheDocument();
  });

  it("issues a third fetch when the 'overdue' chip is clicked", async () => {
    apiGetMock.mockResolvedValue(getOk([]));
    render(<ImmunizationSchedulePage />);

    await screen.findByText(/No immunizations match this filter/i);
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("immunization-filter-overdue"));

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(2));
    expect(apiGetMock).toHaveBeenNthCalledWith(
      2,
      "/ehr/immunizations/schedule?filter=overdue",
    );
    expect(
      screen
        .getByTestId("immunization-filter-overdue")
        .getAttribute("data-active"),
    ).toBe("true");
  });

  it("renders the 'days until' label across all colour branches (overdue / soon / week / month / far / null)", async () => {
    // Build rows whose nextDueDate spans every branch of dueColor() relative
    // to the real current day. Source compares `setHours(0,0,0,0)`-floored
    // dates so a noon-UTC offset is unambiguous within any timezone tests run in.
    apiGetMock.mockResolvedValue(
      getOk([
        // -3 days → "3d overdue" (red-700)
        row({
          id: "imm-overdue",
          vaccine: "VAC-OVERDUE",
          nextDueDate: daysFromNow(-3),
          patient: {
            id: "p-od",
            mrNumber: "MR-OD",
            user: { name: "Overdue Patient", phone: "1" },
          },
        }),
        // 0 days → "today" (red-600, days <= 3)
        row({
          id: "imm-today",
          vaccine: "VAC-TODAY",
          nextDueDate: daysFromNow(0),
          patient: {
            id: "p-td",
            mrNumber: "MR-TD",
            user: { name: "Today Patient", phone: "2" },
          },
        }),
        // +5 days → "in 5d" (amber-600, days <= 7)
        row({
          id: "imm-soon",
          vaccine: "VAC-SOON",
          nextDueDate: daysFromNow(5),
          patient: {
            id: "p-sn",
            mrNumber: "MR-SN",
            user: { name: "Soon Patient", phone: "3" },
          },
        }),
        // +20 days → "in 20d" (blue-600, days <= 30)
        row({
          id: "imm-mid",
          vaccine: "VAC-MID",
          nextDueDate: daysFromNow(20),
          patient: {
            id: "p-md",
            mrNumber: "MR-MD",
            user: { name: "Mid Patient", phone: "4" },
          },
        }),
        // +60 days → "in 60d" (gray-600, days > 30)
        row({
          id: "imm-far",
          vaccine: "VAC-FAR",
          nextDueDate: daysFromNow(60),
          patient: {
            id: "p-fr",
            mrNumber: "MR-FR",
            user: { name: "Far Patient", phone: "5" },
          },
        }),
        // null → "-" (gray-500)
        row({
          id: "imm-null",
          vaccine: "VAC-NULL",
          nextDueDate: null,
          doseNumber: null,
          patient: {
            id: "p-nl",
            mrNumber: "MR-NL",
            user: { name: "Null Patient", phone: "6" },
          },
        }),
      ]),
    );

    render(<ImmunizationSchedulePage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("immunization-schedule-loading"),
      ).not.toBeInTheDocument(),
    );

    // Each branch's label surfaces.
    expect(screen.getByText("3d overdue")).toBeInTheDocument();
    expect(screen.getByText("today")).toBeInTheDocument();
    expect(screen.getByText("in 5d")).toBeInTheDocument();
    expect(screen.getByText("in 20d")).toBeInTheDocument();
    expect(screen.getByText("in 60d")).toBeInTheDocument();

    // The null-dose row renders "-" for both dose AND days-until columns.
    // Use the patient-row to scope assertions.
    const nullRow = screen.getByText("Null Patient").closest("tr")!;
    const cells = within(nullRow).getAllByText("-");
    // Dose cell + next-due cell + days cell — all "-".
    expect(cells.length).toBeGreaterThanOrEqual(2);

    // Colour-class assertions on the days <td>. dueColor() output is encoded
    // as className tokens we can assert on directly.
    const overdueRow = screen.getByText("Overdue Patient").closest("tr")!;
    expect(
      within(overdueRow).getByText("3d overdue").className,
    ).toMatch(/text-red-700/);

    const todayRow = screen.getByText("Today Patient").closest("tr")!;
    expect(within(todayRow).getByText("today").className).toMatch(/text-red-600/);

    const soonRow = screen.getByText("Soon Patient").closest("tr")!;
    expect(within(soonRow).getByText("in 5d").className).toMatch(
      /text-amber-600/,
    );

    const midRow = screen.getByText("Mid Patient").closest("tr")!;
    expect(within(midRow).getByText("in 20d").className).toMatch(
      /text-blue-600/,
    );

    const farRow = screen.getByText("Far Patient").closest("tr")!;
    expect(within(farRow).getByText("in 60d").className).toMatch(
      /text-gray-600/,
    );
  });

  it("tolerates rows where patient.user is missing — falls back to '-' for the name", async () => {
    apiGetMock.mockResolvedValue(
      getOk([
        {
          id: "imm-bare",
          patientId: "pat-bare",
          vaccine: "BCG",
          doseNumber: 1,
          dateGiven: "2026-04-01T00:00:00.000Z",
          nextDueDate: null,
          // No patient.user object — source uses optional chaining.
          patient: { id: "pat-bare", mrNumber: "MR-BARE" } as any,
        },
      ]),
    );

    render(<ImmunizationSchedulePage />);

    // The vaccine + MR number still render.
    expect(await screen.findByText("BCG")).toBeInTheDocument();
    expect(screen.getByText("MR-BARE")).toBeInTheDocument();

    // The patient-name <Link> renders "-" (falsy ?? "-" branch).
    const bareRow = screen.getByText("MR-BARE").closest("tr")!;
    const nameLink = within(bareRow).getByRole("link");
    expect(nameLink.textContent).toBe("-");
    expect(nameLink.getAttribute("href")).toBe("/dashboard/patients/pat-bare");
  });
});
