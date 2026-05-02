/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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
  useTranslation: () => ({
    t: (_k: string, fallback?: string) => fallback ?? _k,
    setLang: vi.fn(),
    lang: "en",
  }),
}));
vi.mock("@/components/PasswordInput", () => ({
  PasswordInput: (props: any) => <input type="password" {...props} />,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/profile",
}));

import ProfilePage from "../profile/page";

const me = {
  data: {
    id: "u1",
    email: "user@example.com",
    name: "Aarav Mehta",
    phone: "+919000000001",
    role: "DOCTOR",
    photoUrl: null,
    preferredLanguage: "en",
  },
};

describe("ProfilePage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Aarav Mehta", email: "user@example.com", role: "DOCTOR" },
        refreshUser: vi.fn(async () => undefined),
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders My Profile heading", async () => {
    apiMock.get.mockResolvedValue(me);
    render(<ProfilePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /my profile/i })
      ).toBeInTheDocument()
    );
  });

  it("populates header card from /auth/me", async () => {
    apiMock.get.mockResolvedValue(me);
    render(<ProfilePage />);
    await waitFor(() =>
      expect(screen.getByTestId("profile-header-name").textContent).toMatch(
        /aarav mehta/i
      )
    );
    expect(screen.getByTestId("profile-header-email").textContent).toContain(
      "user@example.com"
    );
    expect(screen.getByTestId("profile-header-role").textContent).toContain(
      "DOCTOR"
    );
  });

  it("renders editable name and phone inputs", async () => {
    apiMock.get.mockResolvedValue(me);
    render(<ProfilePage />);
    await waitFor(() =>
      expect(screen.getByTestId("profile-name-input")).toBeInTheDocument()
    );
    expect(screen.getByTestId("profile-phone-input")).toBeInTheDocument();
  });

  it("shows Loading state in name field before fetch resolves", async () => {
    let resolve: any;
    apiMock.get.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ProfilePage />);
    await waitFor(() =>
      expect(screen.getByTestId("profile-header-name").textContent).toMatch(/loading/i)
    );
    resolve(me);
  });

  it("shows error toast when /auth/me rejects but page still mounts", async () => {
    apiMock.get.mockRejectedValue(new Error("network"));
    render(<ProfilePage />);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalled()
    );
    expect(
      screen.getByRole("heading", { name: /my profile/i })
    ).toBeInTheDocument();
  });
});
