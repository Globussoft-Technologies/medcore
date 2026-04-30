/**
 * Issue #439 — the "Write Prescription" quick-action on the patient chart
 * routes to /dashboard/prescriptions/new?patientId=<uuid>. That sub-route
 * never existed, so the link resolved to the global 404 and the doctor was
 * blocked from writing an Rx via this primary entry point.
 *
 * Rather than fork a new full-page form (and let it drift from the canonical
 * one on /dashboard/prescriptions), this page is a thin client-side redirect
 * to the existing list page with `?new=1` (which already auto-opens the
 * form) plus the original `patientId` (which the list page now pre-fills
 * into the picker — see #439 fix in ../page.tsx).
 *
 * Keeping a single source of truth for the Rx form means template loading,
 * drug-interaction checks, renal dose calculator and generic-substitution
 * stay in one place forever.
 */
"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function WritePrescriptionRedirectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const patientId = searchParams.get("patientId");
    const params = new URLSearchParams();
    params.set("new", "1");
    if (patientId) params.set("patientId", patientId);
    router.replace(`/dashboard/prescriptions?${params.toString()}`);
  }, [router, searchParams]);

  return (
    <div
      data-testid="rx-new-redirect"
      className="p-8 text-center text-sm text-gray-500"
    >
      Opening prescription form…
    </div>
  );
}
