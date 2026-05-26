import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@medcore/shared"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "media.licdn.com" }],
  },
  // Sentry's Node SDK (@sentry/node, pulled in by @sentry/nextjs) wires up
  // OpenTelemetry auto-instrumentation. Its instrumentation classes and the
  // ESM loader hook hard-require `@opentelemetry/instrumentation` and
  // `import-in-the-middle` at runtime. Those packages MUST run un-bundled:
  // listing them in serverExternalPackages keeps them as plain Node
  // `require()`s resolved from node_modules (they are present — hoisted to
  // the monorepo-root node_modules) instead of being pulled into the
  // webpack server bundle, where OTel's dynamic require-in-the-middle
  // patching cannot work.
  //
  // This replaces an earlier `webpack` IgnorePlugin that *excluded* these
  // modules: it assumed they were not installed, but they are. Excluding
  // them left Sentry's instrumentation reading `undefined` exports and
  // crashing the prod server at boot ("Cannot read properties of undefined
  // (reading 'map')"). Dev was unaffected because `next dev` uses Turbopack
  // and ignores webpack config entirely.
  serverExternalPackages: [
    "@sentry/nextjs",
    "@sentry/node",
    "@opentelemetry/instrumentation",
    "import-in-the-middle",
  ],
  async redirects() {
    return [
      // Sidebar uses the short slug `/dashboard/preauth`; users who type the
      // human-readable URL `/dashboard/pre-authorization` previously hit a
      // chromeless 404 (#276).
      {
        source: "/dashboard/pre-authorization",
        destination: "/dashboard/preauth",
        permanent: true,
      },
      // DPDP personal-data export feature lives at /dashboard/patient-data-export;
      // patients hitting the obvious slug /dashboard/data-export got a chromeless
      // 404 (#209). Same /dashboard/account → /dashboard/profile pattern as #303.
      {
        source: "/dashboard/data-export",
        destination: "/dashboard/patient-data-export",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      // The patient SW lives at /sw.js but registers with scope "/patient".
      // Without this header the browser rejects the registration with a
      // SecurityError ("scope is outside the SW's path"), the registration
      // .catch() logs to the console, and Lighthouse's errors-in-console
      // audit scores 0 on every patient route.
      // Also send no-store: the SW file itself must never be cached, so a
      // redeploy reliably ships the new worker (matches the registration's
      // `updateViaCache: "none"` setting).
      {
        source: "/sw.js",
        headers: [
          { key: "Service-Worker-Allowed", value: "/patient" },
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
      // Next.js content-hashes /_next/static/* filenames, so they're safe to
      // cache forever. Without this, Lighthouse flags uses-long-cache-ttl
      // and cache-insight on every page.
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      // Patient PWA icon assets are also versioned by URL — long-cache them.
      {
        source: "/icon-:size*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
