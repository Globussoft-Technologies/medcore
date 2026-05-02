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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/lab/qc",
}));

import LabQCPage from "../lab/qc/page";

const summary = [
  { testId: "t1", code: "GLU", name: "Glucose", total: 10, pass: 9, passRate: 90 },
];
const tests = [{ id: "t1", code: "GLU", name: "Glucose" }];
const entries = [
  {
    id: "e1",
    testId: "t1",
    qcLevel: "NORMAL",
    runDate: new Date().toISOString(),
    instrument: "A1",
    meanValue: 100,
    recordedValue: 102,
    cv: 1.2,
    withinRange: true,
    notes: null,
    test: { code: "GLU", name: "Glucose" },
    user: { id: "u9", name: "Lab Tech", role: "NURSE" },
  },
];

function defaultGet(url: string) {
  if (url.startsWith("/lab/qc/summary")) return { data: summary };
  if (url.startsWith("/lab/tests")) return { data: tests };
  if (url.startsWith("/lab/qc")) return { data: entries };
  return { data: [] };
}

describe("LabQCPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Lab Quality Control heading for ADMIN", async () => {
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(defaultGet(url))
    );
    render(<LabQCPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /lab quality control/i })
      ).toBeInTheDocument()
    );
  });

  it("renders pass-rate summary rows", async () => {
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(defaultGet(url))
    );
    render(<LabQCPage />);
    await waitFor(() =>
      expect(screen.getAllByText("GLU").length).toBeGreaterThan(0)
    );
    expect(screen.getByText(/90%/)).toBeInTheDocument();
  });

  it("shows 'No QC data' when summary is empty", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/lab/qc/summary")) return Promise.resolve({ data: [] });
      if (url.startsWith("/lab/tests")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<LabQCPage />);
    await waitFor(() =>
      expect(screen.getByText(/no qc data yet/i)).toBeInTheDocument()
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<LabQCPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /lab quality control/i })
      ).toBeInTheDocument()
    );
  });

  it("shows access-denied for unauthorized role (PATIENT)", async () => {
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u9", name: "Pat", email: "p@x.com", role: "PATIENT" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    render(<LabQCPage />);
    expect(screen.getByText(/access denied/i)).toBeInTheDocument();
  });
});
