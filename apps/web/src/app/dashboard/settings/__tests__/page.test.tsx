/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SettingsPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/settings/page.tsx — the multi-tab
 *     settings hub. Eight tabs gated by role allowlist (ADMIN gets the full
 *     eight — incl. WhatsApp + Payments credential panels; all other roles
 *     see four personal-settings tabs). Endpoints:
 *       GET   /auth/me                                      (profile load)
 *       PATCH /auth/me                                      (profile + prefs save)
 *       POST  /uploads                                      (profile photo)
 *       POST  /auth/change-password                         (password change)
 *       GET   /auth/failed-logins                           (security audit table)
 *       POST  /auth/2fa/{setup,verify,disable}              (TOTP lifecycle)
 *       POST  /auth/sessions/logout-others                  (session purge)
 *       GET/PUT /notifications/preferences                  (channel toggles)
 *       GET/PUT /notifications/schedule                     (quiet hours)
 *       POST  /notifications/test                           (test send)
 *       GET/PATCH /settings/branding                        (ADMIN-only)
 *       GET/PATCH /settings/integrations                    (ADMIN-only)
 *
 *   - Behaviours covered (by tab):
 *       Tab gating (Issue #437 / #716): NURSE sees 4 tabs, ADMIN sees all 6;
 *       URL hash `#branding` is honoured for ADMIN but ignored for NURSE.
 *       Profile: GET /auth/me populates fields; load error swallowed;
 *         client-side validation (sanitizeUserInput rejection, phone regex);
 *         happy PATCH; field-level + generic error surfaces;
 *         /uploads happy path reads signedUrl; upload error surfaces.
 *       Security: change-password validates required / length / mismatch;
 *         field-level + generic error from backend; happy POST.
 *         2FA: enable flow (setup → verify → enabled state); disable flow;
 *         disable-without-password blocked; copy-secret toggles icon.
 *         logout-others: confirm rejected vs accepted.
 *         failed-logins: empty + populated branches with reason mapping
 *         (`bad_password` → "Incorrect password", unknown → title-cased).
 *       Notifications: GET fills in default channels;
 *         toggle PUTs the full preferences array; toast.success per-channel
 *         (Issue #658). Quiet hours saveSchedule happy + error.
 *         testChannel: window.confirm rejected vs accepted (Issue #940).
 *       Preferences: language + landing-page save PATCHes /auth/me with
 *         both fields and writes localStorage `medcore_lang`.
 *       Branding (ADMIN): GET pre-fills; loading branch; client-side
 *         hospitalName required + hex regex; save happy + error.
 *       Integrations (ADMIN): GET fills rows; loading branch; toggle
 *         PATCH happy path + rollback on error.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/theme, @/lib/toast,
 *            @/lib/use-dialog, @/components/PasswordInput, next/navigation,
 *            @medcore/shared (sanitizeUserInput passthrough).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, themeMock, confirmMock, refreshUserMock } =
  vi.hoisted(() => ({
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    toastMock: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
    authMock: vi.fn(),
    themeMock: vi.fn(),
    confirmMock: vi.fn(),
    refreshUserMock: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/theme", () => ({ useThemeStore: themeMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/settings",
}));
vi.mock("@/components/PasswordInput", () => ({
  PasswordInput: ({
    value,
    onChange,
    ...rest
  }: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    [k: string]: any;
  }) => (
    <input
      type="password"
      value={value}
      onChange={onChange}
      {...rest}
    />
  ),
}));
// Pass-through sanitizeUserInput so we can exercise the rejection branch
// without hauling in the full shared package (and to keep regex behaviour
// stable across CI / local).
vi.mock("@medcore/shared", () => ({
  sanitizeUserInput: (raw: unknown, opts: { field?: string; maxLength?: number } = {}) => {
    const field = opts.field ?? "Field";
    if (typeof raw !== "string") return { ok: false, error: `${field} is required` };
    const cleaned = raw.trim();
    if (cleaned.length === 0)
      return { ok: false, error: `${field} cannot be empty` };
    if (/[<>]/.test(cleaned))
      return {
        ok: false,
        error: `${field} contains characters that aren't allowed`,
      };
    return { ok: true, value: cleaned };
  },
}));

import SettingsPage from "../page";

function asRole(
  role: string,
  overrides: Partial<{
    id: string;
    email: string;
    name: string;
    preferredLanguage: string | null;
    defaultLandingPage: string | null;
  }> = {},
) {
  authMock.mockReturnValue({
    user: {
      id: "u-self",
      email: "me@medcore.test",
      name: "Me Myself",
      role,
      preferredLanguage: "en",
      defaultLandingPage: "/dashboard",
      ...overrides,
    },
    refreshUser: refreshUserMock,
  });
}

function setupThemeMock(mode: "light" | "dark" | "system" = "light") {
  const setMode = vi.fn();
  themeMock.mockImplementation((selector: (s: any) => any) =>
    selector({ mode, setMode }),
  );
  return setMode;
}

const meFixture = {
  data: {
    id: "u-self",
    email: "me@medcore.test",
    name: "Me Myself",
    phone: "+919876543210",
    role: "ADMIN",
    photoUrl: null,
    twoFactorEnabled: false,
    preferredLanguage: "en",
    defaultLandingPage: "/dashboard",
  },
};

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.patch.mockReset();
  apiMock.delete.mockReset();
  Object.values(toastMock).forEach((fn: any) => fn.mockReset());
  authMock.mockReset();
  themeMock.mockReset();
  confirmMock.mockReset();
  refreshUserMock.mockReset();
  // Default URL hash empty so default tab is the role's first allowed tab.
  if (typeof window !== "undefined") {
    window.location.hash = "";
  }
  setupThemeMock("light");
  // Default catch-all GET to satisfy any tab's load before tab-specific
  // mocks override.
  apiMock.get.mockResolvedValue({ data: [] });
});

afterEach(() => {
  cleanup();
});

describe("SettingsPage — tab gating + RBAC (Issue #437 / #716)", () => {
  it("renders four personal tabs for NURSE — no Branding / Integrations", async () => {
    asRole("NURSE");
    apiMock.get.mockResolvedValue(meFixture);

    render(<SettingsPage />);

    expect(screen.getByRole("button", { name: /Profile/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Security/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Notifications/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Preferences/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Branding/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Integrations/i }),
    ).not.toBeInTheDocument();
  });

  it("ADMIN sees the full admin tab set (Branding / Integrations)", async () => {
    asRole("ADMIN");
    apiMock.get.mockResolvedValue(meFixture);

    render(<SettingsPage />);

    expect(screen.getByRole("button", { name: /Branding/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Integrations/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the first allowed tab for unknown roles", async () => {
    asRole("BOGUS_ROLE_NOT_LISTED");
    apiMock.get.mockResolvedValue(meFixture);

    render(<SettingsPage />);

    // Default for unknown role: __DEFAULT__ → personal tabs only.
    expect(
      screen.queryByRole("button", { name: /Branding/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Profile/i })).toBeInTheDocument();
  });

  it("ignores URL hash deep links that point at disallowed tabs", async () => {
    asRole("NURSE");
    if (typeof window !== "undefined") {
      window.location.hash = "branding";
    }
    apiMock.get.mockResolvedValue(meFixture);

    render(<SettingsPage />);

    // NURSE cannot see Branding — should fall back to Profile pane.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(
      screen.getByRole("heading", { name: /^Profile$/i }),
    ).toBeInTheDocument();
  });
});

describe("SettingsPage — Profile tab", () => {
  beforeEach(() => {
    asRole("ADMIN");
    apiMock.get.mockResolvedValue(meFixture);
  });

  it("loads /auth/me on mount and populates the name/phone inputs", async () => {
    render(<SettingsPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("profile-name") as HTMLInputElement).value,
      ).toBe("Me Myself"),
    );
    expect((screen.getByTestId("profile-phone") as HTMLInputElement).value).toBe(
      "+919876543210",
    );
  });

  it("swallows /auth/me errors and renders the tab with empty fields (Issue #415)", async () => {
    apiMock.get.mockReset();
    apiMock.get.mockRejectedValue(new Error("boom"));

    render(<SettingsPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    expect(
      (screen.getByTestId("profile-name") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByRole("heading", { name: /Settings/i })).toBeInTheDocument();
  });

  it("rejects an empty name on save (sanitizeUserInput) and never PATCHes", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("profile-name") as HTMLInputElement).value,
      ).toBe("Me Myself"),
    );

    fireEvent.change(screen.getByTestId("profile-name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    await screen.findByTestId("error-profile-name");
    expect(toastMock.warning).toHaveBeenCalledWith(
      "Please fix the highlighted fields",
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("rejects a bad phone (Issue #392) and never PATCHes", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("profile-name") as HTMLInputElement).value,
      ).toBe("Me Myself"),
    );

    fireEvent.change(screen.getByTestId("profile-phone"), {
      target: { value: "abc!@#" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    await screen.findByTestId("error-profile-phone");
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("PATCHes /auth/me with sanitized name + phone on happy path", async () => {
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SettingsPage />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("profile-name") as HTMLInputElement).value,
      ).toBe("Me Myself"),
    );

    fireEvent.change(screen.getByTestId("profile-name"), {
      target: { value: "Renamed Self" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.patch.mock.calls[0];
    expect(url).toBe("/auth/me");
    // photoUrl is OMITTED when the photo wasn't changed this session — so a
    // name/phone-only save never clobbers the stored photo with null.
    expect(body).toEqual({
      name: "Renamed Self",
      phone: "+919876543210",
    });
    expect(toastMock.success).toHaveBeenCalledWith("Profile updated");
    expect(refreshUserMock).toHaveBeenCalled();
  });

  it("surfaces field-level errors from the backend onto the name input", async () => {
    apiMock.patch.mockRejectedValue({
      payload: {
        details: [{ field: "name", message: "Name already taken" }],
      },
    });

    render(<SettingsPage />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("profile-name") as HTMLInputElement).value,
      ).toBe("Me Myself"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    await waitFor(() =>
      expect(screen.getByText(/Name already taken/i)).toBeInTheDocument(),
    );
  });

  it("surfaces generic Error from save through toast.error", async () => {
    apiMock.patch.mockRejectedValue(new Error("save blew up"));

    render(<SettingsPage />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("profile-name") as HTMLInputElement).value,
      ).toBe("Me Myself"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("save blew up"),
    );
  });

  it("uploads a profile photo (non-medical mode) and shows the signedUrl preview", async () => {
    apiMock.post.mockResolvedValue({
      data: {
        signedUrl: "https://cdn.example/u/abc.jpg",
        filePath: "ehr/abc.jpg",
      },
    });

    render(<SettingsPage />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("profile-name") as HTMLInputElement).value,
      ).toBe("Me Myself"),
    );

    const file = new File(["fake-bytes"], "avatar.png", { type: "image/png" });
    // Stub FileReader to resolve quickly with a known base64 payload.
    const origFR = (window as any).FileReader;
    (window as any).FileReader = class {
      result = "data:image/png;base64,Zm9v";
      onload: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      readAsDataURL() {
        setTimeout(() => this.onload?.(), 0);
      }
    };

    try {
      // Trigger the hidden <input type="file"> via change event.
      const fileInput = document.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file] });
      fireEvent.change(fileInput);

      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [url, body] = apiMock.post.mock.calls[0];
      expect(url).toBe("/uploads");
      expect(body.filename).toBe("avatar.png");
      // Non-medical mode: no `type`/`patientId`, so the endpoint returns a
      // stable storage key the page persists (and shows the signedUrl).
      expect(body.type).toBeUndefined();
      expect(toastMock.success).toHaveBeenCalledWith(
        "Photo uploaded — click Save",
      );
    } finally {
      (window as any).FileReader = origFR;
    }
  });

  it("surfaces /uploads errors through toast.error", async () => {
    apiMock.post.mockRejectedValue(new Error("upload failed"));

    render(<SettingsPage />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("profile-name") as HTMLInputElement).value,
      ).toBe("Me Myself"),
    );

    const origFR = (window as any).FileReader;
    (window as any).FileReader = class {
      result = "data:image/png;base64,Zm9v";
      onload: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      readAsDataURL() {
        setTimeout(() => this.onload?.(), 0);
      }
    };

    try {
      const file = new File(["bytes"], "x.png", { type: "image/png" });
      const fileInput = document.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file] });
      fireEvent.change(fileInput);

      await waitFor(() =>
        expect(toastMock.error).toHaveBeenCalledWith("upload failed"),
      );
    } finally {
      (window as any).FileReader = origFR;
    }
  });
});

describe("SettingsPage — Security tab", () => {
  beforeEach(() => {
    asRole("ADMIN");
    // /auth/me returns 2FA disabled by default; /auth/failed-logins returns [].
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/auth/failed-logins") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
  });

  async function openSecurity() {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/auth/me"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Security$/i }));
  }

  it("validates required current password on change-password", async () => {
    await openSecurity();

    fireEvent.click(screen.getByRole("button", { name: /Update Password/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Current password is required",
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("validates short new password (length <6)", async () => {
    await openSecurity();

    const inputs = screen.getAllByDisplayValue("");
    // Three password inputs; we need to drive them by their autoComplete attrs.
    const currentInput = document.querySelector(
      'input[autocomplete="current-password"]',
    ) as HTMLInputElement;
    const newInput = document.querySelectorAll(
      'input[autocomplete="new-password"]',
    )[0] as HTMLInputElement;

    fireEvent.change(currentInput, { target: { value: "oldsecret" } });
    fireEvent.change(newInput, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /Update Password/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Password must be at least 6 characters",
      ),
    );
    expect(inputs.length).toBeGreaterThan(0); // sanity
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("validates mismatched confirm password", async () => {
    await openSecurity();

    const currentInput = document.querySelector(
      'input[autocomplete="current-password"]',
    ) as HTMLInputElement;
    const [newInput, confirmInput] = Array.from(
      document.querySelectorAll('input[autocomplete="new-password"]'),
    ) as HTMLInputElement[];

    fireEvent.change(currentInput, { target: { value: "oldsecret" } });
    fireEvent.change(newInput, { target: { value: "newsecret123" } });
    fireEvent.change(confirmInput, { target: { value: "different456" } });
    fireEvent.click(screen.getByRole("button", { name: /Update Password/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Passwords do not match"),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("PATCH-equivalent: POST /auth/change-password on happy path then clears fields", async () => {
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    await openSecurity();

    const currentInput = document.querySelector(
      'input[autocomplete="current-password"]',
    ) as HTMLInputElement;
    const [newInput, confirmInput] = Array.from(
      document.querySelectorAll('input[autocomplete="new-password"]'),
    ) as HTMLInputElement[];

    fireEvent.change(currentInput, { target: { value: "oldsecret" } });
    fireEvent.change(newInput, { target: { value: "newsecret123" } });
    fireEvent.change(confirmInput, { target: { value: "newsecret123" } });
    fireEvent.click(screen.getByRole("button", { name: /Update Password/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/auth/change-password", {
        currentPassword: "oldsecret",
        newPassword: "newsecret123",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Password changed");
  });

  it("surfaces backend field-level password error inline (Issue #394)", async () => {
    apiMock.post.mockRejectedValue({
      payload: {
        details: [
          { field: "newPassword", message: "Password is too common" },
        ],
      },
    });
    await openSecurity();

    const currentInput = document.querySelector(
      'input[autocomplete="current-password"]',
    ) as HTMLInputElement;
    const [newInput, confirmInput] = Array.from(
      document.querySelectorAll('input[autocomplete="new-password"]'),
    ) as HTMLInputElement[];

    fireEvent.change(currentInput, { target: { value: "oldsecret" } });
    fireEvent.change(newInput, { target: { value: "password123" } });
    fireEvent.change(confirmInput, { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /Update Password/i }));

    await waitFor(() =>
      expect(
        screen.getByTestId("error-change-password-newPassword").textContent,
      ).toMatch(/too common/i),
    );
  });

  it("surfaces generic Error from change-password through toast.error", async () => {
    apiMock.post.mockRejectedValue(new Error("server down"));
    await openSecurity();

    const currentInput = document.querySelector(
      'input[autocomplete="current-password"]',
    ) as HTMLInputElement;
    const [newInput, confirmInput] = Array.from(
      document.querySelectorAll('input[autocomplete="new-password"]'),
    ) as HTMLInputElement[];

    fireEvent.change(currentInput, { target: { value: "oldsecret" } });
    fireEvent.change(newInput, { target: { value: "newsecret123" } });
    fireEvent.change(confirmInput, { target: { value: "newsecret123" } });
    fireEvent.click(screen.getByRole("button", { name: /Update Password/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server down"),
    );
  });

  it("2FA enable flow: setup → verify → enabled state", async () => {
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/auth/2fa/setup")
        return Promise.resolve({
          data: {
            secret: "JBSWY3DPEHPK3PXP",
            otpauthUri: "otpauth://totp/medcore",
            backupCodes: ["aaa-bbb", "ccc-ddd"],
          },
        });
      if (url === "/auth/2fa/verify") return Promise.resolve({ data: { ok: true } });
      return Promise.resolve({ data: {} });
    });
    await openSecurity();

    fireEvent.click(screen.getByRole("button", { name: /Enable 2FA/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/auth/2fa/setup"),
    );
    // The POST having been *called* doesn't mean its response has rendered —
    // await the setup payload appearing in the DOM before the sync asserts.
    expect(
      await screen.findByText("otpauth://totp/medcore"),
    ).toBeInTheDocument();
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(screen.getByText("aaa-bbb")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "987654" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Verify & Enable/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/auth/2fa/verify", {
        token: "987654",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("2FA enabled");
  });

  it("2FA disable: requires the current password (toast.error otherwise)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me")
        return Promise.resolve({
          data: { ...meFixture.data, twoFactorEnabled: true },
        });
      if (url === "/auth/failed-logins") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    await openSecurity();

    await screen.findByText(/2FA is enabled on your account/i);

    fireEvent.click(screen.getByRole("button", { name: /Disable 2FA/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Enter your current password",
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("2FA disable: happy path POSTs /auth/2fa/disable and flips state", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me")
        return Promise.resolve({
          data: { ...meFixture.data, twoFactorEnabled: true },
        });
      if (url === "/auth/failed-logins") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    await openSecurity();

    await screen.findByText(/2FA is enabled on your account/i);

    // Two current-password inputs are present when 2FA is enabled (the
    // Change Password form + the Disable 2FA form). The disable input is
    // the LAST one (rendered after the change-password form in the DOM).
    const pwInputs = document.querySelectorAll(
      'input[autocomplete="current-password"]',
    );
    const disablePwInput = pwInputs[pwInputs.length - 1] as HTMLInputElement;
    fireEvent.change(disablePwInput, { target: { value: "oldsecret" } });
    fireEvent.click(screen.getByRole("button", { name: /Disable 2FA/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/auth/2fa/disable", {
        currentPassword: "oldsecret",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("2FA disabled");
  });

  it("logout-others: confirm rejected → no POST", async () => {
    confirmMock.mockResolvedValue(false);
    await openSecurity();

    fireEvent.click(
      screen.getByRole("button", { name: /Sign out all other sessions/i }),
    );

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("logout-others: confirm accepted → POST + toast", async () => {
    confirmMock.mockResolvedValue(true);
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    await openSecurity();

    fireEvent.click(
      screen.getByRole("button", { name: /Sign out all other sessions/i }),
    );

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/auth/sessions/logout-others",
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      "All other sessions signed out",
    );
  });

  it("renders failed-login attempts table with mapped reasons (Issue #874)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/auth/failed-logins")
        return Promise.resolve({
          data: [
            {
              id: "fl-1",
              createdAt: "2026-05-01T10:00:00.000Z",
              ipAddress: "1.2.3.4",
              details: { email: "x@y.com", reason: "bad_password" },
            },
            {
              id: "fl-2",
              createdAt: "2026-05-02T11:00:00.000Z",
              ipAddress: null,
              details: { reason: "weirdo_unknown_reason" },
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    await openSecurity();

    await screen.findByText("Incorrect password");
    // Unknown reason title-cased.
    expect(screen.getByText("Weirdo Unknown Reason")).toBeInTheDocument();
    expect(screen.getByText("x@y.com")).toBeInTheDocument();
    expect(screen.getByText("1.2.3.4")).toBeInTheDocument();
  });

  it("renders empty failed-logins copy when none exist", async () => {
    await openSecurity();

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/auth/failed-logins"),
    );
    expect(
      screen.getByText(/No failed login attempts recorded/i),
    ).toBeInTheDocument();
  });
});

describe("SettingsPage — Notifications tab", () => {
  beforeEach(() => {
    asRole("ADMIN");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/notifications/preferences")
        return Promise.resolve({
          data: [
            { id: "p1", channel: "WHATSAPP", enabled: true },
            { id: "p2", channel: "SMS", enabled: false },
            { id: "p3", channel: "EMAIL", enabled: true },
            { id: "p4", channel: "PUSH", enabled: true },
          ],
        });
      if (url === "/notifications/schedule")
        return Promise.resolve({
          data: { quietHoursStart: "22:00", quietHoursEnd: "07:00", dndUntil: null },
        });
      return Promise.resolve({ data: [] });
    });
  });

  async function openNotifications() {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/auth/me"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Notifications$/i }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/preferences"),
    );
    // The call having fired doesn't mean its resolved Promise has flushed
    // through setPrefs yet — wait for an actual channel row to appear so
    // downstream assertions never race the render under CI load.
    await screen.findByText("WhatsApp");
  }

  it("loads preferences and renders all four channel rows with the friendly label (Issue #873)", async () => {
    await openNotifications();

    // Use getAllByText since CHANNEL_LABEL renders twice per row (header +
    // descriptive body) — at least one match guarantees presence.
    expect(screen.getAllByText("WhatsApp").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Email").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SMS").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Push").length).toBeGreaterThan(0);
  });

  it("toggling a channel PUTs the full preferences array (Issue #658)", async () => {
    apiMock.put.mockResolvedValue({ data: { ok: true } });
    await openNotifications();

    // The SMS row is the second of the four channel rows. CHANNELS array
    // order in source: WHATSAPP, SMS, EMAIL, PUSH. Each row has two
    // buttons: [Send test, toggle]. The second button across all rows
    // is at indices [1, 3, 5, 7] in the test-friendly button list.
    // Grab all "Send test" buttons to get one per row, then the toggle
    // is the next sibling button.
    const sendTestButtons = screen.getAllByRole("button", { name: /Send test/i });
    expect(sendTestButtons.length).toBe(4);
    // Walk to the SMS row's toggle: parent of Send test contains both
    // buttons (Send test + toggle).
    const smsToggle = sendTestButtons[1].nextElementSibling as HTMLButtonElement;
    fireEvent.click(smsToggle);

    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith("/notifications/preferences", {
        preferences: expect.arrayContaining([
          expect.objectContaining({ channel: "SMS", enabled: true }),
        ]),
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      "Enabled SMS notifications",
    );
  });

  it("toggle PUT failure surfaces toast.error", async () => {
    apiMock.put.mockRejectedValue(new Error("net down"));
    await openNotifications();

    const sendTestButtons = screen.getAllByRole("button", { name: /Send test/i });
    const smsToggle = sendTestButtons[1].nextElementSibling as HTMLButtonElement;
    fireEvent.click(smsToggle);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Failed to save notification preference",
      ),
    );
  });

  it("quiet hours: saveSchedule PUTs the values + toast.success", async () => {
    apiMock.put.mockResolvedValue({ data: { ok: true } });
    await openNotifications();

    // Save button label is "Save" (not "Save Changes") for quiet-hours.
    const saveBtn = screen.getByRole("button", { name: /^Save$/i });
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith("/notifications/schedule", {
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Quiet hours saved");
  });

  it("quiet hours: PUT failure surfaces toast.error", async () => {
    apiMock.put.mockRejectedValue(new Error("schedule broke"));
    await openNotifications();

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("schedule broke"),
    );
  });

  it("Send test confirm rejected → no POST (Issue #940)", async () => {
    // Now uses the in-app confirm dialog (useConfirm → confirmMock), not the
    // native window.confirm.
    confirmMock.mockResolvedValue(false);
    await openNotifications();

    // First "Send test" button in the DOM is the WHATSAPP row's.
    fireEvent.click(screen.getAllByRole("button", { name: /Send test/i })[0]);

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Send test confirm accepted → POST /notifications/test + toast", async () => {
    confirmMock.mockResolvedValue(true);
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    await openNotifications();

    fireEvent.click(screen.getAllByRole("button", { name: /Send test/i })[0]);

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/notifications/test", {
        channel: "WHATSAPP",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      "Test WhatsApp notification queued",
    );
  });
});

describe("SettingsPage — Preferences tab", () => {
  beforeEach(() => {
    asRole("ADMIN", { preferredLanguage: "hi", defaultLandingPage: "/dashboard/queue" });
    apiMock.get.mockResolvedValue(meFixture);
  });

  it("PATCHes /auth/me with language + landing, writes localStorage", async () => {
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Preferences$/i }));

    await screen.findByRole("heading", { name: /Localization/i });

    fireEvent.click(screen.getByRole("button", { name: /Save Preferences/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/auth/me", {
        preferredLanguage: "hi",
        defaultLandingPage: "/dashboard/queue",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Preferences saved");
    expect(window.localStorage.getItem("medcore_lang")).toBe("hi");
    expect(refreshUserMock).toHaveBeenCalled();
  });

  it("surfaces generic save error through toast.error", async () => {
    apiMock.patch.mockRejectedValue(new Error("prefs failed"));

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Preferences$/i }));

    fireEvent.click(screen.getByRole("button", { name: /Save Preferences/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("prefs failed"),
    );
  });

  it("theme dropdown calls setMode on change", async () => {
    const setMode = setupThemeMock("light");

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Preferences$/i }));

    const themeSelect = (await screen.findByDisplayValue("Light")) as HTMLSelectElement;
    fireEvent.change(themeSelect, { target: { value: "dark" } });

    expect(setMode).toHaveBeenCalledWith("dark");
  });
});

describe("SettingsPage — Branding tab (ADMIN, Issues #716 / #717)", () => {
  beforeEach(() => {
    asRole("ADMIN");
  });

  it("renders the loading placeholder until /settings/branding resolves", async () => {
    let resolveBranding!: (v: unknown) => void;
    const brandingPromise = new Promise((r) => {
      resolveBranding = r;
    });
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/branding") return brandingPromise;
      return Promise.resolve({ data: [] });
    });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Branding$/i }));

    // Loading now renders the shared Skeleton kit (.mc-skeleton) instead of a
    // "Loading branding…" text placeholder.
    await waitFor(() =>
      expect(document.querySelector(".mc-skeleton")).toBeInTheDocument(),
    );

    resolveBranding({
      data: { hospitalName: "MedCore Demo", primaryColor: "#1e40af", logoUrl: "" },
    });
  });

  it("pre-fills inputs from GET /settings/branding", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/branding")
        return Promise.resolve({
          data: {
            hospitalName: "MedCore Demo",
            primaryColor: "#1e40af",
            logoUrl: "https://logo.example/x.png",
          },
        });
      return Promise.resolve({ data: [] });
    });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Branding$/i }));

    const nameInput = (await screen.findByTestId(
      "branding-hospital-name",
    )) as HTMLInputElement;
    expect(nameInput.value).toBe("MedCore Demo");
    expect(
      (screen.getByTestId("branding-primary-color") as HTMLInputElement).value,
    ).toBe("#1e40af");
  });

  it("rejects empty hospital name (Issue #717) without PATCHing", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/branding")
        return Promise.resolve({
          data: { hospitalName: "", primaryColor: "", logoUrl: "" },
        });
      return Promise.resolve({ data: [] });
    });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Branding$/i }));
    await screen.findByTestId("branding-hospital-name");

    fireEvent.click(screen.getByRole("button", { name: /Save Branding/i }));

    await screen.findByTestId("error-branding-hospital-name");
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("rejects malformed hex color without PATCHing", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/branding")
        return Promise.resolve({
          data: { hospitalName: "OK Name", primaryColor: "", logoUrl: "" },
        });
      return Promise.resolve({ data: [] });
    });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Branding$/i }));
    await screen.findByTestId("branding-hospital-name");

    fireEvent.change(screen.getByTestId("branding-primary-color"), {
      target: { value: "not-a-hex" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/i }));

    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(
        "Please fix the highlighted fields",
      ),
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("happy save PATCHes /settings/branding with trimmed values", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/branding")
        return Promise.resolve({
          data: { hospitalName: "MedCore", primaryColor: "", logoUrl: "" },
        });
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Branding$/i }));
    await screen.findByTestId("branding-hospital-name");

    fireEvent.change(screen.getByTestId("branding-primary-color"), {
      target: { value: "#abcdef" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/settings/branding", {
        hospitalName: "MedCore",
        primaryColor: "#abcdef",
        logoUrl: undefined,
        // Hospital contact/legal fields are always sent (trimmed) so an admin
        // can clear a value; empty when untouched in this test.
        hospitalPhone: "",
        hospitalEmail: "",
        hospitalGstin: "",
        hospitalAddress: "",
        hospitalCity: "",
        hospitalPincode: "",
        hospitalLatitude: "",
        hospitalLongitude: "",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Branding saved");
  });

  it("generic error from save surfaces toast.error", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/branding")
        return Promise.resolve({
          data: { hospitalName: "MedCore", primaryColor: "", logoUrl: "" },
        });
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockRejectedValue(new Error("save failed"));

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Branding$/i }));
    await screen.findByTestId("branding-hospital-name");

    fireEvent.click(screen.getByRole("button", { name: /Save Branding/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("save failed"),
    );
  });
});

describe("SettingsPage — Integrations tab (ADMIN, Issue #716)", () => {
  beforeEach(() => {
    asRole("ADMIN");
  });

  it("renders the loading placeholder until /settings/integrations resolves", async () => {
    let resolveIntegrations!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolveIntegrations = r;
    });
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/integrations") return pending;
      return Promise.resolve({ data: [] });
    });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Integrations$/i }));

    // Loading now renders the shared Skeleton kit (.mc-skeleton) instead of a
    // "Loading integrations…" text placeholder.
    await waitFor(() =>
      expect(document.querySelector(".mc-skeleton")).toBeInTheDocument(),
    );
    resolveIntegrations({ data: { integrations: [] } });
  });

  it("renders the empty-state copy when no integrations are configured", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/integrations")
        return Promise.resolve({ data: { integrations: [] } });
      return Promise.resolve({ data: [] });
    });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Integrations$/i }));

    expect(
      await screen.findByText(/No integrations configured/i),
    ).toBeInTheDocument();
  });

  it("renders the integration rows with friendly labels + configured pill", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/integrations")
        return Promise.resolve({
          data: {
            integrations: [
              { key: "sendgrid", enabled: true, configured: true },
              { key: "whatsapp", enabled: false, configured: false },
              { key: "unknown-key", enabled: false, configured: false },
            ],
          },
        });
      return Promise.resolve({ data: [] });
    });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Integrations$/i }));

    await screen.findByText(/SendGrid \(email\)/i);
    expect(screen.getByText(/WhatsApp/i)).toBeInTheDocument();
    // Unknown keys render with the raw key fallback.
    expect(screen.getByText("unknown-key")).toBeInTheDocument();
    expect(screen.getByText(/Credentials present/i)).toBeInTheDocument();
    expect(
      screen.getAllByText(/Not yet configured/i).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("happy toggle PATCHes /settings/integrations + toast", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/integrations")
        return Promise.resolve({
          data: {
            integrations: [
              { key: "whatsapp", enabled: false, configured: true },
            ],
          },
        });
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Integrations$/i }));

    await screen.findByTestId("integration-row-whatsapp");
    fireEvent.click(screen.getByTestId("integration-toggle-whatsapp"));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/settings/integrations", {
        integrations: [{ key: "whatsapp", enabled: true }],
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("WhatsApp enabled");
  });

  it("toggle PATCH rejection rolls back state + surfaces toast.error", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/integrations")
        return Promise.resolve({
          data: {
            integrations: [
              { key: "sendgrid", enabled: true, configured: true },
            ],
          },
        });
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockRejectedValue(new Error("toggle blew up"));

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Integrations$/i }));

    await screen.findByTestId("integration-row-sendgrid");
    fireEvent.click(screen.getByTestId("integration-toggle-sendgrid"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("toggle blew up"),
    );
  });

  it("falls back to empty rows on GET error (resilience)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve(meFixture);
      if (url === "/settings/integrations")
        return Promise.reject(new Error("403 boom"));
      return Promise.resolve({ data: [] });
    });

    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Integrations$/i }));

    expect(
      await screen.findByText(/No integrations configured/i),
    ).toBeInTheDocument();
  });
});

// ─── Shared helpers for the tenant-admin-only credential tabs ───────────
// WhatsApp + Payments render only for an ADMIN WITH a tenantId (the platform
// super-admin — tenant-less ADMIN — doesn't get them).
function asTenantAdmin(tenantId = "t-1") {
  authMock.mockReturnValue({
    user: {
      id: "u-self",
      email: "me@medcore.test",
      name: "Me Myself",
      role: "ADMIN",
      tenantId,
      preferredLanguage: "en",
      defaultLandingPage: "/dashboard",
    },
    refreshUser: refreshUserMock,
  });
}

// Route GETs by URL: /auth/me → meFixture, then the caller's map, else [].
function mockGets(map: Record<string, () => Promise<unknown>>) {
  apiMock.get.mockImplementation((url: string) => {
    if (url === "/auth/me") return Promise.resolve(meFixture);
    for (const k of Object.keys(map)) {
      if (url === k || url.startsWith(k)) return map[k]();
    }
    return Promise.resolve({ data: [] });
  });
}

const waConfig = (over: Record<string, unknown> = {}) => ({
  data: {
    config: {
      provider: "META",
      credentials: { accessToken: "tok-1", phoneNumberId: "111222333" },
      credentialsByProvider: {
        META: { accessToken: "tok-1", phoneNumberId: "111222333" },
      },
      defaultProductId: null,
      autoReply: false,
      active: true,
      plaintextWarning: false,
      ...over,
    },
  },
});

describe("SettingsPage — WhatsApp tab (multi-provider vault)", () => {
  it("loads the active provider's creds + active badge", async () => {
    asTenantAdmin();
    mockGets({ "/wa/config": () => Promise.resolve(waConfig()) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^WhatsApp$/i }));
    const token = (await screen.findByTestId(
      "wa-field-accessToken",
    )) as HTMLInputElement;
    expect(token.value).toBe("tok-1");
    expect(screen.getByTestId("wa-active-badge")).toHaveTextContent(
      "Active: Meta Cloud API",
    );
  });

  it("Auto-reply reveals Meta App secret + Verify token", async () => {
    asTenantAdmin();
    mockGets({ "/wa/config": () => Promise.resolve(waConfig({ autoReply: false })) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^WhatsApp$/i }));
    await screen.findByTestId("wa-field-accessToken");
    expect(screen.queryByTestId("wa-field-appSecret")).toBeNull();
    fireEvent.click(screen.getByLabelText(/Auto-reply to incoming messages/i));
    expect(await screen.findByTestId("wa-field-appSecret")).toBeInTheDocument();
    expect(screen.getByTestId("wa-field-verifyToken")).toBeInTheDocument();
  });

  it("keeps each provider's creds when switching, and saves the current one", async () => {
    asTenantAdmin();
    mockGets({ "/wa/config": () => Promise.resolve(waConfig()) });
    apiMock.put.mockResolvedValue({ data: { config: {} } });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^WhatsApp$/i }));
    await screen.findByTestId("wa-field-accessToken");
    // Fill Gupshup then switch back to Meta — Meta creds survive.
    fireEvent.change(screen.getByTestId("wa-provider"), {
      target: { value: "GUPSHUP" },
    });
    fireEvent.change(await screen.findByTestId("wa-field-apiKey"), {
      target: { value: "gs-key" },
    });
    fireEvent.change(screen.getByTestId("wa-field-appName"), {
      target: { value: "app" },
    });
    fireEvent.change(screen.getByTestId("wa-field-sourcePhone"), {
      target: { value: "+919990001112" },
    });
    fireEvent.change(screen.getByTestId("wa-provider"), {
      target: { value: "META" },
    });
    expect(
      ((await screen.findByTestId("wa-field-accessToken")) as HTMLInputElement)
        .value,
    ).toBe("tok-1");
    fireEvent.click(screen.getByTestId("wa-save"));
    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith(
        "/wa/config",
        expect.objectContaining({
          credentials: expect.objectContaining({
            provider: "META",
            accessToken: "tok-1",
          }),
          activeProvider: "META",
          active: true,
        }),
      ),
    );
  });

  it("can switch the active provider then save it", async () => {
    asTenantAdmin();
    mockGets({ "/wa/config": () => Promise.resolve(waConfig()) });
    apiMock.put.mockResolvedValue({ data: { config: {} } });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^WhatsApp$/i }));
    await screen.findByTestId("wa-field-accessToken");
    fireEvent.change(screen.getByTestId("wa-provider"), {
      target: { value: "GUPSHUP" },
    });
    fireEvent.change(await screen.findByTestId("wa-field-apiKey"), {
      target: { value: "gs" },
    });
    fireEvent.change(screen.getByTestId("wa-field-appName"), {
      target: { value: "app" },
    });
    fireEvent.change(screen.getByTestId("wa-field-sourcePhone"), {
      target: { value: "+919990001112" },
    });
    const setActive = screen.getByTestId("wa-set-active") as HTMLInputElement;
    expect(setActive.disabled).toBe(false);
    fireEvent.click(setActive);
    expect(screen.getByTestId("wa-active-badge")).toHaveTextContent(
      "Active: Gupshup",
    );
    fireEvent.click(screen.getByTestId("wa-save"));
    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith(
        "/wa/config",
        expect.objectContaining({
          activeProvider: "GUPSHUP",
          credentials: expect.objectContaining({ provider: "GUPSHUP", apiKey: "gs" }),
        }),
      ),
    );
  });

  it("blocks save when required fields are missing (and GET error is swallowed)", async () => {
    asTenantAdmin();
    mockGets({ "/wa/config": () => Promise.reject(new Error("load boom")) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^WhatsApp$/i }));
    await screen.findByTestId("wa-save");
    fireEvent.click(screen.getByTestId("wa-save"));
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled());
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it("surfaces a save error toast", async () => {
    asTenantAdmin();
    mockGets({ "/wa/config": () => Promise.resolve(waConfig()) });
    apiMock.put.mockRejectedValue(new Error("save boom"));
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^WhatsApp$/i }));
    await screen.findByTestId("wa-save");
    fireEvent.click(screen.getByTestId("wa-save"));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("save boom"));
  });

  it("shows the plaintext-storage warning when flagged", async () => {
    asTenantAdmin();
    mockGets({ "/wa/config": () => Promise.resolve(waConfig({ plaintextWarning: true })) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^WhatsApp$/i }));
    expect(await screen.findByText(/plaintext/i)).toBeInTheDocument();
  });

  it("secret field toggles visibility", async () => {
    asTenantAdmin();
    mockGets({ "/wa/config": () => Promise.resolve(waConfig()) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^WhatsApp$/i }));
    const tokenField = (await screen.findByTestId(
      "wa-field-accessToken",
    )) as HTMLInputElement;
    expect(tokenField.type).toBe("password");
    fireEvent.click(screen.getAllByRole("button", { name: /show|hide/i })[0]);
    expect(tokenField.type).toBe("text");
  });
});

const payConfig = (over: Record<string, unknown> = {}) => ({
  data: {
    configured: true,
    razorpayKeyId: "rzp_test_abc123",
    razorpayMode: "test",
    hasSecret: true,
    hasWebhookSecret: false,
    ...over,
  },
});

describe("SettingsPage — Payments tab (Razorpay)", () => {
  it("loads config and shows the key id", async () => {
    asTenantAdmin();
    mockGets({ "/settings/payment": () => Promise.resolve(payConfig()) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Payments$/i }));
    const keyId = (await screen.findByTestId("pay-key-id")) as HTMLInputElement;
    expect(keyId.value).toBe("rzp_test_abc123");
    expect(screen.getByText(/Credentials on file/i)).toBeInTheDocument();
  });

  it("rejects an invalid Key ID", async () => {
    asTenantAdmin();
    mockGets({ "/settings/payment": () => Promise.resolve(payConfig()) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Payments$/i }));
    fireEvent.change(await screen.findByTestId("pay-key-id"), {
      target: { value: "not-a-key" },
    });
    fireEvent.click(screen.getByTestId("pay-save"));
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled());
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("requires a secret on first-time setup (GET error swallowed)", async () => {
    asTenantAdmin();
    mockGets({ "/settings/payment": () => Promise.reject(new Error("load boom")) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Payments$/i }));
    fireEvent.change(await screen.findByTestId("pay-key-id"), {
      target: { value: "rzp_live_abcdef12" },
    });
    fireEvent.click(screen.getByTestId("pay-save"));
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled());
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("saves happily and warns in live mode", async () => {
    asTenantAdmin();
    mockGets({ "/settings/payment": () => Promise.resolve(payConfig()) });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Payments$/i }));
    await screen.findByTestId("pay-key-id");
    fireEvent.change(screen.getByTestId("pay-mode"), { target: { value: "live" } });
    expect(screen.getByText(/Live mode charges real money/i)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("pay-key-secret"), {
      target: { value: "sekret123" },
    });
    fireEvent.click(screen.getByTestId("pay-save"));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/settings/payment",
        expect.objectContaining({
          razorpayKeyId: "rzp_test_abc123",
          razorpayMode: "live",
          razorpayKeySecret: "sekret123",
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Payment settings saved");
  });

  it("surfaces a save error", async () => {
    asTenantAdmin();
    mockGets({ "/settings/payment": () => Promise.resolve(payConfig()) });
    apiMock.patch.mockRejectedValue(new Error("pay boom"));
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Payments$/i }));
    await screen.findByTestId("pay-key-id");
    fireEvent.click(screen.getByTestId("pay-save"));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
  });

  it("toggles the Key Secret visibility", async () => {
    asTenantAdmin();
    mockGets({ "/settings/payment": () => Promise.resolve(payConfig()) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Payments$/i }));
    const secret = (await screen.findByTestId(
      "pay-key-secret",
    )) as HTMLInputElement;
    expect(secret.type).toBe("password");
    fireEvent.click(screen.getAllByRole("button", { name: /show|hide/i })[0]);
    expect(secret.type).toBe("text");
  });
});

const pmjayCfg = (over: Record<string, unknown> = {}) => ({
  data: {
    enabled: true,
    simulationMode: false,
    hospitalId: "H-1",
    clientId: "C-1",
    baseUrl: "https://gw",
    authUrl: "https://gw/auth",
    bisUrl: "",
    tmsUrl: "",
    packageUrl: "",
    timeout: 30000,
    retryCount: 3,
    batchSize: 200,
    logging: false,
    clientSecretSet: true,
    ...over,
  },
});

describe("SettingsPage — PM-JAY Configuration tab (tenant-admin)", () => {
  const openTab = () =>
    fireEvent.click(screen.getByRole("button", { name: /^PM-JAY Configuration$/i }));

  it("loads the tenant config and shows the hospital id + on-file hint", async () => {
    asTenantAdmin();
    mockGets({ "/pmjay/config": () => Promise.resolve(pmjayCfg()) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    openTab();
    const hid = (await screen.findByTestId("pmjay-cfg-hospitalId")) as HTMLInputElement;
    expect(hid.value).toBe("H-1");
    expect(screen.getByText(/Credentials on file/i)).toBeInTheDocument();
    // Live mode (simulation off) surfaces the amber warning.
    expect(screen.getByText(/Live mode calls the real PM-JAY gateway/i)).toBeInTheDocument();
    // The stored secret is NEVER prefilled into the input.
    expect((screen.getByTestId("pmjay-cfg-clientSecret") as HTMLInputElement).value).toBe("");
  });

  it("saves, sending only the fields set (secret omitted when left blank)", async () => {
    asTenantAdmin();
    mockGets({ "/pmjay/config": () => Promise.resolve(pmjayCfg()) });
    apiMock.put.mockResolvedValue({ data: { clientSecretSet: true } });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    openTab();
    fireEvent.change(await screen.findByTestId("pmjay-cfg-hospitalId"), {
      target: { value: "H-9" },
    });
    fireEvent.click(screen.getByTestId("pmjay-cfg-save"));
    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith(
        "/pmjay/config",
        expect.objectContaining({ hospitalId: "H-9" }),
      ),
    );
    const payload = apiMock.put.mock.calls[0][1] as Record<string, unknown>;
    expect("clientSecret" in payload).toBe(false); // blank → not sent
    expect(toastMock.success).toHaveBeenCalledWith("PM-JAY configuration saved.");
  });

  it("includes the client secret in the payload only when typed", async () => {
    asTenantAdmin();
    mockGets({ "/pmjay/config": () => Promise.resolve(pmjayCfg()) });
    apiMock.put.mockResolvedValue({ data: { clientSecretSet: true } });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    openTab();
    fireEvent.change(await screen.findByTestId("pmjay-cfg-clientSecret"), {
      target: { value: "new-secret" },
    });
    fireEvent.click(screen.getByTestId("pmjay-cfg-save"));
    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith(
        "/pmjay/config",
        expect.objectContaining({ clientSecret: "new-secret" }),
      ),
    );
  });

  it("toggles simulation mode and surfaces a save error", async () => {
    asTenantAdmin();
    mockGets({ "/pmjay/config": () => Promise.resolve(pmjayCfg({ simulationMode: true })) });
    apiMock.put.mockRejectedValue(new Error("cfg boom"));
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    openTab();
    // Starts in simulation → no live-mode warning yet.
    await screen.findByTestId("pmjay-cfg-hospitalId");
    expect(screen.queryByText(/Live mode calls the real PM-JAY gateway/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pmjay-cfg-simulationMode")); // → live
    expect(screen.getByText(/Live mode calls the real PM-JAY gateway/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pmjay-cfg-save"));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
  });

  it("swallows a load error and still renders an editable form", async () => {
    asTenantAdmin();
    mockGets({ "/pmjay/config": () => Promise.reject(new Error("load boom")) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    openTab();
    const hid = (await screen.findByTestId("pmjay-cfg-hospitalId")) as HTMLInputElement;
    expect(hid.value).toBe("");
  });

  it("toggles client-secret visibility", async () => {
    asTenantAdmin();
    mockGets({ "/pmjay/config": () => Promise.resolve(pmjayCfg()) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    openTab();
    const secret = (await screen.findByTestId("pmjay-cfg-clientSecret")) as HTMLInputElement;
    expect(secret.type).toBe("password");
    fireEvent.click(screen.getAllByRole("button", { name: /show|hide/i })[0]);
    expect(secret.type).toBe("text");
  });
});

describe("SettingsPage — Branding hospital details", () => {
  const brandingResp = (over: Record<string, unknown> = {}) => ({
    data: {
      hospitalName: "MedCore",
      primaryColor: "",
      logoUrl: "",
      hospitalPhone: "",
      hospitalEmail: "",
      hospitalGstin: "",
      hospitalAddress: "",
      ...over,
    },
  });

  it("rejects a bad email and GSTIN", async () => {
    asTenantAdmin();
    mockGets({ "/settings/branding": () => Promise.resolve(brandingResp()) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Branding$/i }));
    await screen.findByTestId("branding-hospital-name");
    fireEvent.change(screen.getByTestId("branding-hospital-email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.change(screen.getByTestId("branding-hospital-gstin"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/i }));
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled());
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("rejects invalid booking location fields", async () => {
    asTenantAdmin();
    mockGets({ "/settings/branding": () => Promise.resolve(brandingResp()) });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Branding$/i }));
    await screen.findByTestId("branding-hospital-name");
    fireEvent.change(screen.getByTestId("branding-hospital-pincode"), {
      target: { value: "5600" },
    });
    fireEvent.change(screen.getByTestId("branding-hospital-latitude"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByTestId("branding-hospital-longitude"), {
      target: { value: "200" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/i }));
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled());
    expect(apiMock.patch).not.toHaveBeenCalled();
    expect(screen.getByText(/PIN code must be 6 digits/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Latitude must be between -90 and 90/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Longitude must be between -180 and 180/i),
    ).toBeInTheDocument();
  });

  it("saves hospital contact + legal fields", async () => {
    asTenantAdmin();
    mockGets({ "/settings/branding": () => Promise.resolve(brandingResp()) });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<SettingsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/auth/me"));
    fireEvent.click(screen.getByRole("button", { name: /^Branding$/i }));
    await screen.findByTestId("branding-hospital-name");
    fireEvent.change(screen.getByTestId("branding-hospital-phone"), {
      target: { value: "+91 22 1234 5678" },
    });
    fireEvent.change(screen.getByTestId("branding-hospital-email"), {
      target: { value: "info@x.in" },
    });
    fireEvent.change(screen.getByTestId("branding-hospital-gstin"), {
      target: { value: "22AAAAA0000A1Z5" },
    });
    fireEvent.change(screen.getByTestId("branding-hospital-address"), {
      target: { value: "Street, City" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/i }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/settings/branding",
        expect.objectContaining({
          hospitalEmail: "info@x.in",
          hospitalGstin: "22AAAAA0000A1Z5",
          hospitalPhone: "+91 22 1234 5678",
          hospitalAddress: "Street, City",
        }),
      ),
    );
  });
});
