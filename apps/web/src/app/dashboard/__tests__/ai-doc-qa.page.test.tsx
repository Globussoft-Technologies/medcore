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
  usePathname: () => "/dashboard/ai-doc-qa",
}));

import AiDocQaPage from "../ai-doc-qa/page";

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asDoctor() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u2", name: "Doc", email: "d@x.com", role: "DOCTOR" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("AiDocQaPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.error.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("smoke renders the heading for an ADMIN", async () => {
    asAdmin();
    render(<AiDocQaPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /clinical documentation qa/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the empty-state message when no reports exist", async () => {
    asAdmin();
    render(<AiDocQaPage />);
    await waitFor(() =>
      expect(screen.getByText(/no reports yet/i)).toBeInTheDocument()
    );
  });

  it("renders a populated reports table", async () => {
    asAdmin();
    apiMock.get.mockResolvedValue({
      data: [
        {
          consultationId: "abcdef1234567890",
          score: 85,
          completenessScore: 90,
          icdAccuracyScore: 80,
          medicationScore: 88,
          clarityScore: 85,
          issues: [],
          recommendations: [],
          auditedAt: new Date().toISOString(),
        },
      ],
    });
    render(<AiDocQaPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("docqa-report-row").length).toBeGreaterThan(0)
    );
    expect(screen.getByText("85")).toBeInTheDocument();
  });

  it("toasts when the load fails (non-503)", async () => {
    asAdmin();
    apiMock.get.mockRejectedValue({ status: 500, message: "boom" });
    render(<AiDocQaPage />);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/boom|Failed to load/i)
      )
    );
  });

  it("renders the admin-only gate for non-ADMIN roles", async () => {
    asDoctor();
    render(<AiDocQaPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/admin only — documentation qa reports/i)
      ).toBeInTheDocument()
    );
  });
});
