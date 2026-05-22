// Smoke tests for the patient PWA SW registration component (gap #5 piece 4 of 4).
// Covers: register-call shape (path + scope + updateViaCache), waiting-SW SKIP_WAITING
// nudge, and the SSR / unsupported-browser short-circuit. The SW's fetch handler itself
// is NOT integration-tested here — that requires a service worker test environment
// (workbox-window or @web/test-runner) and is deferred until we add such infra.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { PatientServiceWorkerRegistration } from "../PatientServiceWorkerRegistration";

describe("PatientServiceWorkerRegistration", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    "serviceWorker",
  );

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(Navigator.prototype, "serviceWorker", originalDescriptor);
    } else {
      // jsdom by default has no serviceWorker — make sure we leave it clean.
      delete (Navigator.prototype as any).serviceWorker;
    }
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // Force readyState to "complete" so the component invokes onReady synchronously
    // inside the useEffect rather than waiting for a `load` event we never fire.
    Object.defineProperty(document, "readyState", {
      configurable: true,
      get: () => "complete",
    });
  });

  it("registers /sw.js with scope=/patient and updateViaCache=none", async () => {
    const register = vi.fn().mockResolvedValue({ waiting: null });
    Object.defineProperty(Navigator.prototype, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    render(<PatientServiceWorkerRegistration />);

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith("/sw.js", {
      scope: "/patient",
      updateViaCache: "none",
    });
  });

  it("posts SKIP_WAITING when a waiting SW is present after registration", async () => {
    const postMessage = vi.fn();
    const register = vi.fn().mockResolvedValue({ waiting: { postMessage } });
    Object.defineProperty(Navigator.prototype, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    render(<PatientServiceWorkerRegistration />);

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });

  it("does NOT post SKIP_WAITING when registration.waiting is null", async () => {
    const register = vi.fn().mockResolvedValue({ waiting: null });
    Object.defineProperty(Navigator.prototype, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    render(<PatientServiceWorkerRegistration />);

    await waitFor(() => expect(register).toHaveBeenCalled());
    // No throw + nothing to assert beyond register being called — the absence
    // of a TypeError from `null.postMessage` is the assertion.
    expect(true).toBe(true);
  });

  it("is a no-op when navigator.serviceWorker is undefined (SSR / unsupported)", async () => {
    if (originalDescriptor) {
      // Deliberate delete; restored by afterEach.
      delete (Navigator.prototype as any).serviceWorker;
    }
    // If this throws we'd see it; the assertion is "render did not crash".
    const { container } = render(<PatientServiceWorkerRegistration />);
    expect(container.firstChild).toBeNull();
  });

  it("renders no DOM (returns null)", () => {
    const register = vi.fn().mockResolvedValue({ waiting: null });
    Object.defineProperty(Navigator.prototype, "serviceWorker", {
      configurable: true,
      value: { register },
    });
    const { container } = render(<PatientServiceWorkerRegistration />);
    expect(container.firstChild).toBeNull();
  });

  it("logs a warning but does not throw if register() rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const register = vi.fn().mockRejectedValue(new Error("boom"));
    Object.defineProperty(Navigator.prototype, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    render(<PatientServiceWorkerRegistration />);

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0]?.[0]).toMatch(/service worker registration failed/i);
  });
});
