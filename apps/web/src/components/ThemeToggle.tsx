"use client";

/**
 * ThemeToggle — single source of truth for the dark/light theme button.
 *
 * What this is:
 *   A small button that flips the theme between light and dark by
 *   delegating to the Zustand `useThemeStore` (see `@/lib/theme`). The
 *   store handles applying the `.dark` class to `<html>`, persisting
 *   to localStorage under `medcore_theme`, and reacting to OS theme
 *   changes when mode is "system".
 *
 * Why a dedicated component:
 *   The toggle used to be inlined in `apps/web/src/app/dashboard/layout.tsx`.
 *   Two bugs slipped through in that form:
 *
 *   - #485 — "Dark/Light theme toggle has no effect on the page." The
 *     inlined <button> had no explicit `type` attribute. When the
 *     dashboard layout was eventually wrapped by any ancestor <form>
 *     (e.g. a future search form, an experimental admin shell, the
 *     mobile-drawer search box), browsers default <button> to
 *     `type="submit"` — clicking it submitted the surrounding form
 *     and reloaded the page, swallowing the visual flip. Always set
 *     `type="button"` on standalone action buttons; this component
 *     hard-codes that contract.
 *
 *   - #508 — "Theme toggle button accessible label not updated after
 *     press (aria-pressed not flipped)." The inlined button never
 *     emitted `aria-pressed` at all, so screen readers couldn't tell
 *     the user the current state. We now render `aria-pressed` on
 *     every render derived from the store's `resolved` value, so the
 *     attribute flips on every click without any extra plumbing.
 *
 * Behaviour contract (covered by ThemeToggle.test.tsx):
 *   - Click: flips `<html>.classList.contains("dark")` AND flips
 *     `aria-pressed` between "true" and "false".
 *   - Persistence: writes `medcore_theme` to localStorage so the choice
 *     survives a reload (handled by the store's `setMode`).
 *   - aria-label tracks the current state ("Switch to dark mode" /
 *     "Switch to light mode") so screen readers announce what pressing
 *     the button will DO, not what state it's already in.
 */

import { Sun, Moon } from "lucide-react";
import { useThemeStore } from "@/lib/theme";
import { useTranslation } from "@/lib/i18n";

interface ThemeToggleProps {
  /**
   * Optional className override. The default styling matches the
   * dashboard sidebar context (the only consumer at time of writing),
   * but other surfaces (login page, public landing) may want different
   * sizing / hover treatment.
   */
  className?: string;
}

const DEFAULT_CLASS =
  "rounded-lg p-2 text-slate-700 transition hover:bg-sidebar-hover hover:text-slate-900 focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar focus:outline-none dark:text-gray-300 dark:hover:text-white";

export function ThemeToggle({ className = DEFAULT_CLASS }: ThemeToggleProps) {
  const resolved = useThemeStore((s) => s.resolved);
  const toggle = useThemeStore((s) => s.toggle);
  const { t } = useTranslation();

  const isDark = resolved === "dark";
  // aria-label describes the *action* the button will perform on press,
  // which is the WCAG-recommended pattern for toggle buttons whose icon
  // already reflects the current state.
  const label = isDark ? t("common.lightMode") : t("common.darkMode");

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={isDark}
      aria-label={label}
      title={label}
      className={className}
      data-testid="theme-toggle"
    >
      {isDark ? (
        <Sun size={18} aria-hidden="true" />
      ) : (
        <Moon size={18} aria-hidden="true" />
      )}
    </button>
  );
}

export default ThemeToggle;
