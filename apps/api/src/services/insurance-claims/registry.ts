// Adapter registry — picks the correct TPA adapter for a given provider key.
//
// Tests swap the MOCK adapter in via `setAdapterOverride("MOCK", mockAdapter)`
// or by passing `MOCK` as the tpaProvider value — no need to monkey-patch
// `process.env` mid-test.

import { ClaimsAdapter, TpaProvider } from "./adapter";
import { mediAssistAdapter } from "./adapters/medi-assist";
import { paramountAdapter } from "./adapters/paramount";
import { mockAdapter } from "./adapters/mock";

/** Built-in adapter map. */
const ADAPTERS: Record<TpaProvider, ClaimsAdapter> = {
  MEDI_ASSIST: mediAssistAdapter,
  PARAMOUNT: paramountAdapter,
  MOCK: mockAdapter,
  // Stubs — not yet implemented. They will fall through to the UNKNOWN branch
  // and callers get a clean 501 until someone wires them up.
  VIDAL: mediAssistAdapter, // placeholder: Vidal shares a lot of shape with Medi Assist
  FHPL: mediAssistAdapter, // placeholder
  ICICI_LOMBARD: mediAssistAdapter, // placeholder
  STAR_HEALTH: mediAssistAdapter, // placeholder
};

/**
 * Test hook: override the adapter for a given TPA at runtime. Integration
 * tests use this to force the registry to return the MOCK adapter even when
 * an `Insurance.tpaProvider` column says "MEDI_ASSIST". Production code MUST
 * NOT call this.
 */
const overrides = new Map<TpaProvider, ClaimsAdapter>();

export function setAdapterOverride(
  provider: TpaProvider,
  adapter: ClaimsAdapter
): void {
  overrides.set(provider, adapter);
}

export function clearAdapterOverrides(): void {
  overrides.clear();
}

/** Resolve an adapter by the `Insurance.tpaProvider` column value. */
export function getAdapter(provider: string | null | undefined): ClaimsAdapter {
  const key = (provider || "MOCK").toUpperCase() as TpaProvider;
  const override = overrides.get(key);
  if (override) return override;
  return ADAPTERS[key] ?? mockAdapter;
}

/** For admin / debug routes — list all known providers. */
export function listProviders(): TpaProvider[] {
  return Object.keys(ADAPTERS) as TpaProvider[];
}
