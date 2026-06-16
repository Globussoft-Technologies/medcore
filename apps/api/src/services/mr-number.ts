// Per-tenant MR (medical record) number generation.
//
// What / which modules / why:
//   - The MR number scheme is `<TENANT CODE><zero-padded sequence>`, e.g. a
//     tenant whose operator code is "PG-01" issues PG01000001, PG01000002…
//     The sequence is counted INDEPENDENTLY per tenant.
//   - Shared by every surface that creates a Patient so staff-registration
//     (routes/patients.ts) and public self-registration (routes/auth.ts)
//     produce the SAME format. Previously each had its own (divergent) logic.
//
// Prefix derivation (in order): operator-set tenant code (SystemConfig key
// `tenant:<id>:code`, e.g. "PG-01") → tenant subdomain slug → "MR". Slugified
// to uppercase alphanumerics, capped at 12 chars ("PG-01" → "PG01").
//
// The sequence is held in a per-tenant SystemConfig counter
// (`next_mr_number:<tenantId>`), but is never trusted blindly: seeders /
// imports can create rows without advancing it, so we start from
// `max(counter, highest existing seq for this prefix + 1)`. Callers should
// still retry the insert on a unique-constraint clash (concurrent inserts).

// Accept any Prisma-like client — the plain `PrismaClient` AND the
// tenant-scoped `$extends` wrapper (whose method signatures differ enough
// that a strict structural `Pick` won't match both). We only call
// systemConfig/tenant/patient finders here; `any` on the client keeps the
// helper usable from every caller without leaking extension generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MrPrismaClient = any;

const PAD = 6;

export function slugifyMrPrefix(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export function formatMrNumber(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(PAD, "0")}`;
}

/**
 * Resolve the MR-number prefix for a tenant: operator code → subdomain → "MR".
 * Returns "MR" when there is no tenant context (platform/seed callers).
 */
export async function resolveMrPrefix(
  prisma: MrPrismaClient,
  tenantId: string | null | undefined,
): Promise<string> {
  if (!tenantId) return "MR";
  const codeRow = await prisma.systemConfig.findUnique({
    where: { key: `tenant:${tenantId}:code` },
  });
  const fromCode = codeRow?.value ? slugifyMrPrefix(codeRow.value) : "";
  if (fromCode) return fromCode;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subdomain: true },
  });
  const fromSub = tenant?.subdomain ? slugifyMrPrefix(tenant.subdomain) : "";
  return fromSub || "MR";
}

/**
 * Next sequence number for a prefix: max(per-tenant counter, highest existing
 * MR under this prefix + 1). Plain Prisma — no fragile raw SQL.
 */
export async function nextMrSeq(
  prisma: MrPrismaClient,
  counterKey: string,
  prefix: string,
): Promise<number> {
  const config = await prisma.systemConfig.findUnique({
    where: { key: counterKey },
  });
  const counterSeq = config ? parseInt(config.value, 10) || 1 : 1;
  const candidates = await prisma.patient.findMany({
    where: { mrNumber: { startsWith: prefix } },
    orderBy: { mrNumber: "desc" },
    select: { mrNumber: true },
    take: 50,
  });
  const tail = new RegExp(`^${prefix}(\\d+)$`);
  let latestSeq = 0;
  for (const c of candidates) {
    const m = tail.exec(c.mrNumber);
    if (m) latestSeq = Math.max(latestSeq, parseInt(m[1], 10) || 0);
  }
  return Math.max(counterSeq, latestSeq + 1);
}

export function mrCounterKey(tenantId: string | null | undefined): string {
  return `next_mr_number:${tenantId ?? "global"}`;
}
