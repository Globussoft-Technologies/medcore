// Patient PWA route group layout (Pearl §6.1 / §6.2 — gap #5 piece 1 of 4).
//
// This file is intentionally a SERVER component so `metadata` + `viewport`
// can be exported (Next.js disallows those exports from a client file). The
// pathname-dependent chrome swap (bare PWA shell vs. staff /dashboard
// chrome on the /patient/dashboard route) lives in PatientLayoutShell —
// see that file's header for the why.
import type { Metadata, Viewport } from "next";
import { PatientLayoutShell } from "./_components/PatientLayoutShell";

export const metadata: Metadata = {
  title: "Patient Portal — MedCore",
  description:
    "Book appointments, view prescriptions, pay bills, and access your records.",
  // Per-segment manifest (Next 14+); see ./manifest.ts.
  manifest: "/patient/manifest.webmanifest",
  appleWebApp: {
    title: "Patient Portal",
    capable: true,
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0f172a",
};

export default function PatientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PatientLayoutShell>{children}</PatientLayoutShell>;
}
