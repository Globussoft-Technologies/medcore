import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "../ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ConfirmDialog
        open={false}
        title="Delete"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders title + message and testids when open", () => {
    render(
      <ConfirmDialog
        open
        title="Delete this invoice?"
        message="This cannot be undone."
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-dialog-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-dialog-cancel")).toBeInTheDocument();
    expect(screen.getByText("Delete this invoice?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("sets role=dialog and aria-modal on the container", () => {
    render(
      <ConfirmDialog
        open
        title="T"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("calls onConfirm when confirm button clicked", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Go?"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    await userEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when cancel button clicked", async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Go?"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    await userEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("closes via backdrop click (onCancel)", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Go?"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByTestId("confirm-dialog"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("does NOT close when clicking inside the dialog card", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Go?"
        message="inner"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByText("inner"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("closes on ESC key (onCancel)", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Go?"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("applies danger styling (red) to confirm button when danger=true", () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        danger
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const confirmBtn = screen.getByTestId("confirm-dialog-confirm");
    expect(confirmBtn.className).toContain("bg-red-600");
  });

  it("uses custom confirmLabel / cancelLabel when provided", () => {
    render(
      <ConfirmDialog
        open
        title="Continue?"
        confirmLabel="Proceed"
        cancelLabel="Nope"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText("Proceed")).toBeInTheDocument();
    expect(screen.getByText("Nope")).toBeInTheDocument();
  });
});
