// Public prescription verification page reached via QR scan.
// Server-renders a minimal verification card using /api/v1/public/verify/rx/:id.

import { notFound } from "next/navigation";

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
  // Ensure we hit /public/verify/rx/:id (public endpoint, no auth)
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
    // Fall back: server returned HTML — extract minimal signals
    // (current API returns HTML, so we parse loosely)
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

export default async function VerifyPrescriptionPage({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const p = await Promise.resolve(params as { id: string });
  const id = p.id;

  const data = await fetchVerification(id);

  if (!data) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#f1f5f9",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px",
        }}
      >
        <div
          style={{
            maxWidth: "440px",
            width: "100%",
            background: "#fff",
            borderRadius: "12px",
            padding: "36px 28px",
            boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              margin: "0 auto 16px",
              borderRadius: "50%",
              background: "#fee2e2",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#dc2626",
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            !
          </div>
          <h1 style={{ fontSize: 22, color: "#b91c1c", margin: "0 0 8px" }}>
            Prescription Not Found
          </h1>
          <p style={{ color: "#64748b", fontSize: 14, margin: 0 }}>
            The prescription ID <code>{id}</code> could not be verified in our
            records. It may be invalid, expired, or revoked.
          </p>
        </div>
      </div>
    );
  }

  const h = data.hospital;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #eff6ff 0%, #f8fafc 300px)",
        padding: "20px 16px 60px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        {/* Hospital letterhead */}
        <div
          style={{
            textAlign: "center",
            padding: "24px 16px 18px",
            borderBottom: "3px double #2563eb",
            marginBottom: 20,
          }}
        >
          {h.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={h.logoUrl}
              alt={h.name}
              style={{ maxHeight: 64, marginBottom: 8 }}
            />
          ) : (
            <div
              style={{
                width: 64,
                height: 64,
                margin: "0 auto 10px",
                borderRadius: 12,
                background: "#2563eb",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 28,
                fontWeight: 700,
              }}
            >
              {h.name.charAt(0)}
            </div>
          )}
          <h1
            style={{
              fontSize: 22,
              color: "#1e3a8a",
              margin: "0 0 4px",
              fontWeight: 700,
            }}
          >
            {h.name}
          </h1>
          {h.tagline && (
            <p style={{ fontSize: 12, color: "#64748b", margin: "2px 0" }}>
              {h.tagline}
            </p>
          )}
          {h.address && (
            <p style={{ fontSize: 12, color: "#64748b", margin: "2px 0" }}>
              {h.address}
            </p>
          )}
          <p style={{ fontSize: 11, color: "#94a3b8", margin: "2px 0" }}>
            {h.phone ? `Phone: ${h.phone}` : ""}
            {h.phone && h.email ? "  |  " : ""}
            {h.email ? `Email: ${h.email}` : ""}
          </p>
        </div>

        {/* Verification card */}
        <div
          style={{
            background: "#fff",
            borderRadius: 12,
            padding: "28px 24px",
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
            border: "1px solid #e2e8f0",
          }}
        >
          <div style={{ textAlign: "center", marginBottom: 22 }}>
            <div
              style={{
                width: 64,
                height: 64,
                margin: "0 auto 12px",
                borderRadius: "50%",
                background: "#dcfce7",
                color: "#15803d",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 34,
                fontWeight: 700,
                boxShadow: "0 0 0 4px #bbf7d0",
              }}
              aria-label="Verified"
            >
              {"\u2713"}
            </div>
            <div
              style={{
                display: "inline-block",
                background: "#16a34a",
                color: "#fff",
                padding: "6px 16px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: 0.3,
              }}
            >
              VERIFIED &mdash; Authentic Prescription
            </div>
            <p
              style={{
                color: "#64748b",
                fontSize: 12,
                margin: "10px 0 0",
              }}
            >
              This prescription has been validated against our records.
            </p>
          </div>

          <dl
            style={{
              margin: 0,
              display: "grid",
              gridTemplateColumns: "140px 1fr",
              gap: "10px 12px",
              fontSize: 14,
            }}
          >
            <dt style={{ color: "#64748b" }}>Prescription ID</dt>
            <dd
              style={{
                margin: 0,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                color: "#0f172a",
                wordBreak: "break-all",
              }}
            >
              {data.prescriptionId}
            </dd>

            <dt style={{ color: "#64748b" }}>Patient</dt>
            <dd style={{ margin: 0, color: "#0f172a", fontWeight: 600 }}>
              {data.patientInitial}
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  color: "#94a3b8",
                  fontWeight: 400,
                }}
              >
                (name masked for privacy)
              </span>
            </dd>

            <dt style={{ color: "#64748b" }}>Doctor</dt>
            <dd style={{ margin: 0, color: "#0f172a" }}>
              Dr. {data.doctorName}
            </dd>

            <dt style={{ color: "#64748b" }}>Date Issued</dt>
            <dd style={{ margin: 0, color: "#0f172a" }}>{data.dateIssued}</dd>

            <dt style={{ color: "#64748b" }}>Status</dt>
            <dd style={{ margin: 0, color: "#0f172a" }}>{data.status}</dd>
          </dl>

          <p
            style={{
              marginTop: 24,
              fontSize: 11,
              color: "#94a3b8",
              textAlign: "center",
              lineHeight: 1.5,
            }}
          >
            For privacy, the patient&apos;s full name and medication details are
            not disclosed on this public verification page. If you suspect
            tampering, contact the issuing hospital.
          </p>
        </div>

        <p
          style={{
            textAlign: "center",
            fontSize: 11,
            color: "#94a3b8",
            marginTop: 18,
          }}
        >
          Verified by {h.name} &middot; {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}
