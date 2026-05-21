// Segment-scoped PWA manifest for the patient surface (Pearl §6.2 — gap #5 piece 1 of 4).
// Distinct from the root manifest at `apps/web/src/app/manifest.ts` (staff dashboard).
// `start_url: "/patient"` + `scope: "/patient"` together ensure that when a user installs
// this as a home-screen app, opening it lands on the patient portal — and the installed app
// cannot leak into the staff dashboard route tree. Icons are intentionally shared with the
// root manifest this tick — per-tenant hydration is piece 3.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MedCore — Patient Portal",
    short_name: "Patient Portal",
    description:
      "Book appointments, view prescriptions, pay bills, and access your records.",
    start_url: "/patient",
    scope: "/patient",
    id: "/patient",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#0f172a",
    categories: ["medical", "health", "productivity"],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
