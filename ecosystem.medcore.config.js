module.exports = {
  apps: [
    {
      name: "medcore-api",
      // 2026-05-18: PM2 was crash-looping with `sh: 1: tsx: not found`
      // (515 restarts on this box). Cause: `npx tsx` searches
      // ./node_modules/.bin/ from cwd, and with npm workspaces tsx is
      // installed at `apps/api/node_modules/.bin/tsx`, NOT at the root.
      // Switching to the workspace-local binary path makes the lookup
      // deterministic and avoids npx fallbacks (which would otherwise
      // try to network-fetch tsx and fail behind firewalls).
      script: "./apps/api/node_modules/.bin/tsx",
      args: "apps/api/src/index.ts",
      cwd: "/home/empcloud-development/medcore",
      env: {
        PORT: 4100,
        NODE_ENV: "production",
        // DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, CORS_ORIGIN
        // should be set in .env file on the server
      },
    },
    {
      name: "medcore-web",
      // Same fix class as medcore-api above — use the workspace-local
      // next binary directly. apps/web/node_modules/.bin/next is the
      // canonical path; cwd stays apps/web so .next + public paths
      // resolve correctly.
      script: "./node_modules/.bin/next",
      args: "start -p 3200",
      cwd: "/home/empcloud-development/medcore/apps/web",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
