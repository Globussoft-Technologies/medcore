// Patient PWA service worker registration (gap #5 pieces 1 + 4 of 4).
// Mounted by `apps/web/src/app/patient/layout.tsx`. Runs once on mount, in the browser only.
// Scope is pinned to `/patient` so this worker NEVER intercepts staff-dashboard
// requests — the install would otherwise default to scope `/` and break the staff app.
// `updateViaCache: "none"` keeps `sw.js` itself uncached so a deploy reliably ships
// the new SW; the post-register `SKIP_WAITING` postMessage lets a freshly-deployed
// SW activate immediately instead of waiting until every tab closes.
"use client";

import { useEffect } from "react";

export function PatientServiceWorkerRegistration(): null {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Defer to after paint so SW registration never blocks first content.
    const onReady = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/patient", updateViaCache: "none" })
        .then((registration) => {
          // If a new SW is already waiting on first registration, ping it to
          // activate immediately. The matching listener in sw.js calls
          // self.skipWaiting() on receipt.
          if (registration && registration.waiting) {
            registration.waiting.postMessage({ type: "SKIP_WAITING" });
          }
        })
        .catch((err) => {
          // Non-fatal: the portal still works without the SW (degrades to
          // network-only). Log so install regressions are visible.
          // eslint-disable-next-line no-console
          console.warn("Patient PWA service worker registration failed", err);
        });
    };
    if (document.readyState === "complete") {
      onReady();
    } else {
      window.addEventListener("load", onReady, { once: true });
      return () => window.removeEventListener("load", onReady);
    }
  }, []);

  return null;
}
