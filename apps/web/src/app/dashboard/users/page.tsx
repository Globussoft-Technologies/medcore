"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, openPrintEndpoint } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { PasswordInput } from "@/components/PasswordInput";
import { TablePagination } from "@/components/TablePagination";
import {
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Printer,
  Edit2,
  KeyRound,
  Power,
  X,
  Smartphone,
  Users,
  Eye,
  Check,
  Minus,
} from "lucide-react";
import { extractFieldErrors, type FieldErrorMap } from "@/lib/field-errors";
import { Role, sanitizeUserInput } from "@medcore/shared";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { SkeletonTable } from "@/components/Skeleton";

// Issue #190: derive the role list from the shared `Role` enum so adding
// a new role only happens in one place. PATIENT is excluded — patients
// self-register; admins create *staff* here. PHARMACIST + LAB_TECH were
// missing from the prior hardcoded subset which silently blocked those
// staff types.
// Staff-form role choices. PATIENT is excluded (not a staff role).
// SUPER_ADMIN is excluded too — cross-tenant super-admins are invited
// through the dedicated /dashboard/users/new-super-admin page, not the
// inline staff form, so it shouldn't surface here.
const STAFF_ROLE_OPTIONS = (Object.keys(Role) as Array<keyof typeof Role>)
  .filter((r) => r !== "PATIENT" && r !== "SUPER_ADMIN")
  .map((r) => ({
    value: Role[r],
    // Title-case "LAB_TECH" → "Lab Tech".
    label: r
      .split("_")
      .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
      .join(" "),
  }));


interface StaffUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  // Pearl §8.2 — null means the user is a cross-tenant super-admin
  // (either Role.SUPER_ADMIN, or the legacy Role.ADMIN + tenantId=null
  // shape). The role badge surfaces "SUPER ADMIN" for both.
  tenantId?: string | null;
}

// Pearl §8.2 — super-admin roster row returned by
// `GET /api/v1/super-admin/users`. Now includes BOTH Onviqa operators
// (tenantId=null) and tenant super-admins (tenantId set), per the SoW
// "List of super-admins across all tenants" intent.
interface SuperAdminRow {
  id: string;
  name: string;
  email: string | null;
  phone?: string | null;
  isActive: boolean;
  twoFactorEnabled?: boolean;
  createdAt: string;
  permissions?: Record<string, unknown>;
  lastLoginAt?: string | null;
  // Pearl §8.2 — tenant binding. Null for cross-tenant operators;
  // populated for tenant super-admins.
  tenantId?: string | null;
  tenant?: { id: string; name: string; subdomain: string } | null;
  // "onviqa" → cross-tenant operator; "tenant" → tenant super-admin.
  // Drives the row's UI affordances (deactivate is Onviqa-only).
  kind?: "onviqa" | "tenant";
  // Pearl §8.2 — root super-admin. When true, this row cannot be
  // deactivated by anyone; only this user can deactivate other
  // super-admins. UI uses it to disable the action button + show
  // the "Main" badge.
  isMainSuperAdmin?: boolean;
}

const PERMISSION_LABELS: Array<{ key: string; label: string }> = [
  { key: "canManageTenants", label: "Tenants" },
  { key: "canOnboardTenant", label: "Onboard" },
  { key: "canViewBilling", label: "Billing" },
  { key: "canTriggerJobs", label: "Jobs" },
  { key: "canDpdpWorkbench", label: "DPDP" },
  { key: "canViewAudit", label: "Audit" },
];

export default function UsersPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const confirm = useConfirm();
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [staffQuery, setStaffQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  // Issue #991 (UI follow-up): the API treats `address` and
  // `emergencyContact` as `.optional()` for non-PATIENT roles (the
  // server-side gate in /register only fires when role === PATIENT),
  // but the form previously hid them entirely. Exposing them gives
  // the admin a place to capture next-of-kin / postal details at
  // create time without a follow-up edit. Fields are optional, but
  // emergency contact is "all-or-nothing" client-side because the
  // wire schema requires `name` + `phone` + `relationship` together
  // when the object is sent.
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
    role: "DOCTOR",
    address: "",
    emergencyContactName: "",
    emergencyContactPhone: "",
    emergencyContactRelationship: "",
  });
  // Pearl §8.2 — super-admin roster. Only fetched when the current
  // viewer is themselves a super-admin (Role.ADMIN, tenantId=null).
  // Tenant-bound ADMINs never load this data — the API gate would 403
  // anyway, but skipping the fetch avoids a console error.
  // Pearl §8.2 — recognise both shapes: the dedicated SUPER_ADMIN role
  // and the legacy "ADMIN + no tenant" pattern.
  const isSuperAdmin =
    user?.role === "SUPER_ADMIN" ||
    (user?.role === "ADMIN" && (user?.tenantId ?? null) === null);
  const [superAdmins, setSuperAdmins] = useState<SuperAdminRow[]>([]);
  const [superAdminsLoading, setSuperAdminsLoading] = useState(false);
  const [superAdminBusyById, setSuperAdminBusyById] = useState<
    Record<string, boolean>
  >({});
  // Permissions detail modal — set to the row whose Eye button was
  // clicked; null hides the modal. Lets operators see the full grant
  // matrix without overflowing the permissions cell with chips.
  const [permModalRow, setPermModalRow] = useState<SuperAdminRow | null>(null);
  // The caller is the main (root) super-admin when their own row in the
  // loaded roster carries isMainSuperAdmin=true. Page-level platform
  // controls — Add Super-Admin invite + the auto-sign-out config — are
  // gated on this flag so peer super-admins can browse the roster but
  // can't add operators or change the session-timeout policy. False
  // until the roster loads, which is the safe default (hide controls).
  const callerIsMainSuperAdmin = superAdmins.some(
    (r) => r.id === user?.id && r.isMainSuperAdmin === true,
  );
  // Pearl §8.2 — tab toggle between the regular staff table and the
  // cross-tenant Super-Admin roster. Tenant-bound ADMINs only see the
  // "Staff" tab; super-admins see both. Super-Admin invite is now a
  // dedicated page (/dashboard/users/new-super-admin), so the inline
  // create form on this page is staff-only.
  // Read `?tab=super-admins` from the URL so returning from the
  // dedicated invite page lands the operator back on the Super-Admins
  // tab (not Staff). Falls back to "staff" when the param is missing
  // or anything other than "super-admins".
  const searchParams = useSearchParams();
  const initialTab =
    searchParams?.get("tab") === "super-admins" ? "super-admins" : "staff";
  const [activeTab, setActiveTab] = useState<"staff" | "super-admins">(
    initialTab,
  );
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});
  const [submitting, setSubmitting] = useState(false);
  // Issue #286: edit-modal + reset-password state.
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    phone: "",
    role: "DOCTOR",
  });
  const [editError, setEditError] = useState<FieldErrorMap>({});
  const [editSaving, setEditSaving] = useState(false);
  const [resetCode, setResetCode] = useState<{
    email: string;
    code: string;
  } | null>(null);

  // Issue #67: client-side validation BEFORE the request so users get
  // immediate, field-level feedback for the cases the backend silently
  // rejects (weak passwords, non-numeric phone numbers).
  function validateClient(): FieldErrorMap {
    const errs: FieldErrorMap = {};
    // Issue #284: reject HTML/script tags in the staff Full Name BEFORE the
    // request reaches /auth/register. The server denylist is also enforced
    // (see registerSchema's strongPassword + the patch endpoint sanitizer)
    // — this is the early field-level UX hint.
    const nameCheck = sanitizeUserInput(form.name, {
      field: "Full name",
      maxLength: 100,
    });
    if (!nameCheck.ok) {
      errs.name = nameCheck.error || "Full name is required";
    }
    if (!form.email.trim()) errs.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
      errs.email = "Enter a valid email address";
    // Phone: 10–15 digits, optional leading +
    if (!form.phone.trim()) errs.phone = "Phone number is required";
    else if (!/^\+?\d{10,15}$/.test(form.phone.trim()))
      errs.phone = "Phone must be 10–15 digits (optional + prefix)";
    // Password: min 8, at least one letter and one digit
    if (!form.password) errs.password = "Password is required";
    else if (form.password.length < 8)
      errs.password = "Password must be at least 8 characters";
    else if (!/[A-Za-z]/.test(form.password) || !/\d/.test(form.password))
      errs.password = "Password must contain at least one letter and one digit";

    // Issue #991 (UI follow-up): address is optional, but if provided
    // must meet the 5-character floor the server enforces post-parse.
    const addrTrim = form.address.trim();
    if (addrTrim.length > 0 && addrTrim.length < 5) {
      errs.address = "Address must be at least 5 characters";
    } else if (addrTrim.length > 500) {
      errs.address = "Address must be at most 500 characters";
    }

    // Emergency contact: optional, but all-or-nothing. The API's
    // emergencyContactSchema requires name + phone + relationship
    // together; we mirror that here so a half-filled sub-form gets
    // an inline message instead of a 400 round-trip.
    const ecName = form.emergencyContactName.trim();
    const ecPhone = form.emergencyContactPhone.trim();
    const ecRel = form.emergencyContactRelationship.trim();
    const ecAnyFilled = !!(ecName || ecPhone || ecRel);
    if (ecAnyFilled) {
      if (!ecName) errs.emergencyContactName = "Required when any emergency-contact field is filled";
      if (!ecPhone) errs.emergencyContactPhone = "Required when any emergency-contact field is filled";
      else if (!/^\+?\d{10,15}$/.test(ecPhone))
        errs.emergencyContactPhone = "Emergency phone must be 10–15 digits (optional + prefix)";
      if (!ecRel) errs.emergencyContactRelationship = "Required when any emergency-contact field is filled";
    }

    return errs;
  }

  useEffect(() => {
    // Pearl §8.2 — SUPER_ADMIN also has access to user management.
    if (
      user &&
      user.role !== "ADMIN" &&
      user.role !== "SUPER_ADMIN"
    ) {
      router.push("/dashboard");
      return;
    }
    loadUsers();
    if (isSuperAdmin) void loadSuperAdmins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, router, isSuperAdmin]);

  async function loadUsers() {
    setLoading(true);
    try {
      const res = await api.get<{ data: StaffUser[] }>("/users");
      setUsers(res.data);
    } catch {
      // If /users endpoint doesn't exist yet, try to get doctors as a fallback
      try {
        const res = await api.get<{ data: StaffUser[] }>("/doctors");
        setUsers(res.data);
      } catch {
        // empty
      }
    }
    setLoading(false);
  }

  // Pearl §8.2 — load the cross-tenant super-admin roster. Tenant-bound
  // ADMINs would 403 against /super-admin/users (the API enforces the
  // requireSuperAdmin guard), so we only call when isSuperAdmin.
  async function loadSuperAdmins() {
    setSuperAdminsLoading(true);
    try {
      const res = await api.get<{ data: { users: SuperAdminRow[] } }>(
        "/super-admin/users?active=all",
      );
      // Defensive — test stubs may return only `{data: []}` (the staff
      // shape). Default to an empty array so the section still renders
      // a clean empty-state instead of crashing on `.length`.
      setSuperAdmins(Array.isArray(res?.data?.users) ? res.data.users : []);
    } catch {
      setSuperAdmins([]);
    } finally {
      setSuperAdminsLoading(false);
    }
  }

  async function toggleSuperAdminActive(row: SuperAdminRow) {
    if (row.id === user?.id) {
      toast.error("You cannot deactivate yourself");
      return;
    }
    const willDisable = row.isActive;
    const ok = await confirm({
      title: willDisable
        ? `Deactivate ${row.name}?`
        : `Reactivate ${row.name}?`,
      message: willDisable
        ? "This super-admin will no longer be able to sign in."
        : "Re-enables login for this super-admin.",
      danger: willDisable,
    });
    if (!ok) return;
    setSuperAdminBusyById((prev) => ({ ...prev, [row.id]: true }));
    try {
      await api.patch(`/super-admin/users/${row.id}`, {
        active: !willDisable,
      });
      toast.success(willDisable ? "Deactivated" : "Reactivated");
      await loadSuperAdmins();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSuperAdminBusyById((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    }
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    const localErrs = validateClient();
    if (Object.keys(localErrs).length > 0) {
      setFieldErrors(localErrs);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);

    try {
      // This form is staff-only — Super-Admin invites use the dedicated
      // /dashboard/users/new-super-admin page.
      // Issue #991 (UI follow-up): include address + emergencyContact in
      // the wire body only when populated. Both are optional on the
      // /register schema for non-PATIENT roles. The all-or-nothing
      // validator above guarantees we never send a partially-filled
      // emergencyContact object (which the server would reject with a
      // sub-field 400).
      const addrTrim = form.address.trim();
      const ecName = form.emergencyContactName.trim();
      const ecPhone = form.emergencyContactPhone.trim();
      const ecRel = form.emergencyContactRelationship.trim();
      const payload: Record<string, unknown> = {
        name: form.name,
        email: form.email,
        phone: form.phone,
        password: form.password,
        role: form.role,
      };
      if (addrTrim.length >= 5) {
        payload.address = addrTrim;
      }
      if (ecName && ecPhone && ecRel) {
        payload.emergencyContact = {
          name: ecName,
          phone: ecPhone,
          relationship: ecRel,
        };
      }
      await api.post("/auth/register", payload);
      toast.success("User created");
      setShowForm(false);
      setForm({
        name: "",
        email: "",
        phone: "",
        password: "",
        role: "DOCTOR",
        address: "",
        emergencyContactName: "",
        emergencyContactPhone: "",
        emergencyContactRelationship: "",
      });
      loadUsers();
      if (isSuperAdmin) void loadSuperAdmins();
    } catch (err) {
      // Issue #67: surface zod-style backend errors per-field instead of
      // showing a generic "Validation failed" toast.
      // Issue #991 (UI follow-up): the server returns Zod nested paths
      // like "emergencyContact.name" for the sub-fields. Remap those to
      // the flat form keys (emergencyContactName, etc.) so the inline
      // error renders next to the right input.
      const fields = extractFieldErrors(err);
      if (fields) {
        const SERVER_TO_FORM: Record<string, string> = {
          "emergencyContact.name": "emergencyContactName",
          "emergencyContact.phone": "emergencyContactPhone",
          "emergencyContact.relationship": "emergencyContactRelationship",
        };
        const remapped: FieldErrorMap = {};
        for (const [k, v] of Object.entries(fields)) {
          remapped[SERVER_TO_FORM[k] ?? k] = v;
        }
        setFieldErrors(remapped);
        setFormError("");
      } else {
        setFormError(
          err instanceof Error ? err.message : "Failed to create user"
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Issue #286: User Management actions.
  function openEdit(target: StaffUser) {
    setEditing(target);
    setEditForm({
      name: target.name,
      phone: target.phone || "",
      role: target.role,
    });
    setEditError({});
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const errs: FieldErrorMap = {};
    const nameCheck = sanitizeUserInput(editForm.name, {
      field: "Full name",
      maxLength: 100,
    });
    if (!nameCheck.ok) errs.name = nameCheck.error || "Name required";
    if (editForm.phone && !/^\+?\d{10,15}$/.test(editForm.phone.trim())) {
      errs.phone = "Phone must be 10–15 digits (optional + prefix)";
    }
    if (Object.keys(errs).length > 0) {
      setEditError(errs);
      return;
    }
    setEditSaving(true);
    try {
      await api.patch(`/users/${editing.id}`, {
        name: nameCheck.value,
        phone: editForm.phone || undefined,
        role: editForm.role,
      });
      toast.success("User updated");
      setEditing(null);
      loadUsers();
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) setEditError(fields);
      else toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setEditSaving(false);
    }
  }

  async function toggleActive(target: StaffUser) {
    if (target.id === user?.id) {
      toast.error("You cannot disable your own account");
      return;
    }
    const willDisable = target.isActive !== false;
    const ok = await confirm({
      title: willDisable
        ? `Disable ${target.name}?`
        : `Re-enable ${target.name}?`,
      message: willDisable
        ? "Disabled accounts cannot log in but their historical records remain intact."
        : "Re-enables login for this account.",
      danger: willDisable,
    });
    if (!ok) return;
    try {
      await api.patch(`/users/${target.id}`, { isActive: !willDisable });
      toast.success(willDisable ? "User disabled" : "User re-enabled");
      loadUsers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function sendResetPassword(target: StaffUser) {
    const ok = await confirm({
      title: `Send password-reset code to ${target.name}?`,
      message: `A 6-digit reset code valid for 30 minutes will be generated for ${target.email}.`,
    });
    if (!ok) return;
    try {
      const res = await api.post<{
        data: { code: string; email: string; message: string };
      }>(`/users/${target.id}/reset-password`);
      setResetCode({ email: res.data.email, code: res.data.code });
      toast.success("Reset code generated");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to generate reset"
      );
    }
  }

  if (user?.role !== "ADMIN" && user?.role !== "SUPER_ADMIN") return null;

  // Issue #190: include the full Role-enum spectrum so PHARMACIST +
  // LAB_TECH staff don't render as "no badge / grey" in the user list.
  const roleColors: Record<string, string> = {
    ADMIN: "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
    DOCTOR: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    RECEPTION: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
    NURSE: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
    PATIENT: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-200",
    PHARMACIST: "bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300",
    LAB_TECH: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
    // Pearl §8.2 — distinct chip for cross-tenant operators so they're
    // visually different from per-hospital ADMINs.
    SUPER_ADMIN:
      "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  };


  const q = staffQuery.trim().toLowerCase();
  const filteredUsers = q
    ? users.filter((u) =>
        [u.name, u.email, u.phone].some((f) =>
          (f ?? "").toLowerCase().includes(q),
        ),
      )
    : users;
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedUsers = filteredUsers.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 sm:text-2xl">User Management</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {activeTab === "super-admins"
              ? "Manage platform operators with access across all hospital tenants."
              : "Manage staff accounts"}
          </p>
        </div>
        {activeTab === "super-admins" ? (
          // Pearl §8.2 — the Super-Admin invite is a dedicated page, not
          // an inline form. Keeps the roster table visible on this page
          // and the invite form focused on its own URL.
          // Visibility: only the main (root) super-admin can invite new
          // platform operators. Peer super-admins see the roster but no
          // invite affordance — the backend rejects them anyway.
          callerIsMainSuperAdmin ? (
            <Link
              href="/dashboard/users/new-super-admin"
              data-testid="add-super-admin-link"
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark sm:w-auto"
            >
              <Plus size={16} />
              Add Super-Admin
            </Link>
          ) : null
        ) : (
          <button
            onClick={() => setShowForm(!showForm)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark sm:w-auto"
          >
            <Plus size={16} />
            Add Staff User
          </button>
        )}
      </div>

      {/* Pearl §8.2 — tab switcher above the table. Super-admin viewers
          see both tabs; tenant-bound ADMINs see Staff only. When the
          Super-Admins tab is active the role dropdown in the Add form
          should pre-select the synthetic Super-Admin role (handled on
          the button click below). */}
      <div
        role="tablist"
        aria-label="User type"
        data-testid="users-tab-switcher"
        className="mb-6 inline-flex overflow-hidden rounded-lg border border-gray-300 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "staff"}
          data-testid="users-tab-staff"
          onClick={() => {
            setActiveTab("staff");
            // Close the create form so it doesn't leak across tabs.
            setShowForm(false);
          }}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition ${
            activeTab === "staff"
              ? "bg-primary text-white"
              : "bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          }`}
        >
          <Users size={14} aria-hidden="true" />
          Staff
        </button>
        {isSuperAdmin && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "super-admins"}
            data-testid="users-tab-super-admins"
            onClick={() => {
              setActiveTab("super-admins");
              // Close the staff create form when switching to the
              // Super-Admins tab so it doesn't show up under the wrong
              // header. Super-admin invites go through the dedicated
              // /dashboard/users/new-super-admin page anyway.
              setShowForm(false);
            }}
            className={`flex items-center gap-1.5 border-l border-gray-300 px-4 py-2 text-sm font-medium transition dark:border-gray-700 ${
              activeTab === "super-admins"
                ? "bg-primary text-white"
                : "bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            Super-Admins
          </button>
        )}
      </div>

      {/* Create user form — staff-only. Super-admin invites use the
          dedicated /dashboard/users/new-super-admin page. */}
      {showForm && activeTab === "staff" && (
        <form
          onSubmit={handleCreateUser}
          noValidate
          className="mb-6 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800"
        >
          <h2 className="mb-4 font-semibold text-gray-900 dark:text-gray-100">
            Create Staff Account
          </h2>
          {formError && (
            <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-danger dark:bg-red-900/30 dark:text-red-300">
              {formError}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="staff-name"
                className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                data-testid="label-staff-name"
              >
                Full Name
              </label>
              <input
                id="staff-name"
                placeholder="Full Name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                data-testid="staff-name-input"
                aria-invalid={fieldErrors.name ? true : undefined}
              />
              {fieldErrors.name && (
                <p
                  className="mt-1 text-xs text-danger"
                  data-testid="error-name"
                >
                  {fieldErrors.name}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="staff-email"
                className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                data-testid="label-staff-email"
              >
                Email
              </label>
              <input
                id="staff-email"
                type="email"
                placeholder="Email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                data-testid="staff-email-input"
                aria-invalid={fieldErrors.email ? true : undefined}
              />
              {fieldErrors.email && (
                <p
                  className="mt-1 text-xs text-danger"
                  data-testid="error-email"
                >
                  {fieldErrors.email}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="staff-phone"
                className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                data-testid="label-staff-phone"
              >
                Phone Number
              </label>
              <input
                id="staff-phone"
                inputMode="tel"
                placeholder="10-15 digits, e.g. 9876543210"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                data-testid="staff-phone-input"
                aria-invalid={fieldErrors.phone ? true : undefined}
              />
              {fieldErrors.phone && (
                <p
                  className="mt-1 text-xs text-danger"
                  data-testid="error-phone"
                >
                  {fieldErrors.phone}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="staff-password"
                className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                data-testid="label-staff-password"
              >
                Password
              </label>
              <PasswordInput
                id="staff-password"
                placeholder="Password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                data-testid="staff-password-input"
                aria-invalid={fieldErrors.password ? true : undefined}
              />
              {fieldErrors.password ? (
                <p
                  className="mt-1 text-xs text-danger"
                  data-testid="error-password"
                >
                  {fieldErrors.password}
                </p>
              ) : (
                <p
                  className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                  data-testid="password-hint"
                >
                  Min 8 characters, at least one letter and one digit.
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="staff-role"
                className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                data-testid="label-staff-role"
              >
                Role
              </label>
              <select
                id="staff-role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                data-testid="staff-role-input"
              >
                {/* Issue #190: full Role-enum coverage; PHARMACIST +
                    LAB_TECH were dropped from the prior hardcoded list. */}
                {STAFF_ROLE_OPTIONS.map((opt) => (
                  <option
                    key={opt.value}
                    value={opt.value}
                    data-testid={`staff-role-option-${opt.value}`}
                  >
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Issue #991 (UI follow-up): optional Address + Emergency Contact.
              Both are .optional() on the server schema for non-PATIENT
              roles, so the form treats them as optional too. The
              address minimum (5 chars) and the emergency-contact
              all-or-nothing rule mirror the server validation so
              partial input is caught client-side before a round trip. */}
          <div className="mt-6 border-t pt-4 dark:border-slate-700">
            <h3 className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-300">
              Optional details
            </h3>
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              Capture postal + next-of-kin information now, or skip and add
              it later via Edit.
            </p>

            <div className="grid grid-cols-1 gap-4">
              <div>
                <label
                  htmlFor="staff-address"
                  className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                  data-testid="label-staff-address"
                >
                  Address
                  <span className="ml-1 font-normal text-slate-400">(optional)</span>
                </label>
                <textarea
                  id="staff-address"
                  rows={2}
                  placeholder="Street, area, city, PIN"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  data-testid="staff-address-input"
                  aria-invalid={fieldErrors.address ? true : undefined}
                  maxLength={500}
                />
                {fieldErrors.address ? (
                  <p
                    className="mt-1 text-xs text-danger"
                    data-testid="error-address"
                  >
                    {fieldErrors.address}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    If provided, must be 5–500 characters.
                  </p>
                )}
              </div>
            </div>

            <fieldset className="mt-4">
              <legend className="text-xs font-medium text-slate-700 dark:text-slate-300">
                Emergency contact
                <span className="ml-1 font-normal text-slate-400">(optional — all three fields required if any is filled)</span>
              </legend>
              <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="staff-ec-name"
                    className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Name
                  </label>
                  <input
                    id="staff-ec-name"
                    placeholder="Contact name"
                    value={form.emergencyContactName}
                    onChange={(e) =>
                      setForm({ ...form, emergencyContactName: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                    data-testid="staff-ec-name-input"
                    aria-invalid={fieldErrors.emergencyContactName ? true : undefined}
                    maxLength={100}
                  />
                  {fieldErrors.emergencyContactName && (
                    <p
                      className="mt-1 text-xs text-danger"
                      data-testid="error-ec-name"
                    >
                      {fieldErrors.emergencyContactName}
                    </p>
                  )}
                </div>
                <div>
                  <label
                    htmlFor="staff-ec-phone"
                    className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Phone
                  </label>
                  <input
                    id="staff-ec-phone"
                    inputMode="tel"
                    placeholder="10-15 digits"
                    value={form.emergencyContactPhone}
                    onChange={(e) =>
                      setForm({ ...form, emergencyContactPhone: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                    data-testid="staff-ec-phone-input"
                    aria-invalid={fieldErrors.emergencyContactPhone ? true : undefined}
                  />
                  {fieldErrors.emergencyContactPhone && (
                    <p
                      className="mt-1 text-xs text-danger"
                      data-testid="error-ec-phone"
                    >
                      {fieldErrors.emergencyContactPhone}
                    </p>
                  )}
                </div>
                <div>
                  <label
                    htmlFor="staff-ec-rel"
                    className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Relationship
                  </label>
                  <input
                    id="staff-ec-rel"
                    placeholder="e.g. Spouse, Parent"
                    value={form.emergencyContactRelationship}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        emergencyContactRelationship: e.target.value,
                      })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                    data-testid="staff-ec-rel-input"
                    aria-invalid={fieldErrors.emergencyContactRelationship ? true : undefined}
                    maxLength={50}
                  />
                  {fieldErrors.emergencyContactRelationship && (
                    <p
                      className="mt-1 text-xs text-danger"
                      data-testid="error-ec-rel"
                    >
                      {fieldErrors.emergencyContactRelationship}
                    </p>
                  )}
                </div>
              </div>
            </fieldset>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create User"}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Staff table — rendered when the Staff tab is active. */}
      {activeTab === "staff" && (
      <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
        <div className="border-b border-gray-100 p-3 dark:border-gray-700">
          <input
            type="search"
            data-testid="users-search"
            value={staffQuery}
            onChange={(e) => {
              setStaffQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name, email or phone..."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          />
        </div>
        {loading ? (
          <div className="p-4" data-testid="users-loading" aria-busy="true">
            <SkeletonTable rows={5} columns={6} />
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">No users found</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Joined</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pagedUsers.map((u) => (
                <tr key={u.id} className="border-b last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{u.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{u.email}</td>
                  <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{u.phone || "---"}</td>
                  <td className="px-4 py-3">
                    {/* Role is rendered straight from the DB. The
                        icon and color are looked up from the role value
                        so adding a new enum value only requires touching
                        the lookup maps, not the cell itself. */}
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${roleColors[u.role] || "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"}`}
                      data-testid={`user-role-${u.id}`}
                    >
                      {u.role === "SUPER_ADMIN" ? (
                        <ShieldCheck size={12} />
                      ) : u.role === "ADMIN" ? (
                        <ShieldAlert size={12} />
                      ) : (
                        <Shield size={12} />
                      )}
                      {u.role.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        u.isActive !== false
                          ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300"
                          : "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300"
                      }`}
                    >
                      {u.isActive !== false ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {u.createdAt
                      ? new Date(u.createdAt).toLocaleDateString("en-IN")
                      : "---"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        onClick={() => openEdit(u)}
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                        title="Edit this user's details"
                        data-testid={`user-edit-${u.id}`}
                      >
                        <Edit2 size={12} /> Edit
                      </button>
                      <button
                        onClick={() => sendResetPassword(u)}
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                        title="Email a password-reset link to this user"
                        data-testid={`user-reset-${u.id}`}
                      >
                        <KeyRound size={12} /> Reset PW
                      </button>
                      <button
                        onClick={() => toggleActive(u)}
                        disabled={u.id === user?.id}
                        className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:cursor-not-allowed disabled:border-dashed disabled:border-gray-300 disabled:bg-gray-100 disabled:text-gray-400 disabled:opacity-100 disabled:hover:bg-gray-100 dark:disabled:border-gray-700 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 ${
                          u.isActive !== false ? "text-red-600" : "text-green-600"
                        }`}
                        title={
                          u.id === user?.id
                            ? "You can't disable your own account"
                            : u.isActive !== false
                            ? "Disable this user's account"
                            : "Re-enable this user's account"
                        }
                        aria-label={
                          u.id === user?.id
                            ? "You can't disable your own account"
                            : u.isActive !== false
                            ? "Disable this user's account"
                            : "Re-enable this user's account"
                        }
                        data-testid={`user-toggle-${u.id}`}
                      >
                        <Power size={12} />
                        {u.isActive !== false ? "Disable" : "Enable"}
                      </button>
                      <button
                        onClick={() =>
                          openPrintEndpoint(`/users/${u.id}/service-certificate`)
                        }
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                        title="Print a service / experience certificate for this user"
                      >
                        <Printer size={12} /> Cert
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {!loading && users.length > 0 && (
          <TablePagination
            page={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            totalItems={users.length}
            onPageChange={setPage}
            onPageSizeChange={(n) => {
              setPage(1);
              setPageSize(n);
            }}
          />
        )}
      </div>
      )}

      {/* Super-Admin roster — rendered when the Super-Admins tab is
          active AND the viewer is a super-admin. Tenant-bound ADMINs
          never see this tab. The auto-sign-out timer is a platform
          policy knob; only the main super-admin can change it, so
          peers don't get the card at all. */}
      {activeTab === "super-admins" && isSuperAdmin && callerIsMainSuperAdmin && (
        <SuperAdminSessionTimeoutCard />
      )}

      {activeTab === "super-admins" && isSuperAdmin && (
        <div
          data-testid="super-admin-operators-section"
          className="mt-4 rounded-xl bg-white shadow-sm dark:bg-gray-800"
        >
          {superAdminsLoading ? (
            <div className="p-4" aria-busy="true">
              <SkeletonTable rows={3} columns={6} />
            </div>
          ) : superAdmins.length === 0 ? (
            <div
              className="p-8 text-center text-sm text-gray-500 dark:text-gray-400"
              data-testid="super-admin-operators-empty"
            >
              No super-admin operators yet. Click{" "}
              <strong>Add Super-Admin</strong> in the top-right to invite one.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table
                data-testid="super-admin-operators-table"
                className="w-full min-w-[1240px]"
              >
                <thead>
                  <tr className="border-b text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <th className="whitespace-nowrap px-3 py-2.5">Name</th>
                    <th className="whitespace-nowrap px-3 py-2.5">Email</th>
                    <th className="whitespace-nowrap px-3 py-2.5">Tenant</th>
                    <th className="whitespace-nowrap px-3 py-2.5">Role</th>
                    <th className="whitespace-nowrap px-3 py-2.5">2FA</th>
                    <th className="whitespace-nowrap px-3 py-2.5">Permissions</th>
                    <th className="whitespace-nowrap px-3 py-2.5">Status</th>
                    <th className="whitespace-nowrap px-3 py-2.5">Last login</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {superAdmins.map((row) => {
                    const isSelf = row.id === user?.id;
                    const busy = !!superAdminBusyById[row.id];
                    // Pearl §8.2 — the caller is the "main" super-admin
                    // if their row in the loaded list carries
                    // isMainSuperAdmin=true. Reading from the same
                    // payload keeps backend + UI gates in sync.
                    const callerIsMain =
                      superAdmins.find((r) => r.id === user?.id)
                        ?.isMainSuperAdmin === true;
                    // Tenant-bound row = a hospital tenant's local ADMIN.
                    // Any cross-tenant super-admin (main + peer) can
                    // toggle these directly from this page.
                    const rowIsTenantBound =
                      row.kind === "tenant" || !!row.tenantId;
                    // The main-only rule applies only to mutations of
                    // OTHER cross-tenant super-admins. Tenant-admin rows
                    // are exempt — peers can act on them too. The main
                    // row itself is always blocked (its own pill below).
                    const blockedByMainRule =
                      !rowIsTenantBound &&
                      ((!callerIsMain && !isSelf) ||
                        row.isMainSuperAdmin === true);
                    return (
                      <tr
                        key={row.id}
                        data-testid={`super-admin-operator-row-${row.id}`}
                        className="border-b last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50"
                      >
                        <td className="whitespace-nowrap px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                          <span className="inline-flex items-center gap-2">
                            <ShieldCheck
                              size={14}
                              className="text-gray-400"
                              aria-hidden="true"
                            />
                            <span className="truncate">{row.name}</span>
                            {isSelf && (
                              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] uppercase text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                                You
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                          {row.email ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {/* Pearl §8.2 — Tenant column. Onviqa
                              operators (cross-tenant) get a violet
                              "Cross-tenant" pill; tenant super-admins
                              show their hospital name + subdomain. */}
                          {row.kind === "tenant" || row.tenantId ? (
                            <div>
                              <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
                                {row.tenant?.name ?? "—"}
                              </p>
                              {row.tenant?.subdomain && (
                                <p className="font-mono text-[10px] text-gray-400 dark:text-gray-500">
                                  {row.tenant.subdomain}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300"
                              title="Platform operator — access across every hospital tenant"
                            >
                              <ShieldCheck size={12} aria-hidden="true" />
                              Cross-tenant
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {rowIsTenantBound ? (
                            <span
                              className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200"
                              title="Hospital tenant's local admin — full control inside their hospital"
                            >
                              Tenant Admin
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300"
                              title="Platform operator — cross-tenant access. The main super-admin is flagged in the Actions column."
                            >
                              Super-Admin
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {row.twoFactorEnabled ? (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                              <Smartphone size={12} aria-hidden="true" />
                              Enrolled
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                              title="2FA not set up yet — they'll be prompted to enrol on next sign-in"
                            >
                              <KeyRound size={12} aria-hidden="true" />
                              Required
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <button
                            type="button"
                            data-testid={`super-admin-perm-view-${row.id}`}
                            onClick={() => setPermModalRow(row)}
                            title="View this account's permission matrix"
                            aria-label="View permission details"
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-700 transition hover:border-sky-300 hover:bg-sky-100 hover:shadow-sm dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300 dark:hover:border-sky-700 dark:hover:bg-sky-950/60"
                          >
                            <Eye size={12} aria-hidden="true" />
                            View
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {row.isActive ? (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                              Inactive
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                          {row.lastLoginAt
                            ? new Date(row.lastLoginAt).toLocaleDateString(
                                "en-IN",
                                {
                                  day: "2-digit",
                                  month: "short",
                                  year: "numeric",
                                },
                              )
                            : "Never"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {/* Cross-tenant super-admins (main + peers) can
                              toggle tenant-bound hospital admins from
                              this page; only the main super-admin can
                              toggle another cross-tenant super-admin.
                              The main row itself shows a protected pill. */}
                          {!rowIsTenantBound && row.isMainSuperAdmin ? (
                            <span
                              className="inline-flex h-9 min-w-[120px] items-center justify-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-3 text-xs font-semibold text-violet-700"
                              title="Main super-admin — protected, cannot be deactivated"
                            >
                              <ShieldCheck size={12} aria-hidden="true" />
                              Main
                            </span>
                          ) : (
                            <button
                              type="button"
                              data-testid={`super-admin-operator-toggle-${row.id}`}
                              disabled={busy || isSelf || blockedByMainRule}
                              onClick={() => toggleSuperAdminActive(row)}
                              title={
                                isSelf
                                  ? "You can't deactivate your own account"
                                  : blockedByMainRule
                                    ? "Only the main super-admin can change other super-admins' status"
                                    : rowIsTenantBound
                                      ? row.isActive
                                        ? "Deactivate this tenant admin"
                                        : "Reactivate this tenant admin"
                                      : row.isActive
                                        ? "Deactivate this super-admin"
                                        : "Reactivate this super-admin"
                              }
                              className={`inline-flex h-9 min-w-[120px] items-center justify-center gap-1 rounded-md border px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                row.isActive
                                  ? // Active → button is RED (Deactivate is a destructive action)
                                    "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/60"
                                  : // Deactivated → button is GREEN (Reactivate is restorative)
                                    "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/60"
                              }`}
                            >
                              <Power size={12} aria-hidden="true" />
                              {row.isActive ? "Deactivate" : "Reactivate"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Issue #286: Edit modal */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="user-edit-modal"
        >
          <form
            onSubmit={saveEdit}
            noValidate
            className="relative w-full max-h-[90vh] overflow-y-auto max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
          >
            {/* Issue #826: close (X) button so users can dismiss the modal
                without scrolling to the Cancel footer. */}
            <button
              type="button"
              onClick={() => setEditing(null)}
              aria-label="Close"
              data-testid="user-edit-close"
              className="absolute right-3 top-3 rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200"
            >
              <X size={16} />
            </button>
            <h3 className="mb-4 text-lg font-semibold pr-8 dark:text-slate-100">Edit {editing.name}</h3>
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="edit-name"
                  className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Full Name
                </label>
                <input
                  id="edit-name"
                  value={editForm.name}
                  onChange={(e) =>
                    setEditForm({ ...editForm, name: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  data-testid="user-edit-name"
                  aria-invalid={editError.name ? true : undefined}
                />
                {editError.name && (
                  <p
                    className="mt-1 text-xs text-danger"
                    data-testid="user-edit-name-error"
                  >
                    {editError.name}
                  </p>
                )}
              </div>
              {/* Issue #827: surface the user's email as a read-only identity
                  field. The PATCH endpoint does not accept email changes
                  (User.email is the immutable login identifier — see #891),
                  but hiding it from the modal made the list's Email column
                  inconsistent with the editor. Read-only keeps that contract
                  intact while giving the admin the context they expected. */}
              <div>
                <label
                  htmlFor="edit-email"
                  className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Email
                </label>
                <input
                  id="edit-email"
                  type="email"
                  value={editing.email ?? ""}
                  readOnly
                  disabled
                  data-testid="user-edit-email"
                  className="w-full cursor-not-allowed rounded-lg border bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Email is the login identifier and cannot be changed here.
                </p>
              </div>
              <div>
                <label
                  htmlFor="edit-phone"
                  className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Phone
                </label>
                <input
                  id="edit-phone"
                  value={editForm.phone}
                  onChange={(e) =>
                    setEditForm({ ...editForm, phone: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  data-testid="user-edit-phone"
                  aria-invalid={editError.phone ? true : undefined}
                />
                {editError.phone && (
                  <p className="mt-1 text-xs text-danger">{editError.phone}</p>
                )}
              </div>
              <div>
                <label
                  htmlFor="edit-role"
                  className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Role
                </label>
                <select
                  id="edit-role"
                  value={editForm.role}
                  onChange={(e) =>
                    setEditForm({ ...editForm, role: e.target.value })
                  }
                  disabled={editing.id === user?.id}
                  className="w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  data-testid="user-edit-role"
                >
                  {STAFF_ROLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {editing.id === user?.id && (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    You cannot change your own role.
                  </p>
                )}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={editSaving}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
                data-testid="user-edit-save"
              >
                {editSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Issue #286: Reset-password code reveal */}
      {resetCode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="reset-code-modal"
        >
          <div className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">Password Reset Code</h3>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Share this 6-digit code with{" "}
              <span className="font-medium">{resetCode.email}</span>. It
              expires in 30 minutes and is single-use. The user can redeem it
              at /reset-password.
            </p>
            <p
              className="my-4 text-center font-mono text-3xl font-bold tracking-widest text-primary"
              data-testid="reset-code-value"
            >
              {resetCode.code}
            </p>
            <div className="flex justify-end">
              <button
                onClick={() => setResetCode(null)}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
                data-testid="reset-code-close"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {permModalRow &&
        (() => {
          const row = permModalRow;
          const hasPermObj =
            row.permissions && Object.keys(row.permissions).length > 0;
          const grantedKeys = new Set(
            PERMISSION_LABELS.filter(
              (p) => row.permissions?.[p.key] === true,
            ).map((p) => p.key),
          );
          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={(e) => {
                if (e.target === e.currentTarget) setPermModalRow(null);
              }}
              data-testid="super-admin-perm-modal"
            >
              <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-800 sm:max-w-md">
                {/* Header */}
                <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4 dark:border-gray-700">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
                      <Shield size={16} aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {row.name}
                      </p>
                      <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                        {row.email ?? "—"}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPermModalRow(null)}
                    aria-label="Close"
                    className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>

                {/* Body */}
                <div className="px-5 py-4">
                  <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Permission matrix
                  </p>

                  {!hasPermObj ? (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                      <div className="flex items-center gap-2 font-semibold">
                        <Check size={14} aria-hidden="true" />
                        Full platform access
                      </div>
                      <p className="mt-1 text-xs text-emerald-700/90 dark:text-emerald-300/90">
                        No granular grants are configured for this account — every super-admin surface is enabled.
                      </p>
                    </div>
                  ) : grantedKeys.size === 0 ? (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
                      <div className="flex items-center gap-2 font-semibold">
                        <Minus size={14} aria-hidden="true" />
                        No grants
                      </div>
                      <p className="mt-1 text-xs text-rose-700/90 dark:text-rose-300/90">
                        This account can sign in but has no operational scope assigned yet.
                      </p>
                    </div>
                  ) : (
                    <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
                      {PERMISSION_LABELS.map((p) => {
                        const on = grantedKeys.has(p.key);
                        return (
                          <li
                            key={p.key}
                            className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                          >
                            <span className="font-medium text-gray-700 dark:text-gray-200">
                              {p.label}
                            </span>
                            {on ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                                <Check size={11} aria-hidden="true" />
                                Granted
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:bg-gray-700/60 dark:text-gray-400">
                                <Minus size={11} aria-hidden="true" />
                                Not granted
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end border-t border-gray-100 px-5 py-3 dark:border-gray-700">
                  <button
                    type="button"
                    onClick={() => setPermModalRow(null)}
                    className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}

// Pearl §8.2 — operator-facing knob for the global super-admin session
// idle window. Reads + writes /api/v1/super-admin/users/session-idle.
// Allowed range comes from the API so the slider/input stays in sync
// with the server-side clamp.
function SuperAdminSessionTimeoutCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [minutes, setMinutes] = useState<number>(30);
  const [savedMinutes, setSavedMinutes] = useState<number>(30);
  const [limits, setLimits] = useState({ min: 5, max: 1440, default: 30 });
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get<{
        data: { minutes: number; min: number; max: number; default: number };
      }>("/super-admin/users/session-idle");
      setMinutes(res.data.minutes);
      setSavedMinutes(res.data.minutes);
      setLimits({
        min: res.data.min,
        max: res.data.max,
        default: res.data.default,
      });
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to load session-timeout setting");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const dirty = minutes !== savedMinutes;
  const invalid =
    !Number.isFinite(minutes) ||
    minutes < limits.min ||
    minutes > limits.max;

  async function save() {
    if (invalid || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.put<{ data: { minutes: number } }>(
        "/super-admin/users/session-idle",
        { minutes },
      );
      setSavedMinutes(res.data.minutes);
      setMinutes(res.data.minutes);
      toast.success(
        `Super-admin session timeout set to ${res.data.minutes} min`,
      );
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-testid="super-admin-session-timeout-card"
      className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/40 p-4 shadow-sm dark:border-indigo-900/50 dark:bg-indigo-950/20"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
            <KeyRound size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Auto sign-out for super-admins
            </h3>
            <p className="text-xs text-gray-600 dark:text-gray-300">
              Signs idle super-admins out after this many minutes.{" "}
              <span className="text-gray-500 dark:text-gray-400">
                Default {limits.default} · range {limits.min}–{limits.max} min.
              </span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            data-testid="super-admin-session-timeout-input"
            type="number"
            min={limits.min}
            max={limits.max}
            value={Number.isFinite(minutes) ? minutes : ""}
            onChange={(e) => setMinutes(parseInt(e.target.value, 10))}
            disabled={loading || saving}
            className="h-9 w-24 rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
          <span className="text-xs text-gray-600 dark:text-gray-400">min</span>
          <button
            type="button"
            data-testid="super-admin-session-timeout-save"
            disabled={!dirty || invalid || saving || loading}
            onClick={() => void save()}
            className="h-9 rounded-md bg-indigo-600 px-3 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          data-testid="super-admin-session-timeout-error"
          className="mt-2 text-xs text-rose-700 dark:text-rose-300"
        >
          {error}
        </p>
      )}
    </div>
  );
}
