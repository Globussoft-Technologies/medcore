"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { extractFieldErrors, type FieldErrorMap } from "@/lib/field-errors";
import {
  Droplet,
  Plus,
  Search,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  isAboCompatible,
  aboMismatchReason,
  prettyBloodGroup as sharedPrettyGroup,
} from "@medcore/shared";

const BLOOD_GROUPS = [
  "A_POS",
  "A_NEG",
  "B_POS",
  "B_NEG",
  "AB_POS",
  "AB_NEG",
  "O_POS",
  "O_NEG",
] as const;

const COMPONENTS = [
  "WHOLE_BLOOD",
  "PACKED_RED_CELLS",
  "PLATELETS",
  "FRESH_FROZEN_PLASMA",
  "CRYOPRECIPITATE",
] as const;

const URGENCIES = ["ROUTINE", "URGENT", "EMERGENCY"] as const;

function prettyGroup(g: string) {
  return g.replace("_POS", "+").replace("_NEG", "-").replace("_", " ");
}
function prettyComponent(c: string) {
  return c.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());
}

interface Donor {
  id: string;
  donorNumber: string;
  name: string;
  phone: string;
  bloodGroup: string;
  gender: string;
  totalDonations: number;
  lastDonation?: string | null;
  isEligible: boolean;
}

interface Donation {
  id: string;
  unitNumber: string;
  donatedAt: string;
  volumeMl: number;
  approved: boolean;
  donor: Donor;
}

interface BloodUnit {
  id: string;
  unitNumber: string;
  bloodGroup: string;
  component: string;
  volumeMl: number;
  expiresAt: string;
  status: string;
  storageLocation?: string | null;
  reservedUntil?: string | null;
  reservedForRequestId?: string | null;
}

interface InventorySummary {
  totalAvailable: number;
  byBloodGroup: Record<string, Record<string, number>>;
  byComponent: Record<string, number>;
  expiringSoon: number;
  // Issue #49 (2026-04-24): per-group breakdown sourced from the same
  // helper as `expiringSoon` so summary === Σ per-group.
  expiringByBloodGroup?: Record<string, number>;
}

interface BloodRequest {
  id: string;
  requestNumber: string;
  patient: { id: string; user: { name: string } };
  bloodGroup: string;
  component: string;
  unitsRequested: number;
  reason: string;
  urgency: string;
  fulfilled: boolean;
  createdAt: string;
  units: BloodUnit[];
}

interface Patient {
  id: string;
  mrNumber: string;
  user: { name: string; phone: string };
}

type Tab = "inventory" | "donors" | "donations" | "requests";

export default function BloodBankPage() {
  const { user } = useAuthStore();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("inventory");
  const [loading, setLoading] = useState(true);

  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [units, setUnits] = useState<BloodUnit[]>([]);
  const [donors, setDonors] = useState<Donor[]>([]);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [requests, setRequests] = useState<BloodRequest[]>([]);
  const [donorSearch, setDonorSearch] = useState("");
  const [deferralDonorId, setDeferralDonorId] = useState<string | null>(null);
  const [separationDonationId, setSeparationDonationId] = useState<string | null>(null);

  const [showDonorModal, setShowDonorModal] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [matchingRequest, setMatchingRequest] = useState<BloodRequest | null>(null);
  const [matchUnits, setMatchUnits] = useState<BloodUnit[]>([]);
  const [selectedMatchIds, setSelectedMatchIds] = useState<Set<string>>(new Set());

  const canCreateRequest = user?.role === "DOCTOR" || user?.role === "ADMIN" || user?.role === "NURSE";
  const canApprove = user?.role === "DOCTOR" || user?.role === "ADMIN";
  const canRegisterDonor = user?.role === "NURSE" || user?.role === "DOCTOR" || user?.role === "ADMIN";

  async function load() {
    setLoading(true);
    try {
      const [s, invRes, donorsRes, donationsRes, reqRes] = await Promise.all([
        api.get<{ data: InventorySummary }>("/bloodbank/inventory/summary"),
        api.get<{ data: BloodUnit[] }>("/bloodbank/inventory?limit=200"),
        api.get<{ data: Donor[] }>(`/bloodbank/donors?limit=100${donorSearch ? `&search=${encodeURIComponent(donorSearch)}` : ""}`),
        api.get<{ data: Donation[] }>("/bloodbank/donations?limit=50"),
        api.get<{ data: BloodRequest[] }>("/bloodbank/requests?limit=50"),
      ]);
      setSummary(s.data);
      setUnits(invRes.data);
      setDonors(donorsRes.data);
      setDonations(donationsRes.data);
      setRequests(reqRes.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function approveDonation(id: string, approved: boolean) {
    try {
      await api.patch(`/bloodbank/donations/${id}/approve`, { approved });
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function openMatch(request: BloodRequest) {
    setMatchingRequest(request);
    setSelectedMatchIds(new Set());
    try {
      const res = await api.post<{ data: BloodUnit[] }>(`/bloodbank/requests/${request.id}/match`);
      setMatchUnits(res.data);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // Issue #93 (2026-04-26): operator-supplied clinical reason for an ABO
  // mismatch override. Required (≥10 chars) when at least one selected
  // unit is incompatible with the recipient.
  const [aboOverrideReason, setAboOverrideReason] = useState("");

  // Reset the reason whenever the match modal closes/reopens.
  useEffect(() => {
    if (!matchingRequest) setAboOverrideReason("");
  }, [matchingRequest]);

  // Mismatched unit numbers among the currently selected units (for the
  // yellow warning banner inside the match modal).
  const selectedMismatches = useMemo(() => {
    if (!matchingRequest) return [] as Array<{ unitNumber: string; bloodGroup: string }>;
    const recipient = matchingRequest.bloodGroup;
    return matchUnits
      .filter((u) => selectedMatchIds.has(u.id))
      .filter((u) => !isAboCompatible(u.bloodGroup, recipient, "RBC"))
      .map((u) => ({ unitNumber: u.unitNumber, bloodGroup: u.bloodGroup }));
  }, [matchingRequest, matchUnits, selectedMatchIds]);

  async function issueUnits() {
    if (!matchingRequest) return;
    const needsOverride = selectedMismatches.length > 0;
    if (needsOverride && aboOverrideReason.trim().length < 10) {
      toast.error(
        "ABO mismatch detected — provide a clinical reason (≥10 characters) to override."
      );
      return;
    }
    try {
      await api.post(`/bloodbank/requests/${matchingRequest.id}/issue`, {
        unitIds: Array.from(selectedMatchIds),
        ...(needsOverride
          ? {
              overrideAboMismatch: true,
              clinicalReason: aboOverrideReason.trim(),
            }
          : {}),
      });
      setMatchingRequest(null);
      setMatchUnits([]);
      setSelectedMatchIds(new Set());
      setAboOverrideReason("");
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function reserveUnits(hours = 24) {
    if (!matchingRequest) return;
    if (selectedMatchIds.size === 0) {
      toast.error("Select units to reserve");
      return;
    }
    try {
      const ids = Array.from(selectedMatchIds);
      for (const id of ids) {
        await api.post(`/bloodbank/units/${id}/reserve`, {
          requestId: matchingRequest.id,
          durationHours: hours,
        });
      }
      toast.success(`Reserved ${ids.length} unit(s) for ${hours}h`);
      setMatchingRequest(null);
      setMatchUnits([]);
      setSelectedMatchIds(new Set());
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function releaseReservation(unitId: string) {
    try {
      await api.post(`/bloodbank/units/${unitId}/release`, {});
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  function formatRemaining(until: string): string {
    const ms = new Date(until).getTime() - Date.now();
    if (ms <= 0) return "Expired";
    const h = Math.floor(ms / (60 * 60 * 1000));
    const m = Math.floor((ms % (60 * 60 * 1000)) / 60000);
    return `${h}h ${m}m left`;
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Droplet className="text-red-600" size={28} />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Blood Bank</h1>
      </div>

      {/* Summary strip */}
      {summary && (
        <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="rounded-lg bg-white p-4 text-gray-900 shadow dark:bg-gray-800 dark:text-gray-100">
            <p className="text-xs text-gray-500 dark:text-gray-400">Available Units</p>
            <p className="text-2xl font-bold">{summary?.totalAvailable ?? 0}</p>
          </div>
          <div className="rounded-lg bg-white p-4 text-gray-900 shadow dark:bg-gray-800 dark:text-gray-100">
            <p className="text-xs text-gray-500 dark:text-gray-400">Expiring in 7 days</p>
            <p className="text-2xl font-bold text-red-600 dark:text-red-400">{summary?.expiringSoon ?? 0}</p>
          </div>
          <div className="rounded-lg bg-white p-4 text-gray-900 shadow dark:bg-gray-800 dark:text-gray-100">
            <p className="text-xs text-gray-500 dark:text-gray-400">Open Requests</p>
            <p className="text-2xl font-bold">
              {requests.filter((r) => !r.fulfilled).length}
            </p>
          </div>
          <div className="rounded-lg bg-white p-4 text-gray-900 shadow dark:bg-gray-800 dark:text-gray-100">
            <p className="text-xs text-gray-500 dark:text-gray-400">Total Donors</p>
            <p className="text-2xl font-bold">{donors.length}</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b border-gray-200 dark:border-gray-700">
        {(["inventory", "donors", "donations", "requests"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize ${
              tab === t
                ? "border-b-2 border-red-600 text-red-600 dark:text-red-400"
                : "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-gray-500 dark:text-gray-400">Loading...</p>
      ) : (
        <>
          {tab === "inventory" && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
              {BLOOD_GROUPS.map((g) => {
                const counts = summary?.byBloodGroup?.[g] ?? {};
                const total = Object.values(counts).reduce((a, b) => a + b, 0);
                // Issue #49: read expiring count from the summary (single
                // source of truth) instead of re-filtering the paginated
                // `units` list. This guarantees summary.expiringSoon ===
                // Σ expiringByBloodGroup[g] rendered below.
                const expiring = summary?.expiringByBloodGroup?.[g] ?? 0;
                return (
                  <div
                    key={g}
                    className="rounded-lg bg-white p-4 text-gray-900 shadow border border-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:border-gray-700"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-2xl font-bold text-red-600">
                        {prettyGroup(g)}
                      </div>
                      <div className="text-3xl font-bold">{total}</div>
                    </div>
                    <div className="mt-3 space-y-1">
                      {COMPONENTS.map((c) => (
                        <div
                          key={c}
                          className="flex justify-between text-sm text-gray-700 dark:text-gray-200"
                        >
                          <span>{prettyComponent(c)}</span>
                          <span className="font-medium">{counts[c] || 0}</span>
                        </div>
                      ))}
                    </div>
                    {expiring > 0 && (
                      <div className="mt-3 flex items-center gap-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
                        <AlertTriangle size={14} />
                        {expiring} expiring in 7 days
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === "donors" && (
            <div>
              <div className="mb-3 flex items-center gap-3">
                <div className="flex flex-1 items-center gap-2 rounded border bg-white px-3 py-2">
                  <Search size={16} className="text-gray-400" />
                  <input
                    type="text"
                    value={donorSearch}
                    onChange={(e) => setDonorSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && load()}
                    placeholder="Search by name, phone, donor number"
                    className="flex-1 outline-none"
                  />
                </div>
                {canRegisterDonor && (
                  <button
                    onClick={() => setShowDonorModal(true)}
                    className="flex items-center gap-2 rounded bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-700"
                  >
                    <Plus size={16} /> Register Donor
                  </button>
                )}
                {canRegisterDonor && (
                  <button
                    onClick={async () => {
                      if (!(await confirm({ title: "Send donation reminders to all eligible donors?" }))) return;
                      try {
                        const res = await api.post<{
                          data: { count: number };
                        }>(`/bloodbank/donors/send-donation-reminders`, {});
                        toast.success(`Reminders sent to ${res.data.count} donor(s).`);
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Failed");
                      }
                    }}
                    className="flex items-center gap-2 rounded border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-700 hover:bg-blue-100"
                  >
                    Send Reminders
                  </button>
                )}
              </div>
              <div className="rounded-lg bg-white shadow">
                <table className="w-full text-sm">
                  <thead className="border-b bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="p-3">Donor #</th>
                      <th className="p-3">Name</th>
                      <th className="p-3">Phone</th>
                      <th className="p-3">Group</th>
                      <th className="p-3">Donations</th>
                      <th className="p-3">Last</th>
                      <th className="p-3">Eligible</th>
                      <th className="p-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {donors.map((d) => (
                      <tr key={d.id} className="border-b hover:bg-gray-50">
                        <td className="p-3 font-mono text-xs">{d.donorNumber}</td>
                        <td className="p-3 font-medium">{d.name}</td>
                        <td className="p-3">{d.phone}</td>
                        <td className="p-3 font-bold text-red-600">
                          {prettyGroup(d.bloodGroup)}
                        </td>
                        <td className="p-3">{d.totalDonations}</td>
                        <td className="p-3 text-xs text-gray-500">
                          {d.lastDonation
                            ? new Date(d.lastDonation).toLocaleDateString()
                            : "—"}
                        </td>
                        <td className="p-3">
                          {d.isEligible ? (
                            <span className="text-green-600">Yes</span>
                          ) : (
                            <span className="text-gray-400">No</span>
                          )}
                        </td>
                        <td className="p-3">
                          {canApprove && (
                            <button
                              onClick={() => setDeferralDonorId(d.id)}
                              className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
                            >
                              Add Deferral
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {donors.length === 0 && (
                      <tr>
                        <td colSpan={8} className="p-6 text-center text-gray-400">
                          No donors found
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "donations" && (
            <div className="rounded-lg bg-white shadow">
              <table className="w-full text-sm">
                <thead className="border-b bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="p-3">Unit #</th>
                    <th className="p-3">Donor</th>
                    <th className="p-3">Group</th>
                    <th className="p-3">Date</th>
                    <th className="p-3">Volume</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {donations.map((d) => (
                    <tr key={d.id} className="border-b hover:bg-gray-50">
                      <td className="p-3 font-mono text-xs">{d.unitNumber}</td>
                      <td className="p-3">{d.donor.name}</td>
                      <td className="p-3 font-bold text-red-600">
                        {prettyGroup(d.donor.bloodGroup)}
                      </td>
                      <td className="p-3 text-xs text-gray-500">
                        {new Date(d.donatedAt).toLocaleDateString()}
                      </td>
                      <td className="p-3">{d.volumeMl} ml</td>
                      <td className="p-3">
                        {d.approved ? (
                          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
                            Approved
                          </span>
                        ) : (
                          <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">
                            Pending
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        {!d.approved && canApprove && (
                          <div className="flex gap-2">
                            <button
                              onClick={() => approveDonation(d.id, true)}
                              className="flex items-center gap-1 rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                            >
                              <CheckCircle2 size={12} /> Approve
                            </button>
                            <button
                              onClick={() => approveDonation(d.id, false)}
                              className="flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700"
                            >
                              <XCircle size={12} /> Reject
                            </button>
                          </div>
                        )}
                        {d.approved && canApprove && (
                          <button
                            onClick={() => setSeparationDonationId(d.id)}
                            className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
                          >
                            Separate Components
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {donations.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-gray-400">
                        No donations recorded
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === "requests" && (
            <div>
              <div className="mb-3 flex justify-end">
                {canCreateRequest && (
                  <button
                    onClick={() => setShowRequestModal(true)}
                    className="flex items-center gap-2 rounded bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-700"
                  >
                    <Plus size={16} /> New Request
                  </button>
                )}
              </div>
              <div className="rounded-lg bg-white shadow">
                <table className="w-full text-sm">
                  <thead className="border-b bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="p-3">Request #</th>
                      <th className="p-3">Patient</th>
                      <th className="p-3">Need</th>
                      <th className="p-3">Urgency</th>
                      <th className="p-3">Status</th>
                      <th className="p-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id} className="border-b hover:bg-gray-50">
                        <td className="p-3 font-mono text-xs">{r.requestNumber}</td>
                        <td className="p-3">{r.patient.user.name}</td>
                        <td className="p-3">
                          <span className="font-bold text-red-600">
                            {prettyGroup(r.bloodGroup)}
                          </span>{" "}
                          {prettyComponent(r.component)} × {r.unitsRequested}
                        </td>
                        <td className="p-3">
                          <span
                            className={`rounded px-2 py-0.5 text-xs ${
                              r.urgency === "EMERGENCY"
                                ? "bg-red-100 text-red-700"
                                : r.urgency === "URGENT"
                                ? "bg-orange-100 text-orange-700"
                                : "bg-gray-100 text-gray-700"
                            }`}
                          >
                            {r.urgency}
                          </span>
                        </td>
                        <td className="p-3">
                          {r.fulfilled ? (
                            <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
                              Fulfilled
                            </span>
                          ) : (
                            <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">
                              Open
                            </span>
                          )}
                        </td>
                        <td className="p-3">
                          {!r.fulfilled && (
                            <button
                              onClick={() => openMatch(r)}
                              className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
                            >
                              Match Units
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {requests.length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-6 text-center text-gray-400">
                          No requests
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {showDonorModal && (
        <DonorModal
          onClose={() => setShowDonorModal(false)}
          onSaved={() => {
            setShowDonorModal(false);
            load();
          }}
        />
      )}

      {showRequestModal && (
        <RequestModal
          onClose={() => setShowRequestModal(false)}
          onSaved={() => {
            setShowRequestModal(false);
            load();
          }}
        />
      )}

      {deferralDonorId && (
        <DeferralModal
          donorId={deferralDonorId}
          onClose={() => setDeferralDonorId(null)}
          onSaved={() => {
            setDeferralDonorId(null);
            load();
          }}
        />
      )}

      {separationDonationId && (
        <SeparationModal
          donationId={separationDonationId}
          onClose={() => setSeparationDonationId(null)}
          onSaved={() => {
            setSeparationDonationId(null);
            load();
          }}
        />
      )}

      {matchingRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">
                Match Units for {matchingRequest.requestNumber}
              </h2>
              <button
                onClick={() => setMatchingRequest(null)}
                className="text-gray-400 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            <p className="mb-3 text-sm text-gray-600">
              Patient: {matchingRequest.patient.user.name} • Need:{" "}
              <span className="font-bold text-red-600">
                {prettyGroup(matchingRequest.bloodGroup)}
              </span>{" "}
              {prettyComponent(matchingRequest.component)} ×{" "}
              {matchingRequest.unitsRequested}
            </p>
            <div className="space-y-2">
              {matchUnits.length === 0 && (
                <p className="text-sm text-gray-400">No compatible units available.</p>
              )}
              {matchUnits.map((u) => {
                const checked = selectedMatchIds.has(u.id);
                const incompatible = !isAboCompatible(
                  u.bloodGroup,
                  matchingRequest.bloodGroup,
                  "RBC"
                );
                return (
                  <label
                    key={u.id}
                    data-testid={`abo-unit-${u.unitNumber}`}
                    className={`flex cursor-pointer items-center gap-3 rounded border p-3 hover:bg-gray-50 ${
                      incompatible ? "border-yellow-400 bg-yellow-50" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = new Set(selectedMatchIds);
                        if (e.target.checked) next.add(u.id);
                        else next.delete(u.id);
                        setSelectedMatchIds(next);
                      }}
                    />
                    <div className="flex-1">
                      <div className="font-mono text-xs">{u.unitNumber}</div>
                      <div className="text-xs text-gray-500">
                        {prettyGroup(u.bloodGroup)} •{" "}
                        {prettyComponent(u.component)} • {u.volumeMl}ml • exp{" "}
                        {new Date(u.expiresAt).toLocaleDateString()}
                      </div>
                      {incompatible && (
                        <div className="mt-1 inline-flex items-center gap-1 rounded bg-yellow-100 px-2 py-0.5 text-[11px] font-semibold text-yellow-800">
                          <AlertTriangle size={12} /> ABO mismatch with{" "}
                          {sharedPrettyGroup(matchingRequest.bloodGroup)}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>

            {/* Issue #93 (2026-04-26): yellow banner appears once at least
                one selected unit is incompatible. The clinical-reason
                input is REQUIRED before Issue can be clicked. */}
            {selectedMismatches.length > 0 && (
              <div
                data-testid="abo-mismatch-warning"
                className="mt-4 rounded-lg border border-yellow-400 bg-yellow-50 p-3 text-sm text-yellow-900"
              >
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle size={16} />
                  ABO mismatch on {selectedMismatches.length} unit
                  {selectedMismatches.length === 1 ? "" : "s"}
                </div>
                <p className="mt-1 text-xs">
                  {aboMismatchReason(
                    selectedMismatches[0].bloodGroup,
                    matchingRequest.bloodGroup,
                    "RBC"
                  )}
                  . Issuing requires a documented clinical reason for the
                  override (audited).
                </p>
                <label className="mt-2 block text-xs font-medium text-yellow-900">
                  Clinical reason (required, ≥10 chars)
                </label>
                <textarea
                  data-testid="abo-override-reason"
                  value={aboOverrideReason}
                  onChange={(e) => setAboOverrideReason(e.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded border border-yellow-300 bg-white px-2 py-1 text-sm"
                  placeholder="e.g. Massive haemorrhage, no compatible O- in stock, attending Dr Rao authorised emergency override"
                />
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setMatchingRequest(null)}
                className="rounded border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                disabled={selectedMatchIds.size === 0}
                onClick={() => reserveUnits(24)}
                className="rounded border border-amber-500 bg-amber-50 px-4 py-2 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                Reserve {selectedMatchIds.size} Unit(s) (24h)
              </button>
              <button
                data-testid="abo-issue-button"
                disabled={
                  selectedMatchIds.size === 0 ||
                  (selectedMismatches.length > 0 &&
                    aboOverrideReason.trim().length < 10)
                }
                onClick={issueUnits}
                className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                Issue {selectedMatchIds.size} Unit(s)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reserved units panel (bottom) */}
      {tab === "inventory" && (() => {
        const reserved = units.filter((u) => u.status === "RESERVED");
        if (reserved.length === 0) return null;
        return (
          <div className="mt-6 rounded-xl bg-white p-5 shadow">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-amber-800">
                Reserved Units ({reserved.length})
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {reserved.map((u) => (
                <div
                  key={u.id}
                  className="rounded-lg border border-amber-300 bg-amber-50 p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs">{u.unitNumber}</span>
                    <span className="rounded bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">
                      RESERVED
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-600">
                    {u.bloodGroup.replace(/_/g, " ")} • {u.component.replace(/_/g, " ")}
                  </p>
                  {u.reservedUntil && (
                    <p className="mt-1 text-xs font-medium text-amber-800">
                      {formatRemaining(u.reservedUntil)}
                    </p>
                  )}
                  <button
                    onClick={() => releaseReservation(u.id)}
                    className="mt-2 text-xs font-medium text-red-600 hover:underline"
                  >
                    Release
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function DonorModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    bloodGroup: "O_POS",
    gender: "MALE",
    dateOfBirth: "",
    weight: "",
    address: "",
  });
  const [saving, setSaving] = useState(false);
  // Issue #223: per-field zod errors (e.g. "Invalid email", "Phone must
  // be 10–15 digits") instead of a single "Validation failed" toast.
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});

  function clearFieldError(field: string) {
    setFieldErrors((p) => {
      if (!p[field]) return p;
      const n = { ...p };
      delete n[field];
      return n;
    });
  }

  async function save() {
    setSaving(true);
    setFieldErrors({});
    try {
      await api.post("/bloodbank/donors", {
        name: form.name,
        phone: form.phone,
        email: form.email || undefined,
        bloodGroup: form.bloodGroup,
        gender: form.gender,
        dateOfBirth: form.dateOfBirth || undefined,
        weight: form.weight ? Number(form.weight) : undefined,
        address: form.address || undefined,
      });
      onSaved();
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) {
        setFieldErrors(fields);
        toast.error(Object.values(fields)[0] || "Please fix the highlighted fields");
      } else {
        toast.error((err as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Register Donor</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3">
          <div>
            <input
              placeholder="Full name"
              data-testid="donor-name"
              aria-invalid={!!fieldErrors.name}
              className={`w-full rounded border p-2 ${
                fieldErrors.name ? "border-red-500 bg-red-50" : ""
              }`}
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                clearFieldError("name");
              }}
            />
            {fieldErrors.name && (
              <p data-testid="error-donor-name" className="mt-1 text-xs text-red-600">
                {fieldErrors.name}
              </p>
            )}
          </div>
          <div>
            <input
              placeholder="Phone"
              data-testid="donor-phone"
              aria-invalid={!!fieldErrors.phone}
              className={`w-full rounded border p-2 ${
                fieldErrors.phone ? "border-red-500 bg-red-50" : ""
              }`}
              value={form.phone}
              onChange={(e) => {
                setForm({ ...form, phone: e.target.value });
                clearFieldError("phone");
              }}
            />
            {fieldErrors.phone && (
              <p data-testid="error-donor-phone" className="mt-1 text-xs text-red-600">
                {fieldErrors.phone}
              </p>
            )}
          </div>
          <div>
            <input
              placeholder="Email"
              data-testid="donor-email"
              aria-invalid={!!fieldErrors.email}
              className={`w-full rounded border p-2 ${
                fieldErrors.email ? "border-red-500 bg-red-50" : ""
              }`}
              value={form.email}
              onChange={(e) => {
                setForm({ ...form, email: e.target.value });
                clearFieldError("email");
              }}
            />
            {fieldErrors.email && (
              <p data-testid="error-donor-email" className="mt-1 text-xs text-red-600">
                {fieldErrors.email}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <select
              className="rounded border p-2"
              value={form.bloodGroup}
              onChange={(e) => setForm({ ...form, bloodGroup: e.target.value })}
            >
              {BLOOD_GROUPS.map((g) => (
                <option key={g} value={g}>{prettyGroup(g)}</option>
              ))}
            </select>
            <select
              className="rounded border p-2"
              value={form.gender}
              onChange={(e) => setForm({ ...form, gender: e.target.value })}
            >
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <input
                type="date"
                data-testid="donor-dob"
                aria-invalid={!!fieldErrors.dateOfBirth}
                className={`w-full rounded border p-2 ${
                  fieldErrors.dateOfBirth ? "border-red-500 bg-red-50" : ""
                }`}
                value={form.dateOfBirth}
                onChange={(e) => {
                  setForm({ ...form, dateOfBirth: e.target.value });
                  clearFieldError("dateOfBirth");
                }}
              />
              {fieldErrors.dateOfBirth && (
                <p
                  data-testid="error-donor-dob"
                  className="mt-1 text-xs text-red-600"
                >
                  {fieldErrors.dateOfBirth}
                </p>
              )}
            </div>
            <div>
              <input
                type="number"
                placeholder="Weight (kg)"
                data-testid="donor-weight"
                aria-invalid={!!fieldErrors.weight}
                className={`w-full rounded border p-2 ${
                  fieldErrors.weight ? "border-red-500 bg-red-50" : ""
                }`}
                value={form.weight}
                onChange={(e) => {
                  setForm({ ...form, weight: e.target.value });
                  clearFieldError("weight");
                }}
              />
              {fieldErrors.weight && (
                <p
                  data-testid="error-donor-weight"
                  className="mt-1 text-xs text-red-600"
                >
                  {fieldErrors.weight}
                </p>
              )}
            </div>
          </div>
          <textarea
            placeholder="Address"
            className="w-full rounded border p-2"
            rows={2}
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !form.name || !form.phone}
            className="rounded bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Register"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RequestModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [patientSearch, setPatientSearch] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState<string>("");
  const [form, setForm] = useState({
    bloodGroup: "O_POS",
    component: "PACKED_RED_CELLS",
    unitsRequested: 1,
    urgency: "ROUTINE",
    reason: "",
  });
  const [saving, setSaving] = useState(false);

  async function searchPatients() {
    try {
      const res = await api.get<{ data: Patient[] }>(
        `/patients?search=${encodeURIComponent(patientSearch)}&limit=10`
      );
      setPatients(res.data);
    } catch (err) {
      console.error(err);
    }
  }

  async function save() {
    if (!patientId) {
      toast.error("Select a patient");
      return;
    }
    setSaving(true);
    try {
      await api.post("/bloodbank/requests", {
        patientId,
        bloodGroup: form.bloodGroup,
        component: form.component,
        unitsRequested: Number(form.unitsRequested),
        urgency: form.urgency,
        reason: form.reason,
      });
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">New Blood Request</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-600">Patient</label>
            <div className="flex gap-2">
              <input
                placeholder="Search patient by name / MR"
                className="flex-1 rounded border p-2"
                value={patientSearch}
                onChange={(e) => setPatientSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchPatients()}
              />
              <button
                onClick={searchPatients}
                className="rounded border px-3 text-sm"
              >
                Search
              </button>
            </div>
            {patients.length > 0 && (
              <select
                className="mt-2 w-full rounded border p-2"
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
              >
                <option value="">Select...</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.user.name} ({p.mrNumber})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <select
              className="rounded border p-2"
              value={form.bloodGroup}
              onChange={(e) => setForm({ ...form, bloodGroup: e.target.value })}
            >
              {BLOOD_GROUPS.map((g) => (
                <option key={g} value={g}>{prettyGroup(g)}</option>
              ))}
            </select>
            <select
              className="rounded border p-2"
              value={form.component}
              onChange={(e) => setForm({ ...form, component: e.target.value })}
            >
              {COMPONENTS.map((c) => (
                <option key={c} value={c}>{prettyComponent(c)}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <input
              type="number"
              min={1}
              placeholder="Units"
              className="rounded border p-2"
              value={form.unitsRequested}
              onChange={(e) =>
                setForm({ ...form, unitsRequested: Number(e.target.value) })
              }
            />
            <select
              className="rounded border p-2"
              value={form.urgency}
              onChange={(e) => setForm({ ...form, urgency: e.target.value })}
            >
              {URGENCIES.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
          <textarea
            placeholder="Clinical reason"
            className="w-full rounded border p-2"
            rows={2}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !form.reason || !patientId}
            className="rounded bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Submit Request"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeferralModal({
  donorId,
  onClose,
  onSaved,
}: {
  donorId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    reason: "Recent travel",
    deferralType: "TEMPORARY",
    startDate: new Date().toISOString().slice(0, 10),
    endDate: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.post(`/bloodbank/donors/${donorId}/deferrals`, {
        reason: form.reason,
        deferralType: form.deferralType,
        startDate: form.startDate || undefined,
        endDate: form.endDate || undefined,
        notes: form.notes || undefined,
      });
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Add Donor Deferral</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-gray-600">Reason</label>
            <select
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              className="w-full rounded border p-2 text-sm"
            >
              {[
                "Recent travel",
                "Medication",
                "Infection",
                "Piercing/Tattoo",
                "Pregnancy",
                "Low Hb",
                "Low weight",
                "Recent surgery",
                "Other",
              ].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-600">Deferral Type</label>
            <select
              value={form.deferralType}
              onChange={(e) => setForm({ ...form, deferralType: e.target.value })}
              className="w-full rounded border p-2 text-sm"
            >
              <option value="TEMPORARY">Temporary</option>
              <option value="PERMANENT">Permanent</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs text-gray-600">Start Date</label>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                className="w-full rounded border p-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-600">
                End Date {form.deferralType === "PERMANENT" ? "(N/A)" : ""}
              </label>
              <input
                type="date"
                disabled={form.deferralType === "PERMANENT"}
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                className="w-full rounded border p-2 text-sm disabled:bg-gray-100"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-600">Notes</label>
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="w-full rounded border p-2 text-sm"
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded bg-amber-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Deferral"}
          </button>
        </div>
      </div>
    </div>
  );
}

const SEPARATION_COMPONENTS_UI = [
  { key: "PRBC", label: "Packed Red Cells" },
  { key: "PLATELETS", label: "Platelets" },
  { key: "FFP", label: "Fresh Frozen Plasma" },
  { key: "CRYO", label: "Cryoprecipitate" },
];

function SeparationModal({
  donationId,
  onClose,
  onSaved,
}: {
  donationId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<
    Record<string, { enabled: boolean; unitsProduced: number; volumeMl: string }>
  >({
    PRBC: { enabled: true, unitsProduced: 1, volumeMl: "250" },
    PLATELETS: { enabled: false, unitsProduced: 1, volumeMl: "50" },
    FFP: { enabled: false, unitsProduced: 1, volumeMl: "200" },
    CRYO: { enabled: false, unitsProduced: 1, volumeMl: "20" },
  });
  const [saving, setSaving] = useState(false);

  function toggle(key: string) {
    setSelected((s) => ({
      ...s,
      [key]: { ...s[key], enabled: !s[key].enabled },
    }));
  }
  function setField(key: string, field: string, value: string) {
    setSelected((s) => ({
      ...s,
      [key]: {
        ...s[key],
        [field]: field === "unitsProduced" ? Number(value) : value,
      },
    }));
  }

  async function save() {
    const components = SEPARATION_COMPONENTS_UI.filter(
      (c) => selected[c.key].enabled
    ).map((c) => ({
      component: c.key,
      unitsProduced: selected[c.key].unitsProduced,
      volumeMl: selected[c.key].volumeMl
        ? Number(selected[c.key].volumeMl)
        : undefined,
    }));
    if (components.length === 0) {
      toast.error("Select at least one component");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/bloodbank/donations/${donationId}/separate`, {
        components,
      });
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Separate Components</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Select components to produce from this donation. Each component will
          create corresponding blood units in inventory.
        </p>
        <div className="space-y-3">
          {SEPARATION_COMPONENTS_UI.map((c) => {
            const st = selected[c.key];
            return (
              <div
                key={c.key}
                className="flex items-center gap-3 rounded border p-3"
              >
                <input
                  type="checkbox"
                  checked={st.enabled}
                  onChange={() => toggle(c.key)}
                />
                <div className="flex-1 text-sm font-medium">{c.label}</div>
                <input
                  type="number"
                  min={1}
                  max={10}
                  disabled={!st.enabled}
                  value={st.unitsProduced}
                  onChange={(e) => setField(c.key, "unitsProduced", e.target.value)}
                  className="w-16 rounded border p-1 text-sm disabled:bg-gray-100"
                  placeholder="Units"
                  title="Units produced"
                />
                <input
                  type="number"
                  disabled={!st.enabled}
                  value={st.volumeMl}
                  onChange={(e) => setField(c.key, "volumeMl", e.target.value)}
                  className="w-20 rounded border p-1 text-sm disabled:bg-gray-100"
                  placeholder="Vol ml"
                  title="Volume (ml)"
                />
              </div>
            );
          })}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Processing..." : "Separate"}
          </button>
        </div>
      </div>
    </div>
  );
}
