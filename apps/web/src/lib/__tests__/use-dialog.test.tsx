// Tests for apps/web/src/lib/use-dialog.tsx — covers the DialogProvider plus
// useConfirm() / usePrompt() imperative hooks. Exercises the queue head-render
// behaviour, promise resolution on confirm/cancel, prompt input round-trip,
// fallback warnings when the hooks run outside a provider, and that multiple
// concurrent confirm() calls are resolved one-at-a-time in submission order.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  DialogProvider,
  useConfirm,
  usePrompt,
} from "../use-dialog";

function Wrapper({ children }: { children: ReactNode }) {
  return <DialogProvider>{children}</DialogProvider>;
}

describe("DialogProvider + useConfirm", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves true when the confirm button is clicked", async () => {
    const { result } = renderHook(() => useConfirm(), { wrapper: Wrapper });

    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current({ title: "Delete invoice?" });
    });

    // Head of queue renders the dialog.
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    expect(screen.getByText("Delete invoice?")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });

    await expect(promise).resolves.toBe(true);
    // After resolution the dialog unmounts.
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("resolves false when the cancel button is clicked", async () => {
    const { result } = renderHook(() => useConfirm(), { wrapper: Wrapper });
    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current({
        title: "Discard changes?",
        message: "All unsaved edits will be lost.",
        cancelLabel: "Keep editing",
        confirmLabel: "Discard",
        danger: true,
      });
    });

    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(
      screen.getByText("All unsaved edits will be lost.")
    ).toBeInTheDocument();
    expect(screen.getByText("Discard")).toBeInTheDocument();
    expect(screen.getByText("Keep editing")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    });

    await expect(promise).resolves.toBe(false);
  });

  it("queues concurrent confirm() calls and resolves them in order", async () => {
    const { result } = renderHook(() => useConfirm(), { wrapper: Wrapper });
    let p1!: Promise<boolean>;
    let p2!: Promise<boolean>;
    act(() => {
      p1 = result.current({ title: "First?" });
      p2 = result.current({ title: "Second?" });
    });

    // Only the first dialog is rendered (single ConfirmDialog at queue head).
    expect(screen.getByText("First?")).toBeInTheDocument();
    expect(screen.queryByText("Second?")).not.toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });
    await expect(p1).resolves.toBe(true);

    // Second one now takes the head.
    expect(screen.getByText("Second?")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    });
    await expect(p2).resolves.toBe(false);

    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });
});

describe("DialogProvider + usePrompt", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with the typed value on confirm", async () => {
    const { result } = renderHook(() => usePrompt(), { wrapper: Wrapper });
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current({
        title: "Reason?",
        label: "Reason",
        placeholder: "type a reason",
      });
    });

    const input = screen.getByTestId("prompt-dialog-input") as HTMLInputElement;
    expect(input).toBeInTheDocument();

    act(() => {
      fireEvent.change(input, { target: { value: "duplicate entry" } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });

    await expect(promise).resolves.toBe("duplicate entry");
  });

  it("resolves null when cancelled", async () => {
    const { result } = renderHook(() => usePrompt(), { wrapper: Wrapper });
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current({ title: "Note?", label: "Note" });
    });

    act(() => {
      fireEvent.click(screen.getByTestId("prompt-dialog-cancel"));
    });

    await expect(promise).resolves.toBeNull();
  });

  it("supports initialValue and multiline + required flags", async () => {
    const { result } = renderHook(() => usePrompt(), { wrapper: Wrapper });
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current({
        title: "Long note?",
        label: "Long note",
        initialValue: "seed",
        multiline: true,
        required: true,
        confirmLabel: "Submit",
        cancelLabel: "Back",
        message: "Provide a detailed reason.",
      });
    });

    // multiline => textarea, not input.
    const ta = screen.getByTestId("prompt-dialog-input") as HTMLTextAreaElement;
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.value).toBe("seed");
    expect(screen.getByText("Provide a detailed reason.")).toBeInTheDocument();
    expect(screen.getByText("Submit")).toBeInTheDocument();
    expect(screen.getByText("Back")).toBeInTheDocument();

    act(() => {
      fireEvent.change(ta, { target: { value: "elaborate reason" } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });

    await expect(promise).resolves.toBe("elaborate reason");
  });

  it("queues concurrent prompt() calls in submission order", async () => {
    const { result } = renderHook(() => usePrompt(), { wrapper: Wrapper });
    let p1!: Promise<string | null>;
    let p2!: Promise<string | null>;
    act(() => {
      p1 = result.current({ title: "Q1", label: "A" });
      p2 = result.current({ title: "Q2", label: "B" });
    });

    // Only Q1 is rendered.
    expect(screen.getByText("Q1")).toBeInTheDocument();
    expect(screen.queryByText("Q2")).not.toBeInTheDocument();

    act(() => {
      fireEvent.change(screen.getByTestId("prompt-dialog-input"), {
        target: { value: "first answer" },
      });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });
    await expect(p1).resolves.toBe("first answer");

    // Q2 takes the head.
    expect(screen.getByText("Q2")).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByTestId("prompt-dialog-cancel"));
    });
    await expect(p2).resolves.toBeNull();
  });
});

describe("fallback behaviour outside a DialogProvider", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("useConfirm() resolves false and warns when no provider is mounted", async () => {
    const { result } = renderHook(() => useConfirm()); // NO wrapper
    const v = await result.current({ title: "x" });
    expect(v).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("useConfirm() called without a <DialogProvider>")
    );
  });

  it("usePrompt() resolves null and warns when no provider is mounted", async () => {
    const { result } = renderHook(() => usePrompt()); // NO wrapper
    const v = await result.current({ title: "x", label: "y" });
    expect(v).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("usePrompt() called without a <DialogProvider>")
    );
  });
});

describe("DialogProvider mount + children passthrough", () => {
  it("renders its children when no dialogs are queued", () => {
    render(
      <DialogProvider>
        <div data-testid="child-content">hello world</div>
      </DialogProvider>
    );
    expect(screen.getByTestId("child-content")).toHaveTextContent(
      "hello world"
    );
    // No dialog should be visible at rest.
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("prompt-dialog")).not.toBeInTheDocument();
  });
});
