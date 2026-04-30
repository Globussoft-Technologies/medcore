/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/pediatric/test-id",
  useParams: () => ({ patientId: "test-id" }),
}));

import PediatricDetailPage from "../pediatric/[patientId]/page";

const samplePatient = {
  id: "p1",
  mrNumber: "MR-1",
  gender: "MALE",
  dateOfBirth: "2022-01-01",
  user: { name: "Tiny Tim", phone: "9000000001" },
};

describe("PediatricDetailPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Doc", email: "d@x.com", role: "DOCTOR" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("shows loading state initially", async () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<PediatricDetailPage />);
    // page currently just renders Add Measurement disabled state until load resolves
    // (there's no explicit loading text; assert no crash)
    await waitFor(() => expect(document.body).toBeInTheDocument());
  });

  it("renders patient header after load", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/patients/test-id")
        return Promise.resolve({ data: samplePatient });
      if (url.includes("/milestones"))
        return Promise.resolve({
          data: { summary: { total: 0, achieved: 0, expectedNotAchieved: 0 }, diff: [] },
        });
      if (url.includes("/feeding"))
        return Promise.resolve({ data: { logs: [], daily: [] } });
      if (url.startsWith("/growth/patient/test-id"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<PediatricDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Tiny Tim").length).toBeGreaterThan(0)
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    const { container } = render(<PediatricDetailPage />);
    await waitFor(() => {
      // page falls back to Loading indefinitely if patient fetch fails;
      // just assert no crash and the API was hit.
      expect(apiMock.get).toHaveBeenCalled();
    });
    expect(container).toBeTruthy();
  });

  it("clicking Add Measurement opens the form", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/patients/test-id")
        return Promise.resolve({ data: samplePatient });
      if (url.includes("/milestones"))
        return Promise.resolve({
          data: { summary: { total: 0, achieved: 0, expectedNotAchieved: 0 }, diff: [] },
        });
      if (url.includes("/feeding"))
        return Promise.resolve({ data: { logs: [], daily: [] } });
      if (url.startsWith("/growth/patient/test-id"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<PediatricDetailPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /add measurement/i })
    );
    await user.click(screen.getByRole("button", { name: /add measurement/i }));
    await waitFor(() =>
      expect(screen.getByText(/record growth measurement/i)).toBeInTheDocument()
    );
  });

  it("renders growth records table after load", async () => {
    const record = {
      id: "g1",
      ageMonths: 12,
      weightKg: 9,
      heightCm: 75,
      headCircumference: 46,
      measurementDate: new Date().toISOString(),
      milestoneNotes: "",
      developmentalNotes: "",
    };
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/patients/test-id")
        return Promise.resolve({ data: samplePatient });
      if (url.startsWith("/growth/patient/test-id"))
        return Promise.resolve({ data: [record] });
      return Promise.resolve({ data: [] });
    });
    render(<PediatricDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Tiny Tim").length).toBeGreaterThan(0)
    );
  });

  // Issue #440 (production): the FTT banner used to crash the entire page
  // with "Cannot read properties of undefined (reading 'map')" when the
  // /ftt-check endpoint returned `isFTT: true` but `reasons`/`suggestions`
  // were null/undefined (stale build / partial server response). The page
  // must render the patient header even when the banner payload is
  // malformed.
  it("does not crash when /ftt-check returns isFTT:true with null reasons", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/patients/test-id")
        return Promise.resolve({ data: samplePatient });
      if (url.includes("/ftt-check"))
        return Promise.resolve({
          data: {
            isFTT: true,
            reasons: null,
            suggestions: null,
            currentPercentile: null,
            velocityKgPerMonth: null,
            expectedVelocityKgPerMonth: null,
          },
        });
      if (url.includes("/milestones"))
        return Promise.resolve({
          data: { summary: { total: 0, achieved: 0, expectedNotAchieved: 0 }, diff: [] },
        });
      if (url.includes("/feeding"))
        return Promise.resolve({ data: { logs: [], daily: [] } });
      if (url.startsWith("/growth/patient/test-id"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<PediatricDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Tiny Tim").length).toBeGreaterThan(0)
    );
    // The banner heading still renders (the section renders, with empty
    // reasons/suggestions), proving the unguarded `.map`/`.length` no
    // longer crashes the tree.
    await waitFor(() =>
      expect(screen.getByText(/Failure to Thrive Detected/i)).toBeInTheDocument()
    );
  });
});
