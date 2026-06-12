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
  // Issue #33 brought `useSearchParams` into the page. Return a stub so tests
  // do not need to simulate the ?redirect= param.
  useSearchParams: () => ({ get: (_k: string) => null }),
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
  await user.type(screen.getByLabelText(/^password$/i), "correct-horse");
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
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
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

  it("shows the backend reason (e.g. tenant suspended) on 403, not the generic credentials copy", async () => {
    // A 403 on login means the credentials were valid but access is blocked
    // (e.g. the hospital tenant was suspended). The page surfaces the
    // backend's specific message rather than "Invalid email or password".
    loginMock.mockRejectedValueOnce(
      buildHttpError(
        403,
        "Your hospital account has been suspended. Please contact your administrator or MedCore support to restore access.",
      ),
    );
    await submitCredentials();
    await waitFor(() =>
      expect(screen.getByText(/suspended/i)).toBeInTheDocument()
    );
    // MUST NOT fall back to the generic credentials copy on a 403.
    expect(
      screen.queryByText(/invalid email or password/i),
    ).not.toBeInTheDocument();
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

describe("LoginPage — Remember Me (Issue #1)", () => {
  beforeEach(() => {
    loginMock.mockReset();
    verify2FAMock.mockReset();
    pushMock.mockReset();
  });

  it("renders the Remember Me checkbox, unchecked by default", () => {
    render(<LoginPage />);
    const remember = screen.getByTestId("login-remember-me") as HTMLInputElement;
    expect(remember).toBeInTheDocument();
    expect(remember.type).toBe("checkbox");
    expect(remember.checked).toBe(false);
    // Label associated with the checkbox
    expect(screen.getByLabelText(/remember me/i)).toBe(remember);
  });

  it("does NOT pass rememberMe when unchecked (preserves legacy 7d TTL)", async () => {
    const user = userEvent.setup();
    loginMock.mockResolvedValueOnce({});
    render(<LoginPage />);
    await user.type(screen.getByLabelText(/email/i), "user@medcore.local");
    await user.type(screen.getByLabelText(/^password$/i), "correct-horse");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => expect(loginMock).toHaveBeenCalled());
    // Third arg is rememberMe: must be false (or omitted/falsy).
    expect(loginMock).toHaveBeenCalledWith(
      "user@medcore.local",
      "correct-horse",
      false
    );
  });

  it("passes rememberMe: true to the store when checked", async () => {
    const user = userEvent.setup();
    loginMock.mockResolvedValueOnce({});
    render(<LoginPage />);
    await user.type(screen.getByLabelText(/email/i), "user@medcore.local");
    await user.type(screen.getByLabelText(/^password$/i), "correct-horse");
    await user.click(screen.getByTestId("login-remember-me"));
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => expect(loginMock).toHaveBeenCalled());
    expect(loginMock).toHaveBeenCalledWith(
      "user@medcore.local",
      "correct-horse",
      true
    );
  });
});

describe("LoginPage — password show/hide toggle (Issue #2)", () => {
  beforeEach(() => {
    loginMock.mockReset();
    verify2FAMock.mockReset();
    pushMock.mockReset();
  });

  it("renders the password toggle and reveals the value on click", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    const password = screen.getByLabelText(/^password$/i) as HTMLInputElement;
    expect(password.type).toBe("password");
    await user.type(password, "secret");
    const toggle = screen.getByTestId("password-toggle");
    await user.click(toggle);
    expect(password.type).toBe("text");
    await user.click(toggle);
    expect(password.type).toBe("password");
  });

  it("toggle click does not submit the login form", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText(/email/i), "a@b.com");
    await user.type(screen.getByLabelText(/^password$/i), "correct-horse");
    await user.click(screen.getByTestId("password-toggle"));
    expect(loginMock).not.toHaveBeenCalled();
  });
});
