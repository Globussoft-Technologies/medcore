/**
 * Pearl §2.1.3 — /dashboard/lab/new is the "Order Lab" quick-action
 * target from the consult page (the Flask icon next to the SOAP tabs).
 *
 * Without this file, Next.js routed `/lab/new` to `[orderId]/page.tsx`
 * with orderId="new" and the user saw "Order not found". Mirrors the
 * /prescriptions/new redirect: a thin client-side redirect to the main
 * lab page with `?new=1` (auto-opens the order modal) plus the
 * forwarded patientId, appointmentId, and from=consult so the lab
 * page can pre-fill the patient and render a Back-to-Consult link.
 */
"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function NewLabOrderRedirectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const patientId = searchParams.get("patientId");
    const appointmentId = searchParams.get("appointmentId");
    const fromParam = searchParams.get("from");
    const params = new URLSearchParams();
    params.set("new", "1");
    if (patientId) params.set("patientId", patientId);
    if (appointmentId) params.set("appointmentId", appointmentId);
    if (fromParam) params.set("from", fromParam);
    router.replace(`/dashboard/lab?${params.toString()}`);
  }, [router, searchParams]);

  return (
    <div
      data-testid="lab-new-redirect"
      className="p-8 text-center text-sm text-gray-500"
    >
      Opening lab order form…
    </div>
  );
}
