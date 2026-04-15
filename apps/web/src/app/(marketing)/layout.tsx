import { ReactNode } from "react";
import type { Metadata } from "next";
import { MarketingNav } from "./_components/MarketingNav";
import { MarketingFooter } from "./_components/MarketingFooter";

// TODO(i18n): Marketing copy is English-only in this pass. A Hindi translation
// is a separate initiative — nav + shared CTAs will reuse common.* keys later.

const SITE_URL = "https://medcore.globusdemos.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "MedCore — Hospital Management Platform",
    template: "%s · MedCore",
  },
  description:
    "MedCore is an end-to-end hospital management platform built for Indian hospitals. OPD queue, prescriptions with QR verification, GST-aware billing, Razorpay integration, patient mobile app, and more — all in one place.",
  keywords: [
    "hospital management software",
    "HMS India",
    "clinic management",
    "OPD queue",
    "digital prescriptions",
    "GST billing",
    "Razorpay hospital",
    "patient app",
    "EHR India",
    "MedCore",
  ],
  authors: [{ name: "Globussoft Technologies" }],
  creator: "Globussoft Technologies",
  publisher: "Globussoft Technologies",
  openGraph: {
    type: "website",
    locale: "en_IN",
    url: SITE_URL,
    siteName: "MedCore",
    title: "MedCore — Hospital Management Platform",
    description:
      "Run your hospital, not spreadsheets. OPD queue, prescriptions, GST billing, and patient mobile app — all in one platform engineered for Indian hospitals.",
    images: [
      {
        url: "/screenshots/03-dashboard-admin.png",
        width: 1440,
        height: 900,
        alt: "MedCore admin dashboard",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "MedCore — Hospital Management Platform",
    description:
      "OPD queue, prescriptions, GST billing, patient mobile app — all in one platform.",
    images: ["/screenshots/03-dashboard-admin.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  alternates: {
    canonical: SITE_URL,
  },
};

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-gray-950">
      <MarketingNav />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <MarketingFooter />
    </div>
  );
}
