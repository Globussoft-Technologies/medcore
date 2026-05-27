"use client";

/**
 * Invite Super-Admin — Pearl §8.2 (dedicated page).
 *
 * Reached from /dashboard/users (Super-Admins tab) via the
 * "Add Super-Admin" button. Lives on its own URL so the back button
 * dismisses the form and the operator focuses on a single task.
 *
 * Super-admin only — tenant-bound ADMINs get bounced to /dashboard.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  ShieldCheck,
  UserPlus,
  AlertCircle,
  User,
  Smartphone,
  KeySquare,
  Mail,
  Phone,
  Lock,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";

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
    description: "Retry failed crons, manual archival",
  },
  {
    key: "canDpdpWorkbench",
    label: "DPDP workbench",
    description: "Execute right-to-erasure requests",
  },
  {
    key: "canViewAudit",
    label: "View audit trail",
    description: "Read the cross-tenant super-admin audit log",
  },
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?\d{10,15}$/;

export default function DashboardInviteSuperAdminPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const userRole = user?.role;
  const userTenantId = user?.tenantId ?? null;
  const isSuperAdmin =
    userRole === "ADMIN" && userTenantId === null;

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

  // Defeat Chromium credential-autofill so the operator's own login
  // creds don't land in the create-user form.
  const [autofillNonce] = useState(
    () => `nonce-${Math.random().toString(36).slice(2, 10)}`,
  );

  useEffect(() => {
    if (!userRole) return;
    if (!isSuperAdmin) router.replace("/dashboard/users");
  }, [userRole, isSuperAdmin, router]);

  const validation = useMemo<string | null>(() => {
    if (name.trim().length < 2) return "Name must be at least 2 characters";
    if (!EMAIL_REGEX.test(email.trim())) return "Invalid email";
    if (!PHONE_REGEX.test(phone.trim()))
      return "Phone must be 10–15 digits (optional + prefix)";
    if (password.length < 8) return "Password must be at least 8 characters";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password))
      return "Password must contain at least one letter and one digit";
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
      await api.post("/super-admin/users", {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        password,
        requireTwoFactor,
        permissions,
      });
      toast.success("Super-admin invited");
      router.push("/dashboard/users?tab=super-admins");
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 409) {
        setError("A user with this email already exists");
      } else {
        setError(e.message || "Failed to invite");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!isSuperAdmin) return null;

  const grantedCount = Object.values(permissions).filter(Boolean).length;

  return (
    <div
      data-testid="dashboard-invite-super-admin"
      className="mx-auto max-w-4xl"
    >
      {/* Breadcrumb */}
      <Link
        href="/dashboard/users?tab=super-admins"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ArrowLeft size={14} aria-hidden="true" /> Back to Users
      </Link>

      {/* Hero header card with avatar + summary */}
      <div className="mb-6 overflow-hidden rounded-2xl border border-gray-200 bg-gradient-to-br from-indigo-50 via-white to-emerald-50 shadow-sm dark:border-gray-700 dark:from-indigo-950/30 dark:via-gray-800 dark:to-emerald-950/30">
        <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-md">
              <UserPlus size={24} aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                Invite a Super-Admin
              </h1>
              <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-300">
                Adds a platform administrator who can manage every
                hospital tenant on Pearl.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
              <Smartphone size={12} aria-hidden="true" />
              2FA {requireTwoFactor ? "required" : "optional"}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
              <ShieldCheck size={12} aria-hidden="true" />
              {grantedCount}/{PERMISSION_OPTIONS.length} grants
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="invite-error"
          className="mb-6 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* Honeypot inputs eat Chromium's credential autofill */}
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
        <input
          type="text"
          name="fake-username"
          autoComplete="username"
          readOnly
        />
        <input
          type="password"
          name="fake-password"
          autoComplete="current-password"
          readOnly
        />
      </div>

      <div className="space-y-5">
        {/* Identity card */}
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <SectionHeader
            icon={<User size={16} aria-hidden="true" />}
            title="Identity"
            description="Basic profile details. The new user will sign in with this email."
            step={1}
          />
          <div className="grid grid-cols-1 gap-4 p-6 pt-4 sm:grid-cols-2">
            <Field
              label="Full Name"
              icon={<User size={14} aria-hidden="true" />}
            >
              <input
                data-testid="invite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900/40"
                autoComplete="off"
                name={`sa-name-${autofillNonce}`}
              />
            </Field>
            <Field
              label="Email"
              icon={<Mail size={14} aria-hidden="true" />}
            >
              <input
                data-testid="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900/40"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                name={`sa-email-${autofillNonce}`}
              />
            </Field>
            <Field
              label="Phone Number"
              icon={<Phone size={14} aria-hidden="true" />}
              hint="10–15 digits with optional leading +"
            >
              <input
                data-testid="invite-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 9876543210"
                className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900/40"
                inputMode="tel"
                autoComplete="off"
                name={`sa-phone-${autofillNonce}`}
              />
            </Field>
            <Field
              label="Temporary Password"
              icon={<Lock size={14} aria-hidden="true" />}
              hint="Min 8 characters with a letter and a digit. User changes it on first login."
            >
              <div className="relative">
                <input
                  data-testid="invite-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 pr-10 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900/40"
                  autoComplete="new-password"
                  name={`sa-password-${autofillNonce}`}
                />
                <button
                  type="button"
                  data-testid="invite-password-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700"
                  aria-label={
                    showPassword ? "Hide password" : "Show password"
                  }
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </Field>
            <Field
              label="Role"
              icon={<ShieldCheck size={14} aria-hidden="true" />}
              hint="Cross-tenant operator. Cannot be changed."
              fullWidth
            >
              <div
                data-testid="invite-role"
                className="flex h-11 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm font-medium text-gray-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
              >
                <ShieldCheck
                  size={14}
                  className="text-indigo-600 dark:text-indigo-400"
                  aria-hidden="true"
                />
                Super-Admin
              </div>
            </Field>
          </div>
        </section>

        {/* 2FA card */}
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <SectionHeader
            icon={<KeySquare size={16} aria-hidden="true" />}
            title="Two-factor authentication"
            description="Time-based One-Time Password (TOTP) using an authenticator app."
            step={2}
          />
          <div className="p-6 pt-4">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4 transition hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900/40 dark:hover:bg-gray-700/30">
              <input
                type="checkbox"
                data-testid="invite-2fa"
                checked={requireTwoFactor}
                onChange={(e) => setRequireTwoFactor(e.target.checked)}
                className="mt-0.5 h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="flex-1">
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Require TOTP on first login
                </span>
                <span className="mt-1 block text-xs text-gray-600 dark:text-gray-400">
                  Two-factor authentication is required for all super-admin
                  accounts. Keep this enabled unless you are creating a
                  break-glass recovery account.
                </span>
              </span>
            </label>
          </div>
        </section>

        {/* Permission grants card */}
        <section
          data-testid="invite-permissions"
          className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <SectionHeader
            icon={<ShieldCheck size={16} aria-hidden="true" />}
            title="Permission grants"
            description="Select which areas this super-admin can access. Leaving everything unchecked creates a read-only operator."
            step={3}
            badge={`${grantedCount} of ${PERMISSION_OPTIONS.length} selected`}
          />
          <div className="grid grid-cols-1 gap-3 p-6 pt-4 sm:grid-cols-2">
            {PERMISSION_OPTIONS.map((opt) => {
              const checked = permissions[opt.key];
              return (
                <label
                  key={opt.key}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
                    checked
                      ? "border-indigo-400 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950/30"
                      : "border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700/30"
                  }`}
                >
                  <input
                    type="checkbox"
                    data-testid={`invite-perm-${opt.key}`}
                    checked={checked}
                    onChange={(e) =>
                      setPermissions((prev) => ({
                        ...prev,
                        [opt.key]: e.target.checked,
                      }))
                    }
                    className="mt-0.5 h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="flex-1">
                    <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {opt.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-400">
                      {opt.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>
      </div>

      {/* Sticky footer with actions */}
      <div className="sticky bottom-0 z-10 mt-6 -mx-2 rounded-xl border border-gray-200 bg-white/80 px-4 py-3 shadow-lg backdrop-blur dark:border-gray-700 dark:bg-gray-800/80 sm:mx-0">
        <div className="flex items-center justify-between gap-3">
          <p className="hidden text-xs text-gray-500 dark:text-gray-400 sm:block">
            The user will receive these credentials and be prompted to set
            up TOTP on first login.
          </p>
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/users?tab=super-admins"
              className="inline-flex h-11 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-slate-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Cancel
            </Link>
            <button
              type="button"
              data-testid="invite-submit"
              disabled={submitting || !!validation}
              onClick={() => void submit()}
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 disabled:shadow-none dark:disabled:bg-gray-700 dark:disabled:text-gray-500"
            >
              <ShieldCheck size={16} aria-hidden="true" />
              {submitting ? "Inviting…" : "Invite Super-Admin"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Section card header — icon + step number + title + description.
function SectionHeader(props: {
  icon: React.ReactNode;
  title: string;
  description: string;
  step: number;
  badge?: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-6 py-4 dark:border-gray-700">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
          {props.icon}
        </span>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
              Step {props.step}
            </span>
          </div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {props.title}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {props.description}
          </p>
        </div>
      </div>
      {props.badge && (
        <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200">
          {props.badge}
        </span>
      )}
    </div>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  fullWidth?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      className={`block space-y-1.5 ${props.fullWidth ? "sm:col-span-2" : ""}`}
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300">
        {props.icon && (
          <span className="text-gray-400 dark:text-gray-500">{props.icon}</span>
        )}
        {props.label}
      </span>
      {props.children}
      {props.hint && (
        <span className="block text-[11px] text-slate-500 dark:text-slate-400">
          {props.hint}
        </span>
      )}
    </label>
  );
}
