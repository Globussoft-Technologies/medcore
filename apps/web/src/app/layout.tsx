import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastContainer } from "@/components/Toast";
import { ThemeBootstrap } from "@/components/ThemeBootstrap";

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
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
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
        {/* Inline script to apply theme + language before hydration — prevents flash + sets html lang for screen readers */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem('medcore_theme')||'system';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';}var l=localStorage.getItem('medcore_lang');if(l==='en'||l==='hi'){document.documentElement.setAttribute('lang',l);}}catch(e){}})();`,
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
