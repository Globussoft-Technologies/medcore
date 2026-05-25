/* eslint-disable @typescript-eslint/no-explicit-any */
// Behaviour coverage for the forgot-password page
// (`apps/web/src/app/forgot-password/page.tsx`).
//
// Pins the four-step state machine and the issue-#15/#127/#710/#711 fixes:
//   1. Step "email" — controlled input, client-side disabled gate (empty/whitespace),
//      POST `/auth/forgot-password`, enumeration-safe success → step "sent" + toast,
//      authErrorMessage(): 429 → throttle copy, Error.message passthrough, fallback
//      "Something went wrong" when the rejection has no usable message.
//   2. Step "sent" — confirmation banner echoes the entered email, "I have the code"
//      advances to "reset", "Use a different email" returns to "email" + clears error.
//   3. Step "reset" — POST `/auth/reset-password` with {email, code, newPassword},
//      code input strips non-digits and clamps to 6 chars, verify button disabled
//      until code.length === 6, success → step "done", server error → inline banner,
//      "Use a different email" returns to step 1 + clears error.
//   4. Step "done" — success screen + "Back to Sign In" link, NO bottom footer
//      "Remember your password?" sign-in link (only renders when step !== "done").
//   5. Issue #710 signed-in advisory — when useAuthStore has a user, banner renders
//      with email + Sign-out button that calls logout() + toast.info("Signed out.").
//   6. Issue #711 enumeration-safe copy in success toast + sent banner.
//
// Mock layer mirrors the existing `apps/web/src/app/__tests__/forgot-password.page.test.tsx`
// pattern: vi.hoisted api + useAuthStore + toast mocks. This file is the colocated
// __tests__/ companion (per repo convention; both coexist under the include glob).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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

import ForgotPasswordPage from "../page";

function emailInput(): HTMLInputElement {
  return screen.getByPlaceholderText(/enter your email/i) as HTMLInputElement;
}

function sendCodeButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /send reset code|sending/i,
  }) as HTMLButtonElement;
}

async function advanceToSentStep(email = "user@example.com"): Promise<void> {
  apiMock.post.mockResolvedValueOnce({ data: {} });
  const user = userEvent.setup();
  await user.type(emailInput(), email);
  await user.click(sendCodeButton());
  await waitFor(() =>
    expect(screen.getByTestId("forgot-sent-confirmation")).toBeInTheDocument(),
  );
}

async function advanceToResetStep(email = "user@example.com"): Promise<void> {
  await advanceToSentStep(email);
  const user = userEvent.setup();
  await user.click(screen.getByTestId("forgot-have-code-btn"));
  await waitFor(() =>
    expect(
      screen.getByLabelText(/reset code/i),
    ).toBeInTheDocument(),
  );
}

describe("ForgotPasswordPage — step machine, banners, and error surfaces", () => {
  beforeEach(() => {
    apiMock.post.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    toastMock.info.mockReset();
    toastMock.warning.mockReset();
    // Default: anonymous visitor.
    authMock.mockReturnValue({ user: null, logout: vi.fn() });
  });

  describe("Step 1: email", () => {
    it("renders the email-step form with the logo, prompt, and CTA", () => {
      render(<ForgotPasswordPage />);
      expect(
        screen.getByRole("heading", { name: /medcore/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/reset your password/i),
      ).toBeInTheDocument();
      expect(emailInput()).toBeInTheDocument();
      expect(sendCodeButton()).toBeInTheDocument();
      // No sent / reset / done DOM at this point.
      expect(
        screen.queryByTestId("forgot-sent-confirmation"),
      ).not.toBeInTheDocument();
    });

    it("disables the submit button when the email is blank or whitespace-only", async () => {
      const user = userEvent.setup();
      render(<ForgotPasswordPage />);
      // Blank — disabled.
      expect(sendCodeButton()).toBeDisabled();
      // Whitespace-only — still disabled (the source guards with email.trim()).
      await user.type(emailInput(), "   ");
      expect(sendCodeButton()).toBeDisabled();
      // Real value — enabled.
      await user.type(emailInput(), "x@y.com");
      expect(sendCodeButton()).toBeEnabled();
    });

    it("POSTs {email} to /auth/forgot-password and advances to step 'sent' on success", async () => {
      apiMock.post.mockResolvedValueOnce({ data: {} });
      const user = userEvent.setup();
      render(<ForgotPasswordPage />);
      await user.type(emailInput(), "user@example.com");
      await user.click(sendCodeButton());

      await waitFor(() => {
        expect(apiMock.post).toHaveBeenCalledWith("/auth/forgot-password", {
          email: "user@example.com",
        });
      });
      // Issue #711: enumeration-safe success toast fires alongside the banner.
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringMatching(/if an account exists for this email/i),
      );
      // The sent-confirmation step is now in the DOM.
      expect(
        screen.getByTestId("forgot-sent-confirmation"),
      ).toBeInTheDocument();
      expect(screen.getByText(/check your inbox/i)).toBeInTheDocument();
      // The banner echoes the email we entered.
      expect(screen.getByText("user@example.com")).toBeInTheDocument();
    });

    it("maps a 429-shaped rejection to the throttle copy (issue #15)", async () => {
      apiMock.post.mockRejectedValueOnce({ status: 429 });
      const user = userEvent.setup();
      render(<ForgotPasswordPage />);
      await user.type(emailInput(), "user@example.com");
      await user.click(sendCodeButton());

      await waitFor(() => {
        expect(screen.getByTestId("forgot-error-banner")).toHaveTextContent(
          /too many attempts/i,
        );
      });
      // Still on step 1 — sent step did NOT render.
      expect(
        screen.queryByTestId("forgot-sent-confirmation"),
      ).not.toBeInTheDocument();
      expect(toastMock.success).not.toHaveBeenCalled();
    });

    it("passes through Error.message verbatim when the API throws an Error", async () => {
      apiMock.post.mockRejectedValueOnce(new Error("User not found"));
      const user = userEvent.setup();
      render(<ForgotPasswordPage />);
      await user.type(emailInput(), "user@example.com");
      await user.click(sendCodeButton());

      await waitFor(() => {
        expect(screen.getByTestId("forgot-error-banner")).toHaveTextContent(
          /user not found/i,
        );
      });
    });

    it("falls back to 'Something went wrong' when the rejection has no usable message", async () => {
      // Non-Error, non-429 — neither branch of authErrorMessage applies, fallback wins.
      apiMock.post.mockRejectedValueOnce({});
      const user = userEvent.setup();
      render(<ForgotPasswordPage />);
      await user.type(emailInput(), "user@example.com");
      await user.click(sendCodeButton());

      await waitFor(() => {
        expect(screen.getByTestId("forgot-error-banner")).toHaveTextContent(
          /something went wrong/i,
        );
      });
    });

    it("flips the button to 'Sending...' and disables it while the request is in flight", async () => {
      let resolveSend: ((v: unknown) => void) | undefined;
      apiMock.post.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
      );

      const user = userEvent.setup();
      render(<ForgotPasswordPage />);
      await user.type(emailInput(), "user@example.com");
      await user.click(sendCodeButton());

      // Mid-flight: button disabled + label flipped.
      const btn = sendCodeButton();
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent(/sending/i);

      await act(async () => {
        resolveSend?.({ data: {} });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId("forgot-sent-confirmation"),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Step 2: sent", () => {
    it("'I have the code' advances to the reset step with code + new-password inputs", async () => {
      render(<ForgotPasswordPage />);
      await advanceToResetStep();
      expect(screen.getByLabelText(/reset code/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
      expect(
        screen.getByText(/a 6-digit code has been sent/i),
      ).toBeInTheDocument();
    });

    it("'Use a different email' from sent step returns to step 1 and clears prior error", async () => {
      render(<ForgotPasswordPage />);
      await advanceToSentStep("user@example.com");
      const user = userEvent.setup();
      // Click the "Use a different email" button (the second secondary CTA on the sent step).
      await user.click(screen.getByRole("button", { name: /use a different email/i }));
      // Back on step 1: email input visible, sent banner gone.
      expect(emailInput()).toBeInTheDocument();
      expect(
        screen.queryByTestId("forgot-sent-confirmation"),
      ).not.toBeInTheDocument();
    });
  });

  describe("Step 3: reset", () => {
    it("strips non-digits and clamps the code input to 6 characters", async () => {
      render(<ForgotPasswordPage />);
      await advanceToResetStep();
      const code = screen.getByLabelText(/reset code/i) as HTMLInputElement;
      fireEvent.change(code, { target: { value: "12a3b4c5d6e7f8" } });
      // Source: value.replace(/\D/g, "").slice(0, 6) — should yield exactly "123456".
      expect(code.value).toBe("123456");
    });

    it("keeps the reset submit disabled until the code is exactly 6 digits", async () => {
      render(<ForgotPasswordPage />);
      await advanceToResetStep();
      const code = screen.getByLabelText(/reset code/i) as HTMLInputElement;
      const submit = screen.getByRole("button", {
        name: /reset password|resetting/i,
      }) as HTMLButtonElement;
      // Empty code — disabled.
      expect(submit).toBeDisabled();
      fireEvent.change(code, { target: { value: "12345" } }); // 5 digits — still disabled.
      expect(submit).toBeDisabled();
      fireEvent.change(code, { target: { value: "123456" } }); // 6 digits — enabled.
      expect(submit).toBeEnabled();
    });

    it("POSTs {email, code, newPassword} to /auth/reset-password and advances to step 'done' on success", async () => {
      render(<ForgotPasswordPage />);
      await advanceToResetStep("user@example.com");

      // First call was the forgot-password POST; clear for clarity then queue the reset response.
      apiMock.post.mockClear();
      apiMock.post.mockResolvedValueOnce({ data: {} });

      const code = screen.getByLabelText(/reset code/i);
      const newPwd = screen.getByLabelText(/new password/i);
      fireEvent.change(code, { target: { value: "987654" } });
      fireEvent.change(newPwd, { target: { value: "Sup3r$tr0ngPwd!" } });

      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: /reset password/i }),
      );

      await waitFor(() => {
        expect(apiMock.post).toHaveBeenCalledWith("/auth/reset-password", {
          email: "user@example.com",
          code: "987654",
          newPassword: "Sup3r$tr0ngPwd!",
        });
      });
      // Done step rendered.
      expect(
        screen.getByText(/password reset successful/i),
      ).toBeInTheDocument();
    });

    it("surfaces a server-side reset failure inline and stays on the reset step", async () => {
      render(<ForgotPasswordPage />);
      await advanceToResetStep("user@example.com");

      apiMock.post.mockClear();
      apiMock.post.mockRejectedValueOnce(new Error("Invalid or expired code"));

      fireEvent.change(screen.getByLabelText(/reset code/i), {
        target: { value: "111111" },
      });
      fireEvent.change(screen.getByLabelText(/new password/i), {
        target: { value: "AnotherPwd!" },
      });

      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: /reset password/i }),
      );
      await waitFor(() => {
        expect(screen.getByTestId("forgot-error-banner")).toHaveTextContent(
          /invalid or expired code/i,
        );
      });
      // Still on the reset step — done screen NOT rendered.
      expect(
        screen.queryByText(/password reset successful/i),
      ).not.toBeInTheDocument();
    });

    it("'Use a different email' from reset step returns to step 1 and clears the error banner", async () => {
      render(<ForgotPasswordPage />);
      await advanceToResetStep();

      // Trigger an inline error first so we can verify clear-on-back.
      apiMock.post.mockClear();
      apiMock.post.mockRejectedValueOnce(new Error("boom"));
      fireEvent.change(screen.getByLabelText(/reset code/i), {
        target: { value: "123456" },
      });
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: /reset password/i }),
      );
      await waitFor(() => {
        expect(screen.getByTestId("forgot-error-banner")).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /use a different email/i }),
      );
      // Back on step 1 + banner cleared.
      expect(emailInput()).toBeInTheDocument();
      expect(
        screen.queryByTestId("forgot-error-banner"),
      ).not.toBeInTheDocument();
    });
  });

  describe("Step 4: done", () => {
    it("renders the success state with a 'Back to Sign In' link and no footer Sign-In CTA", async () => {
      render(<ForgotPasswordPage />);
      await advanceToResetStep("user@example.com");

      apiMock.post.mockClear();
      apiMock.post.mockResolvedValueOnce({ data: {} });
      fireEvent.change(screen.getByLabelText(/reset code/i), {
        target: { value: "654321" },
      });
      fireEvent.change(screen.getByLabelText(/new password/i), {
        target: { value: "FinalPwd123!" },
      });
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: /reset password/i }),
      );

      await waitFor(() => {
        expect(
          screen.getByText(/password reset successful/i),
        ).toBeInTheDocument();
      });

      // The done step's primary CTA is a Link to /login.
      const backLink = screen.getByRole("link", { name: /back to sign in/i });
      expect(backLink).toHaveAttribute("href", "/login");

      // Issue: the bottom "Remember your password? Sign In" footer is only
      // rendered when step !== "done". Confirm it is NOT present here.
      expect(
        screen.queryByText(/remember your password\?/i),
      ).not.toBeInTheDocument();
    });
  });

  describe("Issue #710 signed-in advisory", () => {
    it("renders the inline signed-in banner with the user's email when authed", () => {
      authMock.mockReturnValue({
        user: {
          id: "u1",
          email: "doc@example.com",
          role: "DOCTOR",
          name: "Doc",
        },
        logout: vi.fn(),
      });
      render(<ForgotPasswordPage />);
      expect(
        screen.getByTestId("forgot-signed-in-banner"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/you're signed in as/i),
      ).toBeInTheDocument();
      expect(screen.getByText("doc@example.com")).toBeInTheDocument();
      // Form remains usable — never auto-redirects.
      expect(sendCodeButton()).toBeInTheDocument();
    });

    it("does NOT render the signed-in banner for anonymous visitors", () => {
      render(<ForgotPasswordPage />);
      expect(
        screen.queryByTestId("forgot-signed-in-banner"),
      ).not.toBeInTheDocument();
    });

    it("Sign-out button invokes logout() and fires the info toast", async () => {
      const logoutSpy = vi.fn().mockResolvedValue(undefined);
      authMock.mockReturnValue({
        user: {
          id: "u1",
          email: "doc@example.com",
          role: "DOCTOR",
          name: "Doc",
        },
        logout: logoutSpy,
      });
      render(<ForgotPasswordPage />);
      const user = userEvent.setup();
      await user.click(screen.getByTestId("forgot-signout-btn"));
      await waitFor(() => {
        expect(logoutSpy).toHaveBeenCalledTimes(1);
      });
      expect(toastMock.info).toHaveBeenCalledWith("Signed out.");
    });
  });

  describe("Footer sign-in link", () => {
    it("renders the 'Remember your password? Sign In' link on the email step", () => {
      render(<ForgotPasswordPage />);
      // There are multiple Sign In-like elements possibly; locate by the link role + href.
      const links = screen
        .getAllByRole("link")
        .filter((el) => el.getAttribute("href") === "/login");
      expect(links.length).toBeGreaterThan(0);
      expect(
        screen.getByText(/remember your password\?/i),
      ).toBeInTheDocument();
    });
  });
});
