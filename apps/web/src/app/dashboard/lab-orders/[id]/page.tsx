// Issue #678 — bookmark/deep-link redirect for /dashboard/lab-orders/{id}.
//
// Modules consumed: none (pure client redirect)
//
// Why this file exists: the patient-portal lab-orders list at
// /dashboard/lab-orders renders a flat list with a "Result" link that opens
// the PDF in a new tab. There was previously no detail page, so any link
// shaped /dashboard/lab-orders/<id> (an externally-shared bookmark, an old
// notification deep-link, or a doctor-shared URL) hit the global 404 with a
// stale "Sign in" CTA for authenticated patients. The reception/lab-tech
// detail page lives at /dashboard/lab/[orderId] and already accepts the
// PATIENT role via LAB_ALLOWED, so we redirect there instead of duplicating
// the entire detail UI under a second route.

"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LabOrderRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const { id } = use(params);
  useEffect(() => {
    router.replace(`/dashboard/lab/${id}`);
  }, [router, id]);
  return (
    <div
      className="flex min-h-[40vh] items-center justify-center text-sm text-gray-500"
      data-testid="lab-orders-redirect"
    >
      Loading lab order…
    </div>
  );
}
