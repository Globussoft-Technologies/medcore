import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@medcore/shared"],
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
    ];
  },
};

export default nextConfig;
