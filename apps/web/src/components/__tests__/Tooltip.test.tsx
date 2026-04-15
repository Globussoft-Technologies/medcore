import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { Tooltip, InfoIcon } from "../Tooltip";

describe("Tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it("renders tooltip content but hidden (opacity-0) by default", () => {
    render(
      <Tooltip content="Hello">
        <button>child</button>
      </Tooltip>
    );
    const tt = screen.getByRole("tooltip");
    expect(tt).toHaveClass("opacity-0");
  });

  it("shows on hover after the delay", () => {
    render(
      <Tooltip content="Hovered" delay={100}>
        <button>child</button>
      </Tooltip>
    );
    const wrapper = screen.getByRole("tooltip").parentElement!;
    act(() => {
      fireEvent.mouseEnter(wrapper);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByRole("tooltip")).toHaveClass("opacity-100");
  });

  it("hides after mouseleave", () => {
    render(
      <Tooltip content="Bye" delay={0}>
        <button>child</button>
      </Tooltip>
    );
    const wrapper = screen.getByRole("tooltip").parentElement!;
    act(() => {
      fireEvent.mouseEnter(wrapper);
      vi.advanceTimersByTime(5);
    });
    expect(screen.getByRole("tooltip")).toHaveClass("opacity-100");
    act(() => {
      fireEvent.mouseLeave(wrapper);
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByRole("tooltip")).toHaveClass("opacity-0");
  });

  it("shows on focus for keyboard users", () => {
    render(
      <Tooltip content="Focused" delay={0}>
        <button>child</button>
      </Tooltip>
    );
    const wrapper = screen.getByRole("tooltip").parentElement!;
    act(() => {
      fireEvent.focus(wrapper);
      vi.advanceTimersByTime(5);
    });
    expect(screen.getByRole("tooltip")).toHaveClass("opacity-100");
  });

  it("applies position classes for each position prop", () => {
    const { rerender } = render(
      <Tooltip content="x" position="top">
        <span>c</span>
      </Tooltip>
    );
    expect(screen.getByRole("tooltip").className).toContain("bottom-full");
    rerender(
      <Tooltip content="x" position="bottom">
        <span>c</span>
      </Tooltip>
    );
    expect(screen.getByRole("tooltip").className).toContain("top-full");
    rerender(
      <Tooltip content="x" position="left">
        <span>c</span>
      </Tooltip>
    );
    expect(screen.getByRole("tooltip").className).toContain("right-full");
    rerender(
      <Tooltip content="x" position="right">
        <span>c</span>
      </Tooltip>
    );
    expect(screen.getByRole("tooltip").className).toContain("left-full");
  });

  it("InfoIcon renders a button and a tooltip from its tooltip prop", () => {
    render(<InfoIcon tooltip="More info" />);
    expect(screen.getByRole("button", { name: /more info/i })).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("More info");
  });
});
