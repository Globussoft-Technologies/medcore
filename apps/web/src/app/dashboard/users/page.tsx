"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, openPrintEndpoint } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { PasswordInput } from "@/components/PasswordInput";
import { TablePagination } from "@/components/TablePagination";
import {
  Plus,
  Shield,
  ShieldAlert,
  Printer,
  Edit2,
  KeyRound,
  Power,
  X,
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
const STAFF_ROLE_OPTIONS = (Object.keys(Role) as Array<keyof typeof Role>)
  .filter((r) => r !== "PATIENT")
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
}

export default function UsersPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const confirm = useConfirm();
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
    role: "DOCTOR",
  });
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
    return errs;
  }

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
      return;
    }
    loadUsers();
  }, [user, router]);

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
      await api.post("/auth/register", {
        name: form.name,
        email: form.email,
        phone: form.phone,
        password: form.password,
        role: form.role,
      });
      setShowForm(false);
      setForm({ name: "", email: "", phone: "", password: "", role: "DOCTOR" });
      loadUsers();
    } catch (err) {
      // Issue #67: surface zod-style backend errors per-field instead of
      // showing a generic "Validation failed" toast.
      const fields = extractFieldErrors(err);
      if (fields) {
        setFieldErrors(fields);
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

  if (user?.role !== "ADMIN") return null;

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
  };

  const totalPages = Math.max(1, Math.ceil(users.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedUsers = users.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">User Management</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Manage staff accounts</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} /> Add Staff User
        </button>
      </div>

      {/* Create user form */}
      {showForm && (
        <form
          onSubmit={handleCreateUser}
          noValidate
          className="mb-6 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800"
        >
          <h2 className="mb-4 font-semibold text-gray-900 dark:text-gray-100">Create Staff Account</h2>
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
              className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Users table */}
      <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
        {loading ? (
          <div className="p-4" data-testid="users-loading" aria-busy="true">
            <SkeletonTable rows={5} columns={6} />
          </div>
        ) : users.length === 0 ? (
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
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${roleColors[u.role] || "bg-gray-100 text-gray-600"}`}
                    >
                      {u.role === "ADMIN" ? (
                        <ShieldAlert size={12} />
                      ) : (
                        <Shield size={12} />
                      )}
                      {u.role}
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
                        title="Edit user"
                        data-testid={`user-edit-${u.id}`}
                      >
                        <Edit2 size={12} /> Edit
                      </button>
                      <button
                        onClick={() => sendResetPassword(u)}
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                        title="Send password reset"
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
                            ? "You cannot disable your own account"
                            : u.isActive !== false
                            ? "Disable account"
                            : "Re-enable account"
                        }
                        aria-label={
                          u.id === user?.id
                            ? "Cannot disable your own account"
                            : u.isActive !== false
                            ? "Disable account"
                            : "Re-enable account"
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
                        title="Service / Experience certificate"
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
                className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
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
    </div>
  );
}
