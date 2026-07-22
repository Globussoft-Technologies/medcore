"use client";

// Department detail page (2026-07) — the full "View Details" surface for one
// department: stats + members (add/remove) + requisition history + materials
// consumed. Admins can manage members; assigned staff get read-only access.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import {
  Building2,
  ArrowLeft,
  Users,
  ClipboardList,
  CheckCircle2,
  PackageCheck,
  Search,
  UserPlus,
  UserMinus,
  Boxes,
} from "lucide-react";
import { SkeletonCard, SkeletonTable } from "@/components/Skeleton";

const VIEW_ALLOWED = new Set(["ADMIN", "PHARMACIST", "NURSE", "DOCTOR", "RECEPTION", "LAB_TECH"]);
const FIELD =
  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500";

interface StaffUser {
  id: string;
  name: string;
  email: string | null;
  role: string;
}
interface Member {
  id: string;
  userId: string;
  user: StaffUser;
}
interface ReqRow {
  id: string;
  requisitionNumber: string;
  status: string;
  createdAt: string;
  requestedBy: string;
  itemCount: number;
}
interface Consumed {
  name: string;
  unit: string;
  issued: number;
}
interface Holding {
  id: string;
  materialId: string;
  name: string;
  unit: string;
  category: string;
  quantity: number;
}
interface Detail {
  department: { id: string; name: string; code: string; active: boolean; createdAt: string };
  stats: {
    memberCount: number;
    totalRequests: number;
    openRequests: number;
    completedRequests: number;
    totalUnitsIssued: number;
    totalUnitsOnHand: number;
  };
  members: Member[];
  requisitions: ReqRow[];
  holdings: Holding[];
  consumed: Consumed[];
}

const STATUS_STYLE: Record<string, string> = {
  SUBMITTED: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  PARTIALLY_APPROVED: "bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300",
  PARTIALLY_ISSUED: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  ISSUED: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
  COMPLETED: "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  REJECTED: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  CANCELLED: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
};

export default function DepartmentDetailPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const params = useParams();
  const id = String(params?.id ?? "");

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [emptyMessage, setEmptyMessage] = useState("Department not found.");

  // Member add/search
  const [memberQuery, setMemberQuery] = useState("");
  const [results, setResults] = useState<StaffUser[]>([]);
  const [searching, setSearching] = useState(false);

  const allowed = !!user && VIEW_ALLOWED.has(user.role);
  const canManage = user?.role === "ADMIN";

  useEffect(() => {
    if (!isLoading && user && !allowed) router.push("/dashboard");
  }, [isLoading, user, allowed, router]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await api.get<{ data: Detail }>(`/departments/${id}/detail`);
      setDetail(res?.data ?? null);
      setEmptyMessage("Department not found.");
    } catch (err) {
      setDetail(null);
      setEmptyMessage(err instanceof Error ? err.message : "Department not found.");
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  const searchStaff = useCallback(
    async (q: string) => {
      if (!id) return;
      setSearching(true);
      try {
        const res = await api.get<{ data: StaffUser[] }>(
          `/departments/${id}/members/search?q=${encodeURIComponent(q)}`,
        );
        setResults(Array.isArray(res?.data) ? res.data : []);
      } catch {
        setResults([]);
      }
      setSearching(false);
    },
    [id],
  );

  // Only search once the admin actually types — an empty query would return
  // every addable staff member and (as an absolute dropdown) cover the real
  // members list below. Clear results when the box is emptied.
  useEffect(() => {
    if (!memberQuery.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    const t = setTimeout(() => void searchStaff(memberQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [memberQuery, searchStaff]);

  const addMember = useCallback(
    async (u: StaffUser) => {
      try {
        await api.post(`/departments/${id}/members`, { userId: u.id });
        toast.success(`${u.name} added`);
        setResults((r) => r.filter((x) => x.id !== u.id));
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add member");
      }
    },
    [id, load],
  );

  const removeMember = useCallback(
    async (m: Member) => {
      try {
        await api.delete(`/departments/${id}/members/${m.userId}`);
        toast.success(`${m.user.name} removed`);
        await load();
        void searchStaff(memberQuery);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove member");
      }
    },
    [id, memberQuery, load, searchStaff],
  );

  if (isLoading || (user && !allowed)) return null;

  if (loading) {
    return (
      <div className="space-y-6">
        <SkeletonCard />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonTable rows={5} columns={4} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="py-16 text-center text-gray-500">
        {emptyMessage}{" "}
        <button onClick={() => router.push("/dashboard/departments")} className="text-primary hover:underline">
          Back to Departments
        </button>
      </div>
    );
  }

  const d = detail.department;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <button
          onClick={() => router.push("/dashboard/departments")}
          className="mb-3 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ArrowLeft size={15} /> Back to Departments
        </button>
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300">
            <Building2 size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{d.name}</h1>
            <p className="text-xs uppercase tracking-wide text-gray-400">
              {d.code}
              <span
                className={`ml-2 rounded-full px-2 py-0.5 text-[10px] ${
                  d.active
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "bg-gray-200 text-gray-600 dark:bg-gray-700"
                }`}
              >
                {d.active ? "Active" : "Inactive"}
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <Stat icon={Users} label="Members" value={detail.stats.memberCount} tone="slate" />
        <Stat icon={ClipboardList} label="Total Requests" value={detail.stats.totalRequests} tone="blue" />
        <Stat icon={ClipboardList} label="Open" value={detail.stats.openRequests} tone="amber" />
        <Stat icon={CheckCircle2} label="Completed" value={detail.stats.completedRequests} tone="emerald" />
        <Stat icon={PackageCheck} label="Units Issued" value={detail.stats.totalUnitsIssued} tone="violet" />
        <Stat icon={Boxes} label="On Hand" value={detail.stats.totalUnitsOnHand} tone="blue" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Members */}
        <section className="rounded-xl border bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Users size={16} /> Members ({detail.members.length})
          </h2>
          {canManage && (
          <div className="relative mb-3">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={memberQuery}
              onChange={(e) => setMemberQuery(e.target.value)}
              placeholder="Search staff to add…"
              className={`${FIELD} pl-9`}
            />
            {memberQuery.trim().length > 0 && (searching || results.length > 0) && (
              <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
                {searching ? (
                  <p className="p-3 text-sm text-gray-400">Searching…</p>
                ) : (
                  results.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => addMember(u)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/60"
                    >
                      <span>
                        <span className="font-medium">{u.name}</span>
                        <span className="ml-2 text-xs text-gray-400">{u.role}</span>
                      </span>
                      <UserPlus size={16} className="shrink-0 text-primary" />
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          )}
          {detail.members.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">No members yet.</p>
          ) : (
            <ul className="space-y-2">
              {detail.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between rounded-lg border px-3 py-2 dark:border-gray-700">
                  <div>
                    <p className="text-sm font-medium">{m.user.name}</p>
                    <p className="text-xs text-gray-400">
                      {m.user.role}
                      {m.user.email ? ` · ${m.user.email}` : ""}
                    </p>
                  </div>
                  {canManage && (
                  <button
                    type="button"
                    onClick={() => removeMember(m)}
                    title="Remove"
                    className="rounded-md p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                  >
                    <UserMinus size={15} />
                  </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Equipment present */}
        <section className="rounded-xl border bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Boxes size={16} /> Equipment Present
          </h2>
          {detail.holdings.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">No equipment is currently recorded for this department.</p>
          ) : (
            <ul className="space-y-2">
              {detail.holdings.map((item) => (
                <li key={item.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm dark:border-gray-700">
                  <div>
                    <span className="font-medium">{item.name}</span>
                    <span className="ml-2 text-xs text-gray-400">
                      {item.category.charAt(0) + item.category.slice(1).toLowerCase()}
                    </span>
                  </div>
                  <span className="tabular-nums text-gray-600 dark:text-gray-300">
                    {item.quantity} {item.unit}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Requisition history */}
      <section className="rounded-xl border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h2 className="flex items-center gap-2 border-b px-5 py-4 text-sm font-semibold dark:border-gray-700">
          <ClipboardList size={16} /> Requisition History ({detail.requisitions.length})
        </h2>
        {detail.requisitions.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">No requisitions raised yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-5 py-3">Requisition</th>
                  <th className="px-5 py-3">Requested by</th>
                  <th className="px-5 py-3 text-right">Items</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {detail.requisitions.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => router.push("/dashboard/requisitions")}
                    className="cursor-pointer border-b text-sm last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
                  >
                    <td className="px-5 py-3 font-medium">{r.requisitionNumber}</td>
                    <td className="px-5 py-3">{r.requestedBy}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{r.itemCount}</td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status] ?? "bg-gray-100 text-gray-600"}`}>
                        {r.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-500">
                      {new Date(r.createdAt).toLocaleDateString("en-IN")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const TONE: Record<string, string> = {
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-900/50 dark:text-slate-300",
  blue: "bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300",
  amber: "bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300",
  emerald: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300",
  violet: "bg-violet-100 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300",
};
function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  tone: keyof typeof TONE;
}) {
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${TONE[tone]}`}>
          <Icon size={18} />
        </div>
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
          <p className="text-xl font-bold tabular-nums">{value}</p>
        </div>
      </div>
    </div>
  );
}
