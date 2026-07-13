// PM-JAY gateway HTTP helper (BIS / package-master side).
//
// Thin authenticated fetch used by the PM-JAY services (beneficiary, package).
// It delegates the token to `token-manager` and normalises transport failures
// into the same `AdapterResult` shape the claim adapter uses, so callers pattern
// -match on `.ok` uniformly. The claim (TMS) side has its own copy inside
// `adapters/pmjay.ts`; this one is for the non-claim endpoints.

import { PmjayConfig } from "./config";
import { getAccessToken, invalidateToken } from "./token-manager";
import type { AdapterResult } from "../insurance-claims/adapter";

export async function pmjayFetch(
  cfg: PmjayConfig,
  url: string,
  init: { method: string; body?: unknown }
): Promise<AdapterResult<unknown>> {
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    const tok = await getAccessToken(cfg);
    if (!tok.ok) return { ok: false, error: { code: tok.code, message: tok.message } };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${tok.token}`,
          "Content-Type": "application/json",
          ...(cfg.hospitalId ? { "X-Hospital-Id": cfg.hospitalId } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });

      if (resp.status === 401 || resp.status === 403) {
        invalidateToken(cfg);
        if (attempt < cfg.retries) continue;
        return { ok: false, error: { code: "AUTH_FAILED", message: "PM-JAY gateway rejected token" } };
      }
      if (resp.status === 404) {
        return { ok: false, error: { code: "NOT_FOUND", message: "PM-JAY resource not found" } };
      }
      if (resp.status === 429) {
        if (attempt < cfg.retries) continue;
        return { ok: false, error: { code: "RATE_LIMITED", message: "PM-JAY gateway rate-limited" } };
      }
      if (resp.status >= 500) {
        if (attempt < cfg.retries) continue;
        return { ok: false, error: { code: "TPA_UNAVAILABLE", message: `PM-JAY gateway HTTP ${resp.status}` } };
      }
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return {
          ok: false,
          error: {
            code: "BUSINESS_RULE",
            message: (json as { message?: string }).message || `PM-JAY gateway HTTP ${resp.status}`,
            providerRaw: json,
          },
        };
      }
      return { ok: true, data: json };
    } catch (err) {
      if (attempt < cfg.retries) continue;
      return {
        ok: false,
        error: {
          code: "TPA_UNAVAILABLE",
          message: `PM-JAY gateway network error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: { code: "TPA_UNAVAILABLE", message: "PM-JAY gateway unreachable" } };
}
