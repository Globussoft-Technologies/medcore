// Behaviour coverage for the patient phone-OTP login page
// (`apps/web/src/app/patient/login/page.tsx`, Pearl §5.3 / §6.1 — gap #5 piece 2).
//
// Pins the two-step flow:
//   1. Step 1 (phone): client-side regex validation, `/patient-auth/otp-request`
//      POST with trimmed phone, success → step 2 + info banner, server error →
//      inline error at `patient-login-error`, thrown error → fallback message.
//   2. Step 2 (otp): client-side 6-digit validation, `/patient-auth/otp-verify`
//      POST with phone + otp, success → `router.push("/patient")`, server error
//      → inline error, "Change number" returns to step 1 + clears OTP/error,
//      "Resend code" re-fires the otp-request POST.
//   3. Misc: register CTA href, busy-state disables interactive controls during
//      the in-flight request.
//
// Mock layer mirrors the patient/register/__tests__/page.test.tsx pattern:
// vi.hoisted api mock + next/navigation router mock.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";

const { apiPostMock, routerPushMock } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  routerPushMock: vi.fn(),
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
  apiPostMock.mockResolvedValueOnce({
    success: true,
    data: { sent: true },
    error: null,
  });
  typePhone(phone);
  await act(async () => {
    fireEvent.click(screen.getByTestId("patient-login-send-code"));
  });
  await waitFor(() => {
    expect(screen.getByTestId("patient-login-otp-input")).toBeInTheDocument();
  });
}

describe("PatientLoginPage — phone-OTP two-step flow", () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    routerPushMock.mockReset();
  });

  it("renders step 1 with the phone input and a register CTA link", () => {
    render(<PatientLoginPage />);
    expect(
      screen.getByRole("heading", { name: /sign in/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("patient-login-phone-input"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("patient-login-send-code"),
    ).toBeInTheDocument();
    const registerLink = screen.getByTestId("patient-login-register-link");
    expect(registerLink).toHaveAttribute("href", "/patient/register");
    // No OTP input yet — flow starts at step 1.
    expect(
      screen.queryByTestId("patient-login-otp-input"),
    ).not.toBeInTheDocument();
  });

  it("rejects an invalid phone number client-side without calling the API", () => {
    render(<PatientLoginPage />);
    typePhone("123"); // Too short — regex requires 10-15 digits.
    fireEvent.click(screen.getByTestId("patient-login-send-code"));
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
      /valid phone number/i,
    );
  });

  it("POSTs trimmed phone to /patient-auth/otp-request on send-code and advances to step 2", async () => {
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: { sent: true },
      error: null,
    });

    render(<PatientLoginPage />);
    typePhone("  +919876543210  "); // Whitespace must be trimmed before POST.
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-send-code"));
    });

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledTimes(1);
    });
    const [endpoint, body] = apiPostMock.mock.calls[0];
    expect(endpoint).toBe("/patient-auth/otp-request");
    expect(body).toEqual({ phone: "+919876543210" });

    // Step 2 specific elements now in the DOM.
    expect(
      screen.getByTestId("patient-login-otp-input"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("patient-login-info")).toHaveTextContent(
      /6-digit code/i,
    );
  });

  it("surfaces a server-side otp-request failure inline and does NOT advance to step 2", async () => {
    apiPostMock.mockResolvedValueOnce({
      success: false,
      data: null,
      error: "Too many requests — please wait 10 minutes.",
    });

    render(<PatientLoginPage />);
    typePhone("+919876543210");
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-send-code"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
        /too many requests/i,
      );
    });
    // Stayed on step 1 — OTP input must NOT be in the DOM.
    expect(
      screen.queryByTestId("patient-login-otp-input"),
    ).not.toBeInTheDocument();
  });

  it("surfaces a thrown network error inline using the error's message", async () => {
    apiPostMock.mockRejectedValueOnce(new Error("Network offline"));

    render(<PatientLoginPage />);
    typePhone("+919876543210");
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-send-code"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
        /network offline/i,
      );
    });
    expect(
      screen.queryByTestId("patient-login-otp-input"),
    ).not.toBeInTheDocument();
  });

  it("rejects an OTP that is not exactly 6 digits client-side without calling the API", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep();
    apiPostMock.mockClear();

    typeOtp("12345"); // Only 5 digits.
    fireEvent.click(screen.getByTestId("patient-login-verify"));

    expect(apiPostMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
      /6-digit code/i,
    );
  });

  it("strips non-numeric characters from OTP input as the user types", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep();
    typeOtp("12a3b4c5d6");
    const input = screen.getByTestId(
      "patient-login-otp-input",
    ) as HTMLInputElement;
    // The page's onChange does value.replace(/\D/g, "") — only digits survive.
    expect(input.value).toBe("123456");
  });

  it("POSTs phone + otp to /patient-auth/otp-verify and router.push('/patient') on success", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep("+919876543210");

    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: {
        user: { id: "u-1", name: "Asha Verma", role: "PATIENT" },
        accessToken: "jwt-token",
      },
      error: null,
    });
    typeOtp("123456");
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-verify"));
    });

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/patient");
    });
    // Verify call shape: second POST is the verify, first was the request.
    const verifyCall = apiPostMock.mock.calls[apiPostMock.mock.calls.length - 1];
    expect(verifyCall[0]).toBe("/patient-auth/otp-verify");
    expect(verifyCall[1]).toEqual({ phone: "+919876543210", otp: "123456" });
  });

  it("surfaces an invalid-OTP server response inline and does NOT redirect", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep();

    apiPostMock.mockResolvedValueOnce({
      success: false,
      data: null,
      error: "Invalid or expired code",
    });
    typeOtp("123456");
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-verify"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
        /invalid or expired code/i,
      );
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("surfaces a thrown verify-step error inline and does NOT redirect", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep();

    apiPostMock.mockRejectedValueOnce(new Error("Verification API down"));
    typeOtp("123456");
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-verify"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("patient-login-error")).toHaveTextContent(
        /verification api down/i,
      );
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("'Change number' returns to step 1 and clears the OTP + error/info banners", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep();

    // Type partial OTP + trigger a client-side error so we can verify clear.
    typeOtp("12");
    fireEvent.click(screen.getByTestId("patient-login-verify"));
    expect(screen.getByTestId("patient-login-error")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("patient-login-back"));

    // Back on step 1 — phone input visible, OTP gone, banners cleared.
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

  it("'Resend code' re-fires the otp-request POST against the same phone", async () => {
    render(<PatientLoginPage />);
    await advanceToOtpStep("+919876543210");
    apiPostMock.mockClear();

    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: { sent: true },
      error: null,
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-login-resend"));
    });

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledTimes(1);
    });
    expect(apiPostMock.mock.calls[0][0]).toBe("/patient-auth/otp-request");
    expect(apiPostMock.mock.calls[0][1]).toEqual({ phone: "+919876543210" });
    // Still on step 2 — OTP input remains visible.
    expect(
      screen.getByTestId("patient-login-otp-input"),
    ).toBeInTheDocument();
  });

  it("disables the send-code button while a request is in flight (busy state)", async () => {
    let resolveSend: ((v: unknown) => void) | undefined;
    apiPostMock.mockReturnValueOnce(
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

    // Mid-flight: button disabled + label flipped to "Sending…".
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/sending/i);

    await act(async () => {
      resolveSend?.({ success: true, data: { sent: true }, error: null });
      await Promise.resolve();
    });

    // Settled: advanced to step 2.
    await waitFor(() => {
      expect(
        screen.getByTestId("patient-login-otp-input"),
      ).toBeInTheDocument();
    });
  });
});
