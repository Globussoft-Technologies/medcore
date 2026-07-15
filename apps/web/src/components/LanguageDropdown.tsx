"use client";

import { useEffect } from "react";
import { useI18nStore, useTranslation, LANGUAGE_OPTIONS, Lang } from "@/lib/i18n";
import { api } from "@/lib/api";
import { Languages } from "lucide-react";

/**
 * Language switcher used both on auth pages (login/register/forgot) and —
 * Issue #137 — inside the authenticated dashboard layout. The component
 * always persists the selection to localStorage via the i18n store.
 *
 * `persistToServer` (Issue #137): when true, additionally PATCH /auth/me
 * with { preferredLanguage } so the choice follows the user across devices.
 * The server call is best-effort: failures are logged but never block the
 * UI update because the local store has already changed.
 *
 * `instanceId` lets the dashboard render multiple instances (mobile header
 * + desktop sidebar) without HTML id collisions.
 */
export function LanguageDropdown({
  className,
  persistToServer = false,
  instanceId = "mc-lang",
}: {
  className?: string;
  persistToServer?: boolean;
  instanceId?: string;
}) {
  const init = useI18nStore((s) => s.init);
  const { lang, setLang } = useTranslation();

  useEffect(() => {
    init();
  }, [init]);

  function handleChange(next: Lang) {
    setLang(next);
    if (persistToServer) {
      // Best-effort server sync. If the user is offline or the request 401s
      // we still keep the local choice — the next successful login will
      // restore the server value if present.
      api
        .patch("/auth/me", { preferredLanguage: next })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[LanguageDropdown] preferredLanguage sync failed", err);
        });
    }
  }

  return (
    <div className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      {/* Issue #810: icon was hardcoded text-gray-500 which read as muddy
          mid-grey against the dark sidebar surface; pair with a lighter
          dark-mode token so the languages glyph stays legible. */}
      <Languages
        size={14}
        className="text-gray-500 dark:text-gray-300"
        aria-hidden="true"
      />
      <label htmlFor={instanceId} className="sr-only">
        Language
      </label>
      <select
        id={instanceId}
        data-testid="language-switcher"
        value={lang}
        onChange={(e) => handleChange(e.target.value as Lang)}
        aria-label="Select language"
        // Issue #536 (2026-05-05): the previous styles removed the OS focus
        // outline (`focus:outline-none`) but only added a faint
        // `focus:ring-primary/20` ring at 20% alpha — barely visible
        // against the white sidebar background, failing WCAG 2.4.7 for
        // keyboard users. Use `focus-visible:` (keyboard-only) with a
        // fully-opaque ring at 2px width that's clearly visible in both
        // light and dark themes.
        className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:focus-visible:ring-offset-gray-900"
      >
        {/* Options derive from the LANGUAGES registry in lib/i18n.ts — adding a
            language there makes it appear here automatically. */}
        {LANGUAGE_OPTIONS.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
