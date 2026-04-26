"use client";

// Issue #80 — Some links/menus point at /dashboard/reports/scheduled but the
// actual page lives at /dashboard/scheduled-reports. Previously this route
// 404'd and made the empty-list scenario look broken. Render a thin
// client-side redirect so deep-links from older docs/menus keep working.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ScheduledReportsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/scheduled-reports");
  }, [router]);

  return (
    <div
      className="flex h-64 items-center justify-center text-sm text-gray-500"
      data-testid="scheduled-reports-redirect"
    >
      Redirecting to Scheduled Reports…
    </div>
  );
}
