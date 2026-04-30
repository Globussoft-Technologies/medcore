/**
 * Issue #303 — `/dashboard/account` is a thin alias for `/dashboard/profile`.
 *
 * Both URLs were 404'ing before this fix; the canonical route is now
 * `/dashboard/profile` and we redirect from `/dashboard/account` so any
 * existing bookmarks, sidebar links, or muscle memory keep working.
 *
 * Server-component redirect — fires before the client bundle loads, so the
 * user never sees a flash of a blank "Account" page.
 */
import { redirect } from "next/navigation";

export default function AccountPage() {
  redirect("/dashboard/profile");
}
