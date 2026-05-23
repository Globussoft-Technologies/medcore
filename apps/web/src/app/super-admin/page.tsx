// Super-admin landing dashboard (Pearl §8.1 — gap #6 piece 1 of 4).
// Two placeholder tiles: Tenants (active link to piece 2's route) +
// Pearl Billing (disabled CTA wired live in piece 3). Plus a small text
// block explaining the staged rollout. NO data fetching — that lands in
// piece 4 (cross-tenant metrics).

import Link from "next/link";
import { Building2, CreditCard, ArrowRight, UserPlus, ListChecks, ShieldAlert, Inbox, Users, BarChart3, ShieldCheck } from "lucide-react";

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
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="super-admin-tiles"
      >
        {/* Onboard-new-tenant tile — wired to the piece-2 wizard. New tenants
            land here from /super-admin first; the Tenants list tile below is
            for ongoing management of existing tenants (also a piece-2/3+
            target — currently 404 if hit). */}
        <Link
          href="/super-admin/onboard"
          data-testid="super-admin-tile-onboard"
          className="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <UserPlus size={18} aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-900">
                Onboard new tenant
              </h2>
              <p className="text-xs text-slate-500">
                3-step wizard: tenant + first branch + super-admin user.
              </p>
            </div>
            <ArrowRight
              size={16}
              className="text-slate-400 transition group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </div>
          <p className="text-xs text-slate-500">
            Piece 2 of 4 — atomic provisioning. HFR/HPR/WhatsApp/Razorpay
            steps land in piece 2b.
          </p>
        </Link>

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

        {/* Background-job queue tile — Pearl §8.4 (gap row 222 closure).
            Wired live to /super-admin/jobs which lists ScheduledTaskRun
            rows + retries FAILED ones via /api/v1/scheduled-jobs. */}
        <Link
          href="/super-admin/jobs"
          data-testid="super-admin-tile-jobs"
          className="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <ListChecks size={18} aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-900">
                Background jobs
              </h2>
              <p className="text-xs text-slate-500">
                View cron-task runs; retry failed ones.
              </p>
            </div>
            <ArrowRight
              size={16}
              className="text-slate-400 transition group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </div>
          <p className="text-xs text-slate-500">
            Pearl §8.4 — failed reminders / deliveries / campaign sends.
          </p>
        </Link>

        {/* DPDP Workbench tile — Pearl §8.6 (gap row 224 closure 2026-05-23).
            Cross-tenant right-to-erasure workbench. Super-admins file /
            execute / reject DPDP Act 2023 §17 deletion tickets here. */}
        <Link
          href="/super-admin/dpdp"
          data-testid="super-admin-tile-dpdp"
          className="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-rose-600 text-white">
              <ShieldAlert size={18} aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-900">
                DPDP Workbench
              </h2>
              <p className="text-xs text-slate-500">
                Right-to-erasure tickets across all tenants.
              </p>
            </div>
            <ArrowRight
              size={16}
              className="text-slate-400 transition group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </div>
          <p className="text-xs text-slate-500">
            Pearl §8.6 — DPDP Act 2023 §17 cross-tenant purge audit log.
          </p>
        </Link>

        {/* Pearl Support Inbox tile — Pearl §8.5 (gap row 223 closure 2026-05-23).
            Tenant-ADMIN → Pearl-operator ticket lifecycle. Distinct from
            patient → hospital complaints. */}
        <Link
          href="/super-admin/support"
          data-testid="super-admin-tile-support"
          className="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-amber-600 text-white">
              <Inbox size={18} aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-900">
                Pearl Support Inbox
              </h2>
              <p className="text-xs text-slate-500">
                Triage support tickets raised by tenant ADMINs.
              </p>
            </div>
            <ArrowRight
              size={16}
              className="text-slate-400 transition group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </div>
          <p className="text-xs text-slate-500">
            Pearl §8.5 — operator-facing tenant escalation channel.
          </p>
        </Link>

        {/* Super-admin roster tile — Pearl §8.2 (gap row 208 closure 2026-05-23).
            Cross-tenant list of users with role=ADMIN AND tenantId==null.
            Deactivate flow with last-active count guard lives here. */}
        <Link
          href="/super-admin/users"
          data-testid="super-admin-tile-users"
          className="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-sky-600 text-white">
              <Users size={18} aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-900">
                Super-admin roster
              </h2>
              <p className="text-xs text-slate-500">
                List + deactivate operators with no tenant binding.
              </p>
            </div>
            <ArrowRight
              size={16}
              className="text-slate-400 transition group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </div>
          <p className="text-xs text-slate-500">
            Pearl §8.2 — cross-tenant Role.ADMIN users.
          </p>
        </Link>

        {/* Cross-tenant metrics tile — Pearl §8.4 (gap rows 219 + 220
            closure 2026-05-23). Cluster-wide totals + per-tenant rollup
            (top-20 by user count). Read-only operator surface. */}
        <Link
          href="/super-admin/metrics"
          data-testid="super-admin-tile-metrics"
          className="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-violet-600 text-white">
              <BarChart3 size={18} aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-900">
                Cross-tenant metrics
              </h2>
              <p className="text-xs text-slate-500">
                Cluster totals + per-tenant rollup (top-20 by users).
              </p>
            </div>
            <ArrowRight
              size={16}
              className="text-slate-400 transition group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </div>
          <p className="text-xs text-slate-500">
            Pearl §8.4 — aggregated metrics + per-tenant health rollup.
          </p>
        </Link>

        {/* Compliance posture tile — Pearl §8.6 (gap row 225 closure 2026-05-23).
            Per-tenant ABHA-link adoption, DPDP activity, audit volume,
            ADMIN TOTP coverage. Red/amber badges flag policy gaps. */}
        <Link
          href="/super-admin/compliance"
          data-testid="super-admin-tile-compliance"
          className="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-teal-600 text-white">
              <ShieldCheck size={18} aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-900">
                Compliance posture
              </h2>
              <p className="text-xs text-slate-500">
                ABHA + DPDP + audit + TOTP coverage per tenant.
              </p>
            </div>
            <ArrowRight
              size={16}
              className="text-slate-400 transition group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </div>
          <p className="text-xs text-slate-500">
            Pearl §8.6 — red/amber badges flag policy gaps.
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
