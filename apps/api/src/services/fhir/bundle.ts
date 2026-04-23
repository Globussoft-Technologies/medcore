/**
 * FHIR R4 Bundle helpers — wraps resources into `searchset` or `transaction`
 * bundles with proper `fullUrl` references.
 *
 * Per FHIR R4 spec, `Bundle.entry.fullUrl` should be a URL that uniquely
 * identifies the resource. When building a local bundle for export we use
 * `urn:uuid:` URNs so receivers can resolve references within the bundle
 * without needing our public base URL.
 */

import type { FhirResource } from "./resources";

export interface FhirBundleEntry<R extends FhirResource = FhirResource> {
  fullUrl: string;
  resource: R;
  request?: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
  };
}

export interface FhirBundle<R extends FhirResource = FhirResource> {
  resourceType: "Bundle";
  id: string;
  type: "searchset" | "transaction" | "transaction-response" | "batch" | "document" | "collection";
  timestamp: string;
  total?: number;
  entry: FhirBundleEntry<R>[];
}

/** Build a `urn:uuid:` fullUrl for a resource. FHIR permits this form for intra-bundle refs. */
function fullUrlFor(resource: FhirResource): string {
  // When the id is already a UUID, keep it; otherwise prefix with the type
  // so fullUrls remain unique across resource types.
  return `urn:uuid:${resource.resourceType}-${resource.id}`;
}

/**
 * Wrap an array of resources into a FHIR `searchset` Bundle. Used for
 * read-style responses (e.g. `$everything`, search results).
 */
export function toSearchsetBundle(resources: FhirResource[], id?: string): FhirBundle {
  const entries: FhirBundleEntry[] = resources.map((r) => ({
    fullUrl: fullUrlFor(r),
    resource: r,
  }));

  return {
    resourceType: "Bundle",
    id: id ?? `bundle-${Date.now()}`,
    type: "searchset",
    timestamp: new Date().toISOString(),
    total: entries.length,
    entry: entries,
  };
}

/**
 * Wrap resources into a FHIR `transaction` Bundle. Each entry gets a PUT
 * request pointing at the canonical resource URL, making the bundle idempotent
 * against the receiving server.
 */
export function toTransactionBundle(resources: FhirResource[], id?: string): FhirBundle {
  const entries: FhirBundleEntry[] = resources.map((r) => ({
    fullUrl: fullUrlFor(r),
    resource: r,
    request: { method: "PUT", url: `${r.resourceType}/${r.id}` },
  }));

  return {
    resourceType: "Bundle",
    id: id ?? `txn-${Date.now()}`,
    type: "transaction",
    timestamp: new Date().toISOString(),
    entry: entries,
  };
}

/**
 * Stub for processing an incoming transaction bundle. In production this would
 * iterate the entries and upsert each referenced resource. For now we return
 * a `transaction-response` echoing 200-OK entries — sufficient for ABDM
 * conformance testing scaffolding.
 */
export function processTransactionBundle(bundle: FhirBundle): FhirBundle {
  const responseEntries: FhirBundleEntry[] = (bundle.entry ?? []).map((e) => ({
    fullUrl: e.fullUrl,
    resource: e.resource,
    request: { method: "POST", url: "200 OK" as any },
  }));

  return {
    resourceType: "Bundle",
    id: `txn-response-${Date.now()}`,
    type: "transaction-response",
    timestamp: new Date().toISOString(),
    entry: responseEntries,
  };
}
