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
