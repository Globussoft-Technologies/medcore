import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toast, useToastStore } from "../toast";

describe("toast store", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    useToastStore.setState({ toasts: [] });
  });

  it("toast.success adds a toast to the queue", () => {
    toast.success("Saved!");
    const toasts = useToastStore.getState().toasts;
    expect(toasts.length).toBe(1);
    expect(toasts[0].kind).toBe("success");
    expect(toasts[0].message).toBe("Saved!");
  });

  it("auto-removes after the duration", () => {
    toast.info("Hi", 2000);
    expect(useToastStore.getState().toasts.length).toBe(1);
    vi.advanceTimersByTime(2001);
    expect(useToastStore.getState().toasts.length).toBe(0);
  });

  it("does not auto-remove when duration is 0", () => {
    toast.info("Permanent", 0);
    vi.advanceTimersByTime(10_000);
    expect(useToastStore.getState().toasts.length).toBe(1);
  });

  it("clear() empties the queue", () => {
    toast.success("One", 0);
    toast.error("Two", 0);
    expect(useToastStore.getState().toasts.length).toBe(2);
    useToastStore.getState().clear();
    expect(useToastStore.getState().toasts.length).toBe(0);
  });

  it("dismiss removes only the targeted toast", () => {
    toast.success("Keep", 0);
    toast.error("Drop", 0);
    const list = useToastStore.getState().toasts;
    const target = list.find((t) => t.message === "Drop")!;
    useToastStore.getState().dismiss(target.id);
    const remaining = useToastStore.getState().toasts;
    expect(remaining.length).toBe(1);
    expect(remaining[0].message).toBe("Keep");
  });
});
