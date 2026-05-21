/**
 * Audience compiler — Pearl ERP Stage 1 §5.1 (gap item #4 — piece 2a of 4).
 *
 * What / which modules / why:
 *   - Pure function (no Prisma I/O) that maps a saved `CampaignAudience.rules`
 *     JSON blob into a `Prisma.PatientWhereInput`. The caller composes the
 *     returned `where` with their own `tenantId` (and any other scoping)
 *     before issuing `prisma.patient.count` / `findMany`.
 *   - Consumed by:
 *       - `routes/campaign-audiences.ts` POST /:id/compile  → audience-size + sample
 *       - `routes/campaigns.ts`         POST /:id/sends/preview → estimated recipients
 *     The dispatcher worker (piece 2b) will also consume this when materializing
 *     CampaignSend rows; it is intentionally synchronous + side-effect-free so it
 *     can be wrapped by any caller (cron, route, future worker, tests).
 *
 * Unknown-predicate handling (intentional, documented in PRD §5.1 closure notes):
 *   - Unknown `field` → no-op clause + `console.warn`. Saved campaigns must
 *     survive DSL evolution; throwing would brick tenant-owned content on a
 *     rename/removal.
 *   - Unknown `op` for a known field → ditto (warn + no-op).
 *   - Filters that target Patient columns that do not exist yet (city, branchId,
 *     optedOut) also no-op + warn. They start filtering automatically once
 *     gap #2 piece 2b lands Patient.branchId etc — no compiler change needed.
 *
 * matchMode semantics:
 *   - "ALL" → AND-combine clauses (default if omitted)
 *   - "ANY" → OR-combine clauses
 *   - Empty filters array → no-op (returns `{}` — caller still applies tenantId)
 */
import { Prisma } from "@prisma/client";
import type { AudienceRules, AudienceFilter } from "@medcore/shared";

// One filter → at most one Prisma `where`-clause object. `null` means
// "compiler decided this filter is a no-op" (warned via console.warn at
// the call site). The combiner skips nulls so they don't pollute the
// AND/OR arrays with empty `{}`s.
type Clause = Prisma.PatientWhereInput | null;

function compileFilter(filter: AudienceFilter): Clause {
  const { field, op, value } = filter;

  switch (field) {
    case "gender": {
      if (op !== "eq") {
        console.warn(
          `[audience-compiler] unsupported op "${op}" for field "gender"; treating as no-op`,
        );
        return null;
      }
      if (typeof value !== "string") {
        console.warn(
          `[audience-compiler] non-string value for gender eq; treating as no-op`,
        );
        return null;
      }
      // Cast to any to bypass the Gender enum check at compile time —
      // the Prisma client will validate at query time, and an invalid
      // value would just return zero matches (acceptable for an
      // audience preview).
      return { gender: value as any };
    }

    case "age": {
      if (op !== "gte" && op !== "lte") {
        console.warn(
          `[audience-compiler] unsupported op "${op}" for field "age"; treating as no-op`,
        );
        return null;
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 150) {
        console.warn(
          `[audience-compiler] invalid age value ${String(value)}; treating as no-op`,
        );
        return null;
      }
      // age >= N (older or equal) → dateOfBirth on/before (now - N years)
      // age <= N (younger or equal) → dateOfBirth on/after (now - N years)
      const threshold = new Date();
      threshold.setUTCFullYear(threshold.getUTCFullYear() - value);
      return op === "gte"
        ? { dateOfBirth: { lte: threshold } }
        : { dateOfBirth: { gte: threshold } };
    }

    case "lastVisitDays": {
      if (op !== "gte" && op !== "lte") {
        console.warn(
          `[audience-compiler] unsupported op "${op}" for field "lastVisitDays"; treating as no-op`,
        );
        return null;
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        console.warn(
          `[audience-compiler] invalid lastVisitDays value ${String(value)}; treating as no-op`,
        );
        return null;
      }
      const threshold = new Date(Date.now() - value * 24 * 60 * 60 * 1000);
      // lte N = "had a visit within the last N days" → ANY appointment.date >= threshold
      // gte N = "no visit in the last N days"        → NO  appointment.date >= threshold
      return op === "lte"
        ? { appointments: { some: { date: { gte: threshold } } } }
        : { appointments: { none: { date: { gte: threshold } } } };
    }

    case "abhaLinked": {
      if (op !== "eq") {
        console.warn(
          `[audience-compiler] unsupported op "${op}" for field "abhaLinked"; treating as no-op`,
        );
        return null;
      }
      if (typeof value !== "boolean") {
        console.warn(
          `[audience-compiler] non-boolean value for abhaLinked eq; treating as no-op`,
        );
        return null;
      }
      return value ? { abhaId: { not: null } } : { abhaId: null };
    }

    case "city":
    case "branchId":
    case "optedOut": {
      // Pearl §5.1 piece-2a documented limitation: Patient lacks these
      // columns today. Patient.branchId lands in gap #2 piece 2b;
      // Patient.address+city and Patient.optedOut have no committed
      // home yet. Compiler emits no-op so the saved DSL is forward-
      // compatible (no code change needed once the columns appear).
      console.warn(
        `[audience-compiler] field "${field}" is reserved for a future schema change; treating as no-op`,
      );
      return null;
    }

    default: {
      console.warn(
        `[audience-compiler] unknown field "${field}"; treating as no-op`,
      );
      return null;
    }
  }
}

/**
 * Compile a saved AudienceRules JSON blob into a Prisma `where` over Patient.
 *
 * The returned object is intended to be composed with the caller's
 * tenantId scope — e.g. `prisma.patient.findMany({ where: { tenantId,
 * AND: [compileAudience(rules)] } })`.
 */
export function compileAudience(rules: AudienceRules): Prisma.PatientWhereInput {
  const filters = rules?.filters ?? [];
  const matchMode = rules?.matchMode ?? "ALL";

  if (filters.length === 0) {
    // Empty audience → match everything (caller still applies tenantId).
    return {};
  }

  const compiled: Prisma.PatientWhereInput[] = [];
  for (const filter of filters) {
    const clause = compileFilter(filter);
    if (clause !== null) compiled.push(clause);
  }

  // All filters were no-ops → match everything (caller still applies tenantId).
  if (compiled.length === 0) return {};

  // Single clause: no need to wrap in AND/OR.
  if (compiled.length === 1) return compiled[0];

  return matchMode === "ANY" ? { OR: compiled } : { AND: compiled };
}
