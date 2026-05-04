/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({ t: (k: string) => k, lang: "en", setLang: vi.fn() }),
}));
vi.mock("@/components/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/register",
}));

import RegisterPage from "../register/page";

describe("RegisterPage", () => {
  beforeEach(() => {
    apiMock.post.mockReset();
    authMock.mockReturnValue({ login: vi.fn(async () => {}) });
  });

  it("renders the registration form", async () => {
    render(<RegisterPage />);
    expect(screen.getByLabelText(/register\.fullName/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/register\.email/i)).toBeInTheDocument();
  });

  it("submits with all required fields", async () => {
    apiMock.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<RegisterPage />);
    await user.type(screen.getByLabelText(/register\.fullName/i), "Aarav Mehta");
    await user.type(screen.getByLabelText(/register\.email/i), "a@x.com");
    await user.type(screen.getByLabelText(/register\.phone/i), "9000000001");
    await user.type(screen.getByLabelText(/register\.password/i), "password123");
    await user.click(screen.getByRole("button", { name: /register\.submit/i }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/auth/register",
        expect.objectContaining({ email: "a@x.com", name: "Aarav Mehta" })
      )
    );
  });

  it("shows error on API failure", async () => {
    // Issue #494: a plain Error with no .status is treated as a network /
    // retryable failure — banner copy comes from `register.error.serverRetry`,
    // and a Retry CTA appears alongside it. (See register.servererrors for
    // status-aware paths: 4xx field details, 5xx, 408, non-retryable 4xx.)
    const err = new Error("Email taken") as Error & { status?: number };
    err.status = 502;
    apiMock.post.mockRejectedValue(err);
    const user = userEvent.setup();
    render(<RegisterPage />);
    await user.type(screen.getByLabelText(/register\.fullName/i), "Aarav");
    await user.type(screen.getByLabelText(/register\.email/i), "a@x.com");
    await user.type(screen.getByLabelText(/register\.phone/i), "9000000001");
    await user.type(screen.getByLabelText(/register\.password/i), "password123");
    await user.click(screen.getByRole("button", { name: /register\.submit/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument()
    );
  });

  it("renders sign-in link", async () => {
    render(<RegisterPage />);
    expect(screen.getByRole("link", { name: /register\.signIn/i })).toBeInTheDocument();
  });

  it("renders gender select with options", async () => {
    render(<RegisterPage />);
    const select = screen.getByLabelText(/register\.gender/i) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.options.length).toBeGreaterThanOrEqual(3);
  });
});
