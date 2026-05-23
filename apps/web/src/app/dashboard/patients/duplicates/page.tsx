"use client";

/**
 * Duplicate-patient triage + merge UI — Pearl ERP Stage 1 §2.1.1 (gap row 41).
 *
 * What / which modules / why:
 *   - Lists every active patient grouped by phone; any phone with >1 active
 *     patient row is rendered as a candidate group for reception to triage.
 *   - For each group, the user picks the canonical "keep" row + N source
 *     rows to merge in, then submits POST /api/v1/patients/:keepId/merge
 *     (routes/patients-merge.ts). On success a toast surfaces the
 *     per-table mergedRowCounts the API returns.
 *   - There is no dedicated `/patients/duplicates` API endpoint yet (the
 *     existing dup-detection is registration-time only at
 *     POST /patients pre-checks). The page derives groups client-side by
 *     paginating through GET /patients (limit 100, mergedIntoId is already
 *     filtered out by the API) and bucketing by phone. Sufficient for the
 *     receptionist-volume tenants Pearl targets; a server-side
 *     "/duplicates" endpoint with full-tenant sweep is a future scope.
 *
 * RBAC: ADMIN + RECEPTION (matches the API authorize set). Patients are
 * bounced to /dashboard/not-authorized; non-allowlisted staff get a toast
 * + redirect mirroring the pattern in patients/page.tsx (Issue #382/#636).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";

// Mirror the API allow-list (routes/patients-merge.ts authorize() call).
const VIEW_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

interface PatientRow {
  id: string;
  mrNumber: string;
  dateOfBirth?: string | null;
  user: { id: string; name: string; email: string; phone: string };
  // Last visit isn't on the list payload today; the page renders "—" when
  // unavailable rather than firing N+1 history calls per duplicate row.
  lastVisitAt?: string | null;
}

interface DuplicateGroup {
  phone: string;
  patients: PatientRow[];
}

export default function PatientsDuplicatesPage() {
  const { user, isLoading: authLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  // Per-group selection state: `keep[groupPhone]` is the id of the chosen
  // canonical row; `fromIds[groupPhone]` is the set of ids selected as
  // merge-source candidates.
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [fromIds, setFromIds] = useState<Record<string, Set<string>>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);

  // ── RBAC gate (mirrors the /dashboard/patients pattern) ────────────
  useEffect(() => {
    if (!authLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error(
        "Duplicate patient management is restricted to Admin and Reception roles.",
      );
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(
          pathname || "/dashboard/patients/duplicates",
        )}`,
      );
    }
  }, [authLoading, user, router, pathname]);

  useEffect(() => {
    if (!authLoading && user && VIEW_ALLOWED.has(user.role)) {
      loadDuplicates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  async function loadDuplicates() {
    setLoading(true);
    try {
      // The patients list API filters `mergedIntoId: null` so every row we
      // see here is still active. Bucket by phone client-side; any bucket
      // with >1 entry is a candidate duplicate set.
      const res = await api.get<{ data: PatientRow[] }>(
        "/patients?limit=100",
      );
      const byPhone = new Map<string, PatientRow[]>();
      for (const p of res.data ?? []) {
        const phone = (p.user?.phone ?? "").trim();
        if (!phone) continue;
        const bucket = byPhone.get(phone) ?? [];
        bucket.push(p);
        byPhone.set(phone, bucket);
      }
      const dupGroups: DuplicateGroup[] = [];
      byPhone.forEach((patients, phone) => {
        if (patients.length > 1) {
          dupGroups.push({ phone, patients });
        }
      });
      // Stable sort: largest groups first (most urgent triage).
      dupGroups.sort((a, b) => b.patients.length - a.patients.length);
      setGroups(dupGroups);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load duplicates");
    }
    setLoading(false);
  }

  function toggleFrom(phone: string, id: string) {
    setFromIds((prev) => {
      const next = new Set(prev[phone] ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, [phone]: next };
    });
  }

  function setKeepRow(phone: string, id: string) {
    setKeep((prev) => ({ ...prev, [phone]: id }));
    // Strip the new keep from the from-set if it was selected as a source.
    setFromIds((prev) => {
      const cur = new Set(prev[phone] ?? []);
      cur.delete(id);
      return { ...prev, [phone]: cur };
    });
  }

  async function handleMerge(group: DuplicateGroup) {
    const keepId = keep[group.phone];
    const sources = Array.from(fromIds[group.phone] ?? []);
    if (!keepId) {
      toast.error("Pick the canonical row to keep first.");
      return;
    }
    if (sources.length === 0) {
      toast.error("Select at least one row to merge into the canonical record.");
      return;
    }
    if (
      !window.confirm(
        `Merge ${sources.length} record(s) into the selected canonical patient? This cannot be undone.`,
      )
    ) {
      return;
    }
    setSubmitting(group.phone);
    try {
      const res = await api.post<{
        data: { mergedRowCounts: Record<string, number> };
      }>(`/patients/${keepId}/merge`, { mergeFromIds: sources });
      const counts = res.data?.mergedRowCounts ?? {};
      const summary = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([table, n]) => `${n} ${table}`)
        .join(", ");
      toast.success(
        `Merge complete. Re-pointed: ${summary || "no child rows"}.`,
      );
      // Refresh — the merged sources will drop out of the list (their
      // mergedIntoId now != null, so the API filter excludes them).
      await loadDuplicates();
      setFromIds((prev) => ({ ...prev, [group.phone]: new Set() }));
    } catch (e) {
      toast.error((e as Error).message || "Merge failed");
    }
    setSubmitting(null);
  }

  const totalDuplicates = useMemo(
    () => groups.reduce((acc, g) => acc + g.patients.length, 0),
    [groups],
  );

  if (authLoading || !user) {
    return (
      <div className="p-6">
        <div className="h-6 w-32 animate-pulse rounded bg-gray-200" />
      </div>
    );
  }
  if (!VIEW_ALLOWED.has(user.role)) {
    // RBAC redirect already fired in useEffect; render nothing so we don't
    // flash the chrome before navigation completes.
    return null;
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Duplicate patients</h1>
          <p className="text-xs text-gray-600">
            Patients sharing the same phone number across active MR records.
            Pick a canonical row + the duplicates to fold into it.
          </p>
        </div>
        <Link
          href="/dashboard/patients"
          className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Back to registry
        </Link>
      </div>

      {loading ? (
        <p data-testid="dup-loading" className="text-sm text-gray-500">
          Loading duplicates…
        </p>
      ) : groups.length === 0 ? (
        <div
          data-testid="dup-empty"
          className="rounded-xl border border-dashed bg-white p-8 text-center text-sm text-gray-500"
        >
          No duplicate phone numbers detected across active patient records.
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-gray-500">
            {groups.length} duplicate group(s) · {totalDuplicates} record(s)
          </p>
          <ul data-testid="dup-groups" className="space-y-4">
            {groups.map((g) => {
              const selectedKeep = keep[g.phone];
              const selectedFrom = fromIds[g.phone] ?? new Set();
              return (
                <li
                  key={g.phone}
                  data-testid="dup-group"
                  data-phone={g.phone}
                  className="overflow-hidden rounded-xl border bg-white"
                >
                  <header className="flex items-center justify-between bg-amber-50 px-4 py-2 text-xs">
                    <span>
                      Phone <strong>{g.phone}</strong> · {g.patients.length} records
                    </span>
                    <button
                      type="button"
                      data-testid="dup-merge-action"
                      disabled={submitting === g.phone}
                      onClick={() => handleMerge(g)}
                      className="rounded-md bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
                    >
                      {submitting === g.phone
                        ? "Merging…"
                        : "Keep & merge into selected"}
                    </button>
                  </header>
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-600">
                      <tr>
                        <th className="px-3 py-2 text-left">Keep</th>
                        <th className="px-3 py-2 text-left">Merge into keep</th>
                        <th className="px-3 py-2 text-left">MR Number</th>
                        <th className="px-3 py-2 text-left">Name</th>
                        <th className="px-3 py-2 text-left">DOB</th>
                        <th className="px-3 py-2 text-left">Phone</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.patients.map((p) => (
                        <tr
                          key={p.id}
                          data-testid="dup-row"
                          data-patient-id={p.id}
                          className="border-t"
                        >
                          <td className="px-3 py-2">
                            <input
                              type="radio"
                              name={`keep-${g.phone}`}
                              data-testid="dup-keep-radio"
                              checked={selectedKeep === p.id}
                              onChange={() => setKeepRow(g.phone, p.id)}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              data-testid="dup-from-checkbox"
                              disabled={selectedKeep === p.id}
                              checked={selectedFrom.has(p.id)}
                              onChange={() => toggleFrom(g.phone, p.id)}
                            />
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">
                            <Link
                              href={`/dashboard/patients/${p.id}`}
                              className="text-blue-700 hover:underline"
                            >
                              {p.mrNumber}
                            </Link>
                          </td>
                          <td className="px-3 py-2">{p.user?.name ?? "—"}</td>
                          <td className="px-3 py-2 text-xs text-gray-600">
                            {p.dateOfBirth
                              ? new Date(p.dateOfBirth)
                                  .toISOString()
                                  .slice(0, 10)
                              : "—"}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-600">
                            {p.user?.phone}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
