// Behaviour coverage for the patient phone-OTP login page
// (`apps/web/src/app/patient/login/page.tsx`, Pearl §5.3 / §6.1 — gap #5
// piece 2, rewritten 2026-05-27 for the Firebase-backed flow).
//
// The page now uses Firebase Phone Auth on the client (invisible
// reCAPTCHA → sendOtp → verifyOtp returns an ID token) and POSTs that
// token to `/patient-auth/firebase-verify` on the API, which mints our
// own httpOnly session cookies. The legacy `/patient-auth/otp-request`
// + `/patient-auth/otp-verify` endpoints are no longer wired into this
// page (still exist server-side as a fallback for the legacy SMS path,
// but no UI calls them anymore).
//
// What's pinned:
//   1. Step 1 (phone): client-side regex/normalisation, sendOtp() called
//      with the canonical E.164, success → step 2 + info banner, thrown
//      Firebase error → inline error and stays on step 1.
//   2. Step 2 (otp): client-side 6-digit validation, verifyOtp() returns
//      the ID token, POST /patient-auth/firebase-verify with that token,
//      success → router.push("/patient/dashboard"), error → inline error
//      and no redirect.
//   3. Misc: register CTA href, busy-state disables interactive controls
//      during in-flight requests, Change number / Resend behaviours.
//
// Mock layer: vi.hoisted handles to the @/lib/firebase helpers (the
// page imports them at module level so module-init order matters) +
// the @/lib/api post mock + the next/navigation router mock.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";

const {
  apiPostMock,
  routerPushMock,
  ensureRecaptchaMock,
  disposeRecaptchaMock,
  sendOtpMock,
  verifyOtpMock,
  resetPhoneAuthStateMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  routerPushMock: vi.fn(),
  ensureRecaptchaMock: vi.fn(),
  disposeRecaptchaMock: vi.fn(),
  sendOtpMock: vi.fn(),
  verifyOtpMock: vi.fn(),
  resetPhoneAuthStateMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: apiPostMock,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/firebase", () => ({
  ensureRecaptcha: ensureRecaptchaMock,
  disposeRecaptcha: disposeRecaptchaMock,
  sendOtp: sendOtpMock,
  verifyOtp: verifyOtpMock,
  resetPhoneAuthState: resetPhoneAuthStateMock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock, replace: vi.fn(), back: vi.fn() }),
}));

import PatientLoginPage from "../page";

function typePhone(value: string): void {
  fireEvent.change(screen.getByTestId("patient-login-phone-input"), {
    target: { value },
  });
}

function typeOtp(value: string): void {
  fireEvent.change(screen.getByTestId("patient-login-otp-input"), {
    target: { value },
  });
}

async function advanceToOtpStep(phone = "+919876543210"): Promise<void> {
  sendOtpMock.mockResolvedValueOnce(undefined);
  typePhone(phone);
  await act(async () => {
    fireEvent.click(screen.getByTestId("patient-login-send-code"));
  });
  await waitFor(() => {
    expect(screen.getByTestId("patient-login-otp-input")).toBeInTheDocument();
  });
}

describe("PatientLoginPage — Firebase phone-OTP two-step flow", () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    routerPushMock.mockReset();
    ensureRecaptchaMock.mockReset();
    disposeRecaptchaMock.mockReset();
    sendOtpMock.mockReset();
    verifyOtpMock.mockReset();
    resetPhoneAuthStateMock.mockReset();
  });

  it("renders step 1 with the phone input and a register CTA link", () => {
    render(<PatientLoginPage />);
    // 2026-05 redesign added a hero "Welcome back. Sign in securely."
    // <h2> on the left rail; the on-form title is still a plain
    // "Sign in" but at h1. Pin level=1 so we match only the form's
    // title, not the rail.
    expect(
      screen.getByRole("heading", { name: /sign in/i, level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("patient-login-phone-input"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("patient-login-send-code"),
    ).toBeInTheDocument();
    const registerLink = screen.getByTestId("patient-login-register-link");
    expect(registerLink).toHaveAttribute("href", "/patient/register");
    expect(
      screen.queryByTestId("patient-login-otp-input"),
    ).not.toBeInTheDocument();
  });

  it("mounts the invisible reCAPTCHA on first render and tears it down on unmount", () => {
    const { unmount } = render(<PatientLoginPage />);
    expect(ensureRecaptchaMock).toHaveBeenCalledWith("patient-recaptcha");
    unmount();
    expect(disposeRecaptchaMock).toHaveBeenCalled();
    expect(resetPhoneAuthStateMock).toHaveBeenCalled();
  });

  it("surfaces a Firebase init error inline if ensureRecaptcha throws", () => {
    ensureRecaptchaMock.mockImplementationOnce(() => {
      throw new Error("Firebase env not configured");
    });
    render(<PatientLoginPage />);
    expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
      /firebase env not configured/i,
    );
  });

  it("rejects an invalid phone number client-side without calling sendOtp", () => {
    render(<PatientLoginPage />);
    typePhone("123"); // Too short — fails normaliseToE164.
    fireEvent.click(screen.getByTestId("patient-login-send-code"));
    expect(sendOtpMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
      /valid phone number/i,
    );
  });

  it("normalises a 10-digit Indian number to +91 E.164 before calling sendOtp", async () => {
    sendOtpMock.mockResolvedValueOnce(undefined);
    render(<PatientLoginPage />);
    typePhone("9876543210"); // bare 10-digit, no +91
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-send-code"));
    });
    await waitFor(() => {
      expect(sendOtpMock).toHaveBeenCalledWith("+919876543210");
    });
    expect(
      screen.getByTestId("patient-login-otp-input"),
    ).toBeInTheDocument();
  });

  it("calls sendOtp with the trimmed E.164 and advances to step 2", async () => {
    sendOtpMock.mockResolvedValueOnce(undefined);
    render(<PatientLoginPage />);
    typePhone("  +919876543210  ");
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-send-code"));
    });
    await waitFor(() => {
      expect(sendOtpMock).toHaveBeenCalledWith("+919876543210");
    });
    expect(
      screen.getByTestId("patient-login-otp-input"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("patient-login-info")).toHaveTextContent(
      /6-digit code/i,
    );
  });

  it("surfaces a thrown sendOtp error inline and does NOT advance to step 2", async () => {
    sendOtpMock.mockRejectedValueOnce(new Error("Invalid phone number format."));
    render(<PatientLoginPage />);
    typePhone("+919876543210");
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-send-code"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
        /invalid phone number format/i,
      );
    });
    expect(
      screen.queryByTestId("patient-login-otp-input"),
    ).not.toBeInTheDocument();
  });

  it("rejects an OTP that is not exactly 6 digits client-side without calling verifyOtp", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep();
    typeOtp("12345"); // Only 5 digits.
    fireEvent.click(screen.getByTestId("patient-login-verify"));
    expect(verifyOtpMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
      /6-digit code/i,
    );
  });

  it("verifyOtp returns ID token → POST /patient-auth/firebase-verify → router.push('/patient/dashboard')", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep("+919876543210");

    verifyOtpMock.mockResolvedValueOnce("firebase-id-token-abc");
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: {
        user: {
          id: "u-1",
          name: "Asha Verma",
          role: "PATIENT",
          phone: "9876543210",
        },
      },
      error: null,
    });
    typeOtp("123456");
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-verify"));
    });

    await waitFor(() => {
      expect(verifyOtpMock).toHaveBeenCalledWith("123456");
    });
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith(
        "/patient-auth/firebase-verify",
        { idToken: "firebase-id-token-abc" },
      );
    });
    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/patient/dashboard");
    });
  });

  it("surfaces a server-side firebase-verify failure inline and does NOT redirect", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep();

    verifyOtpMock.mockResolvedValueOnce("firebase-id-token");
    apiPostMock.mockResolvedValueOnce({
      success: false,
      data: null,
      error: "Couldn't sign you in. Please try again.",
    });
    typeOtp("123456");
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-verify"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
        /couldn't sign you in/i,
      );
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("surfaces a thrown verifyOtp error inline (e.g. wrong code from Firebase) and does NOT redirect", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep();

    verifyOtpMock.mockRejectedValueOnce(
      new Error("That code didn't match — please try again."),
    );
    typeOtp("123456");
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-verify"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
        /didn't match/i,
      );
    });
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("'Change number' returns to step 1 and clears the OTP + error banners", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep();

    // Trigger a client-side error so we can verify it gets cleared.
    typeOtp("12");
    fireEvent.click(screen.getByTestId("patient-login-verify"));
    expect(screen.getByTestId("patient-login-error")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("patient-login-back"));

    expect(
      screen.getByTestId("patient-login-phone-input"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("patient-login-otp-input"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("patient-login-error"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("patient-login-info"),
    ).not.toBeInTheDocument();
  });

  it("'Resend code' re-fires sendOtp against the SAME normalised E.164 and stays on step 2", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep("+919876543210");
    sendOtpMock.mockClear();
    resetPhoneAuthStateMock.mockClear();

    sendOtpMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-resend"));
    });

    await waitFor(() => {
      expect(sendOtpMock).toHaveBeenCalledTimes(1);
    });
    expect(sendOtpMock).toHaveBeenCalledWith("+919876543210");
    // resend() resets any stale ConfirmationResult before re-minting.
    expect(resetPhoneAuthStateMock).toHaveBeenCalled();
    expect(
      screen.getByTestId("patient-login-otp-input"),
    ).toBeInTheDocument();
  });

  it("disables the send-code button while sendOtp is in flight (busy state)", async () => {
    let resolveSend: ((v: unknown) => void) | undefined;
    sendOtpMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    render(<PatientLoginPage />);
    typePhone("+919876543210");
    const button = screen.getByTestId(
      "patient-login-send-code",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });

    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/sending/i);

    await act(async () => {
      resolveSend?.(undefined);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("patient-login-otp-input"),
      ).toBeInTheDocument();
    });
  });
});
