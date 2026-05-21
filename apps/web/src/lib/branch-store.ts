"use client";

/**
 * Pearl ERP Stage 1 gap item #2 — piece 3 of 3.
 *
 * What / which modules / why:
 *   - Zustand store for the user's currently-selected branch.
 *   - Caches the tenant's branch list (cleared on logout / app boot when
 *     the user changes) so the topbar picker can render synchronously.
 *   - Persists `currentBranchId` to localStorage so a refresh keeps the
 *     same branch context. The actual server-side scoping lives behind
 *     `branchScopedPrisma` (piece 2a, `packages/db/src/branch-prisma.ts`),
 *     activated when the API client sends `X-Branch-Id` (wired in
 *     `apps/web/src/lib/api.ts`).
 *
 * Why a dedicated store (not a slice on `useAuthStore`):
 *   - The auth store is intentionally minimal + has a complex
 *     login-generation / cross-tab broadcast contract. Layering branch
 *     state on top of it risks breaking those invariants.
 *   - Branch state has a different lifecycle (loaded after auth, not
 *     during), and a different persistence pattern (localStorage value
 *     survives logout — on the next login the user starts where they
 *     left off).
 *   - Mirrors the i18n pattern (`apps/web/src/lib/i18n.ts`): one small
 *     zustand store per cross-cutting UI concern.
 *
 * Lifecycle:
 *   1. App boots → branch-store reads `medcore_branch_id` from
 *      localStorage into `currentBranchId` (may be null).
 *   2. Dashboard layout mounts → calls `loadBranches()` once the auth
 *      store has a user. The API responds with `data: Branch[]`.
 *   3. If `currentBranchId` is null OR doesn't match any branch in the
 *      returned list, auto-select the branch with `isDefault: true`
 *      (or first if none flagged — defensive).
 *   4. User picks another branch → `setCurrentBranchId(id)` writes the
 *      new id to the store + localStorage; the API client picks it up
 *      on its NEXT request automatically.
 */

import { create } from "zustand";

const STORAGE_KEY = "medcore_branch_id";

export interface Branch {
  id: string;
  tenantId: string;
  name: string;
  code: string | null;
  isDefault: boolean;
  active: boolean;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  phone?: string | null;
  email?: string | null;
  gstin?: string | null;
}

interface BranchState {
  currentBranchId: string | null;
  availableBranches: Branch[];
  isLoading: boolean;
  loaded: boolean;
  setCurrentBranchId: (id: string | null) => void;
  loadBranches: () => Promise<void>;
  /** Reset to a fresh state — called on logout. */
  reset: () => void;
}

function readPersistedBranchId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writePersistedBranchId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable in private mode — best-effort.
  }
}

export const useBranchStore = create<BranchState>((set, get) => ({
  currentBranchId: readPersistedBranchId(),
  availableBranches: [],
  isLoading: false,
  loaded: false,

  setCurrentBranchId: (id) => {
    writePersistedBranchId(id);
    set({ currentBranchId: id });
  },

  loadBranches: async () => {
    // Defer the import so this module stays SSR-safe AND so the
    // api-client doesn't import the branch store (avoiding a circular
    // dependency through the X-Branch-Id interceptor).
    const { api } = await import("./api");
    if (get().isLoading) return;
    set({ isLoading: true });
    try {
      const res = await api.get<{ success: boolean; data: Branch[] }>(
        "/branches?active=true",
      );
      const branches = res.data || [];
      set({ availableBranches: branches, loaded: true, isLoading: false });

      // Auto-pick the default if the user has no current selection OR if
      // the persisted selection isn't in the returned list (e.g. branch
      // was deleted or the tenant changed).
      const { currentBranchId } = get();
      const isCurrentValid =
        currentBranchId && branches.some((b) => b.id === currentBranchId);
      if (!isCurrentValid && branches.length > 0) {
        const fallback = branches.find((b) => b.isDefault) ?? branches[0];
        writePersistedBranchId(fallback.id);
        set({ currentBranchId: fallback.id });
      }
    } catch {
      // Non-fatal — the picker will simply render no options and the
      // API client will send no X-Branch-Id header (legacy passthrough).
      set({ isLoading: false, loaded: true });
    }
  },

  reset: () => {
    writePersistedBranchId(null);
    set({
      currentBranchId: null,
      availableBranches: [],
      isLoading: false,
      loaded: false,
    });
  },
}));

/**
 * Module-scope getter used by the api-client's request interceptor so
 * non-React code can read the current branch id without subscribing to
 * the store. Returns null on the server.
 */
export function getCurrentBranchId(): string | null {
  if (typeof window === "undefined") return null;
  return useBranchStore.getState().currentBranchId;
}

/** Test-only — reset the store between tests. */
export function __resetBranchStoreForTests(): void {
  writePersistedBranchId(null);
  useBranchStore.setState({
    currentBranchId: null,
    availableBranches: [],
    isLoading: false,
    loaded: false,
  });
}
