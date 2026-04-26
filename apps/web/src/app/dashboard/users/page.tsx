"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, openPrintEndpoint } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { PasswordInput } from "@/components/PasswordInput";
import { Plus, Shield, ShieldAlert, Printer } from "lucide-react";
import { extractFieldErrors, type FieldErrorMap } from "@/lib/field-errors";

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
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
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

  // Issue #67: client-side validation BEFORE the request so users get
  // immediate, field-level feedback for the cases the backend silently
  // rejects (weak passwords, non-numeric phone numbers).
  function validateClient(): FieldErrorMap {
    const errs: FieldErrorMap = {};
    if (!form.name.trim()) errs.name = "Full name is required";
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

  if (user?.role !== "ADMIN") return null;

  const roleColors: Record<string, string> = {
    ADMIN: "bg-purple-100 text-purple-700",
    DOCTOR: "bg-blue-100 text-blue-700",
    RECEPTION: "bg-green-100 text-green-700",
    NURSE: "bg-amber-100 text-amber-700",
    PATIENT: "bg-gray-100 text-gray-600",
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">User Management</h1>
          <p className="text-sm text-gray-500">Manage staff accounts</p>
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
          className="mb-6 rounded-xl bg-white p-6 shadow-sm"
        >
          <h2 className="mb-4 font-semibold">Create Staff Account</h2>
          {formError && (
            <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-danger">
              {formError}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="staff-name"
                className="mb-1 block text-xs font-medium text-slate-700"
                data-testid="label-staff-name"
              >
                Full Name
              </label>
              <input
                id="staff-name"
                required
                placeholder="Full Name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
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
                className="mb-1 block text-xs font-medium text-slate-700"
                data-testid="label-staff-email"
              >
                Email
              </label>
              <input
                id="staff-email"
                required
                type="email"
                placeholder="Email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
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
                className="mb-1 block text-xs font-medium text-slate-700"
                data-testid="label-staff-phone"
              >
                Phone Number
              </label>
              <input
                id="staff-phone"
                required
                inputMode="tel"
                pattern="^\+?\d{10,15}$"
                placeholder="10-15 digits, e.g. 9876543210"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
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
                className="mb-1 block text-xs font-medium text-slate-700"
                data-testid="label-staff-password"
              >
                Password
              </label>
              <PasswordInput
                id="staff-password"
                required
                placeholder="Password"
                minLength={8}
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
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
                  className="mt-1 text-xs text-slate-500"
                  data-testid="password-hint"
                >
                  Min 8 characters, at least one letter and one digit.
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="staff-role"
                className="mb-1 block text-xs font-medium text-slate-700"
                data-testid="label-staff-role"
              >
                Role
              </label>
              <select
                id="staff-role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                data-testid="staff-role-input"
              >
                <option value="DOCTOR">Doctor</option>
                <option value="RECEPTION">Reception</option>
                <option value="NURSE">Nurse</option>
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
              className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Users table */}
      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No users found</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
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
              {users.map((u) => (
                <tr key={u.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{u.name}</td>
                  <td className="px-4 py-3 text-sm">{u.email}</td>
                  <td className="px-4 py-3 text-sm">{u.phone || "---"}</td>
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
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {u.isActive !== false ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {u.createdAt
                      ? new Date(u.createdAt).toLocaleDateString("en-IN")
                      : "---"}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() =>
                        openPrintEndpoint(`/users/${u.id}/service-certificate`)
                      }
                      className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      title="Service / Experience certificate"
                    >
                      <Printer size={12} /> Service Cert
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
