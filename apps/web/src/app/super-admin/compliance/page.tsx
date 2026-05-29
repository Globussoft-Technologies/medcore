// Per-tenant compliance posture page — Pearl ERP Stage 1 §8.6
// (gap row 225 closure, 2026-05-23).
//
// Loads /api/v1/super-admin/compliance on mount and renders a table
// with one row per tenant:
//   - Tenant name + active badge.
//   - ABHA-linked %  (with patientCount denominator).
//   - DPDP erasure tickets in the last 30d.
//   - Audit-log rows in the last 30d.
//   - ADMIN TOTP coverage ratio (totpEnrolledAdminCount / adminCount).
//   - Mandatory-TOTP enforcement badge (on / off).
//   - Last DPDP execution timestamp.
//   - Last audit timestamp.
//
// Posture badges:
//   - RED   if requireAdminTOTP=true AND totpEnrolledAdminCount <
//     adminCount  (compliance violation — staff haven't enrolled
//     mandatory TOTP).
//   - AMBER if patientCount > 100 AND abhaLinkedPct < 10%  (low ABHA
//     adoption — flag for outreach).
//
// Defence-in-depth: the /super-admin/ layout already gates on
// Role.ADMIN + tenantId == null. We do NOT re-check here — the API
// double-enforces with `requireSuperAdmin`.

"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
} from "lucide-react";

const VIEW_ALLOWED = new Set(["ADMIN"]);

interface CompliancePostureRow {
  tenantId: string;
  tenantName: string;
  active: boolean;
  patientCount: number;
  abhaLinkedCount: number;
  abhaLinkedPct: number;
  dpdpRequestsLast30d: number;
  auditRowsLast30d: number;
  adminCount: number;
  totpEnrolledAdminCount: number;
  requireAdminTOTP: boolean;
  lastDpdpAt: string | null;
  lastAuditAt: string | null;
  // Pearl §8.6 — compliance posture knobs (editable in tenant drawer).
  whatsappOptInTrackingEnabled: boolean;
  abdmConsentEnforcementRequired: boolean;
  auditLogRetentionDays: number;
  patientDataRetentionDays: number;
}

interface ComplianceResponse {
  success: boolean;
  data: {
    tenants: CompliancePostureRow[];
    snapshotAt: string;
  };
  error: string | null;
}

interface PostureClassification {
  totpViolation: boolean;
  lowAbha: boolean;
  rowClassName: string;
  testidSuffix: "red" | "amber" | "ok";
}

function classifyRow(row: CompliancePostureRow): PostureClassification {
  const totpViolation =
    row.requireAdminTOTP &&
    row.totpEnrolledAdminCount < row.adminCount;
  const lowAbha = row.patientCount > 100 && row.abhaLinkedPct < 0.1;
  if (totpViolation) {
    return {
      totpViolation,
      lowAbha,
      rowClassName: "bg-rose-50",
      testidSuffix: "red",
    };
  }
  if (lowAbha) {
    return {
      totpViolation,
      lowAbha,
      rowClassName: "bg-amber-50",
      testidSuffix: "amber",
    };
  }
  return {
    totpViolation,
    lowAbha,
    rowClassName: "",
    testidSuffix: "ok",
  };
}

function formatPct(frac: number): string {
  return `${(frac * 100).toFixed(1)}%`;
}

function formatTs(iso: string | null): string {
  if (iso == null) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function SuperAdminCompliancePage() {
  // VIEW_ALLOWED is enforced by the /super-admin/ layout + the API. We
  // re-export the constant so a future per-page gate (or unit test) can
  // assert role expectations without reaching into the layout.
  void VIEW_ALLOWED;

  const [rows, setRows] = useState<CompliancePostureRow[]>([]);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchPosture(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/super-admin/compliance", {
        credentials: "include",
      });
      const body = (await res.json()) as ComplianceResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setRows(body.data.tenants);
      setSnapshotAt(body.data.snapshotAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchPosture();
  }, []);

  const violationsCount = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.requireAdminTOTP &&
          r.totpEnrolledAdminCount < r.adminCount,
      ).length,
    [rows],
  );

  const lowAbhaCount = useMemo(
    () =>
      rows.filter((r) => r.patientCount > 100 && r.abhaLinkedPct < 0.1)
        .length,
    [rows],
  );

  return (
    <section
      data-testid="super-admin-compliance"
      className="space-y-6 py-4"
    >
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Per-tenant compliance posture
        </h1>
        <p className="text-sm text-slate-600">
          ABHA-link adoption, DPDP erasure activity, audit volume, and
          ADMIN TOTP coverage across all tenants. Tenants violating
          mandatory-TOTP enforcement float to the top.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          data-testid="super-admin-compliance-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      {loading && rows.length === 0 ? (
        <div
          data-testid="super-admin-compliance-loading"
          className="flex items-center gap-2 text-sm text-slate-500"
        >
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          Loading compliance posture…
        </div>
      ) : null}

      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        data-testid="super-admin-compliance-summary"
      >
        <div
          data-testid="super-admin-compliance-summary-tenants"
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Tenants
          </p>
          <p className="text-2xl font-semibold text-slate-900">
            {rows.length.toLocaleString("en-IN")}
          </p>
        </div>
        <div
          data-testid="super-admin-compliance-summary-totp-violations"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 shadow-sm"
        >
          <p className="flex items-center gap-1 text-xs uppercase tracking-wide text-rose-700">
            <ShieldAlert size={12} aria-hidden="true" />
            TOTP violations
          </p>
          <p className="text-2xl font-semibold text-rose-900">
            {violationsCount.toLocaleString("en-IN")}
          </p>
        </div>
        <div
          data-testid="super-admin-compliance-summary-low-abha"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm"
        >
          <p className="flex items-center gap-1 text-xs uppercase tracking-wide text-amber-700">
            <AlertTriangle size={12} aria-hidden="true" />
            Low ABHA adoption
          </p>
          <p className="text-2xl font-semibold text-amber-900">
            {lowAbhaCount.toLocaleString("en-IN")}
          </p>
        </div>
      </div>

      <div
        className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm"
        data-testid="super-admin-compliance-table-wrapper"
      >
        <table
          className="min-w-full text-left text-sm"
          data-testid="super-admin-compliance-table"
        >
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Tenant
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                ABHA-linked
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                DPDP (30d)
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Audit rows (30d)
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                ADMIN TOTP
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                TOTP enforced
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                WhatsApp opt-in
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                ABDM consent
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Audit retention
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                PHI retention
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Last DPDP
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Last audit
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && !loading ? (
              <tr>
                <td
                  colSpan={12}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  data-testid="super-admin-compliance-empty"
                >
                  No tenants to display.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => {
              const cls = classifyRow(row);
              return (
                <tr
                  key={row.tenantId}
                  data-testid={`super-admin-compliance-row-${row.tenantId}`}
                  data-posture={cls.testidSuffix}
                  className={cls.rowClassName}
                >
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{row.tenantName}</span>
                      {row.active ? (
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] uppercase text-emerald-700">
                          Active
                        </span>
                      ) : (
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] uppercase text-slate-500">
                          Inactive
                        </span>
                      )}
                      {cls.totpViolation ? (
                        <span
                          data-testid={`super-admin-compliance-badge-red-${row.tenantId}`}
                          className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-100 px-2 py-0.5 text-[10px] uppercase text-rose-700"
                        >
                          <ShieldAlert size={10} aria-hidden="true" />
                          TOTP gap
                        </span>
                      ) : null}
                      {cls.lowAbha ? (
                        <span
                          data-testid={`super-admin-compliance-badge-amber-${row.tenantId}`}
                          className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] uppercase text-amber-700"
                        >
                          <AlertTriangle size={10} aria-hidden="true" />
                          Low ABHA
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td
                    className="px-4 py-3 tabular-nums text-slate-800"
                    data-testid={`super-admin-compliance-abha-${row.tenantId}`}
                  >
                    {formatPct(row.abhaLinkedPct)}
                    <span className="ml-1 text-xs text-slate-500">
                      ({row.abhaLinkedCount.toLocaleString("en-IN")}/
                      {row.patientCount.toLocaleString("en-IN")})
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-800">
                    {row.dpdpRequestsLast30d.toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-800">
                    {row.auditRowsLast30d.toLocaleString("en-IN")}
                  </td>
                  <td
                    className="px-4 py-3 tabular-nums text-slate-800"
                    data-testid={`super-admin-compliance-totp-${row.tenantId}`}
                  >
                    {row.totpEnrolledAdminCount.toLocaleString("en-IN")}/
                    {row.adminCount.toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-3">
                    {row.requireAdminTOTP ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] uppercase text-emerald-700">
                        <ShieldCheck size={10} aria-hidden="true" />
                        On
                      </span>
                    ) : (
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] uppercase text-slate-500">
                        Off
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <OnOffPill on={row.whatsappOptInTrackingEnabled} />
                  </td>
                  <td className="px-4 py-3">
                    <OnOffPill on={row.abdmConsentEnforcementRequired} />
                  </td>
                  <td className="px-4 py-3 tabular-nums text-xs text-slate-700">
                    {row.auditLogRetentionDays}d
                  </td>
                  <td className="px-4 py-3 tabular-nums text-xs text-slate-700">
                    {row.patientDataRetentionDays}d
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatTs(row.lastDpdpAt)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatTs(row.lastAuditAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {snapshotAt ? (
        <div
          className="text-xs text-slate-500"
          data-testid="super-admin-compliance-snapshot-at"
        >
          Snapshot: {formatTs(snapshotAt)}
        </div>
      ) : null}
    </section>
  );
}

// Pearl §8.6 — tiny on/off pill used by the per-tenant compliance
// posture row. Mirrors the visual treatment used for the
// "TOTP enforced" column so the four On/Off pills line up.
function OnOffPill({ on }: { on: boolean }) {
  if (on) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] uppercase text-emerald-700">
        <ShieldCheck size={10} aria-hidden="true" />
        On
      </span>
    );
  }
  return (
    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] uppercase text-slate-500">
      Off
    </span>
  );
}
