// Smoke tests for the patient self-register page (Pearl §6.3 — closes audit
// over-claim #2, PEARL_STAGE1_VERIFICATION_AUDIT_2026-05-25 row 32).
//
// Contract under test:
//   • Step 1 renders the basics inputs (name + phone + email + password).
//   • Continue from step 1 with valid values advances to step 2 WITHOUT
//     calling the API (no OTP infra wired for register today — single
//     /auth/register call at the end of step 2).
//   • Submitting step 2 with valid values POSTs /auth/register and redirects
//     to /patient/dashboard.
//   • API error surfaces inline at patient-register-error.
//
// Mock layer mirrors the patient/book/__tests__/page.test.tsx pattern:
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

import PatientRegisterPage from "../page";

function fillBasics(): void {
  fireEvent.change(screen.getByTestId("patient-register-name-input"), {
    target: { value: "Asha Verma" },
  });
  fireEvent.change(screen.getByTestId("patient-register-phone-input"), {
    target: { value: "+919876543210" },
  });
  fireEvent.change(screen.getByTestId("patient-register-email-input"), {
    target: { value: "asha.verma@example.com" },
  });
  fireEvent.change(screen.getByTestId("patient-register-password-input"), {
    target: { value: "Sup3rSecret-Pass" },
  });
  fireEvent.change(
    screen.getByTestId("patient-register-confirm-password-input"),
    { target: { value: "Sup3rSecret-Pass" } },
  );
}

function fillDetails(): void {
  fireEvent.change(screen.getByTestId("patient-register-dob-input"), {
    target: { value: "1992-04-17" },
  });
  fireEvent.change(screen.getByTestId("patient-register-gender-input"), {
    target: { value: "FEMALE" },
  });
  fireEvent.change(screen.getByTestId("patient-register-address-input"), {
    target: { value: "12 MG Road, Bengaluru 560001" },
  });
  fireEvent.change(
    screen.getByTestId("patient-register-emergency-name-input"),
    { target: { value: "Ravi Verma" } },
  );
  fireEvent.change(
    screen.getByTestId("patient-register-emergency-phone-input"),
    { target: { value: "+919812345678" } },
  );
  fireEvent.change(
    screen.getByTestId("patient-register-emergency-rel-input"),
    { target: { value: "spouse" } },
  );
  fireEvent.click(screen.getByTestId("patient-register-terms-input"));
}

describe("Patient self-register page — Pearl §6.3 audit fix", () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    routerPushMock.mockReset();
  });

  it("renders step 1 with name + phone inputs and a sign-in link", () => {
    render(<PatientRegisterPage />);
    expect(
      screen.getByRole("heading", { name: /create account/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("patient-register-name-input"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("patient-register-phone-input"),
    ).toBeInTheDocument();
    const loginLink = screen.getByTestId("patient-register-login-link");
    expect(loginLink).toHaveAttribute("href", "/patient/login");
  });

  it("advances from step 1 to step 2 after the availability check passes", async () => {
    // Continue runs a /auth/check-availability probe (email/phone not taken)
    // before advancing.
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: { emailTaken: false, phoneTaken: false },
      error: null,
    });

    render(<PatientRegisterPage />);
    fillBasics();
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-register-next"));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("patient-register-dob-input"),
      ).toBeInTheDocument();
    });
    expect(apiPostMock).toHaveBeenCalledWith(
      "/auth/check-availability",
      expect.objectContaining({ email: expect.any(String) }),
    );
  });

  it("blocks advancing when the email is already registered", async () => {
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: { emailTaken: true, phoneTaken: false },
      error: null,
    });

    render(<PatientRegisterPage />);
    fillBasics();
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-register-next"));
    });

    // Stays on step 1 (no DOB input) and shows the taken-email error.
    await waitFor(() => {
      expect(
        screen.queryByTestId("patient-register-dob-input"),
      ).not.toBeInTheDocument();
    });
  });

  it("submitting step 2 POSTs /auth/register with the full payload and redirects to /patient/dashboard", async () => {
    // 1st POST = /auth/check-availability (Continue), 2nd = /auth/register.
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: { emailTaken: false, phoneTaken: false },
      error: null,
    });
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: { user: { id: "u1", name: "Asha Verma", role: "PATIENT" } },
      error: null,
    });

    render(<PatientRegisterPage />);
    fillBasics();
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-register-next"));
    });
    fillDetails();

    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-register-submit"));
    });

    // Find the /auth/register call (not the availability probe).
    const registerCall = apiPostMock.mock.calls.find(
      (c) => c[0] === "/auth/register",
    );
    expect(registerCall).toBeTruthy();
    const [endpoint, body] = registerCall!;
    expect(endpoint).toBe("/auth/register");
    expect(body).toMatchObject({
      name: "Asha Verma",
      email: "asha.verma@example.com",
      phone: "+919876543210",
      gender: "FEMALE",
      dateOfBirth: "1992-04-17",
      address: "12 MG Road, Bengaluru 560001",
      emergencyContact: {
        name: "Ravi Verma",
        phone: "+919812345678",
        relationship: "spouse",
      },
      acceptedTerms: true,
      role: "PATIENT",
    });
    expect(routerPushMock).toHaveBeenCalledWith("/patient/dashboard");
  });

  it("surfaces an API error inline at patient-register-error and does not redirect", async () => {
    // 1st POST = availability probe (passes), 2nd = register (rejects).
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: { emailTaken: false, phoneTaken: false },
      error: null,
    });
    apiPostMock.mockRejectedValueOnce(
      Object.assign(new Error("Email already registered"), { status: 409 }),
    );

    render(<PatientRegisterPage />);
    fillBasics();
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-register-next"));
    });
    fillDetails();

    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-register-submit"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("patient-register-error")).toHaveTextContent(
        /email already registered/i,
      );
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("blocks step 2 submit when T&C consent is not ticked", async () => {
    // Availability probe passes so Continue advances to step 2.
    apiPostMock.mockResolvedValueOnce({
      success: true,
      data: { emailTaken: false, phoneTaken: false },
      error: null,
    });
    render(<PatientRegisterPage />);
    fillBasics();
    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-register-next"));
    });
    // Fill details EXCEPT the terms checkbox.
    fireEvent.change(screen.getByTestId("patient-register-dob-input"), {
      target: { value: "1992-04-17" },
    });
    fireEvent.change(screen.getByTestId("patient-register-gender-input"), {
      target: { value: "MALE" },
    });
    fireEvent.change(screen.getByTestId("patient-register-address-input"), {
      target: { value: "12 MG Road, Bengaluru 560001" },
    });
    fireEvent.change(
      screen.getByTestId("patient-register-emergency-name-input"),
      { target: { value: "Ravi Verma" } },
    );
    fireEvent.change(
      screen.getByTestId("patient-register-emergency-phone-input"),
      { target: { value: "+919812345678" } },
    );
    fireEvent.change(
      screen.getByTestId("patient-register-emergency-rel-input"),
      { target: { value: "brother" } },
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("patient-register-submit"));
    });

    // Availability probe fired (Continue), but /auth/register must NOT.
    expect(
      apiPostMock.mock.calls.some((c) => c[0] === "/auth/register"),
    ).toBe(false);
    expect(
      screen.getByTestId("patient-register-field-error-terms"),
    ).toHaveTextContent(/terms/i);
  });
});
