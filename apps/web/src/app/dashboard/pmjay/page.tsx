"use client";

/**
 * PM-JAY (Ayushman Bharat) console — admin + reception.
 *
 * - Stats strip (beneficiaries, pre-auth, claims, amounts, admissions).
 * - Beneficiary: multi-identifier search (card / beneficiary / family / mobile /
 *   ABHA / name) → pick a candidate → verify eligibility against a patient
 *   (persisted server-side) → rich result card + family view.
 * - Pre-Authorization queue (PENDING / APPROVED / ALL) — the central PM-JAY step.
 * - HBP package master: search the local mirror; admins can sync.
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
import { ShieldCheck, Search, RefreshCw, Users, Package, FileCheck, Plus, X } from "lucide-react";

const VIEW_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

type Eligibility = "PENDING" | "ELIGIBLE" | "NOT_ELIGIBLE";

interface Stats {
  beneficiaries: { eligible: number; pendingVerification: number };
  preAuth: { pending: number; approved: number };
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
  name: string | null;
  ayushmanCardNumber: string;
  verifiedAt: string;
  eligible: boolean;
}

interface Candidate {
  beneficiaryId: string;
  name: string;
  ayushmanCardNumber: string;
  familyId: string;
  gender?: string;
}

interface PkgRow {
  id: string;
  packageCode: string;
  packageName: string;
  specialty: string | null;
  amount: string | number;
  hospitalType: string | null;
}

interface PreAuthRow {
  id: string;
  requestNumber: string;
  procedureName: string;
  packageCode: string | null;
  estimatedCost: number;
  status: string;
  approvedAmount: number | null;
  approvalNumber: string | null;
  submittedAt: string;
  patient?: { user?: { name?: string } };
}

const SEARCH_TYPES: { value: keyof typeof SEARCH_LABELS; label: string }[] = [
  { value: "ayushmanCardNumber", label: "Ayushman Card" },
  { value: "beneficiaryId", label: "Beneficiary ID" },
  { value: "familyId", label: "Family ID" },
  { value: "mobile", label: "Mobile" },
  { value: "abhaNumber", label: "ABHA Number" },
  { value: "name", label: "Name" },
];
const SEARCH_LABELS = {
  ayushmanCardNumber: "",
  beneficiaryId: "",
  familyId: "",
  mobile: "",
  abhaNumber: "",
  name: "",
};

function StatCard({ title, value, sub, tone }: { title: string; value: string | number; sub?: string; tone?: "danger" }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{title}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone === "danger" ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-gray-100"}`}>{value}</p>
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

function StatusPill({ status }: { status: string }) {
  const s = status.toUpperCase();
  const cls =
    s === "APPROVED" ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
    : s === "REJECTED" ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
    : s === "PARTIAL" ? "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300"
    : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{s}</span>;
}

export default function PmjayConsolePage() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading } = useAuthStore();
  const isAdmin = user?.role === "ADMIN";

  const [stats, setStats] = useState<Stats | null>(null);

  // Beneficiary search + verification state.
  const [searchType, setSearchType] = useState<keyof typeof SEARCH_LABELS>("ayushmanCardNumber");
  const [searchValue, setSearchValue] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [patientId, setPatientId] = useState("");
  const [card, setCard] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [family, setFamily] = useState<Candidate[] | null>(null);

  // Pre-auth queue.
  const [preAuthTab, setPreAuthTab] = useState<"PENDING" | "APPROVED" | "ALL">("PENDING");
  const [preAuths, setPreAuths] = useState<PreAuthRow[] | null>(null);
  const [showNewPreAuth, setShowNewPreAuth] = useState(false);

  // Package master.
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
      /* best-effort */
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

  const loadPreAuths = useCallback(async () => {
    setPreAuths(null);
    try {
      const res = await api.get<{ data: PreAuthRow[] }>(`/pmjay/preauth?status=${preAuthTab}`);
      setPreAuths(res.data ?? []);
    } catch {
      setPreAuths([]);
    }
  }, [preAuthTab]);

  useEffect(() => { loadStats(); loadPackages(); }, [loadStats, loadPackages]);
  useEffect(() => { loadPreAuths(); }, [loadPreAuths]);

  async function findBeneficiary() {
    if (!searchValue.trim()) {
      toast.error("Enter a value to search.");
      return;
    }
    setSearching(true);
    setCandidates(null);
    try {
      const res = await api.post<{ data: Candidate[] }>("/pmjay/search-beneficiary", {
        [searchType]: searchValue.trim(),
      });
      setCandidates(res.data ?? []);
      if ((res.data ?? []).length === 0) toast.info("No beneficiaries found.");
    } catch (e) {
      toast.error((e as Error).message || "Search failed.");
    } finally {
      setSearching(false);
    }
  }

  async function verify() {
    if (!patientId || !card.trim()) {
      toast.error("Pick a patient and enter/select an Ayushman card number.");
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
      const res = await api.get<{ data: Candidate[] }>(`/pmjay/family/${result.familyId}`);
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
            Beneficiary eligibility, pre-authorisation, HBP packages, and scheme metrics.
          </p>
        </div>
        <Link href="/dashboard/insurance-claims" className="text-sm text-primary underline">
          Go to Insurance Claims →
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard title="Eligible beneficiaries" value={stats?.beneficiaries.eligible ?? "—"} sub={`${stats?.beneficiaries.pendingVerification ?? 0} pending verification`} />
        <StatCard title="Pre-auth pending" value={stats?.preAuth.pending ?? "—"} />
        <StatCard title="Pre-auth approved" value={stats?.preAuth.approved ?? "—"} />
        <StatCard title="Active admissions" value={stats?.admissions ?? "—"} />
        <StatCard title="Claims submitted" value={stats?.claims.submitted ?? "—"} />
        <StatCard title="Claims settled" value={stats?.claims.settled ?? "—"} />
        <StatCard title="Denied claims" value={stats?.claims.denied ?? "—"} tone={stats && stats.claims.denied > 0 ? "danger" : undefined} />
        <StatCard title="Total approved" value={stats ? formatINR(stats.amounts.totalApproved) : "—"} />
        <StatCard title="Settlement amount" value={stats ? formatINR(stats.amounts.settlementAmount) : "—"} />
        <StatCard
          title="Package master"
          value={stats?.packages.active ?? "—"}
          sub={stats?.packages.lastSyncedAt ? `${stats.packages.version} · ${new Date(stats.packages.lastSyncedAt).toLocaleDateString()}` : "not synced"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Beneficiary search + verification */}
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Search className="h-4 w-4" /> Beneficiary verification
          </h2>

          {/* Multi-identifier search */}
          <div className="mt-4 space-y-2 rounded-lg border border-gray-100 p-3 dark:border-gray-700">
            <label className="block text-xs font-medium text-gray-500">Find beneficiary in BIS</label>
            <div className="flex gap-2">
              <select
                value={searchType}
                onChange={(e) => setSearchType(e.target.value as keyof typeof SEARCH_LABELS)}
                data-testid="pmjay-search-type"
                className="rounded-lg border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              >
                {SEARCH_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <input
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                placeholder="Enter identifier..."
                data-testid="pmjay-search-value"
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
              <button
                type="button"
                onClick={findBeneficiary}
                disabled={searching}
                data-testid="pmjay-search-btn"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-gray-600"
              >
                {searching ? "…" : "Find"}
              </button>
            </div>
            {candidates && candidates.length > 0 && (
              <ul className="mt-1 divide-y divide-gray-100 text-xs dark:divide-gray-700">
                {candidates.map((c) => (
                  <li key={c.beneficiaryId} className="flex items-center justify-between py-1.5">
                    <span>
                      {c.name} <span className="font-mono text-gray-400">· {c.ayushmanCardNumber}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setCard(c.ayushmanCardNumber)}
                      className="text-primary underline"
                      data-testid="pmjay-use-candidate"
                    >
                      Use card
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

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
                <dl className="mt-2 grid grid-cols-3 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
                  {result.name && (<><dt className="text-gray-400">Beneficiary</dt><dd className="col-span-2 text-right">{result.name}</dd></>)}
                  <dt className="text-gray-400">Member ID</dt><dd className="col-span-2 text-right font-mono">{result.beneficiaryId ?? "—"}</dd>
                  <dt className="text-gray-400">Family ID</dt><dd className="col-span-2 text-right font-mono">{result.familyId ?? "—"}</dd>
                  <dt className="text-gray-400">Card No</dt><dd className="col-span-2 text-right font-mono">{result.ayushmanCardNumber}</dd>
                  <dt className="text-gray-400">Verified</dt><dd className="col-span-2 text-right">{new Date(result.verifiedAt).toLocaleString()}</dd>
                </dl>
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

      {/* Pre-Authorization queue */}
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <FileCheck className="h-4 w-4" /> Pre-Authorizations
          </h2>
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setShowNewPreAuth(true)}
              data-testid="pmjay-new-preauth-btn"
              className="mr-1 flex items-center gap-1 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-white"
            >
              <Plus className="h-3 w-3" /> New Pre-Auth
            </button>
            {(["PENDING", "APPROVED", "ALL"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setPreAuthTab(t)}
                data-testid={`pmjay-preauth-tab-${t}`}
                className={`rounded-lg px-3 py-1 text-xs font-medium ${
                  preAuthTab === t ? "bg-primary text-white" : "border border-gray-300 dark:border-gray-600"
                }`}
              >
                {t}
              </button>
            ))}
            <Link href="/dashboard/preauth" className="ml-2 self-center text-xs text-primary underline">
              Manage →
            </Link>
          </div>
        </div>
        <div className="mt-3 overflow-x-auto">
          {preAuths === null ? (
            <SkeletonTable />
          ) : preAuths.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">No {preAuthTab === "ALL" ? "" : preAuthTab.toLowerCase()} PM-JAY pre-authorisations.</p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr>
                  <th className="py-1">Request #</th>
                  <th className="py-1">Patient</th>
                  <th className="py-1">Procedure / Package</th>
                  <th className="py-1 text-right">Est. cost</th>
                  <th className="py-1 text-right">Approved</th>
                  <th className="py-1 text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {preAuths.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="py-1.5 font-mono text-xs">{r.requestNumber}</td>
                    <td className="py-1.5">{r.patient?.user?.name ?? "—"}</td>
                    <td className="py-1.5">
                      {r.procedureName}
                      {r.packageCode && <span className="ml-1 font-mono text-xs text-gray-400">· {r.packageCode}</span>}
                    </td>
                    <td className="py-1.5 text-right">{formatINR(r.estimatedCost)}</td>
                    <td className="py-1.5 text-right">{r.approvedAmount != null ? formatINR(r.approvedAmount) : "—"}</td>
                    <td className="py-1.5 text-center"><StatusPill status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {showNewPreAuth && (
        <NewPreAuthModal
          packages={packages ?? []}
          onClose={() => setShowNewPreAuth(false)}
          onCreated={() => {
            setShowNewPreAuth(false);
            setPreAuthTab("PENDING");
            loadPreAuths();
            loadStats();
          }}
        />
      )}
    </div>
  );
}

// ─── New PM-JAY pre-authorisation modal ─────────────────────────────────────
function NewPreAuthModal({
  packages,
  onClose,
  onCreated,
}: {
  packages: PkgRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [patientId, setPatientId] = useState("");
  const [ben, setBen] = useState<{ ayushmanCardNumber: string; beneficiaryId: string | null } | null>(null);
  const [benChecked, setBenChecked] = useState(false);
  const [packageCode, setPackageCode] = useState("");
  const [estimatedCost, setEstimatedCost] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedPkg = packages.find((p) => p.packageCode === packageCode);

  // Auto-fill eligible beneficiary for the chosen patient.
  useEffect(() => {
    if (!patientId) {
      setBen(null);
      setBenChecked(false);
      return;
    }
    let cancelled = false;
    setBenChecked(false);
    api
      .get<{ data: { ayushmanCardNumber: string; beneficiaryId: string | null } | null }>(
        `/pmjay/beneficiary?patientId=${patientId}`
      )
      .then((r) => {
        if (!cancelled) {
          setBen(r.data ?? null);
          setBenChecked(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBen(null);
          setBenChecked(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  function pickPackage(code: string) {
    setPackageCode(code);
    const p = packages.find((x) => x.packageCode === code);
    if (p) setEstimatedCost(String(Number(p.amount)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!patientId) return setErr("Select a patient.");
    if (!ben) return setErr("This patient has no verified, eligible PM-JAY beneficiary. Verify eligibility first.");
    if (!packageCode || !selectedPkg) return setErr("Select an HBP package.");
    const cost = parseFloat(estimatedCost);
    if (Number.isNaN(cost) || cost <= 0) return setErr("Enter a valid estimated cost.");
    setSubmitting(true);
    try {
      await api.post("/preauth", {
        patientId,
        insuranceProvider: "PM-JAY (Ayushman Bharat)",
        policyNumber: ben.ayushmanCardNumber,
        procedureName: selectedPkg.packageName,
        estimatedCost: cost,
        packageCode,
        ...(diagnosis.trim() ? { diagnosis: diagnosis.trim() } : {}),
      });
      toast.success("PM-JAY pre-authorisation created.");
      onCreated();
    } catch (e2) {
      setErr((e2 as Error).message || "Could not create pre-authorisation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} noValidate className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New PM-JAY pre-authorisation</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-3">
          <div>
            <label className="block text-sm font-medium">Patient <span className="text-red-500">*</span></label>
            <EntityPicker
              endpoint="/patients"
              labelField="user.name"
              subtitleField="user.phone"
              hintField="mrNumber"
              value={patientId}
              onChange={(id) => setPatientId(id)}
              searchPlaceholder="Search by name, phone, MR..."
              testIdPrefix="preauth-patient-picker"
            />
          </div>

          {patientId && (
            benChecked && !ben ? (
              <p className="text-xs font-medium text-red-600 dark:text-red-400" data-testid="preauth-noben">
                No verified, eligible beneficiary for this patient — verify eligibility above first.
              </p>
            ) : ben ? (
              <p className="text-xs text-green-700 dark:text-green-400" data-testid="preauth-ben">
                Beneficiary eligible ✓ · card <span className="font-mono">{ben.ayushmanCardNumber}</span>
              </p>
            ) : (
              <p className="text-xs text-gray-500">Checking eligibility…</p>
            )
          )}

          <div>
            <label htmlFor="preauth-package" className="block text-sm font-medium">HBP package <span className="text-red-500">*</span></label>
            <select
              id="preauth-package"
              value={packageCode}
              onChange={(e) => pickPackage(e.target.value)}
              data-testid="preauth-package-select"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            >
              <option value="">Select HBP package...</option>
              {packages.map((p) => (
                <option key={p.packageCode} value={p.packageCode}>
                  {p.packageCode} — {p.packageName}
                </option>
              ))}
            </select>
            {packages.length === 0 && (
              <p className="mt-1 text-xs text-gray-500">No packages loaded — sync the package master first.</p>
            )}
          </div>

          <div>
            <label htmlFor="preauth-cost" className="block text-sm font-medium">Estimated cost (INR) <span className="text-red-500">*</span></label>
            <input
              id="preauth-cost"
              type="number"
              value={estimatedCost}
              onChange={(e) => setEstimatedCost(e.target.value)}
              data-testid="preauth-cost-input"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>

          <div>
            <label htmlFor="preauth-diagnosis" className="block text-sm font-medium">Diagnosis</label>
            <input
              id="preauth-diagnosis"
              value={diagnosis}
              onChange={(e) => setDiagnosis(e.target.value)}
              placeholder="ICD-10 code or description (optional)"
              data-testid="preauth-diagnosis-input"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>
        </div>

        {err && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{err}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700">Cancel</button>
          <button type="submit" disabled={submitting} data-testid="preauth-submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {submitting ? "Creating..." : "Create pre-auth"}
          </button>
        </div>
      </form>
    </div>
  );
}
