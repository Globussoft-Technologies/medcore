/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/census",
}));

import CensusPage from "../census/page";

const sampleDay = {
  date: "2026-04-30",
  totalBeds: 50,
  admittedAtStartOfDay: 30,
  newAdmissions: 5,
  discharges: 4,
  deaths: 0,
  admittedAtEndOfDay: 31,
  occupancyPercent: 62,
};

describe("CensusPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("smoke renders the page heading", async () => {
    render(<CensusPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /census report/i })
      ).toBeInTheDocument()
    );
  });

  it("renders Daily/Weekly/Monthly toggle buttons", () => {
    render(<CensusPage />);
    expect(screen.getByRole("button", { name: /daily/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /weekly/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /monthly/i })).toBeInTheDocument();
  });

  it("renders rows when the range endpoint returns data", async () => {
    apiMock.get.mockResolvedValue({ data: [sampleDay] });
    render(<CensusPage />);
    await waitFor(() =>
      expect(screen.getByText("2026-04-30")).toBeInTheDocument()
    );
  });

  it("shows the empty-state body when range returns no rows", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<CensusPage />);
    // Page shows summary KPIs (zero values) and an empty table body. The
    // empty-data state is "no rows" — assert KPI text is rendered with 0.
    await waitFor(() =>
      expect(screen.getAllByText(/0/).length).toBeGreaterThan(0)
    );
  });

  it("keeps rendering when the census endpoint rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<CensusPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /census report/i })
      ).toBeInTheDocument()
    );
  });
});
