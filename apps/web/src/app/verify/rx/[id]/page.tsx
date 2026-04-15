// Public prescription verification page reached via QR scan.
// Server-rendered (no client JS required) — uses Tailwind classes only.
// Strings are inlined in English: this page must work without the i18n
// client store (which is "use client"). Keys are mirrored in i18n.ts for
// future SSR-friendly i18n refactor.

import { CheckCircle2, ShieldAlert, Printer } from "lucide-react";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface VerifyData {
  ok: true;
  prescriptionId: string;
  patientInitial: string;
  doctorName: string;
  dateIssued: string;
  status: string;
  hospital: {
    name: string;
    address: string;
    phone: string;
    email: string;
    logoUrl?: string;
    tagline?: string;
  };
}

async function fetchVerification(id: string): Promise<VerifyData | null> {
  const base =
    process.env.API_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:4000/api/v1";
  const url = `${base.replace(/\/$/, "")}/public/verify/rx/${encodeURIComponent(
    id
  )}`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = (await res.json()) as VerifyData;
      return json;
    }
    // Fallback: server returned HTML — parse loosely.
    const html = await res.text();
    if (/Prescription Not Found/i.test(html)) return null;
    const match = (re: RegExp) => (html.match(re)?.[1] || "").trim();
    return {
      ok: true,
      prescriptionId: match(/Prescription ID<\/strong><\/td><td[^>]*>([^<]+)/i) || id,
      patientInitial: match(/Patient \(Initial\)<\/strong><\/td><td[^>]*>([^<]+)/i) || "?",
      doctorName: match(/Doctor<\/strong><\/td><td[^>]*>Dr\. ([^<]+)/i) || "",
      dateIssued: match(/Date Issued<\/strong><\/td><td[^>]*>([^<]+)/i) || "",
      status: match(/Status<\/strong><\/td><td[^>]*>([^<]+)/i) || "Issued",
      hospital: {
        name: match(/<h1[^>]*>([^<]+)<\/h1>/i) || "Hospital",
        address: "",
        phone: "",
        email: "",
      },
    };
  } catch {
    return null;
  }
}

function PrintStyles() {
  // Print-friendly CSS: white bg, remove shadows, hide nothing essential.
  return (
    <style
      // eslint-disable-next-line react/no-unknown-property
      dangerouslySetInnerHTML={{
        __html: `
          @media print {
            body { background: #fff !important; }
            .verify-no-print { display: none !important; }
            .verify-card {
              box-shadow: none !important;
              border: 1px solid #cbd5e1 !important;
            }
            .verify-bg { background: #fff !important; }
          }
        `,
      }}
    />
  );
}

export default async function VerifyPrescriptionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const data = await fetchVerification(id);
  const verifiedAt = new Date();
  const verifiedAtStr = verifiedAt.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  if (!data) {
    return (
      <div className="verify-bg flex min-h-screen items-center justify-center bg-gray-50 p-5 dark:bg-gray-950">
        <PrintStyles />
        <div className="verify-card w-full max-w-md rounded-2xl border border-red-200 bg-white p-8 text-center shadow-xl dark:border-red-900/50 dark:bg-gray-900">
          <div
            className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400"
            aria-hidden="true"
          >
            <ShieldAlert className="h-8 w-8" />
          </div>
          <h1 className="mb-2 text-2xl font-bold text-red-700 dark:text-red-400">
            Prescription Not Found
          </h1>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
            The prescription ID{" "}
            <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
              {id}
            </code>{" "}
            could not be verified in our records. This may be a forged QR
            code, or the prescription has been voided or revoked.
          </p>
          <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
            If you believe this is an error, please contact the issuing
            hospital directly.
          </p>
        </div>
      </div>
    );
  }

  const h = data.hospital;

  return (
    <div className="verify-bg min-h-screen bg-gray-50 px-4 py-8 font-sans text-gray-900 dark:bg-gray-950 dark:text-gray-100 md:py-12">
      <PrintStyles />
      <div className="mx-auto max-w-2xl">
        {/* Hospital letterhead */}
        <header className="mb-6 border-b-2 border-double border-primary/60 pb-5 text-center">
          {h.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={h.logoUrl}
              alt={`${h.name} logo`}
              className="mx-auto mb-3 max-h-16"
            />
          ) : (
            <div
              className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-xl bg-primary text-2xl font-bold text-white"
              aria-hidden="true"
            >
              {h.name.charAt(0)}
            </div>
          )}
          <h1 className="text-2xl font-bold tracking-tight text-blue-900 dark:text-blue-200">
            {h.name}
          </h1>
          {h.tagline && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {h.tagline}
            </p>
          )}
          {h.address && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {h.address}
            </p>
          )}
          {(h.phone || h.email) && (
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              {h.phone && <span>Phone: {h.phone}</span>}
              {h.phone && h.email && <span className="mx-2">|</span>}
              {h.email && <span>Email: {h.email}</span>}
            </p>
          )}
        </header>

        {/* Verification card */}
        <article className="verify-card rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-900 md:p-8">
          {/* Hero badge */}
          <div className="mb-6 text-center">
            <div
              className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-green-100 text-green-700 ring-4 ring-green-200 dark:bg-green-900/40 dark:text-green-400 dark:ring-green-900/60"
              aria-hidden="true"
            >
              <CheckCircle2 className="h-12 w-12" strokeWidth={2.5} />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              Verified Prescription
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Issued by Dr. {data.doctorName} on {data.dateIssued}
            </p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-green-600 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-white shadow-sm">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Verified — Authentic Prescription
            </div>
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              This prescription has been validated against our records.
            </p>
          </div>

          {/* Details */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 border-t border-gray-100 pt-6 text-sm dark:border-gray-800">
            <dt className="font-medium text-gray-500 dark:text-gray-400">
              Prescription ID
            </dt>
            <dd className="break-all font-mono text-gray-900 dark:text-gray-100">
              {data.prescriptionId}
            </dd>

            <dt className="font-medium text-gray-500 dark:text-gray-400">
              Patient
            </dt>
            <dd className="text-gray-900 dark:text-gray-100">
              <span className="font-semibold">{data.patientInitial}</span>
              <span className="ml-2 text-xs font-normal text-gray-400 dark:text-gray-500">
                (name masked for privacy)
              </span>
            </dd>

            <dt className="font-medium text-gray-500 dark:text-gray-400">
              Doctor
            </dt>
            <dd className="text-gray-900 dark:text-gray-100">
              Dr. {data.doctorName}
            </dd>

            <dt className="font-medium text-gray-500 dark:text-gray-400">
              Date Issued
            </dt>
            <dd className="text-gray-900 dark:text-gray-100">
              {data.dateIssued}
            </dd>

            <dt className="font-medium text-gray-500 dark:text-gray-400">
              Status
            </dt>
            <dd>
              <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                {data.status}
              </span>
            </dd>

            <dt className="font-medium text-gray-500 dark:text-gray-400">
              Verified At
            </dt>
            <dd className="text-gray-900 dark:text-gray-100">{verifiedAtStr}</dd>
          </dl>

          <p className="mt-6 border-t border-gray-100 pt-4 text-center text-xs leading-relaxed text-gray-500 dark:border-gray-800 dark:text-gray-400">
            For privacy, the patient&apos;s full name and medication details
            are not disclosed on this public verification page. If you suspect
            tampering, contact the issuing hospital.
          </p>
        </article>

        {/* Print button (hidden when printing) */}
        <div className="verify-no-print mt-6 text-center">
          <a
            href="javascript:window.print()"
            className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-gray-200 transition hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-200 dark:ring-gray-700 dark:hover:bg-gray-800"
            aria-label="Print verification"
          >
            <Printer className="h-4 w-4" aria-hidden="true" />
            Print Verification
          </a>
        </div>

        <p className="mt-6 text-center text-xs text-gray-400 dark:text-gray-500">
          Verified by {h.name} &middot; {verifiedAt.getFullYear()}
        </p>
      </div>
    </div>
  );
}
