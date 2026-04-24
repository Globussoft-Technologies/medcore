/* eslint-disable @typescript-eslint/no-explicit-any */
// Guards Issue #15: 429 rate-limits must show a "too many attempts" message,
// NOT the generic "Invalid email or password" copy. Separately, 401 responses
// still show the credentials message so genuine typos remain self-evident.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { loginMock, verify2FAMock, pushMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  verify2FAMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  useAuthStore: () => ({
    login: loginMock,
    verify2FA: verify2FAMock,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/login",
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));

import LoginPage from "../login/page";

function buildHttpError(status: number, message = "Request failed") {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

async function submitCredentials() {
  const user = userEvent.setup();
  render(<LoginPage />);
  await user.type(screen.getByLabelText(/email/i), "user@medcore.local");
  await user.type(screen.getByLabelText(/password/i), "correct-horse");
  await user.click(screen.getByRole("button", { name: /^sign in$/i }));
}

describe("LoginPage — status-aware error handling (Issue #15)", () => {
  beforeEach(() => {
    loginMock.mockReset();
    verify2FAMock.mockReset();
    pushMock.mockReset();
  });

  it("renders the sign-in form", () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("heading", { name: /sign in/i })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("shows the rate-limit message on 429", async () => {
    loginMock.mockRejectedValueOnce(
      buildHttpError(429, "Too many requests. Try again later.")
    );
    await submitCredentials();
    await waitFor(() =>
      expect(
        screen.getByText(/too many login attempts/i)
      ).toBeInTheDocument()
    );
    // MUST NOT fall back to the credentials copy
    expect(screen.queryByText(/invalid email or password/i)).not.toBeInTheDocument();
  });

  it("shows the credentials message on 401", async () => {
    loginMock.mockRejectedValueOnce(buildHttpError(401, "Unauthorized"));
    await submitCredentials();
    await waitFor(() =>
      expect(
        screen.getByText(/invalid email or password/i)
      ).toBeInTheDocument()
    );
  });

  it("shows the credentials message on 403", async () => {
    loginMock.mockRejectedValueOnce(buildHttpError(403, "Forbidden"));
    await submitCredentials();
    await waitFor(() =>
      expect(
        screen.getByText(/invalid email or password/i)
      ).toBeInTheDocument()
    );
  });

  it("falls back to the backend error text on 500", async () => {
    loginMock.mockRejectedValueOnce(
      buildHttpError(500, "Internal server error")
    );
    await submitCredentials();
    await waitFor(() =>
      expect(screen.getByText(/internal server error/i)).toBeInTheDocument()
    );
  });
});
