// Coverage tests for the Patient Consolidated Problem List dashboard page.
// Modules under test: apps/web/src/app/dashboard/patients/[id]/problem-list/page.tsx —
//   fetches /ehr/patients/:id/problem-list with activeOnly + type query params,
//   renders a skeleton-card loading state, a populated row list (icon + ICD-10 +
//   severity badge + last-updated date), an empty state, and an error fallback,
//   plus the two filter controls (Active-only checkbox, type <select>) that
//   re-trigger the fetch with updated query params.
// Why: page was at 0% coverage; these assertions lock in the rendered surface
// AND the API query-string contract so future refactors can't silently break
// the user-facing shape OR the wire protocol the API depends on.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/patients/pt-123/problem-list",
  useParams: () => ({ id: "pt-123" }),
}));

import PatientProblemListPage from "../page";

// Fixed timestamps so date formatting is deterministic across machines.
const TS_RECENT = "2026-05-20T10:30:00.000Z";
const TS_OLDER = "2026-04-02T09:15:00.000Z";

const sampleItems = [
  {
    id: "cond-1",
    type: "condition" as const,
    title: "Hypertension",
    severity: "ACTIVE",
    status: "ACTIVE",
    lastUpdated: TS_RECENT,
    source: "Diagnosed 2024-05-12",
    icd10Code: "I10",
  },
  {
    id: "all-1",
    type: "allergy" as const,
    title: "Penicillin allergy",
    severity: "SEVERE",
    status: "ACTIVE",
    lastUpdated: TS_OLDER,
    source: "Self-reported",
  },
  {
    id: "dx-1",
    type: "diagnosis" as const,
    title: "Type 2 Diabetes",
    severity: "MODERATE",
    status: "ACTIVE",
    lastUpdated: TS_RECENT,
    source: "Lab 2024-09-01",
    icd10Code: "E11",
  },
  {
    id: "adm-1",
    type: "admission" as const,
    title: "General Ward",
    severity: "ADMITTED",
    status: "ADMITTED",
    lastUpdated: TS_RECENT,
    source: "Admitted 2026-05-15",
  },
];

describe("Patient Consolidated Problem List dashboard page", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  it("renders the skeleton loading state while the problem-list fetch is pending", async () => {
    // Never-resolving promise keeps the page in its loading branch.
    apiGetMock.mockImplementation(() => new Promise(() => {}));
    render(<PatientProblemListPage />);
    const loader = await screen.findByTestId("problem-list-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
    // Heading + back link still render around the skeleton.
    expect(
      screen.getByRole("heading", { name: /Consolidated Problem List/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Back to patient/i)).toBeInTheDocument();
  });

  it("fetches /ehr/patients/:id/problem-list with default activeOnly=true and renders all row variants", async () => {
    apiGetMock.mockResolvedValue({ data: sampleItems });

    render(<PatientProblemListPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("problem-list-loading"),
      ).not.toBeInTheDocument(),
    );

    // API contract — default activeOnly=true, no type filter, scoped to params.id.
    expect(apiGetMock).toHaveBeenCalledWith(
      "/ehr/patients/pt-123/problem-list?activeOnly=true",
    );

    // Every fixture row renders by title.
    expect(screen.getByText("Hypertension")).toBeInTheDocument();
    expect(screen.getByText("Penicillin allergy")).toBeInTheDocument();
    expect(screen.getByText("Type 2 Diabetes")).toBeInTheDocument();
    expect(screen.getByText("General Ward")).toBeInTheDocument();

    // ICD-10 chips render only on rows that have one.
    expect(screen.getByText("I10")).toBeInTheDocument();
    expect(screen.getByText("E11")).toBeInTheDocument();

    // Severity badges render verbatim from the data.
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("SEVERE")).toBeInTheDocument();
    expect(screen.getByText("MODERATE")).toBeInTheDocument();
    expect(screen.getByText("ADMITTED")).toBeInTheDocument();

    // Source sublines render.
    expect(screen.getByText("Self-reported")).toBeInTheDocument();
    expect(screen.getByText("Diagnosed 2024-05-12")).toBeInTheDocument();

    // Item count ("N items") reflects the rendered list length.
    expect(screen.getByText(/4 items/i)).toBeInTheDocument();
  });

  it("renders an unknown-severity row using the fallback badge style without throwing", async () => {
    apiGetMock.mockResolvedValue({
      data: [
        {
          id: "x-1",
          type: "condition",
          title: "Weird Condition",
          severity: "UNKNOWN_SEVERITY",
          status: "ACTIVE",
          lastUpdated: TS_RECENT,
          source: "From source",
          icd10Code: null,
        },
      ],
    });
    render(<PatientProblemListPage />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("problem-list-loading"),
      ).not.toBeInTheDocument(),
    );
    // Title + (fallback-styled) severity badge both render.
    expect(screen.getByText("Weird Condition")).toBeInTheDocument();
    expect(screen.getByText("UNKNOWN_SEVERITY")).toBeInTheDocument();
    // Null icd10Code branch — no chip should be rendered for null/falsy code.
    expect(screen.queryByText(/^null$/i)).not.toBeInTheDocument();
  });

  it("renders the 'No problems found' empty state when the API returns no rows", async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    render(<PatientProblemListPage />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("problem-list-loading"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/No problems found\./i)).toBeInTheDocument();
    expect(screen.getByText(/0 items/i)).toBeInTheDocument();
  });

  it("renders the 'No problems found' empty state when the API response lacks a data field", async () => {
    // The source defaults to [] when res.data is undefined — guard the branch.
    apiGetMock.mockResolvedValue({});
    render(<PatientProblemListPage />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("problem-list-loading"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/No problems found\./i)).toBeInTheDocument();
  });

  it("falls back to the empty state when the fetch rejects (error path)", async () => {
    apiGetMock.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    render(<PatientProblemListPage />);
    // Source catches the error, sets loading=false, leaves items=[].
    await waitFor(() =>
      expect(
        screen.queryByTestId("problem-list-loading"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/No problems found\./i)).toBeInTheDocument();
    // Page chrome (heading + back link) still renders independent of the fetch.
    expect(
      screen.getByRole("heading", { name: /Consolidated Problem List/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Back to patient/i)).toBeInTheDocument();
  });

  it("re-fetches with activeOnly=false when the 'Active only' checkbox is unchecked", async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    render(<PatientProblemListPage />);

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));
    expect(apiGetMock).toHaveBeenLastCalledWith(
      "/ehr/patients/pt-123/problem-list?activeOnly=true",
    );

    const checkbox = screen.getByLabelText(/Active only/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(2));
    expect(apiGetMock).toHaveBeenLastCalledWith(
      "/ehr/patients/pt-123/problem-list?activeOnly=false",
    );
    expect(checkbox.checked).toBe(false);
  });

  it("re-fetches with the chosen type filter appended to the query string", async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    render(<PatientProblemListPage />);

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));

    // The page renders exactly one <select> (the type filter).
    const typeSelect = screen
      .getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: "allergy" } });

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(2));
    expect(apiGetMock).toHaveBeenLastCalledWith(
      "/ehr/patients/pt-123/problem-list?activeOnly=true&type=allergy",
    );

    // Switching back to "All types" drops the type param again.
    fireEvent.change(typeSelect, { target: { value: "" } });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(3));
    expect(apiGetMock).toHaveBeenLastCalledWith(
      "/ehr/patients/pt-123/problem-list?activeOnly=true",
    );
  });

  it("renders the Back-to-patient link with the correct href for the current patient id", async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    render(<PatientProblemListPage />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("problem-list-loading"),
      ).not.toBeInTheDocument(),
    );
    const link = screen.getByRole("link", { name: /Back to patient/i });
    expect(link).toHaveAttribute("href", "/dashboard/patients/pt-123");
  });
});
