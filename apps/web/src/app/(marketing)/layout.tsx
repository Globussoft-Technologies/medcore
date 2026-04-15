import { ReactNode } from "react";
import { MarketingNav } from "./_components/MarketingNav";
import { MarketingFooter } from "./_components/MarketingFooter";

// TODO(i18n): Marketing copy is English-only in this pass. A Hindi translation
// is a separate initiative — nav + shared CTAs will reuse common.* keys later.
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
