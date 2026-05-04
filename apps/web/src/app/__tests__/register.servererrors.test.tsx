/* eslint-disable @typescript-eslint/no-explicit-any */
// Issue #494: server-error feedback for the patient self-registration form.
//
// Wave A `74e28f6` tightened the SERVER-side `registerSchema` (XSS,
// age 1-150). Wave C `b1db706` improved `extractFieldErrors` for Zod
// humanization. The remaining gap was CLIENT-side feedback — when the
// server returns a 400 with field errors the form renders inline, when
// the server 5xx's the form shows a top banner with a retry CTA, and in
// neither case are the user's typed values cleared.
//
// What this spec covers (the three paths the page must distinguish):
//   1. 400 + payload.details → inline `error-{field}` spans, form values
//      preserved (no retype).
//   2. 5xx + Error.status >= 500 → `register-error-banner` with a
//      `register-retry-btn` that re-POSTs without re-validating.
//   3. Network/abort error (no .status) → same retry banner as 5xx so a
//      DNS hiccup or offline submit isn't a silent failure.
//
// We deliberately do NOT assert duplicate-email behaviour — the API
// returns 201 on that path (anti-enumeration per #480), so the form's
// success branch handles it; testing it here would require asserting
// what the user *can't* see, which is the whole point of #480.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, loginMock, pushMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  loginMock: vi.fn(),
  pushMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
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
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/components/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));

import RegisterPage from "../register/page";

interface ApiError extends Error {
  status?: number;
  payload?: unknown;
}

function makeApiError(
  status: number,
  payload: unknown,
  message = "Request failed",
): ApiError {
  const e = new Error(message) as ApiError;
  e.status = status;
  e.payload = payload;
  return e;
}

const validForm = {
  name: "Aarav Mehta",
  email: "aarav@example.com",
  phone: "9876543210",
  password: "correct-horse",
};

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/full name/i), validForm.name);
  await user.type(screen.getByLabelText(/^email/i), validForm.email);
  await user.type(screen.getByLabelText(/^phone/i), validForm.phone);
  await user.type(screen.getByLabelText(/^password/i), validForm.password);
}

describe("RegisterPage — server-error feedback (Issue #494)", () => {
  beforeEach(() => {
    apiMock.post.mockReset();
    loginMock.mockReset();
    pushMock.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
  });

  it("renders inline per-field errors when the server returns 400 with details", async () => {
    apiMock.post.mockRejectedValueOnce(
      makeApiError(
        400,
        {
          error: "Validation failed",
          details: [
            { field: "name", message: "String must contain at least 2 character(s)" },
            { field: "phone", message: "Phone must be 10 digits" },
            { field: "password", message: "String must contain at least 6 character(s)" },
          ],
        },
        "Validation failed",
      ),
    );
    const user = userEvent.setup();
    render(<RegisterPage />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("error-name")).toHaveTextContent(
        /at least 2 character/i,
      );
    });
    expect(screen.getByTestId("error-phone")).toHaveTextContent(/10 digits/i);
    expect(screen.getByTestId("error-password")).toHaveTextContent(
      /at least 6 character/i,
    );

    // No top-banner when we have field errors — they live inline.
    expect(screen.queryByTestId("register-error-banner")).not.toBeInTheDocument();
    // Form values are preserved — Issue #494 explicitly forbids clearing.
    expect(
      (screen.getByLabelText(/full name/i) as HTMLInputElement).value,
    ).toBe(validForm.name);
    expect(
      (screen.getByLabelText(/^email/i) as HTMLInputElement).value,
    ).toBe(validForm.email);
    expect(
      (screen.getByLabelText(/^phone/i) as HTMLInputElement).value,
    ).toBe(validForm.phone);
  });

  it("shows a top-banner with a retry CTA on 5xx server errors", async () => {
    apiMock.post.mockRejectedValueOnce(
      makeApiError(500, { error: "Internal Server Error" }, "Internal Server Error"),
    );
    const user = userEvent.setup();
    render(<RegisterPage />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("register-error-banner")).toHaveTextContent(
        /something went wrong/i,
      );
    });
    expect(screen.getByTestId("register-retry-btn")).toBeInTheDocument();
    // No inline field errors when the failure isn't field-shaped.
    expect(screen.queryByTestId("error-name")).not.toBeInTheDocument();
    // Form values preserved across the failed POST.
    expect(
      (screen.getByLabelText(/full name/i) as HTMLInputElement).value,
    ).toBe(validForm.name);
  });

  it("retry CTA re-submits without re-running client validation", async () => {
    apiMock.post
      .mockRejectedValueOnce(makeApiError(503, { error: "Service Unavailable" }))
      .mockResolvedValueOnce({ data: { success: true } });
    loginMock.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<RegisterPage />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    const retryBtn = await screen.findByTestId("register-retry-btn");
    await user.click(retryBtn);

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(2);
    });
    // Banner is cleared after the successful retry.
    await waitFor(() => {
      expect(screen.queryByTestId("register-error-banner")).not.toBeInTheDocument();
    });
  });

  it("treats a network error (no .status) the same as 5xx — banner + retry", async () => {
    // Some `fetch` failures (DNS, offline, CORS preflight) reject with a
    // plain Error and no .status. Those should still surface as a retryable
    // banner, never as a silent dead-end.
    apiMock.post.mockRejectedValueOnce(new Error("Failed to fetch"));
    const user = userEvent.setup();
    render(<RegisterPage />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("register-error-banner")).toBeInTheDocument();
    });
    expect(screen.getByTestId("register-retry-btn")).toBeInTheDocument();
  });

  it("treats a 408 timeout as retryable", async () => {
    // Issue #377 surfaces server-side hangs as `status: 408` from the api
    // client. From the user's POV the registration didn't go through — let
    // them retry from the banner.
    apiMock.post.mockRejectedValueOnce(
      makeApiError(408, null, "Request timed out — please try again"),
    );
    const user = userEvent.setup();
    render(<RegisterPage />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("register-retry-btn")).toBeInTheDocument();
    });
  });

  it("non-retryable 4xx (no field details) shows the banner without a retry CTA", async () => {
    // A 401/403/429 reaching the register form is rare, but if it does we
    // still want to surface the message; retrying won't help so the CTA
    // stays hidden.
    apiMock.post.mockRejectedValueOnce(
      makeApiError(429, { error: "Too many requests" }, "Too many requests"),
    );
    const user = userEvent.setup();
    render(<RegisterPage />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("register-error-banner")).toHaveTextContent(
        /too many requests/i,
      );
    });
    expect(screen.queryByTestId("register-retry-btn")).not.toBeInTheDocument();
  });
});
