import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptDialog } from "../PromptDialog";

describe("PromptDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <PromptDialog
        open={false}
        title="Reason"
        label="Reason"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders dialog with input and testids when open", () => {
    render(
      <PromptDialog
        open
        title="Cancellation reason"
        label="Reason"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId("prompt-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-dialog-input")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-dialog-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-dialog-cancel")).toBeInTheDocument();
    expect(screen.getByText("Cancellation reason")).toBeInTheDocument();
  });

  it("sets aria-label on the input from the label prop", () => {
    render(
      <PromptDialog
        open
        title="T"
        label="Justification text"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const input = screen.getByTestId("prompt-dialog-input");
    expect(input.getAttribute("aria-label")).toBe("Justification text");
  });

  it("resolves with the typed value on confirm", async () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog
        open
        title="T"
        label="Reason"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    await userEvent.type(
      screen.getByTestId("prompt-dialog-input"),
      "Because I said so"
    );
    await userEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    expect(onConfirm).toHaveBeenCalledWith("Because I said so");
  });

  it("calls onCancel when cancel clicked", async () => {
    const onCancel = vi.fn();
    render(
      <PromptDialog
        open
        title="T"
        label="Reason"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    await userEvent.click(screen.getByTestId("prompt-dialog-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("disables confirm button when required is true and input is blank", () => {
    render(
      <PromptDialog
        open
        title="T"
        label="Reason"
        required
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const confirmBtn = screen.getByTestId(
      "prompt-dialog-confirm"
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("enables confirm once text is typed for required prompt", async () => {
    render(
      <PromptDialog
        open
        title="T"
        label="Reason"
        required
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const confirmBtn = screen.getByTestId(
      "prompt-dialog-confirm"
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    await userEvent.type(screen.getByTestId("prompt-dialog-input"), "hi");
    expect(confirmBtn.disabled).toBe(false);
  });

  it("renders a textarea when multiline is true", () => {
    render(
      <PromptDialog
        open
        title="T"
        label="Notes"
        multiline
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const input = screen.getByTestId("prompt-dialog-input");
    expect(input.tagName).toBe("TEXTAREA");
  });

  it("closes on ESC (onCancel)", () => {
    const onCancel = vi.fn();
    render(
      <PromptDialog
        open
        title="T"
        label="Reason"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("closes on backdrop click", () => {
    const onCancel = vi.fn();
    render(
      <PromptDialog
        open
        title="T"
        label="Reason"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByTestId("prompt-dialog"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("honours initialValue prop", () => {
    render(
      <PromptDialog
        open
        title="T"
        label="Reason"
        initialValue="default text"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const input = screen.getByTestId(
      "prompt-dialog-input"
    ) as HTMLInputElement;
    expect(input.value).toBe("default text");
  });
});
