/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/letters",
}));

import LettersPage from "./page";

describe("LettersPage", () => {
  beforeEach(() => {
    apiMock.post.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it("renders the page header and tabs", () => {
    render(<LettersPage />);
    expect(
      screen.getByRole("heading", { name: /ai letter generator/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /referral letter/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /discharge summary/i })).toBeInTheDocument();
  });

  it("defaults to the Referral tab and shows its form fields", () => {
    render(<LettersPage />);
    expect(screen.getByText(/scribe session id/i)).toBeInTheDocument();
    expect(screen.getByText(/refer to specialty/i)).toBeInTheDocument();
  });

  it("toasts when generating a referral without a session ID", async () => {
    const user = userEvent.setup();
    render(<LettersPage />);
    await user.click(screen.getByRole("button", { name: /generate letter/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/scribe session id/i)
      )
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("generates a referral letter and renders the preview", async () => {
    apiMock.post.mockResolvedValue({
      success: true,
      data: { letter: "Dear Dr. Sharma, ...", generatedAt: new Date().toISOString() },
      error: null,
    });
    const user = userEvent.setup();
    render(<LettersPage />);
    await user.type(
      screen.getByPlaceholderText(/550e8400/i),
      "abcd-1234-session-id"
    );
    await user.click(screen.getByRole("button", { name: /generate letter/i }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/letters/referral",
        expect.objectContaining({ scribeSessionId: "abcd-1234-session-id" })
      );
      expect(screen.getByText(/dear dr\. sharma/i)).toBeInTheDocument();
      expect(toastMock.success).toHaveBeenCalledWith("Referral letter generated");
    });
  });

  it("switches to the Discharge tab and shows its admission ID field", async () => {
    const user = userEvent.setup();
    render(<LettersPage />);
    await user.click(screen.getByRole("button", { name: /discharge summary/i }));
    expect(screen.getByText(/admission id/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /generate summary/i })
    ).toBeInTheDocument();
  });

  it("toasts an API error when generation fails", async () => {
    apiMock.post.mockRejectedValue(new Error("AI unavailable"));
    const user = userEvent.setup();
    render(<LettersPage />);
    await user.type(
      screen.getByPlaceholderText(/550e8400/i),
      "abcd-session"
    );
    await user.click(screen.getByRole("button", { name: /generate letter/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("AI unavailable")
    );
  });
});
