// Super-admin route group layout (Pearl §8.1 / §8.2 — gap #6 piece 1 of 4).
//
// Out-of-band operator surface. Pearl wants this on its own host
// (`admin.pearl-erp.in`) eventually; piece 1 ships the route group + dual
// gates only, vhost config is deploy-target work (CLAUDE.md §5.5).
//
// Gate semantics — mirrors apps/api/src/routes/tenants.ts requireSuperAdmin:
//   ALLOW when user.role === "ADMIN" AND user.tenantId == null
//   REJECT everyone else → redirect to /dashboard/not-authorized
//
// Chrome: deliberately bare. No dashboard sidebar, no LanguageDropdown,
// no BranchPicker, no role-keyed nav. Just brand + signed-in identity +
// Sign Out. The intent is a visually distinct admin surface so operators
// know they are NOT in a tenant context.
//
// Server-side gate: deferred to piece 2 (the prompt's scope-cut fallback).
// No apps/web/middleware.ts exists today and adding one as a first instance
// is non-trivial scope. The client-side gate below prevents UI flash; a
// direct hit to /super-admin without a session lands on /login via the
// auth store's existing app-boot redirect path (mirrors the dashboard
// layout's redirect-armed flow). See piece 2 TODO in
// docs/PEARL_STAGE1_GAP_ANALYSIS.md §3.4.

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogOut, ShieldCheck } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

export default function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user, isLoading, loadSession, logout } = useAuthStore();
  const [hydrating, setHydrating] = useState(true);
  // Defence against the auth-store's app-boot race (Issue #33 / WebKit retry
  // pattern from dashboard layout). On a direct hit to /super-admin without a
  // pre-warmed store, `user` is null AND `isLoading` is false for a single
  // render before loadSession() kicks off. We mirror the dashboard layout's
  // retry idiom in miniature: call loadSession once on mount, settle hydrating
  // when either the store reports a user or one tick of /auth/me has resolved.
  const probeAttempted = useRef(false);
  useEffect(() => {
    if (probeAttempted.current) return;
    probeAttempted.current = true;
    (async () => {
      try {
        await loadSession();
      } catch {
        /* swallow — gate below will redirect if still unauthenticated */
      }
      setHydrating(false);
    })();
  }, [loadSession]);

  // Client-side gate. Runs after every render where the auth state is settled.
  // Three branches:
  //   1. Not authenticated → bounce to /login with redirect param.
  //   2. Authenticated but not super-admin → /dashboard/not-authorized.
  //   3. Super-admin → fall through to render.
  useEffect(() => {
    if (hydrating || isLoading) return;
    if (!user) {
      // Pearl §8.2 — direct hit on a super-admin page without a session
      // routes to /login with redirect param so the user returns here
      // after authentication. We don't show a session-expired toast (we
      // never had a session) — just bounce.
      const target =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}${window.location.hash}`
          : "/super-admin";
      const qs = new URLSearchParams({ redirect: target });
      router.replace(`/login?${qs.toString()}`);
      return;
    }
    const isSuperAdmin = user.role === "ADMIN" && (user.tenantId ?? null) === null;
    if (!isSuperAdmin) {
      toast.error(
        "Super-admin access required (Role.ADMIN with no tenant).",
      );
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent("/super-admin")}`,
      );
    }
  }, [hydrating, isLoading, user, router]);

  // Loading state — while the store hydrates we show a minimal spinner
  // rather than the children, so a non-super-admin user never momentarily
  // sees the super-admin surface before the gate fires.
  if (hydrating || isLoading || !user) {
    return (
      <div
        data-testid="super-admin-loading"
        className="flex min-h-screen items-center justify-center bg-slate-50"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="flex flex-col items-center gap-3">
          <div
            className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900"
            aria-hidden="true"
          />
          <p className="text-sm text-slate-600">Loading super-admin…</p>
        </div>
      </div>
    );
  }

  const isSuperAdmin = user.role === "ADMIN" && (user.tenantId ?? null) === null;
  if (!isSuperAdmin) {
    // Render-time guard belt-and-suspenders. The useEffect above will fire
    // a router.replace on the next tick; meanwhile we render nothing to
    // avoid showing the super-admin chrome to a forbidden role.
    return null;
  }

  return (
    <div
      data-testid="super-admin-shell"
      className="flex min-h-screen flex-col bg-slate-50 text-slate-900"
    >
      <header
        className="border-b border-slate-200 bg-slate-900 px-4 py-3 text-white"
        data-testid="super-admin-topbar"
      >
        <div className="mx-auto flex max-w-screen-xl items-center justify-between">
          <Link
            href="/super-admin"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
            data-testid="super-admin-brand"
          >
            <ShieldCheck size={18} aria-hidden="true" />
            MedCore Super-Admin
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <span
              className="hidden text-slate-300 sm:inline"
              data-testid="super-admin-user-name"
            >
              {user.name}
            </span>
            <button
              type="button"
              data-testid="super-admin-sign-out"
              onClick={async () => {
                try {
                  await logout();
                } finally {
                  if (typeof window !== "undefined") {
                    window.location.replace("/login");
                  } else {
                    router.push("/login");
                  }
                }
              }}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-xs font-medium text-slate-100 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-white/40"
            >
              <LogOut size={14} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-screen-xl flex-1 px-4 py-6">
        {children}
      </main>
      <footer className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
        <div className="mx-auto max-w-screen-xl">
          Super-admin console — Pearl §8. Out-of-band operator surface.
        </div>
      </footer>
    </div>
  );
}
