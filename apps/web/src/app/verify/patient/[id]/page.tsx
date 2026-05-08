// Public patient verification page reached via QR scan from the printed
// patient ID card. Shows the same fields that are already visible on the
// physical card (name, MR#, age, gender, blood group, emergency contact)
// plus the issuing hospital — no chart data, no clinical history.
// Server-rendered, mirrors the prescription verify page.

import { CheckCircle2, ShieldAlert, Phone, Printer } from "lucide-react";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface VerifyData {
  ok: true;
  patientId: string;
  mrNumber: string;
  name: string;
  age: number | null;
  gender: string;
  bloodGroup: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
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
  const url = `${base.replace(/\/$/, "")}/public/verify/patient/${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as VerifyData;
    if (!json.ok) return null;
    return json;
  } catch {
    return null;
  }
}

function PrintStyles() {
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

export default async function VerifyPatientPage({
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
            Patient Not Found
          </h1>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
            The patient ID{" "}
            <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
              {id}
            </code>{" "}
            could not be verified in our records. This may be a forged QR code
            or the record has been removed.
          </p>
          <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
            If you believe this is an error, contact the issuing hospital.
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
            <img src={h.logoUrl} alt={`${h.name} logo`} className="mx-auto mb-3 max-h-16" />
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
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{h.tagline}</p>
          )}
          {h.address && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{h.address}</p>
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
              Verified Patient
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Registered with {h.name}
            </p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-green-600 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-white shadow-sm">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Verified — Authentic Patient ID
            </div>
          </div>

          {/* Details */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 border-t border-gray-100 pt-6 text-sm dark:border-gray-800">
            <dt className="font-medium text-gray-500 dark:text-gray-400">Name</dt>
            <dd className="font-semibold text-gray-900 dark:text-gray-100">{data.name}</dd>

            <dt className="font-medium text-gray-500 dark:text-gray-400">MR Number</dt>
            <dd className="break-all font-mono text-gray-900 dark:text-gray-100">
              {data.mrNumber}
            </dd>

            <dt className="font-medium text-gray-500 dark:text-gray-400">Age / Gender</dt>
            <dd className="text-gray-900 dark:text-gray-100">
              {data.age ?? "—"} / {data.gender}
            </dd>

            {data.bloodGroup && (
              <>
                <dt className="font-medium text-gray-500 dark:text-gray-400">Blood Group</dt>
                <dd>
                  <span className="inline-flex rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-300">
                    {data.bloodGroup}
                  </span>
                </dd>
              </>
            )}

            {data.emergencyContactPhone && (
              <>
                <dt className="font-medium text-gray-500 dark:text-gray-400">
                  Emergency Contact
                </dt>
                <dd className="text-gray-900 dark:text-gray-100">
                  {data.emergencyContactName && (
                    <span className="block font-medium">{data.emergencyContactName}</span>
                  )}
                  <a
                    href={`tel:${data.emergencyContactPhone}`}
                    className="inline-flex items-center gap-1.5 text-blue-600 hover:underline dark:text-blue-400"
                  >
                    <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                    {data.emergencyContactPhone}
                  </a>
                </dd>
              </>
            )}

            <dt className="font-medium text-gray-500 dark:text-gray-400">Verified At</dt>
            <dd className="text-gray-900 dark:text-gray-100">{verifiedAtStr}</dd>
          </dl>

          <p className="mt-6 border-t border-gray-100 pt-4 text-center text-xs leading-relaxed text-gray-500 dark:border-gray-800 dark:text-gray-400">
            For privacy, no clinical history, prescriptions, or billing
            information is shown on this public verification page. If you
            suspect tampering, contact the issuing hospital.
          </p>
        </article>

        {/* Print button */}
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
