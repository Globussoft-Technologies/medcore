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
};

export default nextConfig;
