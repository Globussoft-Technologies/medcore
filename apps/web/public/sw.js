// MedCore Patient PWA service worker — gap #5 piece 4 of 4.
// Vanilla JS (no transpile, no workbox, no next-pwa). Scoped to `/patient` at
// registration time (see PatientServiceWorkerRegistration.tsx) so this worker
// does NOT intercept staff-dashboard (`/dashboard/*`) requests.
//
// Strategy (runtime-only — we never precache routes the user hasn't visited):
//   * `/patient/*` HTML navigations → network-first, fallback to cache, fallback
//     to cached `/patient` shell as offline page.
//   * `/_next/static/*`, `/icon-*`, `/manifest.webmanifest`, `*.css`, `*.js`
//     static assets → cache-first with background revalidate (stale-while-revalidate).
//   * `/api/*` and `/login`-shaped requests → never intercepted (auth + PHI must
//     always be fresh; no offline data sync this version).
//   * Non-GET requests, cross-origin requests → never intercepted.
//
// To verify locally:
//   1. npm run dev:web
//   2. Open /patient in Chrome
//   3. DevTools → Application → Service Workers → confirm sw.js is "activated and running"
//   4. Reload, then DevTools → Network → throttle to Offline
//   5. Reload again — patient shell + last-visited /patient/* page should still render
//   6. /api/* requests fail (expected — no offline data sync this version)
/* eslint-disable no-restricted-globals */

// Bump the version suffix on cache-shape changes so activate() purges old caches.
const CACHE_NAME = "medcore-patient-v1";
const OFFLINE_SHELL_URL = "/patient";

self.addEventListener("install", () => {
  // Take control on first install so subsequent navigations within /patient
  // are handled by this worker immediately. NO precache list — runtime-only.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Adopt any open /patient clients without requiring a manual reload + purge
  // any older cache buckets so a SW bump doesn't accumulate stale storage.
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Allow the page to ask a waiting SW to activate immediately (paired with
// `registration.waiting.postMessage({type:'SKIP_WAITING'})` in the registration
// component) so a freshly-deployed SW doesn't sit waiting until every tab closes.
self.addEventListener("message", (event) => {
  if (event && event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Guard 1 — only GETs are cacheable (POST/PATCH/DELETE always go straight to network).
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_e) {
    return;
  }

  // Guard 2 — never intercept cross-origin (CDN, Razorpay scripts, analytics, etc.).
  if (url.origin !== self.location.origin) return;

  // Guard 3 — never intercept API or auth flows. PHI + tokens must always be fresh.
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return;
  if (url.pathname.startsWith("/patient/login")) return;

  // Branch A — HTML navigations under /patient → network-first, fallback to cache,
  // fallback to cached /patient shell as offline page.
  if (
    request.mode === "navigate" &&
    (url.pathname === OFFLINE_SHELL_URL || url.pathname.startsWith("/patient/"))
  ) {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Branch B — static assets → cache-first with background revalidate.
  if (isStaticAsset(url.pathname)) {
    event.respondWith(handleStaticAsset(request));
    return;
  }

  // Everything else under our scope falls through to the network.
});

function isStaticAsset(pathname) {
  if (pathname.startsWith("/_next/static/")) return true;
  if (pathname.startsWith("/icon-")) return true;
  if (pathname === "/manifest.webmanifest") return true;
  if (pathname === "/patient/manifest.webmanifest") return true;
  if (pathname.endsWith(".css")) return true;
  if (pathname.endsWith(".js")) return true;
  if (pathname.endsWith(".woff")) return true;
  if (pathname.endsWith(".woff2")) return true;
  return false;
}

async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    // Network-first: try the live response, cache a clone on success.
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone()).catch(() => {});
    }
    return networkResponse;
  } catch (_err) {
    // Offline path: cached version of THIS exact URL → cached /patient shell
    // → synthesized minimal "you're offline" HTML.
    const cachedExact = await cache.match(request);
    if (cachedExact) return cachedExact;
    const cachedShell = await cache.match(OFFLINE_SHELL_URL);
    if (cachedShell) return cachedShell;
    return new Response(
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Offline</title></head><body style=\"font-family:system-ui;padding:24px;max-width:480px;margin:0 auto\"><h1>You're offline</h1><p>Reconnect to load the latest data. Previously viewed pages may still be available.</p></body></html>",
      {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

async function handleStaticAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  // Stale-while-revalidate: always kick off a background fetch + cache update,
  // return the cached version immediately if we have one.
  const revalidate = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => undefined);
  if (cached) return cached;
  const fresh = await revalidate;
  if (fresh) return fresh;
  // Last resort: an empty 504 so the browser surfaces the failure rather than
  // hanging on the in-flight revalidate.
  return new Response("", { status: 504, statusText: "Gateway Timeout" });
}
