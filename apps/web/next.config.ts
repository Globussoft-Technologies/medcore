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
  // Dev-only API proxy. The super-admin onboarding wizard and the tenant
  // management pages call relative paths like `/api/v1/tenant-onboarding`.
  // Without a proxy those hit the Next dev server on :3000 and 404 (Next
  // returns the HTML error page, which the wizard surfaces as
  // "Invalid server response"). In prod the platform sits behind a
  // reverse proxy that already maps /api → the API container; locally we
  // need to do that ourselves. Reads NEXT_PUBLIC_API_URL (without the
  // trailing /api/v1) to derive the origin, falling back to
  // http://localhost:4000.
  async rewrites() {
    const apiUrl =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
    // NEXT_PUBLIC_API_URL is canonically `<origin>/api/v1`; strip the
    // suffix to derive the origin, then re-attach for the rewrite target.
    const origin = apiUrl.replace(/\/api\/v1\/?$/, "");
    return [
      {
        source: "/api/v1/:path*",
        destination: `${origin}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
