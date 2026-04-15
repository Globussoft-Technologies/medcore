import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/features", "/solutions", "/pricing", "/about", "/contact"],
        // Keep the authenticated app out of search indexes.
        disallow: ["/dashboard", "/dashboard/*", "/api", "/api/*", "/verify/rx/*"],
      },
    ],
    sitemap: "https://medcore.globusdemos.com/sitemap.xml",
    host: "https://medcore.globusdemos.com",
  };
}
