// MedCore Patient PWA service worker — gap #5 piece 1 of 4.
// Vanilla no-op shell: install → skipWaiting; activate → claim clients.
// Scoped to `/patient` at registration time (see PatientServiceWorkerRegistration.tsx)
// so it does NOT intercept staff-dashboard requests.
// Cache strategies (precache app shell, runtime cache for /api/v1/me, etc.) land in piece 4 of 4.
/* eslint-disable no-restricted-globals */

self.addEventListener("install", () => {
  // Take control on first install so subsequent navigations within /patient
  // are handled by this worker immediately.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Adopt any open /patient clients without requiring a manual reload.
  event.waitUntil(self.clients.claim());
});

// Intentionally NO `fetch` handler this tick — letting requests pass through to the
// network keeps piece 1 truly dependency-free and avoids accidentally serving stale
// responses before piece 4 defines the cache strategy.
