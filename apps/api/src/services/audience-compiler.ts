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
 *
 * 2026-05-25 — Pearl §5.1 row 161 closure:
 *   - `city`, `branchId`, and `optedOut` now compile to real Prisma clauses.
 *     `Patient.branchId` shipped 2026-05-21 (migration 20260521000002);
 *     `Patient.city` + `Patient.whatsappOptIn` shipped 2026-05-25 (migration
 *     20260525000002_add_patient_city_and_whatsapp_optin). `optedOut` maps to
 *     the inverse of `whatsappOptIn` (optedOut=true ⇒ whatsappOptIn=false).
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

    case "city": {
      // Pearl §5.1 row 161 — Patient.city landed 2026-05-25
      // (migration 20260525000002). Supports eq (single city) and in
      // (array of cities). Empty array → no-op (matches nothing would
      // be surprising; matching everything is safer for an audience
      // preview and consistent with the empty-filters convention).
      if (op === "eq") {
        if (typeof value !== "string" || value.trim().length === 0) {
          console.warn(
            `[audience-compiler] non-string/empty value for city eq; treating as no-op`,
          );
          return null;
        }
        return { city: value };
      }
      if (op === "in") {
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          !value.every((v) => typeof v === "string" && v.trim().length > 0)
        ) {
          console.warn(
            `[audience-compiler] invalid value for city in; treating as no-op`,
          );
          return null;
        }
        return { city: { in: value as string[] } };
      }
      console.warn(
        `[audience-compiler] unsupported op "${op}" for field "city"; treating as no-op`,
      );
      return null;
    }

    case "branchId": {
      // Pearl §5.1 row 161 — Patient.branchId landed 2026-05-21
      // (migration 20260521000002). Single-branch eq only; multi-branch
      // would be modelled as a "branch" filter with op=in if needed
      // later — keep the v1 shape narrow.
      if (op !== "eq") {
        console.warn(
          `[audience-compiler] unsupported op "${op}" for field "branchId"; treating as no-op`,
        );
        return null;
      }
      if (typeof value !== "string" || value.trim().length === 0) {
        console.warn(
          `[audience-compiler] non-string/empty value for branchId eq; treating as no-op`,
        );
        return null;
      }
      return { branchId: value };
    }

    case "optedOut": {
      // Pearl §5.1 row 161 — Patient.whatsappOptIn landed 2026-05-25
      // (migration 20260525000002). The DSL exposes the inverse
      // ("optedOut") for operator legibility; compiler flips it so the
      // Patient column stays affirmative-consent shaped (DPDP).
      if (op !== "eq") {
        console.warn(
          `[audience-compiler] unsupported op "${op}" for field "optedOut"; treating as no-op`,
        );
        return null;
      }
      if (typeof value !== "boolean") {
        console.warn(
          `[audience-compiler] non-boolean value for optedOut eq; treating as no-op`,
        );
        return null;
      }
      return { whatsappOptIn: !value };
    }

    case "condition": {
      // Diagnosis match — searches a patient's diagnosis WHEREVER it's
      // recorded, so a condition logged in any surface catches the patient:
      //   • ChronicCondition (the problem list)   — name OR icd10Code, ACTIVE
      //   • Prescription.diagnosis (per-visit)     — the visit diagnosis
      //   • Admission.diagnosis / finalDiagnosis   — inpatient diagnosis
      // Case-insensitive `contains`, so "diabet" catches "Type 2 Diabetes
      // Mellitus" and "E11" catches the ICD code. `eq` (single term) and `in`
      // (any of several terms) are supported.
      const terms: string[] =
        op === "in"
          ? Array.isArray(value)
            ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            : []
          : typeof value === "string" && value.trim().length > 0
            ? [value]
            : [];
      if (op !== "eq" && op !== "in") {
        console.warn(
          `[audience-compiler] unsupported op "${op}" for field "condition"; treating as no-op`,
        );
        return null;
      }
      if (terms.length === 0) {
        console.warn(
          `[audience-compiler] empty value for condition ${op}; treating as no-op`,
        );
        return null;
      }
      const ci = (t: string) => ({ contains: t.trim(), mode: "insensitive" as const });
      // A patient matches if ANY term hits ANY of the diagnosis surfaces.
      const perPatient = terms.map((t) => ({
        OR: [
          // Problem list (active conditions) — name or ICD code.
          { chronicConditions: { some: { status: "ACTIVE" as any, OR: [{ condition: ci(t) }, { icd10Code: ci(t) }] } } },
          // Per-visit prescription diagnosis.
          { prescriptions: { some: { diagnosis: ci(t) } } },
          // Inpatient admission diagnosis (working + final).
          { admissions: { some: { OR: [{ diagnosis: ci(t) }, { finalDiagnosis: ci(t) }] } } },
        ],
      }));
      return perPatient.length === 1 ? perPatient[0] : { OR: perPatient };
    }

    case "allergy": {
      // Allergy match — a patient matches if they have a PatientAllergy row
      // whose `allergen` contains ANY of the supplied terms (case-insensitive).
      // Supports `eq` (single allergen) + `in` (any of several). Mirrors the
      // `condition` filter's term-collection shape. Lets a campaign target (or,
      // composed under a NOT, exclude) patients by allergy — e.g. don't send a
      // "free penicillin-based antibiotic camp" blast to penicillin-allergics.
      const aTerms: string[] =
        op === "in"
          ? Array.isArray(value)
            ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            : []
          : typeof value === "string" && value.trim().length > 0
            ? [value]
            : [];
      if (op !== "eq" && op !== "in") {
        console.warn(
          `[audience-compiler] unsupported op "${op}" for field "allergy"; treating as no-op`,
        );
        return null;
      }
      if (aTerms.length === 0) {
        console.warn(
          `[audience-compiler] empty value for allergy ${op}; treating as no-op`,
        );
        return null;
      }
      const ciA = (t: string) => ({ contains: t.trim(), mode: "insensitive" as const });
      return {
        allergies: {
          some: {
            OR: aTerms.map((t) => ({ allergen: ciA(t) })),
          },
        },
      };
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
