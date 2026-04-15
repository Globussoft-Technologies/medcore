import { create } from "zustand";
import { api } from "./api";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  phone?: string;
  photoUrl?: string | null;
  twoFactorEnabled?: boolean;
  preferredLanguage?: string | null;
  defaultLandingPage?: string | null;
}

interface LoginResult {
  twoFactorRequired?: boolean;
  tempToken?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  verify2FA: (tempToken: string, code: string) => Promise<void>;
  logout: () => void;
  loadSession: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  isLoading: true,

  login: async (email: string, password: string) => {
    const res = await api.post<{
      success: boolean;
      data:
        | {
            user: User;
            tokens: { accessToken: string; refreshToken: string };
          }
        | { twoFactorRequired: true; tempToken: string };
    }>("/auth/login", { email, password });

    const data = res.data as any;
    if (data.twoFactorRequired) {
      return { twoFactorRequired: true, tempToken: data.tempToken };
    }

    const { user, tokens } = data;
    localStorage.setItem("medcore_token", tokens.accessToken);
    localStorage.setItem("medcore_refresh", tokens.refreshToken);
    set({ user, token: tokens.accessToken, isLoading: false });
    return {};
  },

  verify2FA: async (tempToken: string, code: string) => {
    const res = await api.post<{
      success: boolean;
      data: {
        user: User;
        tokens: { accessToken: string; refreshToken: string };
      };
    }>("/auth/2fa/verify-login", { tempToken, code });
    const { user, tokens } = res.data;
    localStorage.setItem("medcore_token", tokens.accessToken);
    localStorage.setItem("medcore_refresh", tokens.refreshToken);
    set({ user, token: tokens.accessToken, isLoading: false });
  },

  refreshUser: async () => {
    const token = localStorage.getItem("medcore_token");
    if (!token) return;
    try {
      const res = await api.get<{ success: boolean; data: User }>("/auth/me", { token });
      set({ user: res.data });
    } catch {
      // ignore
    }
  },

  logout: () => {
    localStorage.removeItem("medcore_token");
    localStorage.removeItem("medcore_refresh");
    set({ user: null, token: null });
  },

  loadSession: async () => {
    const token = localStorage.getItem("medcore_token");
    if (!token) {
      set({ isLoading: false });
      return;
    }

    try {
      const res = await api.get<{ success: boolean; data: User }>("/auth/me", {
        token,
      });
      set({ user: res.data, token, isLoading: false });
    } catch {
      localStorage.removeItem("medcore_token");
      localStorage.removeItem("medcore_refresh");
      set({ user: null, token: null, isLoading: false });
    }
  },
}));
