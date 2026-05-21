/**
 * Pearl ERP Stage 1 gap #2 piece 3 — BranchPicker smoke test.
 *
 * Asserts:
 *   - picker is hidden when the tenant has 0 or 1 branches
 *   - picker renders all available branches with their codes
 *   - changing the selection updates the store + localStorage
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BranchPicker } from "../BranchPicker";
import {
  useBranchStore,
  __resetBranchStoreForTests,
  type Branch,
} from "@/lib/branch-store";

const FAKE_BRANCHES: Branch[] = [
  { id: "b-main", tenantId: "t1", name: "Main", code: "MAIN", isDefault: true, active: true },
  { id: "b-jkr", tenantId: "t1", name: "Jakkur", code: "JKR", isDefault: false, active: true },
];

describe("BranchPicker", () => {
  beforeEach(() => {
    __resetBranchStoreForTests();
    window.localStorage.clear();
  });

  it("renders nothing when the tenant has zero branches", () => {
    const { container } = render(<BranchPicker />);
    expect(container.querySelector('[data-testid="branch-picker"]')).toBeNull();
  });

  it("renders nothing when the tenant has only one branch", () => {
    useBranchStore.setState({
      availableBranches: [FAKE_BRANCHES[0]],
      currentBranchId: "b-main",
      loaded: true,
    });
    const { container } = render(<BranchPicker />);
    expect(container.querySelector('[data-testid="branch-picker"]')).toBeNull();
  });

  it("renders a dropdown with each branch as an option (multi-branch tenant)", () => {
    useBranchStore.setState({
      availableBranches: FAKE_BRANCHES,
      currentBranchId: "b-main",
      loaded: true,
    });
    render(<BranchPicker />);
    expect(screen.getByTestId("branch-picker")).toBeInTheDocument();
    const select = screen.getByLabelText("Select branch") as HTMLSelectElement;
    expect(select.value).toBe("b-main");
    expect(screen.getByTestId("branch-option-b-main")).toBeInTheDocument();
    expect(screen.getByTestId("branch-option-b-jkr")).toBeInTheDocument();
  });

  it("changing the selection updates the store and localStorage", async () => {
    useBranchStore.setState({
      availableBranches: FAKE_BRANCHES,
      currentBranchId: "b-main",
      loaded: true,
    });
    const user = userEvent.setup();
    render(<BranchPicker />);
    const select = screen.getByLabelText("Select branch");
    await user.selectOptions(select, "b-jkr");
    expect(useBranchStore.getState().currentBranchId).toBe("b-jkr");
    expect(window.localStorage.getItem("medcore_branch_id")).toBe("b-jkr");
  });

  it("formats option labels as `CODE — name` when code is present", () => {
    useBranchStore.setState({
      availableBranches: FAKE_BRANCHES,
      currentBranchId: "b-main",
      loaded: true,
    });
    render(<BranchPicker />);
    const opt = screen.getByTestId("branch-option-b-main");
    expect(opt.textContent).toContain("MAIN");
    expect(opt.textContent).toContain("Main");
  });

  it("falls back to just the name when code is null", () => {
    useBranchStore.setState({
      availableBranches: [
        { ...FAKE_BRANCHES[0], code: null },
        FAKE_BRANCHES[1],
      ],
      currentBranchId: "b-main",
      loaded: true,
    });
    render(<BranchPicker />);
    const opt = screen.getByTestId("branch-option-b-main");
    expect(opt.textContent?.trim()).toBe("Main");
  });
});
