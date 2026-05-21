/**
 * Pearl ERP Stage 1 gap #2 piece 3 — branch-store smoke test.
 *
 * Asserts the core contract of `useBranchStore`:
 *   - setCurrentBranchId persists to localStorage
 *   - loadBranches() populates the cache + auto-selects the default
 *     branch when no selection is persisted
 *   - loadBranches() honours an existing valid persisted selection
 *   - loadBranches() falls back to default when the persisted id is
 *     not in the returned list (e.g. branch was deleted)
 *   - reset() clears both the cache and the localStorage key
 *
 * The api-client is mocked end-to-end so this test does not depend on
 * any network or server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));

import {
  useBranchStore,
  __resetBranchStoreForTests,
  getCurrentBranchId,
} from "../branch-store";

const FAKE_BRANCHES = [
  { id: "b-main", tenantId: "t1", name: "Main", code: "MAIN", isDefault: true, active: true },
  { id: "b-jkr", tenantId: "t1", name: "Jakkur", code: "JKR", isDefault: false, active: true },
];

describe("useBranchStore", () => {
  beforeEach(() => {
    __resetBranchStoreForTests();
    window.localStorage.clear();
    apiMock.get.mockReset();
  });

  it("setCurrentBranchId writes to localStorage and updates the store", () => {
    useBranchStore.getState().setCurrentBranchId("b-jkr");
    expect(useBranchStore.getState().currentBranchId).toBe("b-jkr");
    expect(window.localStorage.getItem("medcore_branch_id")).toBe("b-jkr");
  });

  it("setCurrentBranchId(null) removes the persisted key", () => {
    window.localStorage.setItem("medcore_branch_id", "b-jkr");
    useBranchStore.setState({ currentBranchId: "b-jkr" });
    useBranchStore.getState().setCurrentBranchId(null);
    expect(useBranchStore.getState().currentBranchId).toBeNull();
    expect(window.localStorage.getItem("medcore_branch_id")).toBeNull();
  });

  it("loadBranches fetches /branches and caches the result", async () => {
    apiMock.get.mockResolvedValueOnce({ success: true, data: FAKE_BRANCHES });
    await useBranchStore.getState().loadBranches();
    expect(apiMock.get).toHaveBeenCalledWith("/branches?active=true");
    expect(useBranchStore.getState().availableBranches).toEqual(FAKE_BRANCHES);
    expect(useBranchStore.getState().loaded).toBe(true);
  });

  it("loadBranches auto-selects the default branch when nothing is persisted", async () => {
    apiMock.get.mockResolvedValueOnce({ success: true, data: FAKE_BRANCHES });
    await useBranchStore.getState().loadBranches();
    expect(useBranchStore.getState().currentBranchId).toBe("b-main");
    expect(window.localStorage.getItem("medcore_branch_id")).toBe("b-main");
  });

  it("loadBranches keeps a valid persisted selection", async () => {
    useBranchStore.getState().setCurrentBranchId("b-jkr");
    apiMock.get.mockResolvedValueOnce({ success: true, data: FAKE_BRANCHES });
    await useBranchStore.getState().loadBranches();
    expect(useBranchStore.getState().currentBranchId).toBe("b-jkr");
  });

  it("loadBranches falls back to default when persisted id is not in the list", async () => {
    useBranchStore.getState().setCurrentBranchId("b-deleted");
    apiMock.get.mockResolvedValueOnce({ success: true, data: FAKE_BRANCHES });
    await useBranchStore.getState().loadBranches();
    expect(useBranchStore.getState().currentBranchId).toBe("b-main");
  });

  it("loadBranches handles network errors gracefully (no throw, isLoading clears)", async () => {
    apiMock.get.mockRejectedValueOnce(new Error("network down"));
    await useBranchStore.getState().loadBranches();
    expect(useBranchStore.getState().isLoading).toBe(false);
    expect(useBranchStore.getState().loaded).toBe(true);
    expect(useBranchStore.getState().availableBranches).toEqual([]);
  });

  it("reset clears the cache, the persisted id, and the loaded flag", () => {
    useBranchStore.setState({
      currentBranchId: "b-main",
      availableBranches: FAKE_BRANCHES,
      loaded: true,
    });
    window.localStorage.setItem("medcore_branch_id", "b-main");
    useBranchStore.getState().reset();
    expect(useBranchStore.getState().currentBranchId).toBeNull();
    expect(useBranchStore.getState().availableBranches).toEqual([]);
    expect(useBranchStore.getState().loaded).toBe(false);
    expect(window.localStorage.getItem("medcore_branch_id")).toBeNull();
  });

  it("getCurrentBranchId returns the store's current id (used by api interceptor)", () => {
    useBranchStore.getState().setCurrentBranchId("b-main");
    expect(getCurrentBranchId()).toBe("b-main");
    useBranchStore.getState().setCurrentBranchId(null);
    expect(getCurrentBranchId()).toBeNull();
  });
});
