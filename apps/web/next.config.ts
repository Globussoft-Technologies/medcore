import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@medcore/shared"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "media.licdn.com" }],
  },
  // Sentry's @sentry/node ships static requires for OpenTelemetry tracing
  // integrations against many optional npm packages (amqplib, ioredis,
  // kafkajs, mysql, mysql2, pg-native, etc.) and the base
  // `@opentelemetry/instrumentation` engine. MedCore does not use these
  // libraries so they are not in node_modules; webpack still tries to
  // resolve the static requires at build time and fails. IgnorePlugin
  // suppresses the unresolved-module warning AND emits a stub at the
  // import site, so Sentry's dynamic-require fallback no-ops at runtime
  // (it gracefully detects the missing module and skips that integration).
  //
  // Triggered after the 2026-05-06 lockfile regeneration which dropped
  // optional transitive deps that npm had previously hoisted by chance.
  webpack: (config, { webpack }) => {
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp:
          /^(@opentelemetry\/instrumentation(-(amqplib|connect|dataloader|fs|generic-pool|graphql|hapi|http|ioredis|kafkajs|knex|koa|lru-memoizer|mongodb|mongoose|mysql|mysql2|pg|redis|redis-4|tedious))?|@fastify\/otel|@prisma\/instrumentation|import-in-the-middle)$/,
      }),
    );
    return config;
  },
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
