// Super-admin invite form — Pearl ERP Stage 1 §8.2.
//
// Creates a new Onviqa-style super-admin (Role.ADMIN, tenantId = null).
// Captures: name + email + phone + temporary password + 2FA requirement
// + granular permission grants. Submits to POST /api/v1/super-admin/users.
//
// Auth: relies on the /super-admin layout's super-admin gate.

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  ShieldCheck,
  UserPlus,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { csrfFetch } from "@/lib/csrf-fetch";

interface PermissionsState {
  canManageTenants: boolean;
  canOnboardTenant: boolean;
  canViewBilling: boolean;
  canTriggerJobs: boolean;
  canDpdpWorkbench: boolean;
  canViewAudit: boolean;
}

const PERMISSION_OPTIONS: Array<{
  key: keyof PermissionsState;
  label: string;
  description: string;
}> = [
  {
    key: "canManageTenants",
    label: "Manage tenants",
    description: "Create / suspend / restore / archive tenants",
  },
  {
    key: "canOnboardTenant",
    label: "Onboard tenant",
    description: "Run the 8-step tenant onboarding wizard",
  },
  {
    key: "canViewBilling",
    label: "View billing",
    description: "Platform billing dashboards + invoices",
  },
  {
    key: "canTriggerJobs",
    label: "Trigger jobs",
    description: "Retry failed cron tasks, manual archival, etc.",
  },
  {
    key: "canDpdpWorkbench",
    label: "DPDP workbench",
    description: "Execute right-to-erasure requests cross-tenant",
  },
  {
    key: "canViewAudit",
    label: "View audit trail",
    description: "Read the cross-tenant super-admin audit log",
  },
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?\d{7,15}$/;

export default function SuperAdminInvitePage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [requireTwoFactor, setRequireTwoFactor] = useState(true);
  const [permissions, setPermissions] = useState<PermissionsState>({
    canManageTenants: true,
    canOnboardTenant: true,
    canViewBilling: false,
    canTriggerJobs: false,
    canDpdpWorkbench: false,
    canViewAudit: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    id: string;
    name: string;
    email: string | null;
  } | null>(null);

  // Stable nonce keeps Chrome's credential autofill from prefilling the
  // operator's own login email/password into this create-user form.
  const [autofillNonce] = useState(
    () => `nonce-${Math.random().toString(36).slice(2, 10)}`,
  );

  const validation = useMemo<string | null>(() => {
    if (name.trim().length < 2) return "Name must be at least 2 characters";
    if (!EMAIL_REGEX.test(email.trim())) return "Invalid email";
    if (!PHONE_REGEX.test(phone.trim()))
      return "Phone must be 7-15 digits, optional leading +";
    if (password.length < 8) return "Password must be at least 8 characters";
    return null;
  }, [name, email, phone, password]);

  async function submit() {
    if (validation) {
      setError(validation);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await csrfFetch("/api/v1/super-admin/users", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          password,
          requireTwoFactor,
          permissions,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError(body.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setCreated({
        id: body.data.id,
        name: body.data.name,
        email: body.data.email,
      });
    } catch (err) {
      setError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <section
        data-testid="super-admin-invite-success"
        className="mx-auto max-w-2xl space-y-6 py-4"
      >
        <Link
          href="/super-admin/users"
          className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft size={14} aria-hidden="true" /> All super-admins
        </Link>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="text-emerald-600" size={24} aria-hidden="true" />
            <h1 className="text-xl font-semibold text-emerald-900">
              Super-admin invited
            </h1>
          </div>
          <p className="mt-2 text-sm text-emerald-900">
            <strong>{created.name}</strong> (
            <span className="font-mono">{created.email}</span>) can now sign
            in to the Pearl console. They will be prompted to enrol TOTP on
            first login if 2FA was required.
          </p>
          <div className="mt-4 flex gap-2">
            <Link
              href={`/super-admin/users/${created.id}`}
              className="inline-flex h-10 items-center rounded-md bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Open profile
            </Link>
            <Link
              href="/super-admin/users"
              className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Back to list
            </Link>
            <button
              type="button"
              onClick={() => {
                setCreated(null);
                setName("");
                setEmail("");
                setPhone("");
                setPassword("");
              }}
              className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Invite another
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="super-admin-invite"
      className="mx-auto max-w-2xl space-y-6 py-4"
    >
      <Link
        href="/super-admin/users"
        className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft size={14} aria-hidden="true" /> All super-admins
      </Link>

      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <UserPlus size={22} aria-hidden="true" />
          Invite a super-admin
        </h1>
        <p className="text-sm text-slate-600">
          New users get <code>Role.ADMIN</code> with no tenant binding —
          full cross-tenant operator access by default; narrow it with the
          permission toggles below.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          data-testid="super-admin-invite-error"
          className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* Honeypot — eats Chromium's first-pass credential autofill */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-9999px",
          top: "-9999px",
          height: 0,
          width: 0,
          overflow: "hidden",
        }}
      >
        <input type="text" name="fake-username" autoComplete="username" readOnly />
        <input
          type="password"
          name="fake-password"
          autoComplete="current-password"
          readOnly
        />
      </div>

      <fieldset className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <legend className="px-2 text-sm font-semibold text-slate-700">
          Identity
        </legend>
        <Field label="Full name">
          <input
            data-testid="super-admin-invite-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
            autoComplete="off"
            name={`sa-name-${autofillNonce}`}
          />
        </Field>
        <Field label="Email">
          <input
            data-testid="super-admin-invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            name={`sa-email-${autofillNonce}`}
          />
        </Field>
        <Field label="Phone" hint="E.164 format with country code (e.g. +919876543210).">
          <input
            data-testid="super-admin-invite-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
            inputMode="tel"
            autoComplete="off"
            name={`sa-phone-${autofillNonce}`}
          />
        </Field>
        <Field
          label="Temporary password"
          hint="Minimum 8 characters. The user should change this and enrol TOTP on first login."
        >
          <div className="relative">
            <input
              data-testid="super-admin-invite-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 pr-10 text-base focus:border-slate-500 focus:outline-none"
              autoComplete="new-password"
              name={`sa-password-${autofillNonce}`}
            />
            <button
              type="button"
              data-testid="super-admin-invite-password-toggle"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded text-slate-500 hover:bg-slate-100"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </Field>
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <legend className="px-2 text-sm font-semibold text-slate-700">
          Two-factor authentication
        </legend>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            data-testid="super-admin-invite-2fa"
            checked={requireTwoFactor}
            onChange={(e) => setRequireTwoFactor(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            <span className="font-medium text-slate-900">
              Require TOTP on first login
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Pearl §8.2 mandates 2FA for super-admins. Leave checked.
            </span>
          </span>
        </label>
      </fieldset>

      <fieldset
        data-testid="super-admin-invite-permissions"
        className="space-y-3 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <legend className="px-2 text-sm font-semibold text-slate-700">
          Permission grants
        </legend>
        <p className="text-xs text-slate-500">
          Check the surfaces this super-admin can access. Leave all
          unchecked to create a read-only operator.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PERMISSION_OPTIONS.map((opt) => (
            <label
              key={opt.key}
              className="flex items-start gap-3 rounded-md border border-slate-100 px-3 py-2 text-sm hover:bg-slate-50"
            >
              <input
                type="checkbox"
                data-testid={`super-admin-invite-perm-${opt.key}`}
                checked={permissions[opt.key]}
                onChange={(e) =>
                  setPermissions((prev) => ({
                    ...prev,
                    [opt.key]: e.target.checked,
                  }))
                }
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>
                <span className="font-medium text-slate-900">
                  {opt.label}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {opt.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center justify-end gap-2">
        <Link
          href="/super-admin/users"
          className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </Link>
        <button
          type="button"
          data-testid="super-admin-invite-submit"
          disabled={submitting || !!validation}
          onClick={() => void submit()}
          className="inline-flex h-11 items-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ShieldCheck size={14} aria-hidden="true" />
          {submitting ? "Inviting…" : "Invite super-admin"}
        </button>
      </div>
    </section>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-700">{props.label}</span>
      {props.children}
      {props.hint && (
        <span className="block text-[11px] text-slate-500">{props.hint}</span>
      )}
    </label>
  );
}
