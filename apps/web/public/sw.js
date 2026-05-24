// MedCore Patient PWA service worker — gap #5 piece 4 of 4 + Pearl §6.2 rows 196/393.
// Vanilla JS (no transpile, no workbox, no next-pwa). Scoped to `/patient` at
// registration time (see PatientServiceWorkerRegistration.tsx) so this worker
// does NOT intercept staff-dashboard (`/dashboard/*`) requests.
//
// Strategy (runtime-only — we never precache routes the user hasn't visited):
//   * `/patient/*` HTML navigations → network-first, fallback to cache, fallback
//     to cached `/patient` shell as offline page.
//   * `/_next/static/*`, `/icon-*`, `/manifest.webmanifest`, `*.css`, `*.js`
//     static assets → cache-first with background revalidate (stale-while-revalidate).
//   * Allow-listed `/api/v1/{prescriptions,appointments,lab/orders}` GETs
//     (patient's own auto-scoped read-only PHI) → stale-while-revalidate with
//     24h max-age, served from `medcore-patient-records-swr-v1`. Cache purged on
//     logout via `postMessage({type:'patient-cache-clear'})`.
//   * All other `/api/*` and `/login`-shaped requests → never intercepted (auth
//     + non-allow-listed PHI must always be fresh; no offline data sync).
//   * Non-GET requests, cross-origin requests → never intercepted.
//
// To verify locally:
//   1. npm run dev:web
//   2. Open /patient in Chrome
//   3. DevTools → Application → Service Workers → confirm sw.js is "activated and running"
//   4. Reload, then DevTools → Network → throttle to Offline
//   5. Reload again — patient shell + last-visited /patient/* page should still render
//   6. Allow-listed /api/v1/prescriptions etc. surface cached data offline; other /api/*
//      requests fail (expected — no offline data sync for those paths)
/* eslint-disable no-restricted-globals */

// Bump the version suffix on cache-shape changes so activate() purges old caches.
const CACHE_NAME = "medcore-patient-v1";
// Separate bucket for allow-listed /api/v1 PHI GETs so we can purge it on logout
// without nuking the shell + static asset cache. Bump to -v2 if the allow-list shape
// changes (e.g. adding `/api/v1/bills` would warrant a version bump).
const RECORDS_CACHE_NAME = "medcore-patient-records-swr-v1";
// Max-age for cached PHI responses. After this, the cached copy is treated as a
// miss and the network response is required. 24h matches the Pearl §6.2 contract
// "Read-only PHI views must remain viewable offline (last successful response)".
const RECORDS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OFFLINE_SHELL_URL = "/patient";

// Allow-list for the PHI SWR cache. Strict prefix-match — anything not on this
// list (e.g. `/api/v1/patients/me`, `/api/v1/bills`) bypasses the cache and goes
// straight to network. Every entry below is a PATIENT-owned read-only GET that
// the API auto-scopes server-side to `req.user.patientId` so a cached response
// can only belong to the currently-signed-in patient.
const RECORDS_API_PREFIXES = [
  "/api/v1/prescriptions",
  "/api/v1/appointments",
  "/api/v1/lab/orders",
];

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
          .filter((k) => k !== CACHE_NAME && k !== RECORDS_CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Allow the page to ask a waiting SW to activate immediately (paired with
// `registration.waiting.postMessage({type:'SKIP_WAITING'})` in the registration
// component) so a freshly-deployed SW doesn't sit waiting until every tab closes.
// Also listen for an explicit cache-purge ping fired on patient logout so the
// next signed-in patient never sees the prior patient's cached PHI.
self.addEventListener("message", (event) => {
  if (!event || !event.data) return;
  if (event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (event.data.type === "patient-cache-clear") {
    event.waitUntil(caches.delete(RECORDS_CACHE_NAME).catch(() => undefined));
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

  // Branch A0 — allow-listed PHI GETs go through the records SWR cache.
  // Checked BEFORE the blanket `/api/` bypass below so the allow-list wins.
  if (isAllowListedRecordsApi(url.pathname)) {
    event.respondWith(handleRecordsApi(request));
    return;
  }

  // Guard 3 — never intercept non-allow-listed API or auth flows. PHI + tokens
  // outside the allow-list must always be fresh.
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

// Strict allow-list check for the PHI SWR cache. Matches exact path OR `/:id`
// sub-path under each prefix — NOT bare `/api/v1/prescriptions-something-else`.
function isAllowListedRecordsApi(pathname) {
  for (const prefix of RECORDS_API_PREFIXES) {
    if (pathname === prefix) return true;
    if (pathname.startsWith(prefix + "/")) return true;
  }
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

// Stale-while-revalidate for the allow-listed PHI GETs. Contract:
//   * Cache hit + fresh (< 24h) → serve cached immediately + background-refresh.
//   * Cache hit + stale (≥ 24h) → ignore cached, treat as miss; require network.
//   * Cache miss → await network; cache on 200; let 4xx/5xx through uncached.
//   * Network fail + cached (any age) → serve cached as the offline fallback.
//   * Network fail + no cache → re-throw (lets the browser surface the failure
//     rather than fabricating a response that lies to the UI).
async function handleRecordsApi(request) {
  const cache = await caches.open(RECORDS_CACHE_NAME);
  const cached = await cache.match(request);
  const cachedFresh = cached ? !isRecordsCacheStale(cached) : false;

  const revalidate = fetch(request)
    .then((response) => {
      // Only persist 200-class responses. 4xx/5xx never overwrite a good cached
      // copy and never create a poisoned cache entry on first miss.
      if (response && response.ok) {
        const stamped = stampWithCacheTimestamp(response.clone());
        cache.put(request, stamped).catch(() => {});
      }
      return response;
    })
    .catch(() => undefined);

  // Fresh cache hit → return immediately, let the revalidate run in the background.
  if (cached && cachedFresh) {
    return cached;
  }

  // Stale or no cache → must await network. On failure, fall back to whatever
  // cached copy we have (even stale) so the patient keeps seeing data offline.
  const fresh = await revalidate;
  if (fresh) return fresh;
  if (cached) return cached;
  // No cache + no network → 504 so the UI surfaces the failure clearly.
  return new Response(
    JSON.stringify({ success: false, error: "offline" }),
    {
      status: 504,
      statusText: "Gateway Timeout",
      headers: { "Content-Type": "application/json" },
    },
  );
}

// Stamp a Response with the cache-write timestamp via a custom header so a later
// hit can decide if it's still fresh. Cloning + re-constructing is required
// because Response.headers is immutable once the response is consumed.
function stampWithCacheTimestamp(response) {
  const headers = new Headers(response.headers);
  headers.set("x-sw-cached-at", String(Date.now()));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isRecordsCacheStale(response) {
  const stamp = response.headers.get("x-sw-cached-at");
  if (!stamp) return true;
  const cachedAt = Number(stamp);
  if (!Number.isFinite(cachedAt)) return true;
  return Date.now() - cachedAt > RECORDS_MAX_AGE_MS;
}
