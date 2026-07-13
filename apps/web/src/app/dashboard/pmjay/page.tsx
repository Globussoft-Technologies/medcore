"use client";

/**
 * PM-JAY (Ayushman Bharat) console — admin + reception.
 *
 * - Stats strip (beneficiaries, claims by stage, amounts) from /pmjay/stats.
 * - Beneficiary verification: pick patient + Ayushman card → verify eligibility
 *   (persisted server-side); view family for an eligible beneficiary.
 * - HBP package master: search the local mirror; admins can trigger a sync.
 *
 * Backend: `/api/v1/pmjay`. Eligibility must be ELIGIBLE before a PM-JAY claim
 * can be created on the Insurance Claims page.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { formatINR } from "@/lib/currency";
import { EntityPicker } from "@/components/EntityPicker";
import { SkeletonTable } from "@/components/Skeleton";
import { ShieldCheck, Search, RefreshCw, Users, Package } from "lucide-react";

const VIEW_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

type Eligibility = "PENDING" | "ELIGIBLE" | "NOT_ELIGIBLE";

interface Stats {
  beneficiaries: { eligible: number; pendingVerification: number };
  claims: { submitted: number; inReview: number; approved: number; denied: number; settled: number };
  admissions: number;
  amounts: { totalClaimed: number; totalApproved: number; settlementAmount: number };
  packages: { active: number; lastSyncedAt: string | null; version: string | null };
  ops: { documentUploadsPending: number; documentUploadsFailed: number };
}

interface VerifyResult {
  eligibilityStatus: Eligibility;
  beneficiaryId: string | null;
  familyId: string | null;
  eligible: boolean;
}

interface FamilyMember {
  beneficiaryId: string;
  name: string;
  ayushmanCardNumber: string;
  familyId: string;
}

interface PkgRow {
  id: string;
  packageCode: string;
  packageName: string;
  specialty: string | null;
  amount: string | number;
  hospitalType: string | null;
}

function StatCard({ title, value, sub }: { title: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{title}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

function EligibilityBadge({ status }: { status: Eligibility }) {
  const map: Record<Eligibility, string> = {
    ELIGIBLE: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    NOT_ELIGIBLE: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    PENDING: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  };
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${map[status]}`}>{status.replace("_", " ")}</span>;
}

export default function PmjayConsolePage() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading } = useAuthStore();
  const isAdmin = user?.role === "ADMIN";

  const [stats, setStats] = useState<Stats | null>(null);

  // Beneficiary verification state.
  const [patientId, setPatientId] = useState("");
  const [card, setCard] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [family, setFamily] = useState<FamilyMember[] | null>(null);

  // Package master state.
  const [packages, setPackages] = useState<PkgRow[] | null>(null);
  const [pkgSearch, setPkgSearch] = useState("");
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error("PM-JAY is restricted to Admin and Reception.");
      router.replace(`/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/pmjay")}`);
    }
  }, [user, isLoading, router, pathname]);

  const loadStats = useCallback(async () => {
    try {
      const res = await api.get<{ data: Stats }>("/pmjay/stats");
      setStats(res.data ?? null);
    } catch {
      /* stats are best-effort */
    }
  }, []);

  const loadPackages = useCallback(async () => {
    try {
      const qs = pkgSearch ? `?search=${encodeURIComponent(pkgSearch)}` : "";
      const res = await api.get<{ data: PkgRow[] }>(`/pmjay/packages${qs}`);
      setPackages(res.data ?? []);
    } catch {
      setPackages([]);
    }
  }, [pkgSearch]);

  useEffect(() => {
    loadStats();
    loadPackages();
  }, [loadStats, loadPackages]);

  async function verify() {
    if (!patientId || !card.trim()) {
      toast.error("Pick a patient and enter an Ayushman card number.");
      return;
    }
    setVerifying(true);
    setResult(null);
    setFamily(null);
    try {
      const res = await api.post<{ data: VerifyResult }>("/pmjay/verify", {
        patientId,
        ayushmanCardNumber: card.trim(),
      });
      setResult(res.data);
      if (res.data.eligible) toast.success("Beneficiary is PM-JAY eligible.");
      else toast.error("Beneficiary is NOT eligible.");
      loadStats();
    } catch (e) {
      toast.error((e as Error).message || "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  async function viewFamily() {
    if (!result?.familyId) return;
    try {
      const res = await api.get<{ data: FamilyMember[] }>(`/pmjay/family/${result.familyId}`);
      setFamily(res.data ?? []);
    } catch (e) {
      toast.error((e as Error).message || "Could not load family.");
    }
  }

  async function syncPackages() {
    setSyncing(true);
    try {
      const res = await api.post<{ data: { synced: number; skipped: boolean } }>("/pmjay/packages/sync", {});
      toast.success(res.data.skipped ? "Package master already up to date." : `Synced ${res.data.synced} packages.`);
      loadPackages();
      loadStats();
    } catch (e) {
      toast.error((e as Error).message || "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  if (isLoading || (user && !VIEW_ALLOWED.has(user.role))) {
    return <div className="p-6"><SkeletonTable /></div>;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
            <ShieldCheck className="h-5 w-5 text-primary" /> PM-JAY (Ayushman Bharat)
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Beneficiary eligibility, HBP packages, and scheme metrics.
          </p>
        </div>
        <Link href="/dashboard/insurance-claims" className="text-sm text-primary underline">
          Go to Insurance Claims →
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <StatCard title="Eligible beneficiaries" value={stats?.beneficiaries.eligible ?? "—"} />
        <StatCard title="Pending verification" value={stats?.beneficiaries.pendingVerification ?? "—"} />
        <StatCard title="Claims submitted" value={stats?.claims.submitted ?? "—"} />
        <StatCard title="Claims settled" value={stats?.claims.settled ?? "—"} />
        <StatCard title="Total approved" value={stats ? formatINR(stats.amounts.totalApproved) : "—"} />
        <StatCard title="Settlement amount" value={stats ? formatINR(stats.amounts.settlementAmount) : "—"} sub={`${stats?.admissions ?? 0} admissions`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Beneficiary verification */}
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Search className="h-4 w-4" /> Beneficiary verification
          </h2>
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-sm font-medium">Patient</label>
              <EntityPicker
                endpoint="/patients"
                labelField="user.name"
                subtitleField="user.phone"
                hintField="mrNumber"
                value={patientId}
                onChange={(id) => setPatientId(id)}
                searchPlaceholder="Search by name, phone, MR..."
                testIdPrefix="pmjay-patient-picker"
              />
            </div>
            <div>
              <label htmlFor="pmjay-card" className="block text-sm font-medium">Ayushman card number</label>
              <input
                id="pmjay-card"
                data-testid="pmjay-card-input"
                value={card}
                onChange={(e) => setCard(e.target.value)}
                placeholder="e.g. PMJAY-XXXX-XXXX"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
            </div>
            <button
              type="button"
              onClick={verify}
              disabled={verifying}
              data-testid="pmjay-verify-btn"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {verifying ? "Verifying..." : "Verify eligibility"}
            </button>

            {result && (
              <div data-testid="pmjay-verify-result" className="mt-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Eligibility</span>
                  <EligibilityBadge status={result.eligibilityStatus} />
                </div>
                {result.beneficiaryId && (
                  <dl className="mt-2 grid grid-cols-2 gap-1 text-xs text-gray-600 dark:text-gray-300">
                    <dt>Beneficiary ID</dt><dd className="text-right font-mono">{result.beneficiaryId}</dd>
                    <dt>Family ID</dt><dd className="text-right font-mono">{result.familyId}</dd>
                  </dl>
                )}
                {result.familyId && (
                  <button type="button" onClick={viewFamily} className="mt-2 flex items-center gap-1 text-xs text-primary underline">
                    <Users className="h-3 w-3" /> View family
                  </button>
                )}
                {family && (
                  <ul className="mt-2 space-y-1 text-xs">
                    {family.map((m) => (
                      <li key={m.beneficiaryId} className="flex justify-between border-t border-gray-100 pt-1 dark:border-gray-700">
                        <span>{m.name}</span>
                        <span className="font-mono text-gray-400">{m.ayushmanCardNumber}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Package master */}
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Package className="h-4 w-4" /> HBP package master
            </h2>
            {isAdmin && (
              <button
                type="button"
                onClick={syncPackages}
                disabled={syncing}
                data-testid="pmjay-sync-btn"
                className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium disabled:opacity-60 dark:border-gray-600"
              >
                <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} /> Sync
              </button>
            )}
          </div>
          {stats?.packages.lastSyncedAt && (
            <p className="mt-1 text-xs text-gray-400">
              {stats.packages.active} active · {stats.packages.version} · last synced{" "}
              {new Date(stats.packages.lastSyncedAt).toLocaleString()}
            </p>
          )}
          <input
            value={pkgSearch}
            onChange={(e) => setPkgSearch(e.target.value)}
            placeholder="Search package code or name..."
            data-testid="pmjay-package-search"
            className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
          <div className="mt-3 max-h-80 overflow-y-auto">
            {packages === null ? (
              <SkeletonTable />
            ) : packages.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-400">No packages. {isAdmin ? "Run a sync to load the master." : ""}</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-gray-500">
                  <tr>
                    <th className="py-1">Code</th>
                    <th className="py-1">Package</th>
                    <th className="py-1 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {packages.map((p) => (
                    <tr key={p.id} className="border-t border-gray-100 dark:border-gray-700">
                      <td className="py-1.5 font-mono text-xs">{p.packageCode}</td>
                      <td className="py-1.5">
                        {p.packageName}
                        {p.specialty && <span className="ml-1 text-xs text-gray-400">· {p.specialty}</span>}
                      </td>
                      <td className="py-1.5 text-right">{formatINR(Number(p.amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
