/* eslint-disable @typescript-eslint/no-explicit-any */
// Component tests for the mandatory-TOTP enrolment-at-login page
// — Pearl §8.2.
//
// Covers:
//   - Missing sessionStorage token → "session timed out" empty state,
//     no fetch.
//   - Token present + setup fetch resolves → QR + secret + backup
//     codes render; Verify button disabled until 6 digits typed.
//   - Setup fetch fails (expired token) → friendly message surfaced.
//   - Successful verify → flips the success flag in sessionStorage
//     and routes back to /login.
//   - Wrong code → page returns to ready state with server message.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { routerPush } = vi.hoisted(() => ({
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
}));

import EnrolTotpPage from "../page";

const STORAGE_KEY = "medcore_enrol_totp";
const DONE_KEY = "medcore_enrol_done";

const SETUP_OK = {
  success: true,
  data: {
    secret: "JBSWY3DPEHPK3PXP",
    otpauthUri: "otpauth://totp/MedCore:a@b.com?secret=JBSWY3DPEHPK3PXP&issuer=MedCore",
    // 1x1 transparent PNG data URL — sufficient for the <img> tag.
    qrDataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==",
    backupCodes: ["abc123", "def456", "ghi789", "jkl012"],
    email: "alice@medcore.local",
  },
  error: null,
};

function mockFetchOnce(response: {
  ok: boolean;
  status: number;
  body: unknown;
}) {
  (global.fetch as any).mockResolvedValueOnce({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  });
}

function seedSession(meta: {
  token?: string;
  role?: string;
  email?: string | null;
}) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
}

describe("/auth/enrol-totp — Pearl §8.2 mandatory TOTP enrolment", () => {
  beforeEach(() => {
    routerPush.mockReset();
    sessionStorage.clear();
    (global.fetch as any) = vi.fn();
  });

  it("shows the empty 'session timed out' state when sessionStorage has no token", async () => {
    render(<EnrolTotpPage />);
    expect(
      await screen.findByText(/sign-in session timed out/i),
    ).toBeInTheDocument();
    // No fetch should fire — there's no enrolToken to send.
    expect((global.fetch as any)).not.toHaveBeenCalled();
  });

  it("loads the QR + secret + backup codes after a successful setup fetch", async () => {
    seedSession({
      token: "enrol-abc-123",
      role: "SUPER_ADMIN",
      email: "alice@medcore.local",
    });
    mockFetchOnce({ ok: true, status: 200, body: SETUP_OK });

    render(<EnrolTotpPage />);

    // Wait for the QR step to render.
    await waitFor(() =>
      expect(screen.getByAltText(/QR code/i)).toBeInTheDocument(),
    );
    // Secret is shown verbatim so it can be typed by hand.
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    // All 4 backup codes are rendered.
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(screen.getByText("def456")).toBeInTheDocument();
    expect(screen.getByText("ghi789")).toBeInTheDocument();
    expect(screen.getByText("jkl012")).toBeInTheDocument();
    // Role-aware copy.
    expect(
      screen.getByText(/required for every super-admin/i),
    ).toBeInTheDocument();
    // Account email shown for confirmation.
    expect(screen.getByText(/alice@medcore\.local/)).toBeInTheDocument();

    // Verify button is disabled until 6 digits typed.
    const verifyBtn = screen.getByTestId("enrol-totp-verify");
    expect(verifyBtn).toBeDisabled();

    const input = screen.getByTestId("enrol-totp-code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "123456" } });
    expect(verifyBtn).not.toBeDisabled();
  });

  it("surfaces the expired-token message when the setup fetch returns 401", async () => {
    seedSession({ token: "expired", role: "SUPER_ADMIN", email: null });
    mockFetchOnce({
      ok: false,
      status: 401,
      body: {
        success: false,
        data: null,
        error:
          "This enrolment link has expired. Please sign in again to get a fresh one.",
      },
    });

    render(<EnrolTotpPage />);

    expect(
      await screen.findByText(/enrolment link has expired/i),
    ).toBeInTheDocument();
    // No QR rendered.
    expect(screen.queryByAltText(/QR code/i)).not.toBeInTheDocument();
  });

  it("on successful verify, flips sessionStorage flag and routes to /login", async () => {
    seedSession({
      token: "enrol-abc-123",
      role: "ADMIN",
      email: "ops@hospital.local",
    });
    mockFetchOnce({ ok: true, status: 200, body: SETUP_OK });

    render(<EnrolTotpPage />);
    const input = (await screen.findByTestId(
      "enrol-totp-code",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "987654" } });

    mockFetchOnce({
      ok: true,
      status: 200,
      body: { success: true, data: { enabled: true }, error: null },
    });

    fireEvent.click(screen.getByTestId("enrol-totp-verify"));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/login"));
    // The enrolToken cache is dropped.
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    // The success banner gets dropped for /login to pick up.
    expect(sessionStorage.getItem(DONE_KEY)).toMatch(/two-factor/i);
  });

  it("surfaces the server error and stays on the page when verify rejects the code", async () => {
    seedSession({ token: "enrol-abc-123", role: "SUPER_ADMIN", email: null });
    mockFetchOnce({ ok: true, status: 200, body: SETUP_OK });

    render(<EnrolTotpPage />);
    const input = (await screen.findByTestId(
      "enrol-totp-code",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "111111" } });

    mockFetchOnce({
      ok: false,
      status: 400,
      body: {
        success: false,
        data: null,
        error: "That code didn't match. Please sign in again and retry.",
      },
    });

    fireEvent.click(screen.getByTestId("enrol-totp-verify"));

    expect(
      await screen.findByText(/code didn't match/i),
    ).toBeInTheDocument();
    // Stayed on /auth/enrol-totp — no router push.
    expect(routerPush).not.toHaveBeenCalled();
    // Cache untouched.
    expect(sessionStorage.getItem(DONE_KEY)).toBeNull();
  });
});
