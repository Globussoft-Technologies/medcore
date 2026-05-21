// Super-admin landing dashboard (Pearl §8.1 — gap #6 piece 1 of 4).
// Two placeholder tiles: Tenants (active link to piece 2's route) +
// Pearl Billing (disabled CTA wired live in piece 3). Plus a small text
// block explaining the staged rollout. NO data fetching — that lands in
// piece 4 (cross-tenant metrics).

import Link from "next/link";
import { Building2, CreditCard, ArrowRight } from "lucide-react";

export default function SuperAdminLandingPage() {
  return (
    <section
      data-testid="super-admin-landing"
      className="space-y-8 py-4"
    >
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Super-Admin Console
        </h1>
        <p className="text-sm text-slate-600">
          Operator surface for managing hospital tenants and the Pearl
          subscription book. Restricted to super-admins (Role.ADMIN with
          no tenant binding).
        </p>
      </header>

      <div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        data-testid="super-admin-tiles"
      >
        {/* Tenants tile — wired to piece 2's route. Today /super-admin/tenants
            does not exist (404 inside the surface). Piece 2 adds the
            onboarding-wizard list under that path. */}
        <Link
          href="/super-admin/tenants"
          data-testid="super-admin-tile-tenants"
          className="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-white">
              <Building2 size={18} aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-900">
                Tenants
              </h2>
              <p className="text-xs text-slate-500">
                Provision, suspend, and onboard hospitals.
              </p>
            </div>
            <ArrowRight
              size={16}
              className="text-slate-400 transition group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </div>
          <p className="text-xs text-slate-500">
            Onboarding wizard ships in piece 2 of 4.
          </p>
        </Link>

        {/* Pearl Billing tile — disabled until piece 3 ships
            PearlSubscription + PearlInvoice schemas + the Pearl-side billing
            UI. aria-disabled + native disabled both set so SR users and
            mouse users alike see it as inactive. */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          title="Pearl Billing ships in piece 3"
          data-testid="super-admin-tile-pearl-billing"
          className="flex cursor-not-allowed flex-col gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-left opacity-70"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-slate-300 text-slate-600">
              <CreditCard size={18} aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-700">
                Pearl Billing
              </h2>
              <p className="text-xs text-slate-500">
                Pearl → hospital invoices, subscription state, proration.
              </p>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            Schema + UI ship in piece 3 of 4.
          </p>
        </button>
      </div>

      <div
        className="rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600"
        data-testid="super-admin-roadmap-note"
      >
        Super-admin console — Pearl §8. Onboarding wizard, billing, and
        cross-tenant metrics roll out in pieces 2–4.
      </div>
    </section>
  );
}
