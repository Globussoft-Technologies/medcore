/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Forgot-password page tests.
 *
 * Issues #710 + #711 (May 2026): page now shows
 *  - inline "you're signed in" advisory when the auth store has a user
 *    (#710 — never auto-redirects)
 *  - dedicated `step === "sent"` confirmation after the email POST
 *    (#711 — enumeration-safe success copy + toast)
 */
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
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));

import ForgotPasswordPage from "../forgot-password/page";

describe("ForgotPasswordPage", () => {
  beforeEach(() => {
    apiMock.post.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    toastMock.info.mockReset();
    // Default: anonymous visitor (no signed-in advisory).
    authMock.mockReturnValue({ user: null, logout: vi.fn() });
  });

  it("renders the email-step form", async () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByRole("heading", { name: /medcore/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter your email/i)).toBeInTheDocument();
  });

  it("submitting email calls forgot-password API", async () => {
    apiMock.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);
    await user.type(
      screen.getByPlaceholderText(/enter your email/i),
      "a@x.com"
    );
    await user.click(screen.getByRole("button", { name: /send reset code/i }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/auth/forgot-password", {
        email: "a@x.com",
      })
    );
  });

  it("shows enumeration-safe sent confirmation after success (#711)", async () => {
    apiMock.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);
    await user.type(
      screen.getByPlaceholderText(/enter your email/i),
      "a@x.com"
    );
    await user.click(screen.getByRole("button", { name: /send reset code/i }));
    await waitFor(() =>
      expect(
        screen.getByTestId("forgot-sent-confirmation"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/check your inbox/i)).toBeInTheDocument();
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/if an account exists for this email/i),
    );
  });

  it("advancing from sent → reset surfaces the code-entry copy", async () => {
    apiMock.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);
    await user.type(
      screen.getByPlaceholderText(/enter your email/i),
      "a@x.com"
    );
    await user.click(screen.getByRole("button", { name: /send reset code/i }));
    await waitFor(() =>
      expect(screen.getByTestId("forgot-have-code-btn")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("forgot-have-code-btn"));
    expect(
      screen.getByText(/a 6-digit code has been sent/i),
    ).toBeInTheDocument();
  });

  it("shows error message on API failure", async () => {
    apiMock.post.mockRejectedValue(new Error("User not found"));
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);
    await user.type(
      screen.getByPlaceholderText(/enter your email/i),
      "a@x.com"
    );
    await user.click(screen.getByRole("button", { name: /send reset code/i }));
    await waitFor(() =>
      expect(screen.getByText(/user not found/i)).toBeInTheDocument()
    );
  });

  it("renders sign-in link", async () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument();
  });

  it("renders signed-in advisory when authed, never auto-redirects (#710)", async () => {
    authMock.mockReturnValue({
      user: { id: "u1", email: "doc@x.com", role: "DOCTOR", name: "Doc" },
      logout: vi.fn(),
    });
    render(<ForgotPasswordPage />);
    expect(screen.getByTestId("forgot-signed-in-banner")).toBeInTheDocument();
    expect(screen.getByText(/you're signed in as/i)).toBeInTheDocument();
    // Form is still rendered — page never bounces an authed user away.
    expect(
      screen.getByRole("button", { name: /send reset code/i }),
    ).toBeInTheDocument();
  });

  it("does not render signed-in advisory when anonymous (#710)", async () => {
    render(<ForgotPasswordPage />);
    expect(
      screen.queryByTestId("forgot-signed-in-banner"),
    ).not.toBeInTheDocument();
  });
});
