"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useThemeStore } from "@/lib/theme";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { extractFieldErrors } from "@/lib/field-errors";
import { sanitizeUserInput } from "@medcore/shared";
import { PasswordInput } from "@/components/PasswordInput";
import {
  User as UserIcon,
  Shield,
  Bell,
  SlidersHorizontal,
  Camera,
  Upload,
  Copy,
  Check,
  AlertTriangle,
  LogOut,
} from "lucide-react";

type Tab = "profile" | "security" | "notifications" | "preferences";

interface MeResponse {
  data: {
    id: string;
    email: string;
    name: string;
    phone: string;
    role: string;
    photoUrl?: string | null;
    twoFactorEnabled?: boolean;
    preferredLanguage?: string | null;
    defaultLandingPage?: string | null;
  };
}

interface Preference {
  id?: string;
  channel: "WHATSAPP" | "SMS" | "EMAIL" | "PUSH";
  enabled: boolean;
}

interface FailedLogin {
  id: string;
  createdAt: string;
  ipAddress: string | null;
  details?: { email?: string; reason?: string };
}

interface ScheduleResp {
  data: {
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    dndUntil: string | null;
  } | null;
}

const CHANNELS: Preference["channel"][] = ["WHATSAPP", "SMS", "EMAIL", "PUSH"];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("profile");

  // Read URL hash for tab persistence
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace("#", "") as Tab;
    if (["profile", "security", "notifications", "preferences"].includes(hash)) {
      setTab(hash);
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.location.hash = tab;
  }, [tab]);

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "profile", label: "Profile", icon: UserIcon },
    { id: "security", label: "Security", icon: Shield },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Settings</h1>

      <div className="flex flex-col gap-6 md:flex-row">
        {/* Tabs */}
        <nav className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto rounded-xl bg-white p-2 shadow-sm dark:bg-gray-800 md:w-56 md:flex-col">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={
                "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition " +
                (tab === id
                  ? "bg-primary text-white"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700")
              }
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1">
          {tab === "profile" && <ProfileTab />}
          {tab === "security" && <SecurityTab />}
          {tab === "notifications" && <NotificationsTab />}
          {tab === "preferences" && <PreferencesTab />}
        </div>
      </div>
    </div>
  );
}

// ─── PROFILE ───────────────────────────────────────────

function ProfileTab() {
  const { user, refreshUser } = useAuthStore();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Issue #138: render per-field errors next to the inputs instead of a
  // single toast — matches the patient/surgery forms.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await api.get<MeResponse>("/auth/me");
    setName(res.data.name);
    setPhone(res.data.phone);
    setPhotoUrl(res.data.photoUrl ?? null);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    // Client-side mirror of `updateProfileSchema` — fail fast so we don't
    // round-trip a 400. The API enforces the same regex.
    const errs: Record<string, string> = {};
    // Issues #248, #265 (Apr 2026): the profile Full Name field used to
    // accept raw HTML and `<script>alert("xss")</script>` payloads which
    // then rendered into the sidebar avatar fallback. Reject XSS vectors
    // BEFORE the request reaches /auth/me.
    const nameCheck = sanitizeUserInput(name, {
      field: "Name",
      maxLength: 100,
    });
    if (!nameCheck.ok) errs.name = nameCheck.error || "Name cannot be empty";
    // Issue #392 (Apr 2026): the phone field used to silently accept empty,
    // "abcdefg!@#" and 30-digit numbers. Reject anything that doesn't match
    // the project-wide PHONE_REGEX (10–15 digits, optional leading +).
    // Empty is also rejected — Profile requires a contact phone.
    const trimmedPhone = phone.trim();
    if (!/^\+?\d{10,15}$/.test(trimmedPhone)) {
      errs.phone = "Phone must be 10–15 digits, optional leading +";
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.warning("Please fix the highlighted fields");
      return;
    }
    setSaving(true);
    try {
      await api.patch("/auth/me", {
        name: nameCheck.value,
        phone: trimmedPhone,
        photoUrl,
      });
      toast.success("Profile updated");
      setFieldErrors({});
      await refreshUser();
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) {
        setFieldErrors(fields);
        toast.error(Object.values(fields)[0] || "Save failed");
      } else {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await api.post<{ data: { url?: string; filePath?: string } }>(
        "/uploads",
        {
          filename: file.name,
          base64Content: base64,
          type: "profile_photo",
        }
      );
      const url = res.data.url || res.data.filePath || base64;
      setPhotoUrl(url);
      toast.success("Photo uploaded — click Save");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
      <h2 className="mb-4 text-lg font-semibold">Profile</h2>

      <div className="mb-6 flex items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt="Profile" className="h-full w-full object-cover" />
          ) : (
            <UserIcon size={32} className="text-gray-400" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
          >
            <Upload size={14} /> {uploading ? "Uploading..." : "Upload Photo"}
          </button>
          <button
            onClick={async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                const video = document.createElement("video");
                video.srcObject = stream;
                await video.play();
                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext("2d")?.drawImage(video, 0, 0);
                stream.getTracks().forEach((t) => t.stop());
                const blob = await new Promise<Blob | null>((res) =>
                  canvas.toBlob(res, "image/jpeg", 0.9)
                );
                if (blob) {
                  const f = new File([blob], `webcam-${Date.now()}.jpg`, {
                    type: "image/jpeg",
                  });
                  await handleFile(f);
                }
              } catch {
                toast.error("Could not access webcam");
              }
            }}
            className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
          >
            <Camera size={14} /> Webcam Snapshot
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Full Name">
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (fieldErrors.name) setFieldErrors((p) => ({ ...p, name: "" }));
            }}
            data-testid="profile-name"
            aria-invalid={fieldErrors.name ? "true" : undefined}
            className={
              "w-full rounded-lg border px-3 py-2 dark:bg-gray-900 " +
              (fieldErrors.name
                ? "border-red-500 bg-red-50"
                : "border-gray-300 dark:border-gray-600")
            }
          />
          {fieldErrors.name && (
            <p
              data-testid="error-profile-name"
              className="mt-1 text-xs text-red-600"
            >
              {fieldErrors.name}
            </p>
          )}
        </Field>
        <Field label="Email (read-only)">
          <input
            type="email"
            value={user?.email || ""}
            readOnly
            className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/50"
          />
        </Field>
        <Field label="Phone">
          <input
            type="tel"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              if (fieldErrors.phone) setFieldErrors((p) => ({ ...p, phone: "" }));
            }}
            data-testid="profile-phone"
            aria-invalid={fieldErrors.phone ? "true" : undefined}
            className={
              "w-full rounded-lg border px-3 py-2 dark:bg-gray-900 " +
              (fieldErrors.phone
                ? "border-red-500 bg-red-50"
                : "border-gray-300 dark:border-gray-600")
            }
          />
          {fieldErrors.phone && (
            <p
              data-testid="error-profile-phone"
              className="mt-1 text-xs text-red-600"
            >
              {fieldErrors.phone}
            </p>
          )}
        </Field>
      </div>

      <div className="mt-6 flex justify-end">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
}

// ─── SECURITY ──────────────────────────────────────────

function SecurityTab() {
  const { refreshUser } = useAuthStore();
  const askConfirm = useConfirm();
  const [twoFAEnabled, setTwoFAEnabled] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [otpUri, setOtpUri] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [verifyCode, setVerifyCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [copied, setCopied] = useState(false);

  // Password change
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // Issue #394 (Apr 2026): the change-password form used to swallow the
  // specific zod refine error ("Password must be at least 8 characters",
  // "Password is too common", etc) under a generic "Validation failed"
  // toast. Surface the field-level message inline next to the new-password
  // input so the user knows exactly what to fix.
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>(
    {}
  );

  const [failedLogins, setFailedLogins] = useState<FailedLogin[]>([]);

  const loadAll = useCallback(async () => {
    const me = await api.get<MeResponse>("/auth/me");
    setTwoFAEnabled(!!me.data.twoFactorEnabled);
    try {
      const fl = await api.get<{ data: FailedLogin[] }>("/auth/failed-logins");
      setFailedLogins(fl.data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordErrors({});
    if (newPassword !== confirmPassword) {
      setPasswordErrors({ newPassword: "Passwords do not match" });
      toast.error("Passwords do not match");
      return;
    }
    try {
      await api.post("/auth/change-password", { currentPassword, newPassword });
      toast.success("Password changed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      // Issue #394: pull the per-field zod message out of `payload.details`
      // so we can render the specific reason ("Password must be at least 8
      // characters", "Password is too common — please choose a less
      // predictable password", etc) instead of the top-line "Validation
      // failed". Falls back to the generic Error.message when the API
      // returned a non-validation failure (e.g. wrong current password).
      const fields = extractFieldErrors(err);
      if (fields) {
        setPasswordErrors(fields);
        toast.error(
          fields.newPassword ||
            Object.values(fields)[0] ||
            "Failed to change password"
        );
      } else {
        toast.error(
          err instanceof Error ? err.message : "Failed to change password"
        );
      }
    }
  }

  async function startSetup() {
    try {
      const res = await api.post<{
        data: { secret: string; otpauthUri: string; backupCodes: string[] };
      }>("/auth/2fa/setup");
      setSecret(res.data.secret);
      setOtpUri(res.data.otpauthUri);
      setBackupCodes(res.data.backupCodes);
      setSetupOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Setup failed");
    }
  }

  async function confirmSetup() {
    try {
      await api.post("/auth/2fa/verify", { token: verifyCode });
      toast.success("2FA enabled");
      setTwoFAEnabled(true);
      setVerifyCode("");
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invalid code");
    }
  }

  async function disable2FA() {
    if (!disablePassword) {
      toast.error("Enter your current password");
      return;
    }
    try {
      await api.post("/auth/2fa/disable", { currentPassword: disablePassword });
      toast.success("2FA disabled");
      setTwoFAEnabled(false);
      setSetupOpen(false);
      setDisablePassword("");
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disable");
    }
  }

  async function logoutOthers() {
    if (!(await askConfirm({ title: "Sign out all other sessions?", message: "This will sign out all other sessions.", confirmLabel: "Continue" }))) return;
    try {
      await api.post("/auth/sessions/logout-others");
      toast.success("All other sessions signed out");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="space-y-6">
      {/* Change Password */}
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-semibold">Change Password</h2>
        <form onSubmit={changePassword} className="grid gap-4 md:grid-cols-2">
          <Field label="Current Password">
            <PasswordInput
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            />
          </Field>
          <div />
          <Field label="New Password">
            <PasswordInput
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                if (passwordErrors.newPassword)
                  setPasswordErrors((p) => ({ ...p, newPassword: "" }));
              }}
              required
              minLength={6}
              autoComplete="new-password"
              aria-invalid={passwordErrors.newPassword ? "true" : undefined}
              className={
                "rounded-lg border px-3 py-2 dark:bg-gray-900 " +
                (passwordErrors.newPassword
                  ? "border-red-500 bg-red-50"
                  : "border-gray-300 dark:border-gray-600")
              }
            />
            {passwordErrors.newPassword && (
              <p
                data-testid="error-change-password-newPassword"
                className="mt-1 text-xs text-red-600"
              >
                {passwordErrors.newPassword}
              </p>
            )}
          </Field>
          <Field label="Confirm Password">
            <PasswordInput
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            />
          </Field>
          <div className="md:col-span-2">
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              Update Password
            </button>
          </div>
        </form>
      </div>

      {/* 2FA */}
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-2 text-lg font-semibold">Two-Factor Authentication</h2>
        <p className="mb-4 text-sm text-gray-500">
          Add an extra layer of security with a TOTP authenticator app.
        </p>
        {twoFAEnabled ? (
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm text-green-600">
              <Check size={16} /> 2FA is enabled on your account
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Current Password">
                <PasswordInput
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  autoComplete="current-password"
                  wrapperClassName="relative w-64"
                  className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
                />
              </Field>
              <button
                onClick={disable2FA}
                className="rounded-lg border border-red-500 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                Disable 2FA
              </button>
            </div>
          </div>
        ) : !setupOpen ? (
          <button
            onClick={startSetup}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            Enable 2FA
          </button>
        ) : (
          <div className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <p className="text-sm">
              Scan this with Google Authenticator, Authy, 1Password, or any TOTP app:
            </p>
            <div className="rounded-lg bg-gray-50 p-3 font-mono text-xs break-all dark:bg-gray-900">
              {otpUri}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Secret:</span>
              <code className="rounded bg-gray-100 px-2 py-1 text-xs dark:bg-gray-700">
                {secret}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(secret);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded p-1 hover:bg-gray-200 dark:hover:bg-gray-700"
                title="Copy"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>

            {backupCodes.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium text-amber-600">
                  Save these backup codes — they will only be shown once:
                </p>
                <div className="grid grid-cols-2 gap-2 rounded-lg bg-amber-50 p-3 font-mono text-sm dark:bg-amber-900/20">
                  {backupCodes.map((c) => (
                    <div key={c}>{c}</div>
                  ))}
                </div>
                <button
                  onClick={() => {
                    const blob = new Blob([backupCodes.join("\n")], {
                      type: "text/plain",
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "medcore-backup-codes.txt";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="mt-2 text-xs text-primary hover:underline"
                >
                  Download backup codes
                </button>
              </div>
            )}

            <div className="flex items-end gap-2">
              <Field label="Enter the 6-digit code from your app">
                <input
                  type="text"
                  inputMode="numeric"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  placeholder="123456"
                  className="w-40 rounded-lg border border-gray-300 px-3 py-2 tracking-widest dark:border-gray-600 dark:bg-gray-900"
                />
              </Field>
              <button
                onClick={confirmSetup}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Verify & Enable
              </button>
              <button
                onClick={() => setSetupOpen(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Sessions */}
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-semibold">Active Sessions</h2>
        <div className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Current session</p>
              <p className="text-xs text-gray-500">This browser</p>
            </div>
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
              Active
            </span>
          </div>
        </div>
        <button
          onClick={logoutOthers}
          className="mt-3 flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
        >
          <LogOut size={14} /> Sign out all other sessions
        </button>
      </div>

      {/* Failed login attempts */}
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
          <AlertTriangle size={16} className="text-amber-600" />
          Recent Failed Login Attempts
        </h2>
        {failedLogins.length === 0 ? (
          <p className="text-sm text-gray-500">No failed login attempts recorded.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th className="pb-2">When</th>
                <th className="pb-2">IP</th>
                <th className="pb-2">Email</th>
                <th className="pb-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {failedLogins.map((f) => (
                <tr key={f.id} className="border-t border-gray-100 dark:border-gray-700">
                  <td className="py-2">{new Date(f.createdAt).toLocaleString()}</td>
                  <td className="py-2 font-mono text-xs">{f.ipAddress || "—"}</td>
                  <td className="py-2">{f.details?.email || "—"}</td>
                  <td className="py-2 text-xs text-gray-500">{f.details?.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── NOTIFICATIONS ─────────────────────────────────────

function NotificationsTab() {
  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [savingSched, setSavingSched] = useState(false);

  const load = useCallback(async () => {
    const p = await api.get<{ data: Preference[] }>("/notifications/preferences");
    // ensure all 4 channels
    const map = new Map(p.data.map((x) => [x.channel, x]));
    setPrefs(
      CHANNELS.map((c) => map.get(c) || { channel: c, enabled: true })
    );
    try {
      const s = await api.get<ScheduleResp>("/notifications/schedule");
      setQuietStart(s.data?.quietHoursStart || "");
      setQuietEnd(s.data?.quietHoursEnd || "");
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(channel: Preference["channel"], enabled: boolean) {
    const updated = prefs.map((p) => (p.channel === channel ? { ...p, enabled } : p));
    setPrefs(updated);
    try {
      await api.put("/notifications/preferences", {
        preferences: updated.map((p) => ({ channel: p.channel, enabled: p.enabled })),
      });
      toast.success("Preferences saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  async function saveSchedule() {
    setSavingSched(true);
    try {
      await api.put("/notifications/schedule", {
        quietHoursStart: quietStart || null,
        quietHoursEnd: quietEnd || null,
      });
      toast.success("Quiet hours saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSavingSched(false);
    }
  }

  async function testChannel(channel: string) {
    try {
      await api.post("/notifications/test", { channel });
      toast.success(`Test ${channel} notification queued`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-semibold">Channel Preferences</h2>
        <div className="space-y-3">
          {prefs.map((p) => (
            <div
              key={p.channel}
              className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700"
            >
              <div>
                <p className="text-sm font-medium">{p.channel}</p>
                <p className="text-xs text-gray-500">
                  Receive notifications via {p.channel.toLowerCase()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => testChannel(p.channel)}
                  className="rounded-lg border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
                >
                  Send test
                </button>
                <button
                  onClick={() => toggle(p.channel, !p.enabled)}
                  className={
                    "relative inline-flex h-6 w-11 items-center rounded-full transition " +
                    (p.enabled ? "bg-primary" : "bg-gray-300 dark:bg-gray-600")
                  }
                >
                  <span
                    className={
                      "inline-block h-4 w-4 transform rounded-full bg-white transition " +
                      (p.enabled ? "translate-x-6" : "translate-x-1")
                    }
                  />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-semibold">Quiet Hours</h2>
        <p className="mb-4 text-sm text-gray-500">
          Notifications during these hours will be deferred until quiet hours end.
        </p>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Start (HH:MM)">
            <input
              type="time"
              value={quietStart}
              onChange={(e) => setQuietStart(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            />
          </Field>
          <Field label="End (HH:MM)">
            <input
              type="time"
              value={quietEnd}
              onChange={(e) => setQuietEnd(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            />
          </Field>
          <div className="flex items-end">
            <button
              onClick={saveSchedule}
              disabled={savingSched}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {savingSched ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PREFERENCES ───────────────────────────────────────

function PreferencesTab() {
  const { user, refreshUser } = useAuthStore();
  const themeMode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const [language, setLanguage] = useState<string>("en");
  const [landing, setLanding] = useState<string>("/dashboard");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setLanguage(user.preferredLanguage || "en");
      setLanding(user.defaultLandingPage || "/dashboard");
    }
  }, [user]);

  async function save() {
    setSaving(true);
    try {
      await api.patch("/auth/me", {
        preferredLanguage: language,
        defaultLandingPage: landing,
      });
      if (typeof window !== "undefined") {
        localStorage.setItem("medcore_lang", language);
      }
      toast.success("Preferences saved");
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-semibold">Appearance</h2>
        <Field label="Theme">
          <select
            value={themeMode}
            onChange={(e) => setMode(e.target.value as "light" | "dark" | "system")}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </Field>
      </div>

      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-semibold">Localization & Landing</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Language">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            >
              <option value="en">English</option>
              <option value="hi">हिन्दी (Hindi)</option>
            </select>
          </Field>
          <Field label="Default Landing Page">
            <select
              value={landing}
              onChange={(e) => setLanding(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            >
              <option value="/dashboard">Dashboard</option>
              <option value="/dashboard/appointments">Appointments</option>
              <option value="/dashboard/patients">Patients</option>
              <option value="/dashboard/queue">Queue</option>
              <option value="/dashboard/calendar">Calendar</option>
              <option value="/dashboard/notifications">Notifications</option>
            </select>
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Preferences"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
        {label}
      </span>
      {children}
    </label>
  );
}
