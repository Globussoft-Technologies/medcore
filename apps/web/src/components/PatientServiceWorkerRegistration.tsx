// Patient PWA service worker registration (gap #5 piece 1 of 4).
// Mounted by `apps/web/src/app/patient/layout.tsx`. Runs once on mount, in the browser only.
// Scope is pinned to `/patient` so this worker NEVER intercepts staff-dashboard
// requests — the install would otherwise default to scope `/` and break the staff app.
"use client";

import { useEffect } from "react";

export function PatientServiceWorkerRegistration(): null {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Defer to after paint so SW registration never blocks first content.
    const onReady = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/patient" })
        .catch((err) => {
          // Non-fatal: the portal still works without the SW (piece 1 ships no
          // cache strategy yet). Log so install regressions are visible.
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
