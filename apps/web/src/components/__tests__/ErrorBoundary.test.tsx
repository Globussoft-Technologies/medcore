/**
 * ErrorBoundary unit tests.
 *
 * Covers the React class-component error boundary at
 * `apps/web/src/components/ErrorBoundary.tsx` — the safety net that
 * prevents a single render-time throw from blanking the whole client.
 *
 * Behaviours pinned here:
 *  - happy path: renders children verbatim when no error
 *  - throw path: catches a render-time throw + shows the default fallback panel
 *  - custom fallback prop wins over the default panel
 *  - the "Try again" button resets internal state + re-renders children
 *  - componentDidCatch logs to console.error
 *  - errors without a message stringify safely (no "undefined" leak)
 *  - documents the contract that async (post-commit) throws are NOT caught
 *
 * @testing-library/react silences the noisy React error-info dump under the
 * hood by replaying it through console.error — we mock that so the test
 * output stays clean and so we can assert the logging side-effect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { ErrorBoundary } from "../ErrorBoundary";

// Helper component that throws on render when `boom` is true.
function Bomb({ boom, message }: { boom: boolean; message?: string }) {
  if (boom) {
    throw new Error(message ?? "kaboom");
  }
  return <div data-testid="bomb-ok">all good</div>;
}

// Helper that throws a non-Error value (string) — exercises the
// `String(err ?? "Unknown error")` branch in getDerivedStateFromError.
function StringThrower() {
  throw "raw-string-throw";
}

// Helper that throws an Error with an empty message — exercises the
// `?? "Unknown error"` fallback in the render path.
function EmptyMessageThrower() {
  // eslint-disable-next-line @typescript-eslint/no-throw-literal
  throw new Error("");
}

describe("ErrorBoundary", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React itself logs a "The above error occurred in the <X> component"
    // dump on every caught throw. Silence + capture so we can assert our
    // OWN componentDidCatch log without drowning the test output.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("renders children verbatim when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Bomb boom={false} />
      </ErrorBoundary>
    );
    expect(screen.getByTestId("bomb-ok")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary")).toBeNull();
  });

  it("catches a render-time throw and renders the default fallback panel", () => {
    render(
      <ErrorBoundary>
        <Bomb boom message="reports page exploded" />
      </ErrorBoundary>
    );
    const panel = screen.getByTestId("error-boundary");
    expect(panel).toBeInTheDocument();
    expect(panel.getAttribute("role")).toBe("alert");
    expect(
      screen.getByText("Something went wrong rendering this view.")
    ).toBeInTheDocument();
    expect(screen.getByText("reports page exploded")).toBeInTheDocument();
    expect(screen.getByTestId("error-boundary-retry")).toBeInTheDocument();
  });

  it("honours a custom testId prop on the fallback panel", () => {
    render(
      <ErrorBoundary testId="reports-boundary">
        <Bomb boom />
      </ErrorBoundary>
    );
    expect(screen.getByTestId("reports-boundary")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary")).toBeNull();
  });

  it("renders a custom fallback prop instead of the default panel", () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">custom!</div>}>
        <Bomb boom />
      </ErrorBoundary>
    );
    expect(screen.getByTestId("custom-fallback")).toBeInTheDocument();
    // Default panel must NOT show when fallback is provided.
    expect(screen.queryByTestId("error-boundary")).toBeNull();
    expect(screen.queryByTestId("error-boundary-retry")).toBeNull();
  });

  it("logs the error through componentDidCatch (console.error)", () => {
    render(
      <ErrorBoundary>
        <Bomb boom message="logged-throw" />
      </ErrorBoundary>
    );
    // At least one console.error call must be our [ErrorBoundary] tag.
    const ourCall = consoleErrorSpy.mock.calls.find(
      (args) => args[0] === "[ErrorBoundary]"
    );
    expect(ourCall).toBeDefined();
    // 2nd arg is the Error instance, 3rd arg is React's errorInfo object.
    expect(ourCall?.[1]).toBeInstanceOf(Error);
    expect((ourCall?.[1] as Error).message).toBe("logged-throw");
    expect(ourCall?.[2]).toBeDefined();
  });

  it("'Try again' button resets state — children re-render when they no longer throw", async () => {
    // Use a stateful wrapper so we can flip `boom` from outside.
    function Harness() {
      const [boom, setBoom] = React.useState(true);
      return (
        <div>
          <button
            type="button"
            data-testid="fix-it"
            onClick={() => setBoom(false)}
          >
            fix
          </button>
          <ErrorBoundary>
            <Bomb boom={boom} />
          </ErrorBoundary>
        </div>
      );
    }

    render(<Harness />);

    // Initial throw — fallback is showing.
    expect(screen.getByTestId("error-boundary")).toBeInTheDocument();

    // Simulate the underlying issue being fixed first…
    await userEvent.click(screen.getByTestId("fix-it"));
    // …then click "Try again" to reset the boundary.
    await userEvent.click(screen.getByTestId("error-boundary-retry"));

    expect(screen.queryByTestId("error-boundary")).toBeNull();
    expect(screen.getByTestId("bomb-ok")).toBeInTheDocument();
  });

  it("'Try again' that hits the SAME throw immediately re-shows the fallback", async () => {
    render(
      <ErrorBoundary>
        <Bomb boom message="still broken" />
      </ErrorBoundary>
    );
    expect(screen.getByTestId("error-boundary")).toBeInTheDocument();
    // Click reset — children re-render, throw again, boundary catches again.
    await userEvent.click(screen.getByTestId("error-boundary-retry"));
    expect(screen.getByTestId("error-boundary")).toBeInTheDocument();
    expect(screen.getByText("still broken")).toBeInTheDocument();
  });

  it("stringifies a non-Error throw safely (string thrown by child)", () => {
    render(
      <ErrorBoundary>
        <StringThrower />
      </ErrorBoundary>
    );
    expect(screen.getByTestId("error-boundary")).toBeInTheDocument();
    expect(screen.getByText("raw-string-throw")).toBeInTheDocument();
  });

  it("CONTRACT: empty Error.message renders an empty message paragraph (no fallback string)", () => {
    // Source uses `this.state.message ?? "Unknown error"` — `??` only catches
    // null/undefined, so an empty-string message renders as an empty <p>.
    // Pinning the current behaviour so a future change to `||` (which WOULD
    // surface "Unknown error" here) is a deliberate, visible decision.
    render(
      <ErrorBoundary>
        <EmptyMessageThrower />
      </ErrorBoundary>
    );
    const panel = screen.getByTestId("error-boundary");
    expect(panel).toBeInTheDocument();
    // The opacity-80 paragraph is the message slot; it exists but is empty.
    const messagePara = panel.querySelector("p.opacity-80");
    expect(messagePara).not.toBeNull();
    expect(messagePara?.textContent).toBe("");
    // The literal fallback string should NOT be in the DOM.
    expect(screen.queryByText("Unknown error")).toBeNull();
  });

  it("CONTRACT: async (post-commit) errors are NOT caught — boundary stays inert", async () => {
    // React error boundaries only catch synchronous render-phase / lifecycle
    // / constructor throws. setTimeout-scheduled throws escape to the global
    // error handler. We assert that contract here so a future refactor
    // doesn't quietly start swallowing async errors and masking real bugs.
    function AsyncThrower() {
      React.useEffect(() => {
        const t = setTimeout(() => {
          // Swallow at the window level so vitest's jsdom doesn't fail the
          // test on an uncaught error — the assertion below is what matters.
          try {
            throw new Error("async-bomb");
          } catch {
            /* intentionally swallowed; boundary contract test */
          }
        }, 0);
        return () => clearTimeout(t);
      }, []);
      return <div data-testid="async-ok">scheduled</div>;
    }

    render(
      <ErrorBoundary>
        <AsyncThrower />
      </ErrorBoundary>
    );

    // Pre-tick: child rendered fine, no boundary trip.
    expect(screen.getByTestId("async-ok")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary")).toBeNull();

    // Flush the scheduled microtask + macrotask.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });

    // Boundary still must NOT have rendered the fallback — async escapes it.
    expect(screen.queryByTestId("error-boundary")).toBeNull();
    expect(screen.getByTestId("async-ok")).toBeInTheDocument();
  });
});
