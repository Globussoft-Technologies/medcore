/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, routerMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai/chart-search",
}));

import ChartSearchPage from "./page";

describe("ChartSearchPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerMock.push.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Dr Asha", role: "DOCTOR" },
      isLoading: false,
    });
  });

  it("renders the heading, the Ask button and both tabs", () => {
    render(<ChartSearchPage />);
    expect(
      screen.getByRole("heading", { name: /ambient chart search/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^ask$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /this patient/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /cohort/i })).toBeInTheDocument();
  });

  it("shows a loading spinner while auth is loading", () => {
    authMock.mockReturnValue({ user: null, isLoading: true });
    const { container } = render(<ChartSearchPage />);
    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
  });

  it("redirects a NURSE user away from the page", async () => {
    authMock.mockReturnValue({
      user: { id: "u1", name: "Nurse", role: "NURSE" },
      isLoading: false,
    });
    render(<ChartSearchPage />);
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("renders the LLM answer and source hits after a successful cohort query", async () => {
    apiMock.post.mockResolvedValue({
      data: {
        answer: "Two patients missed their appointment [1].",
        hits: [
          {
            id: "k1",
            documentType: "CONSULTATION",
            title: "OPD on 2026-04-18",
            content: "Missed follow up for BP review",
            tags: ["patient:p1"],
            rank: 0.9,
            patientId: "p1",
            doctorId: "d1",
            date: new Date().toISOString(),
          },
        ],
        citedChunkIds: ["k1"],
        patientIds: ["p1"],
        totalHits: 1,
      },
    });
    const user = userEvent.setup();
    render(<ChartSearchPage />);
    await user.click(screen.getByRole("tab", { name: /cohort/i }));
    const textbox = screen.getByPlaceholderText(/which of my diabetic/i);
    await user.type(textbox, "Who missed their follow up?");
    await user.click(screen.getByRole("button", { name: /^ask$/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/two patients missed their appointment/i)
      ).toBeInTheDocument();
      expect(screen.getByText(/OPD on 2026-04-18/)).toBeInTheDocument();
    });
  });

  it("surfaces an error message when the search call fails", async () => {
    apiMock.post.mockRejectedValue(new Error("RAG service down"));
    const user = userEvent.setup();
    render(<ChartSearchPage />);
    await user.click(screen.getByRole("tab", { name: /cohort/i }));
    const textbox = screen.getByPlaceholderText(/which of my diabetic/i);
    await user.type(textbox, "anything");
    await user.click(screen.getByRole("button", { name: /^ask$/i }));
    await waitFor(() =>
      expect(screen.getByText(/rag service down/i)).toBeInTheDocument()
    );
  });
});
