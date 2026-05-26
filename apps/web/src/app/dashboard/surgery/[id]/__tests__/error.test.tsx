/**
 * Covers `apps/web/src/app/dashboard/surgery/[id]/error.tsx` — Next.js 15
 * App Router route-segment error boundary for the surgery detail page
 * (Issue #86). This boundary fires when an unhandled render error escapes
 * inside `/dashboard/surgery/[id]`, e.g. a null-deref on
 * `surgery.ot.dailyRate.toFixed(...)` or a stale fetch returning a partial
 * object — and keeps the dashboard chrome alive while giving the user a
 * Retry CTA + a Back-to-Surgery link instead of a hard 503.
 *
 * Tests cover: the static chrome (testid + role=alert + heading + helper
 * copy), the Retry button wiring through to the injected `reset()` prop,
 * the Back-to-Surgery link href, the conditional `error.digest` reference
 * line (rendered iff digest is set), and the `useEffect` console.error
 * logging side-effect (on mount + on error-prop change).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SurgeryDetailError from "../error";

function buildError(message: string, digest?: string) {
  const err = new Error(message) as Error & { digest?: string };
  if (digest !== undefined) err.digest = digest;
  return err;
}

describe("SurgeryDetailError — boundary chrome", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The component logs via console.error inside useEffect; mute it so the
    // test output stays clean, and so we can assert call shape.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders the boundary container with the testid hook", () => {
    render(<SurgeryDetailError error={buildError("boom")} reset={vi.fn()} />);
    expect(screen.getByTestId("surgery-detail-error")).toBeInTheDocument();
  });

  it("renders the container with role=alert for assistive tech", () => {
    render(<SurgeryDetailError error={buildError("boom")} reset={vi.fn()} />);
    const container = screen.getByTestId("surgery-detail-error");
    expect(container.getAttribute("role")).toBe("alert");
  });

  it("renders the 'Could not load this surgery' headline", () => {
    render(<SurgeryDetailError error={buildError("boom")} reset={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: /could not load this surgery/i }),
    ).toBeInTheDocument();
  });

  it("renders the error.message body when message is non-empty", () => {
    render(
      <SurgeryDetailError
        error={buildError("OT dailyRate is null")}
        reset={vi.fn()}
      />,
    );
    expect(screen.getByText(/ot dailyrate is null/i)).toBeInTheDocument();
  });

  it("renders the fallback copy when error.message is the empty string (falsy)", () => {
    render(<SurgeryDetailError error={buildError("")} reset={vi.fn()} />);
    expect(
      screen.getByText(
        /an unexpected error occurred while rendering this page\./i,
      ),
    ).toBeInTheDocument();
  });
});

describe("SurgeryDetailError — Retry button wiring", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders the Retry button with the visible label", () => {
    render(<SurgeryDetailError error={buildError("boom")} reset={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /retry/i }),
    ).toBeInTheDocument();
  });

  it("invokes the injected reset() prop on click", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<SurgeryDetailError error={buildError("boom")} reset={reset} />);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("invokes reset() once per click (multiple clicks → multiple calls)", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<SurgeryDetailError error={buildError("boom")} reset={reset} />);
    const btn = screen.getByRole("button", { name: /retry/i });
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    expect(reset).toHaveBeenCalledTimes(3);
  });
});

describe("SurgeryDetailError — Back to Surgery link", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders the Back-to-Surgery link pointing at /dashboard/surgery", () => {
    render(<SurgeryDetailError error={buildError("boom")} reset={vi.fn()} />);
    const link = screen.getByRole("link", { name: /back to surgery/i });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/dashboard/surgery");
  });
});

describe("SurgeryDetailError — error.digest conditional reference line", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders 'Reference: <digest>' when error.digest is set", () => {
    render(
      <SurgeryDetailError
        error={buildError("boom", "abc123-digest-xyz")}
        reset={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/reference:\s*abc123-digest-xyz/i),
    ).toBeInTheDocument();
  });

  it("does NOT render the Reference line when error.digest is absent", () => {
    render(<SurgeryDetailError error={buildError("boom")} reset={vi.fn()} />);
    expect(screen.queryByText(/reference:/i)).not.toBeInTheDocument();
  });

  it("does NOT render the Reference line when error.digest is the empty string (falsy)", () => {
    render(
      <SurgeryDetailError error={buildError("boom", "")} reset={vi.fn()} />,
    );
    expect(screen.queryByText(/reference:/i)).not.toBeInTheDocument();
  });
});

describe("SurgeryDetailError — useEffect console logging side-effect", () => {
  it("logs '[surgery/[id]/error]' with the error object on mount", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = buildError("kaboom", "digest-1");
    render(<SurgeryDetailError error={err} reset={vi.fn()} />);
    expect(spy).toHaveBeenCalledWith("[surgery/[id]/error]", err);
    spy.mockRestore();
  });

  it("re-logs when the `error` prop changes (effect dep on `error`)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e1 = buildError("first");
    const { rerender } = render(
      <SurgeryDetailError error={e1} reset={vi.fn()} />,
    );
    expect(spy).toHaveBeenCalledWith("[surgery/[id]/error]", e1);
    const initialCalls = spy.mock.calls.length;
    const e2 = buildError("second");
    rerender(<SurgeryDetailError error={e2} reset={vi.fn()} />);
    // A new error object must trigger the effect again.
    expect(spy.mock.calls.length).toBeGreaterThan(initialCalls);
    expect(spy).toHaveBeenLastCalledWith("[surgery/[id]/error]", e2);
    spy.mockRestore();
  });
});
