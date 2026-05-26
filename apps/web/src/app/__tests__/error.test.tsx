/**
 * Covers `apps/web/src/app/error.tsx` — Next.js 15 route-segment error
 * boundary (Issue #65). This boundary fires when an unhandled exception
 * bubbles up from a route under `/(*)` — see the source's docblock for the
 * deploy-time nginx companion piece. Unlike `global-error.tsx`, this file
 * renders inside the regular root layout (so no `<html>`/`<body>` of its
 * own), and additionally surfaces a "Back to dashboard" `<Link>` CTA.
 *
 * Tests cover: the static chrome (testid hook + heading + helper copy +
 * triangular warning glyph + aria-hidden), both CTAs (the Try-again
 * button wired through to the injected `reset()` prop, and the dashboard
 * `<Link>`), the conditional `error.digest` reference line (rendered iff
 * digest is set), and the `useEffect` console.error logging side-effect
 * (on mount + when the `error` prop changes).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import RouteError from "../error";

function buildError(message: string, digest?: string) {
  const err = new Error(message) as Error & { digest?: string };
  if (digest !== undefined) err.digest = digest;
  return err;
}

describe("RouteError — route-level error boundary chrome", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The component logs via console.error inside useEffect; mute it so the
    // test output stays clean, and so we can assert call shape later.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders the boundary container with the testid hook", () => {
    render(<RouteError error={buildError("boom")} reset={vi.fn()} />);
    expect(screen.getByTestId("route-error-boundary")).toBeInTheDocument();
  });

  it("renders the headline + apologetic helper copy", () => {
    render(<RouteError error={buildError("boom")} reset={vi.fn()} />);
    expect(
      screen.getByRole("heading", {
        name: /we'?re experiencing issues/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/medcore couldn'?t complete that request/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/contact your administrator/i),
    ).toBeInTheDocument();
  });

  it("renders the decorative warning glyph as an aria-hidden SVG", () => {
    const { container } = render(
      <RouteError error={buildError("boom")} reset={vi.fn()} />,
    );
    const glyph = container.querySelector('svg[aria-hidden="true"]');
    expect(glyph).not.toBeNull();
    // The triangle path is the giveaway — the alert-triangle "M10.29 3.86 …"
    // start coords. Just sanity-checking we got the right SVG, not some
    // unrelated icon that future refactors might add.
    expect(glyph?.querySelector('path')?.getAttribute('d')).toMatch(/^M10\.29/);
  });
});

describe("RouteError — Try again button wiring", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders the Try again button (testid + label + type=button)", () => {
    render(<RouteError error={buildError("boom")} reset={vi.fn()} />);
    const btn = screen.getByTestId("route-error-retry");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/try again/i);
    expect(btn.getAttribute("type")).toBe("button");
  });

  it("invokes the injected reset() prop on click", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<RouteError error={buildError("boom")} reset={reset} />);
    await user.click(screen.getByTestId("route-error-retry"));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("invokes reset() once per click (multiple clicks → multiple calls)", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<RouteError error={buildError("boom")} reset={reset} />);
    const btn = screen.getByTestId("route-error-retry");
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    expect(reset).toHaveBeenCalledTimes(3);
  });
});

describe("RouteError — Back to dashboard link", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders a 'Back to dashboard' anchor pointing at /dashboard", () => {
    render(<RouteError error={buildError("boom")} reset={vi.fn()} />);
    const link = screen.getByRole("link", { name: /back to dashboard/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/dashboard");
  });
});

describe("RouteError — error.digest conditional reference line", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders 'Reference: <digest>' when error.digest is set", () => {
    render(
      <RouteError
        error={buildError("boom", "abc123-digest-xyz")}
        reset={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/reference:/i),
    ).toBeInTheDocument();
    // The digest itself renders inside a <code>, which getByText splits
    // across nodes. Assert against the <code> node directly.
    const code = screen.getByText("abc123-digest-xyz");
    expect(code.tagName).toBe("CODE");
  });

  it("does NOT render the Reference line when error.digest is absent", () => {
    render(<RouteError error={buildError("boom")} reset={vi.fn()} />);
    expect(screen.queryByText(/reference:/i)).not.toBeInTheDocument();
  });

  it("does NOT render the Reference line when error.digest is the empty string (falsy)", () => {
    render(
      <RouteError error={buildError("boom", "")} reset={vi.fn()} />,
    );
    expect(screen.queryByText(/reference:/i)).not.toBeInTheDocument();
  });
});

describe("RouteError — useEffect console logging side-effect", () => {
  it("logs '[medcore] route error' with the error object on mount", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = buildError("kaboom", "digest-1");
    render(<RouteError error={err} reset={vi.fn()} />);
    expect(spy).toHaveBeenCalledWith("[medcore] route error", err);
    spy.mockRestore();
  });

  it("re-logs when the `error` prop changes (effect dep on `error`)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e1 = buildError("first");
    const { rerender } = render(
      <RouteError error={e1} reset={vi.fn()} />,
    );
    expect(spy).toHaveBeenCalledWith("[medcore] route error", e1);
    const initialCalls = spy.mock.calls.length;
    const e2 = buildError("second");
    rerender(<RouteError error={e2} reset={vi.fn()} />);
    // A new error object must trigger the effect again.
    expect(spy.mock.calls.length).toBeGreaterThan(initialCalls);
    expect(spy).toHaveBeenLastCalledWith("[medcore] route error", e2);
    spy.mockRestore();
  });
});
