/**
 * Live Queue at-a-glance counts page.
 *
 * Issue #748 (May 2026): the previous render used hard-coded literals
 * (`<div>12 Waiting</div>` etc.) so the figures never moved during the
 * working day. This rewrite derives every count from the real
 * `GET /api/v1/queue` aggregate (per-doctor `currentToken` + `waitingCount`)
 * plus a `GET /api/v1/appointments?date=<today>&status=COMPLETED` lookup
 * for the Done bucket.
 *
 * Refresh contract:
 *   - Initial fetch on mount.
 *   - Background poll every 30 seconds (matches the queue/page.tsx pattern
 *     codified for issue #430).
 *   - Cleanup on unmount so the interval doesn't leak across navigations.
 *
 * RBAC: same role allowlist as /dashboard/queue (issue #383). Patients
 * MUST NOT see the cross-clinic counts.
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { SkeletonText } from "@/components/Skeleton";

const QUEUE_ALLOWED = new Set(["ADMIN", "RECEPTION", "DOCTOR", "NURSE"]);

interface QueueDoctorSummary {
  doctorId: string;
  doctorName: string;
  specialization: string;
  currentToken: number | null;
  waitingCount: number;
}

interface AppointmentRow {
  id: string;
  status: string;
}

export default function LiveQueuePage() {
  const user = useAuthStore((s) => s.user);
  const isAuthLoading = useAuthStore((s) => s.isLoading);
  const router = useRouter();
  const pathname = usePathname();

  const [waiting, setWaiting] = useState<number>(0);
  const [inConsult, setInConsult] = useState<number>(0);
  const [done, setDone] = useState<number>(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Issue #383 mirror: redirect non-staff away from cross-clinic counts.
  // Issue #703 hydration discipline: gate on `!isAuthLoading` so the
  // redirect doesn't fire on a brief mount-flicker before the auth store
  // populates.
  useEffect(() => {
    if (isAuthLoading) return;
    if (user && !QUEUE_ALLOWED.has(user.role)) {
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/live-queue")}`
      );
    }
  }, [isAuthLoading, user, router, pathname]);

  useEffect(() => {
    if (isAuthLoading) return;
    if (user && !QUEUE_ALLOWED.has(user.role)) return;

    async function refresh() {
      try {
        const today = new Date().toISOString().split("T")[0];
        const [queueRes, doneRes] = await Promise.all([
          api
            .get<{ data: QueueDoctorSummary[] }>("/queue")
            .catch(() => ({ data: [] as QueueDoctorSummary[] })),
          api
            .get<{ data: AppointmentRow[] }>(
              `/appointments?date=${today}&status=COMPLETED&limit=200`
            )
            .catch(() => ({ data: [] as AppointmentRow[] })),
        ]);

        const docs = Array.isArray(queueRes.data) ? queueRes.data : [];
        const totalWaiting = docs.reduce(
          (acc, d) => acc + (Number(d.waitingCount) || 0),
          0
        );
        const totalInConsult = docs.reduce(
          (acc, d) => acc + (d.currentToken !== null ? 1 : 0),
          0
        );
        const totalDone = Array.isArray(doneRes.data) ? doneRes.data.length : 0;

        setWaiting(totalWaiting);
        setInConsult(totalInConsult);
        setDone(totalDone);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load queue");
      } finally {
        setLoaded(true);
      }
    }

    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(id);
  }, [isAuthLoading, user]);

  if (isAuthLoading) {
    return (
      <div
        className="flex items-center justify-center p-12 text-sm text-gray-700"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        Loading…
      </div>
    );
  }

  if (user && !QUEUE_ALLOWED.has(user.role)) {
    return (
      <div className="p-8 text-center text-gray-700">
        Live Queue is staff-only.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Live Queue</h1>
        <p className="text-sm text-gray-700">
          Real-time clinic-wide queue counts (refreshes every 30 seconds).
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <CountTile
          label="Waiting"
          value={waiting}
          tone="amber"
          testid="live-queue-waiting"
        />
        <CountTile
          label="In Consult"
          value={inConsult}
          tone="green"
          testid="live-queue-in-consult"
        />
        <CountTile
          label="Done"
          value={done}
          tone="gray"
          testid="live-queue-done"
        />
      </div>

      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
      {!loaded && !error && (
        // Pearl §7.2 wave 11: thin SkeletonText strip in place of the inline
        // "Loading counts…" so the layout area is visibly reserved.
        <div
          className="max-w-xs"
          data-testid="live-queue-loading"
          aria-busy="true"
        >
          <SkeletonText lines={1} />
        </div>
      )}
    </div>
  );
}

function CountTile({
  label,
  value,
  tone,
  testid,
}: {
  label: string;
  value: number;
  tone: "amber" | "green" | "gray";
  testid: string;
}) {
  const palette: Record<string, string> = {
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    green: "border-green-200 bg-green-50 text-green-900",
    gray: "border-gray-200 bg-gray-50 text-gray-800",
  };
  return (
    <div
      data-testid={testid}
      className={`rounded-xl border p-5 shadow-sm ${palette[tone]}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide">{label}</p>
      <p className="mt-2 text-4xl font-bold">{value.toLocaleString("en-IN")}</p>
    </div>
  );
}
