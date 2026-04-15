import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeyboardShortcutsModal } from "../KeyboardShortcutsModal";

describe("KeyboardShortcutsModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <KeyboardShortcutsModal open={false} onClose={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the list of shortcuts when open", () => {
    render(<KeyboardShortcutsModal open onClose={() => {}} />);
    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Open search palette")).toBeInTheDocument();
    expect(screen.getByText("Show this help")).toBeInTheDocument();
    // Several kbd elements for key combos
    expect(screen.getAllByText("Ctrl + K").length).toBeGreaterThan(0);
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsModal open onClose={onClose} />);
    await userEvent.click(
      screen.getByRole("button", { name: /close keyboard shortcuts/i })
    );
    expect(onClose).toHaveBeenCalled();
  });
});
