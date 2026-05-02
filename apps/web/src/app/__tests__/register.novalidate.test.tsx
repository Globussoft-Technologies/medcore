/* eslint-disable @typescript-eslint/no-explicit-any */
// Mirror of `login.novalidate.test.tsx` for the registration form. The page
// runs a full client-side validator (`validateClient`) and renders one
// `<p data-testid="error-{field}">` per failed field rather than relying on
// the browser's native validation popover (which would only surface the
// first failure and clip on Chromium under tight viewports — Issue #102 /
// #130).
//
// The cases here are the client-only paths — server submission is never
// reached when `validateClient()` returns errors, so the API mock should
// stay un-called.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, loginMock, pushMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  loginMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));

vi.mock("@/lib/store", () => ({
  useAuthStore: () => ({ login: loginMock }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/register",
  useSearchParams: () => ({ get: (_k: string) => null }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));

import RegisterPage from "../register/page";

describe("RegisterPage — noValidate + inline field errors (Issue #102 / #130)", () => {
  beforeEach(() => {
    apiMock.post.mockReset();
    loginMock.mockReset();
    pushMock.mockReset();
  });

  it("renders the form with noValidate so the browser tooltip is suppressed", () => {
    render(<RegisterPage />);
    const form = screen.getByRole("form", { name: /registration form/i });
    expect((form as HTMLFormElement).noValidate).toBe(true);
  });

  it("shows every per-field inline error at once when all required fields are empty", async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    // The validateClient() up-front pass should set all four required-field
    // errors in one render — Issue #130 specifically asserts no "fix the
    // first error then click again" loop.
    await waitFor(() => {
      expect(screen.getByTestId("error-name")).toBeInTheDocument();
    });
    expect(screen.getByTestId("error-email")).toBeInTheDocument();
    expect(screen.getByTestId("error-phone")).toBeInTheDocument();
    expect(screen.getByTestId("error-password")).toBeInTheDocument();

    // The API must NOT have been called — client-side validation short-circuits.
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects a malformed email with a 'valid email' message and skips submit", async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);
    await user.type(screen.getByLabelText(/full name/i), "Aarav Mehta");
    await user.type(screen.getByLabelText(/^email$/i), "not-an-email");
    await user.type(screen.getByLabelText(/^phone$/i), "9876543210");
    await user.type(screen.getByLabelText(/^password$/i), "correct-horse");
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("error-email")).toHaveTextContent(/valid email/i);
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects a phone with too few digits", async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);
    await user.type(screen.getByLabelText(/full name/i), "Aarav Mehta");
    await user.type(screen.getByLabelText(/^email/i), "aarav@example.com");
    await user.type(screen.getByLabelText(/^phone/i), "12345"); // only 5 digits
    await user.type(screen.getByLabelText(/^password/i), "correct-horse");
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("error-phone")).toHaveTextContent(/10-digit/i);
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects a too-short password", async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);
    await user.type(screen.getByLabelText(/full name/i), "Aarav Mehta");
    await user.type(screen.getByLabelText(/^email/i), "aarav@example.com");
    await user.type(screen.getByLabelText(/^phone/i), "9876543210");
    await user.type(screen.getByLabelText(/^password/i), "short"); // 5 chars

    await user.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("error-password")).toHaveTextContent(/at least 6/i);
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects age=0 with a 'between 1 and 150' message (Issue #167)", async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);
    await user.type(screen.getByLabelText(/full name/i), "Aarav Mehta");
    await user.type(screen.getByLabelText(/^email/i), "aarav@example.com");
    await user.type(screen.getByLabelText(/^phone/i), "9876543210");
    await user.type(screen.getByLabelText(/^password/i), "correct-horse");
    await user.type(screen.getByLabelText(/^age/i), "0");
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("error-age")).toHaveTextContent(/between 1 and 150/i);
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("clears a field's inline error as soon as the user edits the input", async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);

    // Trigger the empty-form errors first.
    await user.click(screen.getByRole("button", { name: /^register$/i }));
    await waitFor(() => {
      expect(screen.getByTestId("error-name")).toBeInTheDocument();
    });

    // Type into the name field — the error-name span should disappear without
    // re-running validation.
    await user.type(screen.getByLabelText(/full name/i), "A");
    await waitFor(() => {
      expect(screen.queryByTestId("error-name")).not.toBeInTheDocument();
    });
    // Other field errors should still be present.
    expect(screen.getByTestId("error-email")).toBeInTheDocument();
  });
});
