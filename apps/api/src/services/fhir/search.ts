/**
 * FHIR R4 search (`type=searchset`) for MedCore.
 *
 * Supports the minimum subset of FHIR search parameters needed to interop with
 * ABDM HIU pulls and typical third-party EHR clients. Each `searchXxx` function
 * returns a `Bundle(type="searchset")` with `total`, `entry[]` and `link[]`
 * (self/next/prev) following FHIR R4 §3.1.3.
 *
 * Design notes:
 * - We reuse the forward mappers from `resources.ts` so the wire format stays
 *   identical to the `$everything` and `$export` bundles. No duplicated
 *   Patient→FHIR conversion.
 * - All Prisma access goes through the typed delegates (`prisma.patient`,
 *   `prisma.appointment`, …). No `as any` on delegate calls; casts only
 *   appear where Prisma relation types collide with the forward mapper's
 *   `any` fixture shape.
 * - Parameter validation throws `FhirSearchError` which the route layer
 *   converts to a 400 OperationOutcome.
 * - `_lastUpdated` supports `gt`, `lt`, `ge`, `le` prefixes.
 * - Date parameters accept `YYYY-MM-DD`, `YYYY-MM`, `YYYY` and the same
 *   four prefixes. `YYYY-MM` and `YYYY` expand to a window over the month
 *   or year respectively.
 *
 * Ambiguities resolved:
 * - FHIR `name` search is spec'd as "matches any of family, given, prefix,
 *   suffix, text"; we match case-insensitive substring against family+given
 *   (User.name column). `family` and `given` are more specific — they search
 *   only the appropriate tokens.
 * - The Patient model has no `updatedAt` column — we interpret
 *   `_lastUpdated` on Patient as a filter on `User.updatedAt` via the
 *   mandatory `user` relation, which is the best proxy available without
 *   a schema change.
 * - `_count`: FHIR doesn't mandate a max, but we cap at 200 to prevent
 *   payload-bomb DoS. `_count=0` and negatives default back to 50.
 */

import { prisma } from "@medcore/db";
import {
  patientToFhir,
  consultationToEncounter,
  prescriptionToMedicationRequests,
  allergyToFhir,
  type FhirResource,
} from "./resources";
import type { FhirBundle, FhirBundleEntry } from "./bundle";

// ─── Errors / constants ─────────────────────────────────────────────────────

export class FhirSearchError extends Error {
  readonly diagnostics: string;
  constructor(diagnostics: string) {
    super(diagnostics);
    this.diagnostics = diagnostics;
    this.name = "FhirSearchError";
  }
}

export const DEFAULT_COUNT = 50;
export const MAX_COUNT = 200;

const DATE_PREFIXES = ["ge", "le", "gt", "lt", "eq"] as const;
type DatePrefix = (typeof DATE_PREFIXES)[number];

// ─── Parameter shape ────────────────────────────────────────────────────────

/** Common pagination + `_lastUpdated` parameters accepted by every search. */
export interface CommonParams {
  _count?: number | string;
  _offset?: number | string;
  _lastUpdated?: string;
}

export interface PatientSearchParams extends CommonParams {
  name?: string;
  family?: string;
  given?: string;
  identifier?: string; // may be "system|value" or plain value
  birthdate?: string;
  gender?: string;
}

export interface EncounterSearchParams extends CommonParams {
  patient?: string;
  date?: string;
  status?: string;
}

export interface MedicationRequestSearchParams extends CommonParams {
  patient?: string;
  status?: string;
  authoredon?: string;
}

export interface AllergyIntoleranceSearchParams extends CommonParams {
  patient?: string;
}

/**
 * Union of every FHIR search-param shape accepted by this module. Useful
 * for generic helpers (audit redaction, logging) that need to accept any
 * of the four without falling back to `object`.
 */
export type SearchParams =
  | PatientSearchParams
  | EncounterSearchParams
  | MedicationRequestSearchParams
  | AllergyIntoleranceSearchParams;

// ─── Parameter parsers ──────────────────────────────────────────────────────

/** Parse and clamp `_count` / `_offset`. Invalid values raise FhirSearchError. */
function parsePagination(p: CommonParams): { count: number; offset: number } {
  let count = DEFAULT_COUNT;
  if (p._count !== undefined && p._count !== "") {
    const n = Number(p._count);
    if (!Number.isFinite(n) || Number.isNaN(n)) {
      throw new FhirSearchError(`Invalid _count value: ${String(p._count)}`);
    }
    if (n <= 0) count = DEFAULT_COUNT;
    else count = Math.min(Math.floor(n), MAX_COUNT);
  }
  let offset = 0;
  if (p._offset !== undefined && p._offset !== "") {
    const n = Number(p._offset);
    if (!Number.isFinite(n) || Number.isNaN(n) || n < 0) {
      throw new FhirSearchError(`Invalid _offset value: ${String(p._offset)}`);
    }
    offset = Math.floor(n);
  }
  return { count, offset };
}

/** Split a prefixed date parameter like `ge2024-01-01` into {prefix, value}. */
function splitPrefix(raw: string): { prefix: DatePrefix; value: string } {
  const trimmed = raw.trim();
  for (const pfx of DATE_PREFIXES) {
    if (trimmed.startsWith(pfx)) {
      return { prefix: pfx, value: trimmed.slice(pfx.length) };
    }
  }
  return { prefix: "eq", value: trimmed };
}

/**
 * Parse a FHIR date value (possibly with prefix) into a {gte, lte} window.
 * Accepts `YYYY`, `YYYY-MM`, `YYYY-MM-DD`.
 *
 * - `eqYYYY-MM-DD`  → [day 00:00, next day 00:00)
 * - `eqYYYY-MM`     → [first of month, first of next month)
 * - `eqYYYY`        → [Jan 1, next Jan 1)
 * - `geYYYY-MM-DD`  → start of that day onwards
 * - `leYYYY-MM-DD`  → up to (inclusive) end of that day
 * - `gtYYYY-MM-DD`  → strictly after end of that day
 * - `ltYYYY-MM-DD`  → strictly before start of that day
 */
function parseDateParam(raw: string, paramName: string): { gte?: Date; lte?: Date; lt?: Date; gt?: Date } {
  const { prefix, value } = splitPrefix(raw);
  const window = expandDateWindow(value, paramName);

  switch (prefix) {
    case "eq":
      return { gte: window.start, lt: window.endExclusive };
    case "ge":
      return { gte: window.start };
    case "le":
      // inclusive upper — use lt the next instant so ORM comparisons work.
      return { lt: window.endExclusive };
    case "gt":
      return { gte: window.endExclusive };
    case "lt":
      return { lt: window.start };
  }
}

interface DateWindow {
  start: Date; // inclusive
  endExclusive: Date; // exclusive upper bound
}

function expandDateWindow(value: string, paramName: string): DateWindow {
  // YYYY
  if (/^\d{4}$/.test(value)) {
    const y = Number(value);
    return {
      start: new Date(Date.UTC(y, 0, 1)),
      endExclusive: new Date(Date.UTC(y + 1, 0, 1)),
    };
  }
  // YYYY-MM
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [ys, ms] = value.split("-");
    const y = Number(ys);
    const m = Number(ms);
    if (m < 1 || m > 12) throw new FhirSearchError(`Invalid ${paramName} date: ${value}`);
    return {
      start: new Date(Date.UTC(y, m - 1, 1)),
      endExclusive: new Date(Date.UTC(y, m, 1)),
    };
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [ys, ms, ds] = value.split("-");
    const y = Number(ys);
    const m = Number(ms);
    const d = Number(ds);
    if (m < 1 || m > 12 || d < 1 || d > 31) {
      throw new FhirSearchError(`Invalid ${paramName} date: ${value}`);
    }
    const start = new Date(Date.UTC(y, m - 1, d));
    if (start.getUTCMonth() !== m - 1 || start.getUTCDate() !== d) {
      throw new FhirSearchError(`Invalid ${paramName} date: ${value}`);
    }
    const endExclusive = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, endExclusive };
  }
  throw new FhirSearchError(`Invalid ${paramName} format: "${value}" (expected YYYY, YYYY-MM or YYYY-MM-DD)`);
}

/** Map a {gte, lt, gt} window into Prisma's filter grammar. */
function toPrismaDateFilter(w: ReturnType<typeof parseDateParam>): Record<string, Date> {
  const out: Record<string, Date> = {};
  if (w.gte) out.gte = w.gte;
  if (w.lte) out.lte = w.lte;
  if (w.lt) out.lt = w.lt;
  if (w.gt) out.gt = w.gt;
  return out;
}

/** Parse `_lastUpdated` (same date grammar). Returns the Prisma filter or null. */
function parseLastUpdated(raw: string | undefined): Record<string, Date> | null {
  if (!raw) return null;
  const w = parseDateParam(raw, "_lastUpdated");
  return toPrismaDateFilter(w);
}

/**
 * Parse `identifier` which may be `system|value` or just `value`. Returns the
 * value alone — we search across all identifier columns (mrNumber, abhaId,
 * aadhaarMasked). System filtering is best-effort: when a system is provided,
 * we match only the matching column; otherwise any column.
 */
function parseIdentifier(raw: string): { system: string | null; value: string } {
  const trimmed = raw.trim();
  const pipeIdx = trimmed.indexOf("|");
  if (pipeIdx === -1) return { system: null, value: trimmed };
  return { system: trimmed.slice(0, pipeIdx) || null, value: trimmed.slice(pipeIdx + 1) };
}

function mapGenderFilter(raw: string): string {
  switch (raw.toLowerCase()) {
    case "male":
      return "MALE";
    case "female":
      return "FEMALE";
    case "other":
      return "OTHER";
    case "unknown":
      // MedCore has no UNKNOWN enum value; map to OTHER for want of better.
      return "OTHER";
    default:
      throw new FhirSearchError(`Invalid gender: ${raw}`);
  }
}

// ─── Bundle assembly ────────────────────────────────────────────────────────

export interface SearchsetLink {
  relation: "self" | "next" | "previous" | "first" | "last";
  url: string;
}

export interface FhirSearchsetBundle extends FhirBundle {
  link?: SearchsetLink[];
}

/** Build a `urn:uuid:` fullUrl for a resource (mirrors bundle.ts). */
function fullUrlFor(resource: FhirResource): string {
  return `urn:uuid:${resource.resourceType}-${resource.id}`;
}

/** Build self/next/prev link URLs for a searchset page. */
function buildLinks(opts: {
  selfUrl: string;
  total: number;
  count: number;
  offset: number;
  searchParams: URLSearchParams;
  baseUrl: string;
}): SearchsetLink[] {
  const { total, count, offset, searchParams, baseUrl, selfUrl } = opts;
  const links: SearchsetLink[] = [{ relation: "self", url: selfUrl }];

  const makeUrl = (newOffset: number): string => {
    const p = new URLSearchParams(searchParams);
    p.set("_count", String(count));
    p.set("_offset", String(newOffset));
    return `${baseUrl}?${p.toString()}`;
  };

  if (offset + count < total) {
    links.push({ relation: "next", url: makeUrl(offset + count) });
  }
  if (offset > 0) {
    const prev = Math.max(0, offset - count);
    links.push({ relation: "previous", url: makeUrl(prev) });
  }
  return links;
}

interface AssembleOpts {
  id: string;
  total: number;
  resources: FhirResource[];
  links?: SearchsetLink[];
}

/** Wrap resources into a `searchset` bundle. */
function createSearchsetBundle(opts: AssembleOpts): FhirSearchsetBundle {
  const entries: FhirBundleEntry[] = opts.resources.map((r) => ({
    fullUrl: fullUrlFor(r),
    resource: r,
  }));
  const bundle: FhirSearchsetBundle = {
    resourceType: "Bundle",
    id: opts.id,
    type: "searchset",
    timestamp: new Date().toISOString(),
    total: opts.total,
    entry: entries,
  };
  if (opts.links && opts.links.length) bundle.link = opts.links;
  return bundle;
}

// ─── Patient search ─────────────────────────────────────────────────────────

export interface SearchContext {
  /** Absolute URL that produced this search (for `self` link). */
  selfUrl?: string;
  /** Base URL (minus querystring) used to build next/prev links. */
  baseUrl?: string;
  /** Raw querystring parameters for next/prev link regeneration. */
  searchParams?: URLSearchParams;
}

function emptyContextLinks(ctx: SearchContext | undefined, total: number, count: number, offset: number): SearchsetLink[] {
  if (!ctx?.selfUrl || !ctx.baseUrl || !ctx.searchParams) return [];
  return buildLinks({
    selfUrl: ctx.selfUrl,
    total,
    count,
    offset,
    baseUrl: ctx.baseUrl,
    searchParams: ctx.searchParams,
  });
}

/**
 * Search Patient resources. Returns a `searchset` Bundle.
 */
export async function searchPatient(
  params: PatientSearchParams,
  ctx?: SearchContext
): Promise<FhirSearchsetBundle> {
  const { count, offset } = parsePagination(params);

  const where: Record<string, unknown> = {};
  const userWhere: Record<string, unknown> = {};

  // name / family / given — all hit User.name (we store single-string names).
  // When more than one is provided we AND them so every token must appear
  // in the name; this lets `family=Sharma&given=Arjun` be stricter than
  // `name=Sharma` alone.
  const nameTokens: string[] = [];
  if (params.name) nameTokens.push(params.name);
  if (params.family) nameTokens.push(params.family);
  if (params.given) nameTokens.push(params.given);
  if (nameTokens.length === 1) {
    userWhere.name = { contains: nameTokens[0], mode: "insensitive" };
  } else if (nameTokens.length > 1) {
    userWhere.AND = nameTokens.map((tok) => ({
      name: { contains: tok, mode: "insensitive" },
    }));
  }

  // identifier — mrNumber, abhaId, aadhaarMasked.
  if (params.identifier) {
    const { system, value } = parseIdentifier(params.identifier);
    const orClauses: Array<Record<string, unknown>> = [];
    // We only lookup by system URI when provided; otherwise search all columns.
    if (!system || system.includes("mr-number")) orClauses.push({ mrNumber: value });
    if (!system || system.includes("healthid") || system.includes("abha")) orClauses.push({ abhaId: value });
    if (!system || system.includes("uidai") || system.includes("aadhaar")) orClauses.push({ aadhaarMasked: value });
    if (!orClauses.length) {
      // unknown system — match nothing rather than returning every patient
      orClauses.push({ mrNumber: "__no_match__" });
    }
    where.OR = orClauses;
  }

  if (params.gender) {
    where.gender = mapGenderFilter(params.gender);
  }

  if (params.birthdate) {
    const w = parseDateParam(params.birthdate, "birthdate");
    where.dateOfBirth = toPrismaDateFilter(w);
  }

  const lastUpdated = parseLastUpdated(params._lastUpdated);
  if (lastUpdated) {
    // Patient has no updatedAt column → proxy via user.updatedAt.
    userWhere.updatedAt = lastUpdated;
  }

  if (Object.keys(userWhere).length > 0) {
    where.user = { is: userWhere };
  }

  const [total, rows] = await Promise.all([
    prisma.patient.count({ where }),
    prisma.patient.findMany({
      where,
      include: { user: true },
      orderBy: { mrNumber: "asc" },
      take: count,
      skip: offset,
    }),
  ]);

  const resources: FhirResource[] = rows.map((p) => patientToFhir(p));
  const links = emptyContextLinks(ctx, total, count, offset);

  return createSearchsetBundle({
    id: `patient-search-${Date.now()}`,
    total,
    resources,
    links,
  });
}

// ─── Encounter search ───────────────────────────────────────────────────────

const ENCOUNTER_STATUS_FROM_FHIR: Record<string, "in-progress" | "finished"> = {
  "in-progress": "in-progress",
  finished: "finished",
};

/**
 * Encounter is modelled on Consultation in MedCore. We don't have a 1-to-1
 * status field; `finished` means consultationEndedAt is set and `in-progress`
 * means it's not. Other FHIR statuses (`planned`, `arrived`, etc.) return
 * empty because MedCore tracks those at the Appointment level.
 */
export async function searchEncounter(
  params: EncounterSearchParams,
  ctx?: SearchContext
): Promise<FhirSearchsetBundle> {
  const { count, offset } = parsePagination(params);

  // We'll filter on Consultation.appointment since consultation itself has no
  // patientId column — the relation is via appointment.
  const where: Record<string, unknown> = {};
  const appointmentWhere: Record<string, unknown> = {};

  if (params.patient) {
    appointmentWhere.patientId = params.patient;
  }

  if (params.date) {
    const w = parseDateParam(params.date, "date");
    // Consultation.createdAt is the closest proxy for "encounter date".
    where.createdAt = toPrismaDateFilter(w);
  }

  if (params.status) {
    const mapped = ENCOUNTER_STATUS_FROM_FHIR[params.status.toLowerCase()];
    if (!mapped) {
      throw new FhirSearchError(
        `Unsupported Encounter.status: ${params.status}. Supported: in-progress, finished.`
      );
    }
    if (mapped === "finished") {
      appointmentWhere.consultationEndedAt = { not: null };
    } else {
      appointmentWhere.consultationEndedAt = null;
    }
  }

  const lastUpdated = parseLastUpdated(params._lastUpdated);
  if (lastUpdated) where.updatedAt = lastUpdated;

  if (Object.keys(appointmentWhere).length > 0) {
    where.appointment = { is: appointmentWhere };
  }

  const [total, rows] = await Promise.all([
    prisma.consultation.count({ where }),
    prisma.consultation.findMany({
      where,
      include: { appointment: true },
      orderBy: { createdAt: "desc" },
      take: count,
      skip: offset,
    }),
  ]);

  const resources: FhirResource[] = rows.map((c) => consultationToEncounter(c));
  const links = emptyContextLinks(ctx, total, count, offset);

  return createSearchsetBundle({
    id: `encounter-search-${Date.now()}`,
    total,
    resources,
    links,
  });
}

// ─── MedicationRequest search ───────────────────────────────────────────────

/**
 * MedicationRequest is derived from PrescriptionItem rows. Since the forward
 * mapper `prescriptionToMedicationRequests` takes a Prescription (with items),
 * we query Prescriptions and flatten the resulting MedicationRequest array.
 * `status` filter is applied post-mapping since we hard-code status "active"
 * in the mapper.
 */
export async function searchMedicationRequest(
  params: MedicationRequestSearchParams,
  ctx?: SearchContext
): Promise<FhirSearchsetBundle> {
  const { count, offset } = parsePagination(params);

  const where: Record<string, unknown> = {};

  if (params.patient) where.patientId = params.patient;

  if (params.authoredon) {
    const w = parseDateParam(params.authoredon, "authoredon");
    where.createdAt = toPrismaDateFilter(w);
  }

  const lastUpdated = parseLastUpdated(params._lastUpdated);
  if (lastUpdated) where.updatedAt = lastUpdated;

  // NOTE: The forward mapper emits MedicationRequest.status = "active" for
  // every prescription item. If the caller filters on a status other than
  // "active" we short-circuit and return an empty bundle. This avoids
  // returning irrelevant rows until per-item status is persisted.
  if (params.status && params.status.toLowerCase() !== "active") {
    return createSearchsetBundle({
      id: `medreq-search-${Date.now()}`,
      total: 0,
      resources: [],
      links: emptyContextLinks(ctx, 0, count, offset),
    });
  }

  const rows = await prisma.prescription.findMany({
    where,
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });

  const allMedRequests: FhirResource[] = [];
  for (const rx of rows) {
    allMedRequests.push(...prescriptionToMedicationRequests(rx));
  }

  const total = allMedRequests.length;
  const page = allMedRequests.slice(offset, offset + count);
  const links = emptyContextLinks(ctx, total, count, offset);

  return createSearchsetBundle({
    id: `medreq-search-${Date.now()}`,
    total,
    resources: page,
    links,
  });
}

// ─── AllergyIntolerance search ──────────────────────────────────────────────

export async function searchAllergyIntolerance(
  params: AllergyIntoleranceSearchParams,
  ctx?: SearchContext
): Promise<FhirSearchsetBundle> {
  const { count, offset } = parsePagination(params);

  const where: Record<string, unknown> = {};
  if (params.patient) where.patientId = params.patient;

  const lastUpdated = parseLastUpdated(params._lastUpdated);
  if (lastUpdated) where.notedAt = lastUpdated;

  const [total, rows] = await Promise.all([
    prisma.patientAllergy.count({ where }),
    prisma.patientAllergy.findMany({
      where,
      orderBy: { notedAt: "desc" },
      take: count,
      skip: offset,
    }),
  ]);

  const resources: FhirResource[] = rows.map((a) => allergyToFhir(a));
  const links = emptyContextLinks(ctx, total, count, offset);

  return createSearchsetBundle({
    id: `allergy-search-${Date.now()}`,
    total,
    resources,
    links,
  });
}
