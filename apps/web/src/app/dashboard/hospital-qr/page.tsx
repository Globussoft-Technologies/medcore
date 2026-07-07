"use client";

// Hospital QR — reception/admin display screen.
//
// Shows the scannable hospital QR for the logged-in staff member's hospital.
// A patient scans it with their phone camera; the encoded URL opens the public
// kiosk (/hospital/qr?tenantId=<this hospital>) scoped to THIS hospital, so a
// guest lands on the correct hospital's directory + booking + check-in flow.
// The QR encodes only a public URL — no PHI.

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { QrCode, Printer, Copy, Check, RefreshCw } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";

const QR_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

interface HospitalQr {
  tenantId: string;
  hospitalName: string | null;
  url: string;
  qrDataUrl: string;
}

export default function HospitalQrPage() {
  const { user, isLoading: authLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  const [data, setData] = useState<HospitalQr | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // RBAC: only reception + admin may display the hospital QR.
  useEffect(() => {
    if (!authLoading && user && !QR_ALLOWED.has(user.role)) {
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/hospital-qr")}`,
      );
    }
  }, [authLoading, user, router, pathname]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ data: HospitalQr }>("/hospital-kiosk/qr");
      setData(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the hospital QR");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || !user || !QR_ALLOWED.has(user.role)) return;
    void load();
  }, [authLoading, user, load]);

  async function copyLink() {
    if (!data?.url) return;
    try {
      await navigator.clipboard.writeText(data.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <div className="flex items-center gap-2">
          <QrCode className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Hospital QR
          </h1>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          aria-label="Reload"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <p className="mb-6 text-sm text-gray-600 dark:text-gray-300 print:hidden">
        Display or print this code at your front desk. Patients scan it with
        their phone camera to open your hospital&apos;s booking &amp; check-in
        screen — no app needed.
      </p>

      {error && (
        <p
          role="alert"
          data-testid="hospital-qr-error"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex h-80 items-center justify-center rounded-2xl border border-gray-200 dark:border-gray-700">
          <RefreshCw className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : data ? (
        // The printable card — centred QR + hospital name + link.
        <div
          data-testid="hospital-qr-card"
          className="rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-700 dark:bg-gray-900 print:border-0 print:shadow-none"
        >
          <h2 className="mb-1 text-xl font-bold text-gray-900 dark:text-gray-100">
            {data.hospitalName ?? "Our Hospital"}
          </h2>
          <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
            Scan to book or check in
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={data.qrDataUrl}
            alt="Hospital QR code"
            data-testid="hospital-qr-image"
            className="mx-auto h-64 w-64 rounded-xl bg-white"
          />
          <p className="mx-auto mt-6 max-w-md break-all text-xs text-gray-500 dark:text-gray-400">
            {data.url}
          </p>

          <div className="mt-6 flex items-center justify-center gap-3 print:hidden">
            <button
              type="button"
              onClick={() => window.print()}
              data-testid="hospital-qr-print"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              <Printer className="h-4 w-4" />
              Print
            </button>
            <button
              type="button"
              onClick={() => void copyLink()}
              data-testid="hospital-qr-copy"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 text-emerald-600" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" /> Copy link
                </>
              )}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
