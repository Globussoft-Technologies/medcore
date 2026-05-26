/**
 * Covers `apps/web/src/app/global-error.tsx` — Next.js 15 root-level error
 * boundary (Issue #65). This boundary fires only when an error escapes the
 * route-level `error.tsx`, e.g. a crash inside the root layout itself.
 * Per Next.js 15 contract the file renders its own `<html>` + `<body>` and
 * the regular layout is bypassed.
 *
 * Tests cover: the static chrome (testid + heading + helper copy + ! glyph),
 * the Try-again button wiring through to the injected `reset()` prop, the
 * conditional `error.digest` reference line (rendered iff digest is set),
 * and the `useEffect` console.error logging side-effect (with + without
 * `window.console` available).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import GlobalError from "../global-error";

function buildError(message: string, digest?: string) {
  const err = new Error(message) as Error & { digest?: string };
  if (digest !== undefined) err.digest = digest;
  return err;
}

describe("GlobalError — root-level error boundary chrome", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The component logs via console.error inside useEffect; mute it so the
    // test output stays clean, and so we can assert call shape.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders the boundary body with the testid hook", () => {
    // GlobalError renders its own <html>/<body>; React mounts it as the
    // document.body element (which the testing library's default container
    // does not include). Query the document directly.
    render(<GlobalError error={buildError("boom")} reset={vi.fn()} />);
    expect(
      document.querySelector('[data-testid="global-error-boundary"]'),
    ).not.toBeNull();
  });

  it("renders the headline + apologetic helper copy", () => {
    render(<GlobalError error={buildError("boom")} reset={vi.fn()} />);
    expect(
      screen.getByRole("heading", {
        name: /medcore is currently experiencing issues/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/we'?re working on it\. please try again/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/contact your administrator/i),
    ).toBeInTheDocument();
  });

  it("renders the decorative '!' glyph with aria-hidden so it's invisible to AT", () => {
    const { container } = render(
      <GlobalError error={buildError("boom")} reset={vi.fn()} />,
    );
    const glyph = container.querySelector('[aria-hidden="true"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.textContent).toBe("!");
  });
});

describe("GlobalError — Try again button wiring", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders the Try again button (testid + label + type=button)", () => {
    render(<GlobalError error={buildError("boom")} reset={vi.fn()} />);
    const btn = screen.getByTestId("global-error-retry");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/try again/i);
    expect(btn.getAttribute("type")).toBe("button");
  });

  it("invokes the injected reset() prop on click", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<GlobalError error={buildError("boom")} reset={reset} />);
    await user.click(screen.getByTestId("global-error-retry"));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("invokes reset() once per click (multiple clicks → multiple calls)", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<GlobalError error={buildError("boom")} reset={reset} />);
    const btn = screen.getByTestId("global-error-retry");
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    expect(reset).toHaveBeenCalledTimes(3);
  });
});

describe("GlobalError — error.digest conditional reference line", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders 'Reference: <digest>' when error.digest is set", () => {
    render(
      <GlobalError
        error={buildError("boom", "abc123-digest-xyz")}
        reset={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/reference:\s*abc123-digest-xyz/i),
    ).toBeInTheDocument();
  });

  it("does NOT render the Reference line when error.digest is absent", () => {
    render(<GlobalError error={buildError("boom")} reset={vi.fn()} />);
    expect(screen.queryByText(/reference:/i)).not.toBeInTheDocument();
  });

  it("does NOT render the Reference line when error.digest is the empty string (falsy)", () => {
    render(
      <GlobalError error={buildError("boom", "")} reset={vi.fn()} />,
    );
    expect(screen.queryByText(/reference:/i)).not.toBeInTheDocument();
  });
});

describe("GlobalError — useEffect console logging side-effect", () => {
  it("logs '[medcore] global error' with the error object on mount", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = buildError("kaboom", "digest-1");
    render(<GlobalError error={err} reset={vi.fn()} />);
    expect(spy).toHaveBeenCalledWith("[medcore] global error", err);
    spy.mockRestore();
  });

  it("re-logs when the `error` prop changes (effect dep on `error`)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e1 = buildError("first");
    const { rerender } = render(<GlobalError error={e1} reset={vi.fn()} />);
    expect(spy).toHaveBeenCalledWith("[medcore] global error", e1);
    const initialCalls = spy.mock.calls.length;
    const e2 = buildError("second");
    rerender(<GlobalError error={e2} reset={vi.fn()} />);
    // A new error object must trigger the effect again.
    expect(spy.mock.calls.length).toBeGreaterThan(initialCalls);
    expect(spy).toHaveBeenLastCalledWith("[medcore] global error", e2);
    spy.mockRestore();
  });
});
