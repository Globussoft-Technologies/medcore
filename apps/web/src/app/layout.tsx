import type { Metadata, Viewport } from "next";
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
      <head>
        <script
          src="https://analytics.ahrefs.com/analytics.js"
          data-key="2lN5NX8XNzPNcaliBIYppA"
          async
        />
        {/*
          Issue #591 / #634: this inline script runs before hydration so the
          .dark class is on <html> by first paint — no white flash on dark
          mode and no dark flash on light mode. The previous version only
          *added* the .dark class and never *removed* it, so a stale class
          left over from a server-rendered page (or from a previous tab in
          the same site) could persist into a freshly-loaded light-mode
          page. We now branch both ways: explicitly add for dark, explicitly
          remove for light, and ALWAYS set colorScheme so native form
          controls (date pickers, scrollbars, focus rings) match. This is
          the bookmark + tab-restore-friendly equivalent of an SSR cookie.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem('medcore_theme')||'system';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;if(d){r.classList.add('dark');r.style.colorScheme='dark';}else{r.classList.remove('dark');r.style.colorScheme='light';}var l=localStorage.getItem('medcore_lang');if(l==='en'||l==='hi'){r.setAttribute('lang',l);}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="bg-bg min-h-screen antialiased text-gray-900 dark:text-gray-100">
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
