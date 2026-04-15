import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ToastContainer } from "../Toast";
import { toast, useToastStore } from "@/lib/toast";

describe("ToastContainer", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });
  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    useToastStore.setState({ toasts: [] });
  });

  it("toast.success pushes a success toast to the queue and renders it", () => {
    render(<ToastContainer />);
    act(() => {
      toast.success("Saved!");
    });
    expect(screen.getByText("Saved!")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("toast.error shows an error toast with red border class", () => {
    render(<ToastContainer />);
    act(() => {
      toast.error("Oops");
    });
    const toastEl = screen.getByRole("status");
    expect(toastEl.className).toContain("border-red-500");
  });

  it("success toast has green border class", () => {
    render(<ToastContainer />);
    act(() => {
      toast.success("OK");
    });
    expect(screen.getByRole("status").className).toContain("border-green-500");
  });

  it("auto-dismisses after 4 seconds", () => {
    render(<ToastContainer />);
    act(() => {
      toast.info("Hi", 4000);
    });
    expect(screen.getByText("Hi")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4001);
    });
    expect(screen.queryByText("Hi")).toBeNull();
  });

  it("multiple toasts stack in the container", () => {
    render(<ToastContainer />);
    act(() => {
      toast.success("One");
      toast.success("Two");
      toast.success("Three");
    });
    expect(screen.getAllByRole("status").length).toBe(3);
  });

  it("close button removes the toast", () => {
    render(<ToastContainer />);
    act(() => {
      toast.info("Close me", 0);
    });
    const btn = screen.getByLabelText("Dismiss notification");
    act(() => {
      fireEvent.click(btn);
    });
    expect(screen.queryByText("Close me")).toBeNull();
  });

  it("toasts use role=status for accessibility", () => {
    render(<ToastContainer />);
    act(() => {
      toast.warning("Heads up");
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders nothing when there are no toasts", () => {
    const { container } = render(<ToastContainer />);
    expect(container.firstChild).toBeNull();
  });
});
