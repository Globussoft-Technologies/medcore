/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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
vi.mock("@/lib/use-dialog", () => ({
  usePrompt: () => vi.fn(async () => ""),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/my-schedule",
}));

import MySchedulePage from "../my-schedule/page";

const today = new Date();
const isoDate = today.toISOString();

const shifts = [
  {
    id: "s1",
    userId: "u1",
    date: isoDate,
    type: "MORNING",
    startTime: "09:00",
    endTime: "17:00",
    status: "SCHEDULED",
    notes: null,
  },
];

const leavesEnvelope = {
  data: {
    leaves: [],
    summary: { pending: 1, approved: 4, used: { CASUAL: 2, SICK: 1 } },
  },
};

describe("MySchedulePage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders My Schedule heading", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/shifts/my")) return Promise.resolve({ data: [] });
      if (url.startsWith("/leaves/my"))
        return Promise.resolve({
          data: { leaves: [], summary: { pending: 0, approved: 0, used: {} } },
        });
      if (url.startsWith("/hr-ops/certifications"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<MySchedulePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /my schedule/i })
      ).toBeInTheDocument()
    );
  });

  it("renders MORNING shift card on the day grid", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/shifts/my"))
        return Promise.resolve({ data: shifts });
      if (url.startsWith("/leaves/my")) return Promise.resolve(leavesEnvelope);
      if (url.startsWith("/hr-ops/certifications"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<MySchedulePage />);
    await waitFor(() =>
      expect(screen.getAllByText(/MORNING/i).length).toBeGreaterThan(0)
    );
  });

  it("shows 'No shifts' for empty days", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/shifts/my")) return Promise.resolve({ data: [] });
      if (url.startsWith("/leaves/my"))
        return Promise.resolve({
          data: { leaves: [], summary: { pending: 0, approved: 0, used: {} } },
        });
      if (url.startsWith("/hr-ops/certifications"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<MySchedulePage />);
    await waitFor(() =>
      expect(screen.getAllByText(/no shifts/i).length).toBeGreaterThan(0)
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<MySchedulePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /my schedule/i })
      ).toBeInTheDocument()
    );
  });

  it("renders Pending leave summary count", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/shifts/my")) return Promise.resolve({ data: shifts });
      if (url.startsWith("/leaves/my")) return Promise.resolve(leavesEnvelope);
      if (url.startsWith("/hr-ops/certifications"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<MySchedulePage />);
    await waitFor(() => expect(screen.getByText(/pending/i)).toBeInTheDocument());
  });
});
