import { NextResponse } from "next/server";

// POST /api/enquiry/submit
// Thin proxy to backend /api/v1/marketing/enquiry. The backend owns validation,
// Prisma storage, and the optional CRM_WEBHOOK_URL forward (best-effort, never
// blocks the enquiry from being stored).
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  // Honeypot — if a bot filled the hidden "website" field, short-circuit with
  // a fake success so we don't waste backend cycles or leak detection signal.
  const payload = body as Record<string, unknown>;
  if (typeof payload.website === "string" && payload.website.length > 0) {
    return NextResponse.json({ success: true });
  }

  const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
  try {
    const resp = await fetch(`${apiBase}/marketing/enquiry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const data = await resp.json().catch(() => ({ success: false }));
    if (!resp.ok) {
      return NextResponse.json(
        { success: false, error: data?.error || "Submission failed" },
        { status: resp.status }
      );
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: "Unable to reach backend" },
      { status: 502 }
    );
  }
}
