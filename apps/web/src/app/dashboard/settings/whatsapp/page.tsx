// Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-i of 4).
// /dashboard/settings/whatsapp — per-tenant WhatsApp provider config.
//
// What / which modules / why:
//   - Translated from `callified/frontend/.../WhatsAppTab.jsx`. Five
//     providers (Gupshup, WATI, AiSensei, Interakt, Meta Cloud) with
//     distinct credential field sets selected by a single dropdown.
//   - Reads + writes /api/v1/wa/config (apps/api/src/routes/whatsapp-config.ts).
//   - ADMIN-only at the page level (role gate via the auth store);
//     server-side authorize(Role.ADMIN) is the actual security boundary.
//   - Mobile-first, h-11 (44px) touch targets per Pearl §6.2.
//   - Secret fields render as type="password" by default with a per-field
//     show/hide toggle so admins can audit what they're saving without
//     leaving the value visible on screen.
//   - Pieces 3j-ii / 3j-iii / 3j-iv add the inbound webhook + reception
//     inbox + reply endpoint respectively.

"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Save, MessageCircle, AlertCircle } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

type Provider = "GUPSHUP" | "WATI" | "AISENSEI" | "INTERAKT" | "META";

interface ConfigResponse {
  data: {
    config: null | {
      id: string;
      provider: Provider;
      credentials: Record<string, string> | null;
      defaultProductId: string | null;
      autoReply: boolean;
      active: boolean;
      plaintextWarning?: boolean;
    };
  };
}

interface ProviderFieldSpec {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
}

const PROVIDER_FIELDS: Record<Provider, ProviderFieldSpec[]> = {
  GUPSHUP: [
    { key: "apiKey", label: "API key", secret: true },
    { key: "appName", label: "App name", secret: false, placeholder: "e.g. hospital_prod" },
    {
      key: "sourcePhone",
      label: "Source phone (E.164)",
      secret: false,
      placeholder: "+919876543210",
    },
  ],
  WATI: [
    { key: "bearerToken", label: "Bearer token", secret: true },
    {
      key: "tenantUrl",
      label: "Tenant URL",
      secret: false,
      placeholder: "https://live-server-xxxx.wati.io",
    },
  ],
  AISENSEI: [
    { key: "apiKey", label: "API key", secret: true },
    {
      key: "baseUrl",
      label: "Base URL",
      secret: false,
      placeholder: "https://app.aisensei.ai",
    },
  ],
  INTERAKT: [
    { key: "apiKey", label: "API key", secret: true },
  ],
  META: [
    { key: "accessToken", label: "Access token", secret: true },
    {
      key: "phoneNumberId",
      label: "Phone number ID",
      secret: false,
      placeholder: "1234567890123456",
    },
    { key: "appSecret", label: "App secret", secret: true },
    { key: "verifyToken", label: "Verify token", secret: true },
  ],
};

const PROVIDER_OPTIONS: Array<{ value: Provider; label: string }> = [
  { value: "GUPSHUP", label: "Gupshup" },
  { value: "WATI", label: "WATI" },
  { value: "AISENSEI", label: "AiSensei" },
  { value: "INTERAKT", label: "Interakt" },
  { value: "META", label: "Meta Cloud API" },
];

export default function WhatsAppSettingsPage() {
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === "ADMIN";

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauth, setUnauth] = useState(false);

  const [provider, setProvider] = useState<Provider>("GUPSHUP");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [defaultProductId, setDefaultProductId] = useState("");
  const [autoReply, setAutoReply] = useState(true);
  const [active, setActive] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [plaintextWarning, setPlaintextWarning] = useState(false);

  const fields = useMemo(() => PROVIDER_FIELDS[provider], [provider]);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = (await api.get<ConfigResponse>("/wa/config")) as ConfigResponse;
        if (cancelled) return;
        const cfg = res.data?.config;
        if (cfg) {
          setProvider(cfg.provider);
          setCreds(
            cfg.credentials
              ? Object.fromEntries(
                  Object.entries(cfg.credentials).map(([k, v]) => [k, String(v ?? "")]),
                )
              : {},
          );
          setDefaultProductId(cfg.defaultProductId ?? "");
          setAutoReply(cfg.autoReply);
          setActive(cfg.active);
          setConfigured(true);
          setPlaintextWarning(!!cfg.plaintextWarning);
        } else {
          setConfigured(false);
        }
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (/401/.test(msg)) {
          setUnauth(true);
        } else {
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  function setCredField(key: string, value: string) {
    setCreds((prev) => ({ ...prev, [key]: value }));
  }

  function changeProvider(next: Provider) {
    setProvider(next);
    // Reset only the cred fields — provider-switch invalidates everything
    // entered for the previous provider. Leave defaultProductId/toggles.
    setCreds({});
    setShowSecret({});
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const body = {
        credentials: { provider, ...creds },
        defaultProductId: defaultProductId.trim() || null,
        autoReply,
        active,
      };
      await api.put("/wa/config", body);
      toast.success("WhatsApp configuration saved");
      setConfigured(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  if (!isAdmin) {
    return (
      <section data-testid="wa-settings-not-allowed" className="space-y-3 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">WhatsApp inbox</h1>
        <p className="text-sm text-slate-600">
          Only tenant admins can configure the WhatsApp provider. Please ask
          your administrator for access.
        </p>
      </section>
    );
  }

  if (unauth) {
    return (
      <section data-testid="wa-settings-unauth" className="space-y-3 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in required</h1>
        <p className="text-sm text-slate-600">
          Your session has expired. Please sign in again to manage the WhatsApp
          provider config.
        </p>
        <a
          href="/login"
          className="inline-flex h-11 min-w-[120px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
          data-testid="wa-settings-signin-cta"
        >
          Go to sign-in
        </a>
      </section>
    );
  }

  return (
    <section data-testid="wa-settings" className="space-y-6 py-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <MessageCircle aria-hidden className="h-6 w-6 text-emerald-600" />
          <h1 className="text-2xl font-semibold tracking-tight">WhatsApp inbox</h1>
        </div>
        <p className="text-sm text-slate-600">
          Configure the provider Pearl uses to send and receive WhatsApp
          messages. Credentials are encrypted at rest.
        </p>
      </header>

      {plaintextWarning ? (
        <div
          role="alert"
          data-testid="wa-settings-plaintext-warning"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-medium">Credentials stored in plaintext</p>
            <p className="mt-0.5">
              WHATSAPP_CREDS_KEY is not set on this deployment. Set the env var
              (64-char hex, AES-256 key) and re-save the config to encrypt at
              rest before going to production.
            </p>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div
          data-testid="wa-settings-loading"
          aria-busy="true"
          className="h-44 animate-pulse rounded-md border border-slate-200 bg-slate-50"
        />
      ) : (
        <div className="space-y-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          {!configured ? (
            <div
              data-testid="wa-settings-empty"
              className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-700"
            >
              <p className="font-medium">WhatsApp not configured yet</p>
              <p className="mt-1 text-slate-600">
                Pick a provider below and paste the credentials your hospital
                received from them. Reply routing + reception inbox light up
                once you save.
              </p>
            </div>
          ) : null}

          {/* Provider dropdown */}
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Provider
            </span>
            <select
              data-testid="wa-settings-provider-select"
              value={provider}
              onChange={(e) => changeProvider(e.target.value as Provider)}
              className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          {/* Per-provider credential fields */}
          <div data-testid="wa-settings-fields" className="space-y-4">
            {fields.map((f) => {
              const visible = showSecret[f.key];
              const inputType = f.secret && !visible ? "password" : "text";
              return (
                <label key={f.key} className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-700">
                    {f.label}
                  </span>
                  <div className="flex items-stretch gap-2">
                    <input
                      data-testid={`wa-settings-field-${f.key}`}
                      type={inputType}
                      autoComplete="off"
                      placeholder={f.placeholder}
                      value={creds[f.key] ?? ""}
                      onChange={(e) => setCredField(f.key, e.target.value)}
                      className="h-11 flex-1 rounded-md border border-slate-300 px-3 text-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                    {f.secret ? (
                      <button
                        type="button"
                        data-testid={`wa-settings-toggle-${f.key}`}
                        onClick={() =>
                          setShowSecret((p) => ({ ...p, [f.key]: !p[f.key] }))
                        }
                        aria-label={visible ? "Hide secret" : "Show secret"}
                        className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-3 hover:bg-slate-50"
                      >
                        {visible ? (
                          <EyeOff aria-hidden className="h-4 w-4" />
                        ) : (
                          <Eye aria-hidden className="h-4 w-4" />
                        )}
                      </button>
                    ) : null}
                  </div>
                </label>
              );
            })}
          </div>

          {/* Misc options */}
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Default product ID
              <span className="ml-1 text-xs font-normal text-slate-500">(optional)</span>
            </span>
            <input
              data-testid="wa-settings-default-product-id"
              type="text"
              value={defaultProductId}
              onChange={(e) => setDefaultProductId(e.target.value)}
              className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </label>

          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="wa-settings-auto-reply"
                checked={autoReply}
                onChange={(e) => setAutoReply(e.target.checked)}
                className="h-5 w-5 rounded border-slate-300"
              />
              <span className="text-sm">Auto-reply (Stage-2 AI agent)</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="wa-settings-active"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="h-5 w-5 rounded border-slate-300"
              />
              <span className="text-sm">Active</span>
            </label>
          </div>

          {error ? (
            <div
              role="alert"
              data-testid="wa-settings-error"
              className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
            >
              {error}
            </div>
          ) : null}

          <div className="flex justify-end">
            <button
              type="button"
              data-testid="wa-settings-save"
              onClick={() => void onSave()}
              disabled={saving}
              className="inline-flex h-11 min-w-[120px] items-center justify-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Save aria-hidden className="h-4 w-4" />
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
