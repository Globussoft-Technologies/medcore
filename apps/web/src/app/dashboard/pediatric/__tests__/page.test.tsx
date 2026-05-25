// Coverage tests for the Pediatric dashboard page.
// Modules under test: apps/web/src/app/dashboard/pediatric/page.tsx —
//   fetches /patients?limit=200 (+ optional search), filters in-memory to
//   age < 18 via computeAgeYears, renders loading skeleton / empty state /
//   table; debounces the search input by 250ms; guards against future-dated
//   DOBs (issue #751) which compute to null and are excluded by the filter.
// Why: page was at 0% coverage; lock in the rendered surface (loading,
// happy fetch with age filter, empty, error, search debounce, future-DOB
// guard) so future refactors can't silently break the user-facing shape.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

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

// next/link renders an <a> in jsdom — the default behaviour is fine, but
// pinning it makes the assertions deterministic across next versions.
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import PediatricPage from "../page";

// Fixed "now" anchor so DOB → age math is deterministic across CI runs.
// Picked a date well past the youngest fixture's DOB so age math is
// stable regardless of when the suite runs.
const NOW = new Date("2026-05-25T12:00:00.000Z");

// Helper — build a patient row with a DOB N years before NOW so the
// expected age (floor) is deterministic.
function makePatient(overrides: {
  id: string;
  mrNumber: string;
  name: string;
  ageYears?: number; // years before NOW
  dateOfBirth?: string | null;
  age?: number | null;
  gender?: string;
  phone?: string;
}) {
  const dob =
    overrides.dateOfBirth !== undefined
      ? overrides.dateOfBirth
      : overrides.ageYears !== undefined
        ? new Date(
            NOW.getTime() - overrides.ageYears * 365.25 * 24 * 60 * 60 * 1000,
          ).toISOString()
        : null;
  return {
    id: overrides.id,
    mrNumber: overrides.mrNumber,
    dateOfBirth: dob,
    age: overrides.age ?? null,
    gender: overrides.gender ?? "MALE",
    user: { name: overrides.name, phone: overrides.phone },
  };
}

describe("Pediatric dashboard page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    apiGetMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the loading skeleton while /patients is pending", async () => {
    // Never-resolving promise keeps the page in its loading branch.
    apiGetMock.mockImplementation(() => new Promise(() => {}));
    render(<PediatricPage />);
    const loader = await screen.findByTestId("pediatric-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
  });

  it("fetches /patients?limit=200 and renders only under-18 rows in the table", async () => {
    apiGetMock.mockResolvedValue({
      data: [
        makePatient({
          id: "p-child-1",
          mrNumber: "MR-001",
          name: "Aarav Sharma",
          ageYears: 5,
          gender: "MALE",
          phone: "+91 90000 00001",
        }),
        makePatient({
          id: "p-teen-1",
          mrNumber: "MR-002",
          name: "Diya Patel",
          ageYears: 16,
          gender: "FEMALE",
        }),
        // Adult — must be filtered out.
        makePatient({
          id: "p-adult-1",
          mrNumber: "MR-003",
          name: "Rohan Adult",
          ageYears: 40,
          gender: "MALE",
        }),
        // Borderline 18 — also excluded (filter is strict <18).
        makePatient({
          id: "p-eighteen",
          mrNumber: "MR-004",
          name: "Just Eighteen",
          ageYears: 18,
          gender: "MALE",
        }),
      ],
    });

    render(<PediatricPage />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("pediatric-loading"),
      ).not.toBeInTheDocument(),
    );

    // API contract — exact endpoint shape when no search term is set.
    expect(apiGetMock).toHaveBeenCalledWith("/patients?limit=200");

    // Heading + subtitle present.
    expect(
      screen.getByRole("heading", { name: /Pediatric Patients/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/children under 18/i),
    ).toBeInTheDocument();

    // Under-18 rows rendered…
    expect(screen.getByText("Aarav Sharma")).toBeInTheDocument();
    expect(screen.getByText("Diya Patel")).toBeInTheDocument();
    expect(screen.getByText("MR-001")).toBeInTheDocument();
    expect(screen.getByText("MR-002")).toBeInTheDocument();
    expect(screen.getByText("5y")).toBeInTheDocument();
    expect(screen.getByText("16y")).toBeInTheDocument();
    expect(screen.getByText("+91 90000 00001")).toBeInTheDocument();

    // …adult + boundary rows filtered out.
    expect(screen.queryByText("Rohan Adult")).not.toBeInTheDocument();
    expect(screen.queryByText("MR-003")).not.toBeInTheDocument();
    expect(screen.queryByText("Just Eighteen")).not.toBeInTheDocument();
    expect(screen.queryByText("MR-004")).not.toBeInTheDocument();

    // Each surviving row links to /dashboard/pediatric/<id> twice (name + action).
    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs.filter((h) => h === "/dashboard/pediatric/p-child-1")).toHaveLength(2);
    expect(hrefs.filter((h) => h === "/dashboard/pediatric/p-teen-1")).toHaveLength(2);

    // Action chip copy.
    expect(screen.getAllByText(/Growth Chart/i).length).toBeGreaterThanOrEqual(2);
  });

  it("shows '—' for phone when missing and for age when DOB is in the future (issue #751 guard)", async () => {
    apiGetMock.mockResolvedValue({
      data: [
        // No DOB, but `age` field present and < 18 — should render and show "10y".
        makePatient({
          id: "p-age-field",
          mrNumber: "MR-A",
          name: "Age Field Child",
          age: 10,
          gender: "FEMALE",
          // phone deliberately undefined → "—"
        }),
        // Future DOB → computeAgeYears returns null → excluded by filter.
        // To prove the guard, also supply an `age` field that's null so
        // nothing else lets it through.
        makePatient({
          id: "p-future",
          mrNumber: "MR-F",
          name: "Future DOB Patient",
          dateOfBirth: new Date(
            NOW.getTime() + 365 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          age: null,
          gender: "MALE",
        }),
      ],
    });

    render(<PediatricPage />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("pediatric-loading"),
      ).not.toBeInTheDocument(),
    );

    // The age-field row renders with the supplied numeric age.
    expect(screen.getByText("Age Field Child")).toBeInTheDocument();
    expect(screen.getByText("10y")).toBeInTheDocument();
    // Phone column for the row falls back to em-dash sentinel.
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);

    // Future-DOB row is filtered OUT — issue #751 guard.
    expect(screen.queryByText("Future DOB Patient")).not.toBeInTheDocument();
    expect(screen.queryByText("MR-F")).not.toBeInTheDocument();
  });

  it("renders the empty-state copy when no under-18 patients are returned", async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    render(<PediatricPage />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("pediatric-loading"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText(/No pediatric patients found\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Patients under 18 will appear here/i),
    ).toBeInTheDocument();
  });

  it("falls back to the empty-state surface when /patients rejects", async () => {
    apiGetMock.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    render(<PediatricPage />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("pediatric-loading"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText(/No pediatric patients found\./i),
    ).toBeInTheDocument();
    // Heading still rendered — chrome is independent of the fetch outcome.
    expect(
      screen.getByRole("heading", { name: /Pediatric Patients/i }),
    ).toBeInTheDocument();
  });

  it("debounces the search input by 250ms and URL-encodes the search term", async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    render(<PediatricPage />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("pediatric-loading"),
      ).not.toBeInTheDocument(),
    );

    // Initial mount fired one call with no search term.
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenNthCalledWith(1, "/patients?limit=200");

    const input = screen.getByPlaceholderText(
      /Search by name or MR number/i,
    ) as HTMLInputElement;

    // Type a value that must be URL-encoded (space → %20).
    fireEvent.change(input, { target: { value: "Aarav S" } });
    expect(input.value).toBe("Aarav S");

    // No new fetch yet — the 250ms debounce hasn't elapsed.
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    // Advance fake timers past the debounce window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(260);
    });

    // Second call goes through with the URL-encoded search payload.
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(apiGetMock).toHaveBeenNthCalledWith(
      2,
      "/patients?search=Aarav%20S&limit=200",
    );
  });
});
