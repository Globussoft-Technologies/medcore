import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { ToastContainer } from "@/components/Toast";
import { ThemeBootstrap } from "@/components/ThemeBootstrap";
import logo from "./assets/HD_Icon.png";

export const metadata: Metadata = {
  title: "MedCore - Hospital Operations",
  description: "Hospital Operations Automation System",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    title: "MedCore",
    capable: true,
    statusBarStyle: "default",
  },
  icons: {
    icon: [{ url: logo.src, type: "image/png" }],
    apple: [{ url: logo.src, type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#2563eb",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-bg min-h-screen antialiased text-gray-900 dark:text-gray-100">
        {/*
          Issue #591 / #634: this inline script runs BEFORE hydration so the
          .dark class is on <html> by first paint — no white flash on dark
          mode and no dark flash on light mode. It branches both ways
          (explicitly add for dark, remove for light) and always sets
          colorScheme so native controls match. Rendered via next/script
          (strategy="beforeInteractive") instead of a raw <script> so React 19
          doesn't warn about script tags in the component tree; Next hoists it
          into <head> and runs it before the page is interactive.
        */}
        <Script id="mc-theme-noflash" strategy="beforeInteractive">
          {`(function(){try{var m=localStorage.getItem('medcore_theme')||'system';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;if(d){r.classList.add('dark');r.style.colorScheme='dark';}else{r.classList.remove('dark');r.style.colorScheme='light';}var l=localStorage.getItem('medcore_lang');if(l==='en'||l==='hi'){r.setAttribute('lang',l);}}catch(e){}})();`}
        </Script>
        <Script
          src="https://analytics.ahrefs.com/analytics.js"
          data-key="2lN5NX8XNzPNcaliBIYppA"
          strategy="afterInteractive"
        />
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <ThemeBootstrap />
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
