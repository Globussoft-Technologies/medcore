"use client";

/**
 * Issue #65 — Root-level error boundary.
 *
 * Triggered only when an error escapes the route-level `error.tsx` (e.g. a
 * crash inside the root layout itself). Next.js 15 requires this file to
 * render its own <html>/<body>; the regular layout is bypassed.
 *
 * NB: when the upstream Next.js process is down or unreachable, nginx
 * serves its own 502 page and this component is never rendered. The
 * production fix for that is an nginx `error_page` directive — see
 * `docs/DEPLOY.md` ("Maintenance / 502 page") for the recommended config.
 */

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).console) {
      console.error("[medcore] global error", error);
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        data-testid="global-error-boundary"
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          background: "#f9fafb",
          color: "#111827",
          padding: "1.5rem",
        }}
      >
        <div style={{ maxWidth: 480, width: "100%", textAlign: "center" }}>
          <div
            style={{
              margin: "0 auto 1rem",
              width: 56,
              height: 56,
              borderRadius: 16,
              background: "#fee2e2",
              color: "#dc2626",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              fontWeight: 700,
            }}
            aria-hidden="true"
          >
            !
          </div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: 8 }}>
            MedCore is currently experiencing issues
          </h1>
          <p
            style={{
              fontSize: "0.9rem",
              color: "#4b5563",
              marginTop: 0,
              marginBottom: 24,
            }}
          >
            We&apos;re working on it. Please try again in a few minutes.
            If the problem persists, contact your administrator.
          </p>
          <button
            type="button"
            data-testid="global-error-retry"
            onClick={() => reset()}
            style={{
              background: "#2563eb",
              color: "white",
              border: "none",
              borderRadius: 12,
              padding: "0.625rem 1rem",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error?.digest && (
            <p
              style={{
                marginTop: 24,
                fontSize: "0.7rem",
                color: "#9ca3af",
              }}
            >
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
