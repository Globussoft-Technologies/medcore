// Thin shim — Pearl §8.3 (2026-05-28).
//
// The platform-billing operator UI lives at
// `apps/web/src/app/super-admin/platform-billing/page.tsx` (the canonical
// implementation). This file exists so the same page is reachable at
// `/dashboard/platform-billing` and is wrapped by the dashboard layout
// (sidebar, search, language picker, dark-mode toggle) instead of the
// bare super-admin chrome. Re-exporting the default keeps a single
// source of truth — edits to the canonical file flow through here with
// no changes needed.
export { default } from "../../super-admin/platform-billing/page";
