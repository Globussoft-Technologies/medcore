"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useThemeStore } from "@/lib/theme";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { extractFieldErrors } from "@/lib/field-errors";
import { sanitizeUserInput } from "@medcore/shared";
import { PasswordInput } from "@/components/PasswordInput";
import { Skeleton, SkeletonText } from "@/components/Skeleton";
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
  Palette,
  Plug,
  CreditCard,
  MessageCircle,
  Eye,
  EyeOff,
  ArrowLeft,
} from "lucide-react";

// Issues #716/#717 (2026-05-08): admins reported four "ghost" tabs they
// expected to see (Branding, Notifications, Security, Integrations).
// Notifications + Security were already wired on the personal-settings
// surface, but Branding and Integrations were missing entirely. Added
// here as ADMIN-only tabs backed by /api/v1/settings/{branding,integrations}.
type Tab =
  | "profile"
  | "security"
  | "notifications"
  | "preferences"
  | "branding"
  | "integrations"
  | "whatsapp"
  | "payments";

// Issue #437 (Apr 30 2026): Settings page exposed admin-only sections
// (organization profile, user list, billing/integrations) to nurses, leaking
// configuration even if API writes were rejected. Define a per-role allow
// list so the tab list itself is filtered before render — server routes are
// guarded separately. Nurse, Doctor, Reception, Patient see only personal
// settings (profile / security / notifications / preferences). Admin sees
// the full set; org/users/billing surfaces live on dedicated /admin-console
// routes which are RBAC-gated independently — those tabs were never wired
// in here, so the leak was actually that admin-only *future* sections were
// being added to this generic Settings page. Future work: when adding
// Organization/Users/Billing tabs, list them in `ALLOWED_TABS_BY_ROLE.ADMIN`
// only and the per-role filter below will keep them hidden from everyone
// else.
const ALLOWED_TABS_BY_ROLE: Record<string, ReadonlyArray<Tab>> = {
  // Issue #716: ADMIN gets the full set including Branding + Integrations.
  // The two admin-only tabs back onto /api/v1/settings/{branding,integrations}
  // which are themselves ADMIN-gated server-side, so leakage to other roles
  // would only ever produce empty 403 responses anyway — but we filter at
  // the UI layer too so non-admins don't even see the tabs.
  // NOTE: "whatsapp" + "payments" are intentionally NOT listed here. They are
  // TENANT-level credential panels (a hospital's own WhatsApp provider +
  // Razorpay account) and must be hidden from the platform super-admin, who is
  // a tenant-less ADMIN (role coerced to ADMIN with tenantId == null — see
  // lib/store coerceUser). The component appends those two tabs only when the
  // caller is a real tenant admin (ADMIN with a tenantId). See `allowed` below.
  ADMIN: [
    "profile",
    "security",
    "notifications",
    "preferences",
    "branding",
    "integrations",
  ],
  DOCTOR: ["profile", "security", "notifications", "preferences"],
  NURSE: ["profile", "security", "notifications", "preferences"],
  RECEPTION: ["profile", "security", "notifications", "preferences"],
  PATIENT: ["profile", "security", "notifications", "preferences"],
  // Default for any role we haven't enumerated — restrict to personal
  // settings only. If a new role is introduced, its admin-only access must
  // be explicitly granted here.
  __DEFAULT__: ["profile", "security", "notifications", "preferences"],
};

function allowedTabsForRole(role: string | undefined): ReadonlyArray<Tab> {
  if (!role) return ALLOWED_TABS_BY_ROLE.__DEFAULT__;
  return ALLOWED_TABS_BY_ROLE[role] || ALLOWED_TABS_BY_ROLE.__DEFAULT__;
}


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

// Issue #874: the API emits raw snake_case enum values for `details.reason`
// (e.g. "bad_password", "user_not_found_or_inactive"). Showing those in a
// patient-facing security audit log leaks internal naming and looks
// unfinished. Map known values to human-readable copy; unknown values fall
// back to a title-cased version so a newly-added backend reason still
// renders sensibly without a deploy lock-step.
function formatLoginFailureReason(raw: string | undefined): string {
  if (!raw) return "—";
  const KNOWN: Record<string, string> = {
    bad_password: "Incorrect password",
    user_not_found_or_inactive: "Account not found or inactive",
    tenant_deactivated: "Organisation account is deactivated",
  };
  if (KNOWN[raw]) return KNOWN[raw];
  // Fallback: snake_case → Title Case so a future backend enum we haven't
  // mapped yet still reads like English instead of leaking the raw value.
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface ScheduleResp {
  data: {
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    dndUntil: string | null;
  } | null;
}

const CHANNELS: Preference["channel"][] = ["WHATSAPP", "SMS", "EMAIL", "PUSH"];

// Issue #873: the API stores channels as upper-snake enums (WHATSAPP, SMS,
// EMAIL, PUSH) but the UI cards were rendering the title as raw enum and the
// body as `.toLowerCase()` — producing "WHATSAPP" / "via whatsapp" instead of
// "WhatsApp" / "via WhatsApp". Centralise the enum→display mapping so both
// halves of the card stay in sync. SMS/PUSH/EMAIL keep their natural casing
// (SMS is an initialism, EMAIL is just "Email", PUSH is "Push"). WhatsApp is
// the only branded one that needs explicit mixed-casing.
const CHANNEL_LABEL: Record<Preference["channel"], string> = {
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  EMAIL: "Email",
  PUSH: "Push",
};

export default function SettingsPage() {
  // Issue #437: read role first so the default tab is always one the user
  // is actually allowed to see — protects against deep links to e.g.
  // #organization that should never render for a nurse.
  const { user } = useAuthStore();
  // WhatsApp + Payments are per-hospital credential panels. Only a real tenant
  // admin should see them — the platform super-admin is a tenant-less ADMIN
  // (tenantId == null; see lib/store coerceUser) and manages tenant creds via
  // the super-admin surfaces instead, so we withhold both tabs from them.
  const isTenantAdmin = user?.role === "ADMIN" && !!user?.tenantId;
  const allowed: ReadonlyArray<Tab> = isTenantAdmin
    ? [...allowedTabsForRole(user?.role), "whatsapp", "payments"]
    : allowedTabsForRole(user?.role);
  const [tab, setTab] = useState<Tab>("profile");

  // When the admin arrived here from the tenant onboarding checklist (its
  // "Open WhatsApp / payment settings" buttons append ?from=onboarding), show
  // a link back to their onboarding page so they can continue the checklist
  // after saving credentials. The onboarding route is keyed by the caller's
  // own tenantId; fall back to the dashboard if it's somehow absent.
  const searchParams = useSearchParams();
  const fromOnboarding = searchParams?.get("from") === "onboarding";
  const onboardingHref = user?.tenantId
    ? `/dashboard/tenants/${user.tenantId}/onboarding`
    : "/dashboard";

  // Read the deep-link hash into the active tab — the ONLY thing that drives
  // the tab from the URL. There is deliberately NO effect mirroring tab → hash:
  // that mirror was racing this reader and, on a deep load of `#whatsapp`, wrote
  // the default `#profile` back into the URL in the same commit — so the
  // onboarding "Open WhatsApp settings" / "Open payment settings" deep links
  // always bounced to Profile. The hash is now written ONLY on an explicit tab
  // click (see selectTab), so nothing competes with this reader.
  //
  // Runs on mount and again whenever role/tenantId changes, because the
  // WhatsApp + Payments tabs only enter `allowed` once tenant-admin status is
  // known — a `#whatsapp` deep link must re-resolve after the store hydrates.
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;
    const hash = window.location.hash.replace("#", "") as Tab;
    // Issue #437: only honour the hash if the role is allowed to access it, so
    // a nurse deep-linking `#branding` just stays on the default tab.
    if (hash && allowed.includes(hash)) setTab(hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role, user?.tenantId]);

  // Explicit tab selection: update state AND the URL hash together.
  // replaceState keeps the URL shareable without pushing a history entry or
  // triggering the browser's hash-scroll jump.
  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${next}`);
    }
  }, []);

  const allTabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "profile", label: "Profile", icon: UserIcon },
    { id: "security", label: "Security", icon: Shield },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
    // Issues #716/#717: admin-only — filtered out for everyone else by
    // the per-role allowlist above.
    { id: "branding", label: "Branding", icon: Palette },
    { id: "integrations", label: "Integrations", icon: Plug },
    { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
    { id: "payments", label: "Payments", icon: CreditCard },
  ];
  // Issue #437: filter the visible tab list down to what this role is
  // allowed to interact with. Hiding the tab in the nav AND skipping the
  // content render below is the UI-layer half of the RBAC fix; routes that
  // back the tabs (e.g. `/auth/me`, `/notifications/preferences`) are
  // already role-gated server-side.
  const tabs = allTabs.filter((t) => allowed.includes(t.id));

  return (
    <div>
      {fromOnboarding && (
        <Link
          href={onboardingHref}
          data-testid="settings-back-to-onboarding"
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft size={16} /> Back to onboarding
        </Link>
      )}
      <h1 className="mb-6 text-2xl font-bold">Settings</h1>

      <div className="flex flex-col gap-6 md:flex-row">
        {/* Tabs */}
        <nav className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto rounded-xl bg-white p-2 shadow-sm dark:bg-gray-800 md:w-56 md:flex-col">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => selectTab(id)}
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
          {/* Issue #437: belt-and-braces — even if `tab` somehow ends up at a
              value the role isn't allowed (manual setState during dev,
              stale URL fragment), we still gate each tab's render. */}
          {tab === "profile" && allowed.includes("profile") && <ProfileTab />}
          {tab === "security" && allowed.includes("security") && <SecurityTab />}
          {tab === "notifications" && allowed.includes("notifications") && (
            <NotificationsTab />
          )}
          {tab === "preferences" && allowed.includes("preferences") && (
            <PreferencesTab />
          )}
          {tab === "branding" && allowed.includes("branding") && <BrandingTab />}
          {tab === "integrations" &&
            allowed.includes("integrations") && <IntegrationsTab />}
          {tab === "whatsapp" && allowed.includes("whatsapp") && <WhatsAppTab />}
          {tab === "payments" && allowed.includes("payments") && <PaymentsTab />}
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
  // `photoUrl` is the DISPLAY value (resolved signed URL / data URL) shown
  // in the <img>. `pendingPhotoKey` is the stable storage KEY from a fresh
  // upload that we PATCH to User.photoUrl on save — null means "photo not
  // changed", so save() leaves the stored photo untouched.
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [pendingPhotoKey, setPendingPhotoKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Issue #138: render per-field errors next to the inputs instead of a
  // single toast — matches the patient/surgery forms.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    // Issue #415 (Apr 2026, cluster D): if /auth/me errors out (500, network
    // drop, etc) we still want the Settings shell to render — the user can
    // switch tabs and the heading/nav must stay mounted. Swallow the load
    // failure and fall through with empty fields. The page-level wrapper
    // doesn't need an error UI here; sibling pages (patients, etc) follow
    // the same `try { ... } catch { /* empty */ }` convention for tab loads.
    try {
      const res = await api.get<MeResponse>("/auth/me");
      setName(res.data.name);
      setPhone(res.data.phone);
      setPhotoUrl(res.data.photoUrl ?? null);
    } catch {
      // ignore — keep tab rendered with default empty fields
    }
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
        // Only send the photo when it changed this session — PATCH the
        // stable KEY, never the resolved/expiring display URL. Omitting it
        // leaves the stored photo as-is.
        ...(pendingPhotoKey !== null ? { photoUrl: pendingPhotoKey } : {}),
      });
      setPendingPhotoKey(null);
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
      // Issue #665: the upload route returns `signedUrl` (the field is
      // generated by `getSignedDownloadUrl(stored.key)` in
      // apps/api/src/routes/uploads.ts:203). The previous code read
      // `res.data.url` (which doesn't exist) and fell through to
      // `res.data.filePath` — the raw S3 key, which the browser can't
      // load directly — so the avatar rendered as a broken image. Read
      // the right field, but keep the legacy fallbacks for any older
      // server build still on the wire.
      // Non-medical upload (no `type`/`patientId`) so the endpoint accepts
      // the image and returns a stable storage KEY (filePath) plus a
      // short-lived signedUrl. We PATCH the stable KEY to User.photoUrl
      // (it survives expiry — GET /auth/me resolves a fresh signed URL on
      // read), and show the signedUrl only as the immediate preview.
      const res = await api.post<{
        data: { signedUrl?: string; filePath?: string };
      }>("/uploads", {
        filename: file.name,
        base64Content: base64,
      });
      setPendingPhotoKey(res.data.filePath || base64);
      setPhotoUrl(res.data.signedUrl || base64);
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
                ? "border-red-500 bg-red-50 dark:bg-red-900/20"
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
                ? "border-red-500 bg-red-50 dark:bg-red-900/20"
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
    if (!currentPassword) {
      setPasswordErrors({ currentPassword: "Current password is required" });
      toast.error("Current password is required");
      return;
    }
    if (!newPassword) {
      setPasswordErrors({ newPassword: "New password is required" });
      toast.error("New password is required");
      return;
    }
    if (newPassword.length < 6) {
      setPasswordErrors({ newPassword: "Password must be at least 6 characters" });
      toast.error("Password must be at least 6 characters");
      return;
    }
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
        <form onSubmit={changePassword} noValidate className="grid gap-4 md:grid-cols-2">
          <Field label="Current Password">
            <PasswordInput
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
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
              autoComplete="new-password"
              aria-invalid={passwordErrors.newPassword ? "true" : undefined}
              className={
                "rounded-lg border px-3 py-2 dark:bg-gray-900 " +
                (passwordErrors.newPassword
                  ? "border-red-500 bg-red-50 dark:bg-red-900/20"
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
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Add an extra layer of security with a TOTP authenticator app.
        </p>
        {twoFAEnabled ? (
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
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
              <span className="text-xs text-gray-500 dark:text-gray-400">Secret:</span>
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
              <p className="text-xs text-gray-500 dark:text-gray-400">This browser</p>
            </div>
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-300">
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
          <p className="text-sm text-gray-500 dark:text-gray-400">No failed login attempts recorded.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500 dark:text-gray-400">
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
                  <td className="py-2 text-xs text-gray-700 dark:text-gray-200">
                    {formatLoginFailureReason(f.details?.reason)}
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

// ─── NOTIFICATIONS ─────────────────────────────────────

function NotificationsTab() {
  const askConfirm = useConfirm();
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
      // Issue #658: previously fired "Preferences saved" — users
      // reported that toggling a single channel returned a vague
      // confirmation that didn't name what changed. Per-channel
      // wording surfaces the specific update.
      toast.success(
        `${enabled ? "Enabled" : "Disabled"} ${CHANNEL_LABEL[channel]} notifications`,
      );
    } catch {
      toast.error("Failed to save notification preference");
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
    // Issue #940: the "Send test" button fired immediately on click with no
    // confirmation, which let a stray click send a real (potentially SMS or
    // WhatsApp-charged) test message. Gate it behind the in-app confirm dialog
    // (not the native browser confirm) so it matches the rest of the UI. The
    // label uses the same friendly map the success toast does so the prompt
    // and the toast read consistently.
    const label =
      CHANNEL_LABEL[channel as Preference["channel"]] ?? channel;
    const ok = await askConfirm({
      title: `Send a test ${label} notification?`,
      message: `A real test message will be sent via ${label} to your registered contact.`,
      confirmLabel: "Send test",
    });
    if (!ok) return;
    try {
      await api.post("/notifications/test", { channel });
      // Issue #873 continued: the toast renders the friendly label (set
      // above) instead of the raw enum so it reads cleanly.
      toast.success(`Test ${label} notification queued`);
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
                <p className="text-sm font-medium">{CHANNEL_LABEL[p.channel]}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Receive notifications via {CHANNEL_LABEL[p.channel]}
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
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
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

// ─── BRANDING ──────────────────────────────────────────
//
// Issues #716 / #717 (2026-05-08): the General/Branding panel was the one
// admins reported as "missing tabs" + "saves blank Hospital Name". Both
// land on the same tab here. Hospital Name is required client-side
// (mirrors the Zod refine on PATCH /api/v1/settings/branding) so the user
// gets an inline error instead of a silent blank save.

interface BrandingResponse {
  data: {
    hospitalName: string;
    primaryColor: string;
    logoUrl: string;
    hospitalPhone?: string;
    hospitalEmail?: string;
    hospitalGstin?: string;
    hospitalAddress?: string;
  };
}

function BrandingTab() {
  const [hospitalName, setHospitalName] = useState("");
  const [primaryColor, setPrimaryColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [hospitalPhone, setHospitalPhone] = useState("");
  const [hospitalEmail, setHospitalEmail] = useState("");
  const [hospitalGstin, setHospitalGstin] = useState("");
  const [hospitalAddress, setHospitalAddress] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<BrandingResponse>("/settings/branding");
        setHospitalName(res.data.hospitalName || "");
        setPrimaryColor(res.data.primaryColor || "");
        setLogoUrl(res.data.logoUrl || "");
        setHospitalPhone(res.data.hospitalPhone || "");
        setHospitalEmail(res.data.hospitalEmail || "");
        setHospitalGstin(res.data.hospitalGstin || "");
        setHospitalAddress(res.data.hospitalAddress || "");
      } catch {
        // Ignore — keep the panel rendered with empty fields so the admin
        // can populate from scratch.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save() {
    // Issue #717: Hospital Name silently saved blank — reject empty
    // BEFORE the request. Mirrors the server-side `min(1)` refine.
    const errs: Record<string, string> = {};
    if (!hospitalName.trim()) {
      errs.hospitalName = "Hospital Name is required";
    } else if (hospitalName.trim().length > 200) {
      errs.hospitalName = "Hospital Name must be 200 characters or fewer";
    }
    if (
      primaryColor.trim().length > 0 &&
      !/^#[0-9a-fA-F]{6}$/.test(primaryColor.trim())
    ) {
      errs.primaryColor = "Primary color must be a hex like #1e40af";
    }
    if (
      hospitalEmail.trim().length > 0 &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hospitalEmail.trim())
    ) {
      errs.hospitalEmail = "Enter a valid email address";
    }
    if (
      hospitalGstin.trim().length > 0 &&
      !/^[0-9A-Za-z]{15}$/.test(hospitalGstin.trim())
    ) {
      errs.hospitalGstin = "GSTIN must be 15 letters/digits";
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.warning("Please fix the highlighted fields");
      return;
    }
    setSaving(true);
    try {
      await api.patch("/settings/branding", {
        hospitalName: hospitalName.trim(),
        primaryColor: primaryColor.trim() || undefined,
        logoUrl: logoUrl.trim() || undefined,
        // Send these unconditionally (trimmed) so clearing a field persists.
        hospitalPhone: hospitalPhone.trim(),
        hospitalEmail: hospitalEmail.trim(),
        hospitalGstin: hospitalGstin.trim().toUpperCase(),
        hospitalAddress: hospitalAddress.trim(),
      });
      toast.success("Branding saved");
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

  if (loading) {
    return (
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <Skeleton variant="text" width="30%" height={20} className="mb-2" />
        <Skeleton variant="text" width="60%" className="mb-4" />
        <div className="grid gap-6 md:grid-cols-2">
          <SkeletonText lines={2} />
          <SkeletonText lines={2} />
          <SkeletonText lines={2} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
      <h2 className="mb-1 text-lg font-semibold">Branding</h2>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        Hospital identity used across the dashboard, PDFs and notifications.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Hospital Name (required)">
          <input
            type="text"
            value={hospitalName}
            onChange={(e) => {
              setHospitalName(e.target.value);
              if (fieldErrors.hospitalName)
                setFieldErrors((p) => ({ ...p, hospitalName: "" }));
            }}
            data-testid="branding-hospital-name"
            aria-invalid={fieldErrors.hospitalName ? "true" : undefined}
            className={
              "w-full rounded-lg border px-3 py-2 dark:bg-gray-900 " +
              (fieldErrors.hospitalName
                ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                : "border-gray-300 dark:border-gray-600")
            }
          />
          {fieldErrors.hospitalName && (
            <p
              data-testid="error-branding-hospital-name"
              className="mt-1 text-xs text-red-600"
            >
              {fieldErrors.hospitalName}
            </p>
          )}
        </Field>
        <Field label="Primary Color (hex like #1e40af)">
          <input
            type="text"
            value={primaryColor}
            onChange={(e) => {
              setPrimaryColor(e.target.value);
              if (fieldErrors.primaryColor)
                setFieldErrors((p) => ({ ...p, primaryColor: "" }));
            }}
            placeholder="#1e40af"
            data-testid="branding-primary-color"
            aria-invalid={fieldErrors.primaryColor ? "true" : undefined}
            className={
              "w-full rounded-lg border px-3 py-2 dark:bg-gray-900 " +
              (fieldErrors.primaryColor
                ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                : "border-gray-300 dark:border-gray-600")
            }
          />
          {fieldErrors.primaryColor && (
            <p className="mt-1 text-xs text-red-600">
              {fieldErrors.primaryColor}
            </p>
          )}
        </Field>
        <Field label="Logo URL">
          <input
            type="text"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
          />
        </Field>
      </div>

      {/* Hospital contact / legal details — rendered on invoices,
          prescriptions and receipts. */}
      <div className="mt-6 border-t border-gray-100 pt-5 dark:border-gray-700">
        <h3 className="mb-1 text-sm font-semibold">Hospital details</h3>
        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
          Contact &amp; legal info shown on invoices, prescriptions and receipts.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Phone">
            <input
              type="tel"
              value={hospitalPhone}
              onChange={(e) => setHospitalPhone(e.target.value)}
              placeholder="+91 98765 43210"
              data-testid="branding-hospital-phone"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={hospitalEmail}
              onChange={(e) => {
                setHospitalEmail(e.target.value);
                if (fieldErrors.hospitalEmail)
                  setFieldErrors((p) => ({ ...p, hospitalEmail: "" }));
              }}
              placeholder="hello@hospital.in"
              data-testid="branding-hospital-email"
              aria-invalid={fieldErrors.hospitalEmail ? "true" : undefined}
              className={
                "w-full rounded-lg border px-3 py-2 dark:bg-gray-900 " +
                (fieldErrors.hospitalEmail
                  ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                  : "border-gray-300 dark:border-gray-600")
              }
            />
            {fieldErrors.hospitalEmail && (
              <p className="mt-1 text-xs text-red-600">{fieldErrors.hospitalEmail}</p>
            )}
          </Field>
          <Field label="GSTIN">
            <input
              type="text"
              value={hospitalGstin}
              onChange={(e) => {
                setHospitalGstin(e.target.value.toUpperCase());
                if (fieldErrors.hospitalGstin)
                  setFieldErrors((p) => ({ ...p, hospitalGstin: "" }));
              }}
              placeholder="22AAAAA0000A1Z5"
              maxLength={15}
              data-testid="branding-hospital-gstin"
              aria-invalid={fieldErrors.hospitalGstin ? "true" : undefined}
              className={
                "w-full rounded-lg border px-3 py-2 uppercase dark:bg-gray-900 " +
                (fieldErrors.hospitalGstin
                  ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                  : "border-gray-300 dark:border-gray-600")
              }
            />
            {fieldErrors.hospitalGstin && (
              <p className="mt-1 text-xs text-red-600">{fieldErrors.hospitalGstin}</p>
            )}
          </Field>
          <Field label="Address">
            <textarea
              value={hospitalAddress}
              onChange={(e) => setHospitalAddress(e.target.value)}
              rows={2}
              placeholder="Street, City, State, PIN"
              data-testid="branding-hospital-address"
              className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            />
          </Field>
        </div>
      </div>

      <div className="mt-6 flex justify-end">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save Branding"}
        </button>
      </div>
    </div>
  );
}

// ─── INTEGRATIONS ──────────────────────────────────────
//
// Issue #716: surface the per-integration on/off toggles. The actual
// credentials are managed via env vars + tenant-scoped SystemConfig writes
// (handled out-of-band for now); this UI only exposes the enable flag and
// a "configured?" indicator so admins can tell whether the wiring is in
// place. Toggling persists to /api/v1/settings/integrations.

interface IntegrationRow {
  key: string;
  enabled: boolean;
  configured: boolean;
}

interface IntegrationsResponse {
  data: { integrations: IntegrationRow[] };
}

const INTEGRATION_LABELS: Record<string, string> = {
  sendgrid: "SendGrid (email)",
  twilio: "Twilio (SMS / WhatsApp)",
  razorpay: "Razorpay (payments)",
  abdm: "ABDM (national health stack)",
  fhir: "FHIR R4 export",
  hl7v2: "HL7 v2 messaging",
  sentry: "Sentry (error tracking)",
};

function IntegrationsTab() {
  const [rows, setRows] = useState<IntegrationRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get<IntegrationsResponse>("/settings/integrations");
      setRows(res.data.integrations || []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(key: string, enabled: boolean) {
    const previous = rows;
    // Optimistic update so the click feels instant.
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, enabled } : r)),
    );
    try {
      await api.patch("/settings/integrations", {
        integrations: [{ key, enabled }],
      });
      toast.success(`${INTEGRATION_LABELS[key] || key} ${enabled ? "enabled" : "disabled"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
      setRows(previous);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <Skeleton variant="text" width="30%" height={20} className="mb-2" />
        <Skeleton variant="text" width="60%" className="mb-4" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700"
            >
              <div className="flex-1 space-y-2">
                <Skeleton variant="text" width="40%" />
                <Skeleton variant="text" width="25%" />
              </div>
              <Skeleton variant="rect" width={44} height={24} className="rounded-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
      <h2 className="mb-1 text-lg font-semibold">Integrations</h2>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        Enable or disable third-party connectors. Credentials are managed
        out-of-band via environment configuration.
      </p>
      <div className="space-y-3">
        {rows.map((r) => (
          <div
            key={r.key}
            data-testid={`integration-row-${r.key}`}
            className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700"
          >
            <div>
              <p className="text-sm font-medium">
                {INTEGRATION_LABELS[r.key] || r.key}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {r.configured ? "Credentials present" : "Not yet configured"}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={
                  "rounded-full px-2 py-0.5 text-xs font-medium " +
                  (r.enabled
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                    : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300")
                }
              >
                {r.enabled ? "Enabled" : "Disabled"}
              </span>
              <button
                onClick={() => toggle(r.key, !r.enabled)}
                data-testid={`integration-toggle-${r.key}`}
                className={
                  "relative inline-flex h-6 w-11 items-center rounded-full transition " +
                  (r.enabled ? "bg-primary" : "bg-gray-300 dark:bg-gray-600")
                }
              >
                <span
                  className={
                    "inline-block h-4 w-4 transform rounded-full bg-white transition " +
                    (r.enabled ? "translate-x-6" : "translate-x-1")
                  }
                />
              </button>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            No integrations configured.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── WHATSAPP ──────────────────────────────────────────
//
// Per-tenant WhatsApp provider credentials. Backed by the existing
// tenant-scoped, ADMIN-only, AES-256-GCM-encrypted API at /api/v1/wa/config
// (there is also a standalone page at /dashboard/settings/whatsapp; this tab
// surfaces the same config inside the main Settings screen). Five providers,
// each with its own credential field set. Secrets render masked with a
// per-field show/hide toggle; they are write-only — the server returns the
// decrypted creds only to the ADMIN who owns the tenant.

type WaProvider = "GUPSHUP" | "WATI" | "AISENSEI" | "INTERAKT" | "META";

interface WaFieldSpec {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  // Only needed to RECEIVE messages (webhook). Hidden + not required unless
  // Auto-reply is enabled — a send-only setup doesn't need these.
  inboundOnly?: boolean;
}

const WA_PROVIDER_FIELDS: Record<WaProvider, WaFieldSpec[]> = {
  GUPSHUP: [
    { key: "apiKey", label: "API key (token)", secret: true },
    { key: "appName", label: "App name", secret: false, placeholder: "e.g. hospital_prod" },
    { key: "sourcePhone", label: "WhatsApp number (E.164)", secret: false, placeholder: "+919876543210" },
  ],
  WATI: [
    { key: "bearerToken", label: "Bearer token", secret: true },
    { key: "tenantUrl", label: "Tenant URL", secret: false, placeholder: "https://live-server-xxxx.wati.io" },
  ],
  AISENSEI: [
    { key: "apiKey", label: "API key (token)", secret: true },
    { key: "baseUrl", label: "Base URL", secret: false, placeholder: "https://app.aisensei.ai" },
  ],
  INTERAKT: [{ key: "apiKey", label: "API key (token)", secret: true }],
  META: [
    { key: "accessToken", label: "Access token", secret: true },
    { key: "phoneNumberId", label: "Phone number ID", secret: false, placeholder: "1234567890123456" },
    // Webhook (receive) creds — only for auto-reply.
    { key: "appSecret", label: "App secret", secret: true, inboundOnly: true },
    { key: "verifyToken", label: "Verify token", secret: true, inboundOnly: true },
  ],
};

const WA_PROVIDER_OPTIONS: Array<{ value: WaProvider; label: string }> = [
  { value: "GUPSHUP", label: "Gupshup" },
  { value: "WATI", label: "WATI" },
  { value: "AISENSEI", label: "AiSensei" },
  { value: "INTERAKT", label: "Interakt" },
  { value: "META", label: "Meta Cloud API" },
];

interface WaConfigResponse {
  data: {
    config: null | {
      provider: WaProvider;
      credentials: Record<string, string> | null;
      defaultProductId: string | null;
      autoReply: boolean;
      active: boolean;
      plaintextWarning?: boolean;
    };
  };
}

function WhatsAppTab() {
  const [provider, setProvider] = useState<WaProvider>("META");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [autoReply, setAutoReply] = useState(true);
  const [active, setActive] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [plaintextWarning, setPlaintextWarning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Show inbound (webhook) creds only when Auto-reply is on — a send-only
  // setup doesn't need App secret / Verify token. This drives BOTH the
  // rendered inputs and the required-field check in save().
  const fields = WA_PROVIDER_FIELDS[provider].filter(
    (f) => !f.inboundOnly || autoReply,
  );

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<WaConfigResponse>("/wa/config");
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
          setAutoReply(cfg.autoReply);
          setActive(cfg.active);
          setConfigured(true);
          setPlaintextWarning(!!cfg.plaintextWarning);
        }
      } catch {
        // Keep the panel rendered with empty fields so the admin can set up.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function changeProvider(next: WaProvider) {
    setProvider(next);
    // A provider switch invalidates the previous provider's cred fields.
    setCreds({});
    setShowSecret({});
  }

  async function save() {
    // Mirror the server's discriminated-union: every field for the chosen
    // provider must be non-empty.
    const missing = fields.filter((f) => !(creds[f.key] ?? "").trim());
    if (missing.length > 0) {
      toast.warning(`Please fill: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }
    setSaving(true);
    try {
      await api.put("/wa/config", {
        credentials: { provider, ...creds },
        autoReply,
        active,
      });
      toast.success("WhatsApp configuration saved");
      setConfigured(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <Skeleton variant="text" width="30%" height={20} className="mb-2" />
        <Skeleton variant="text" width="60%" className="mb-4" />
        <div className="space-y-4">
          <SkeletonText lines={2} />
          <SkeletonText lines={2} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
      <h2 className="mb-1 text-lg font-semibold">WhatsApp</h2>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        Per-hospital WhatsApp provider used to send and receive messages.
        Credentials are encrypted at rest and never shared with other hospitals.
      </p>

      {plaintextWarning && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          Credentials are being stored in plaintext — the encryption key
          (WHATSAPP_CREDS_KEY) is not set on the server. Set it and re-save
          before going live.
        </div>
      )}

      <div className="grid gap-4">
        <Field label="Provider">
          <select
            value={provider}
            onChange={(e) => changeProvider(e.target.value as WaProvider)}
            data-testid="wa-provider"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
          >
            {WA_PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        {fields.map((f) => {
          const visible = showSecret[f.key];
          return (
            <Field key={f.key} label={f.label}>
              <div className="flex items-stretch gap-2">
                <input
                  type={f.secret && !visible ? "password" : "text"}
                  autoComplete="off"
                  placeholder={f.placeholder}
                  value={creds[f.key] ?? ""}
                  onChange={(e) => setCreds((p) => ({ ...p, [f.key]: e.target.value }))}
                  data-testid={`wa-field-${f.key}`}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
                />
                {f.secret && (
                  <button
                    type="button"
                    onClick={() => setShowSecret((p) => ({ ...p, [f.key]: !p[f.key] }))}
                    aria-label={visible ? "Hide" : "Show"}
                    className="inline-flex min-w-[44px] items-center justify-center rounded-lg border border-gray-300 px-3 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
                  >
                    {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                )}
              </div>
            </Field>
          );
        })}

        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoReply}
              onChange={(e) => setAutoReply(e.target.checked)}
              className="h-4 w-4"
            />
            Auto-reply
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="h-4 w-4"
            />
            Active
          </label>
        </div>

        {provider === "META" && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {autoReply
              ? "Auto-reply is on — App secret and Verify token are required so the WhatsApp webhook can receive and verify incoming messages."
              : "Sending messages only? Leave Auto-reply off — App secret and Verify token aren't needed. Turn Auto-reply on to also receive messages."}
          </p>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <span className="text-xs text-gray-400">
          {configured ? "Configured" : "Not configured yet"}
        </span>
        <button
          onClick={save}
          disabled={saving}
          data-testid="wa-save"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save WhatsApp"}
        </button>
      </div>
    </div>
  );
}

// ─── PAYMENTS (Razorpay) ───────────────────────────────
//
// Per-tenant Razorpay gateway credentials. Backed by the tenant-scoped,
// ADMIN-only API at /api/v1/settings/payment, which writes onto the caller's
// OWN Tenant row and busts the per-tenant Razorpay client cache. Each hospital
// charges patients through its own merchant account. The Key Secret is
// write-only — the server returns only a masked key-id prefix + a "hasSecret"
// flag, so re-saving mode/webhook without re-typing the secret keeps it.

interface PaymentResponse {
  data: {
    configured: boolean;
    razorpayKeyId: string;
    razorpayMode: "test" | "live";
    hasSecret: boolean;
    hasWebhookSecret: boolean;
  };
}

function PaymentsTab() {
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [mode, setMode] = useState<"test" | "live">("test");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [hasWebhookSecret, setHasWebhookSecret] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [showWebhook, setShowWebhook] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<PaymentResponse>("/settings/payment");
        setKeyId(res.data.razorpayKeyId || "");
        setMode(res.data.razorpayMode || "test");
        setHasSecret(res.data.hasSecret);
        setHasWebhookSecret(res.data.hasWebhookSecret);
      } catch {
        // Keep the panel rendered with empty fields for first-time setup.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save() {
    const errs: Record<string, string> = {};
    if (!/^rzp_(test|live)_[A-Za-z0-9]{6,}$/.test(keyId.trim())) {
      errs.keyId = "Key ID must look like rzp_test_XXXX or rzp_live_XXXX";
    }
    // Secret required only when none is stored yet (rotation may leave blank).
    if (!hasSecret && !keySecret.trim()) {
      errs.keySecret = "Key Secret is required for first-time setup";
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.warning("Please fix the highlighted fields");
      return;
    }
    setSaving(true);
    try {
      await api.patch("/settings/payment", {
        razorpayKeyId: keyId.trim(),
        // Omit the secret when left blank so the stored one is kept.
        ...(keySecret.trim() ? { razorpayKeySecret: keySecret.trim() } : {}),
        razorpayMode: mode,
        ...(webhookSecret.trim()
          ? { razorpayWebhookSecret: webhookSecret.trim() }
          : {}),
      });
      toast.success("Payment settings saved");
      setHasSecret(true);
      if (webhookSecret.trim()) setHasWebhookSecret(true);
      // Clear the write-only fields after a successful save — they're never
      // read back, and blanking them avoids the illusion the secret is shown.
      setKeySecret("");
      setWebhookSecret("");
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

  if (loading) {
    return (
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <Skeleton variant="text" width="30%" height={20} className="mb-2" />
        <Skeleton variant="text" width="60%" className="mb-4" />
        <div className="space-y-4">
          <SkeletonText lines={2} />
          <SkeletonText lines={2} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
      <h2 className="mb-1 text-lg font-semibold">Payments (Razorpay)</h2>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        This hospital&apos;s own Razorpay account. Patient payments are charged
        through these keys — every hospital keeps its own, kept separate from
        all others.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Razorpay Key ID">
          <input
            type="text"
            value={keyId}
            onChange={(e) => {
              setKeyId(e.target.value);
              if (fieldErrors.keyId) setFieldErrors((p) => ({ ...p, keyId: "" }));
            }}
            placeholder="rzp_live_XXXXXXXXXXXX"
            data-testid="pay-key-id"
            aria-invalid={fieldErrors.keyId ? "true" : undefined}
            className={
              "w-full rounded-lg border px-3 py-2 dark:bg-gray-900 " +
              (fieldErrors.keyId
                ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                : "border-gray-300 dark:border-gray-600")
            }
          />
          {fieldErrors.keyId && (
            <p className="mt-1 text-xs text-red-600">{fieldErrors.keyId}</p>
          )}
        </Field>

        <Field label="Mode">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "test" | "live")}
            data-testid="pay-mode"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
          >
            <option value="test">Test</option>
            <option value="live">Live</option>
          </select>
        </Field>

        <Field
          label={
            hasSecret
              ? "Razorpay Key Secret (leave blank to keep current)"
              : "Razorpay Key Secret"
          }
        >
          <div className="flex items-stretch gap-2">
            <input
              type={showSecret ? "text" : "password"}
              autoComplete="off"
              value={keySecret}
              onChange={(e) => {
                setKeySecret(e.target.value);
                if (fieldErrors.keySecret)
                  setFieldErrors((p) => ({ ...p, keySecret: "" }));
              }}
              placeholder={hasSecret ? "•••••••• (stored)" : "Key secret"}
              data-testid="pay-key-secret"
              aria-invalid={fieldErrors.keySecret ? "true" : undefined}
              className={
                "w-full rounded-lg border px-3 py-2 dark:bg-gray-900 " +
                (fieldErrors.keySecret
                  ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                  : "border-gray-300 dark:border-gray-600")
              }
            />
            <button
              type="button"
              onClick={() => setShowSecret((v) => !v)}
              aria-label={showSecret ? "Hide" : "Show"}
              className="inline-flex min-w-[44px] items-center justify-center rounded-lg border border-gray-300 px-3 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {fieldErrors.keySecret && (
            <p className="mt-1 text-xs text-red-600">{fieldErrors.keySecret}</p>
          )}
        </Field>

        <Field
          label={
            hasWebhookSecret
              ? "Webhook Secret (leave blank to keep current)"
              : "Webhook Secret (optional)"
          }
        >
          <div className="flex items-stretch gap-2">
            <input
              type={showWebhook ? "text" : "password"}
              autoComplete="off"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={hasWebhookSecret ? "•••••••• (stored)" : "Webhook signing secret"}
              data-testid="pay-webhook-secret"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            />
            <button
              type="button"
              onClick={() => setShowWebhook((v) => !v)}
              aria-label={showWebhook ? "Hide" : "Show"}
              className="inline-flex min-w-[44px] items-center justify-center rounded-lg border border-gray-300 px-3 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              {showWebhook ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </Field>
      </div>

      {mode === "live" && (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          Live mode charges real money. Double-check the keys belong to this
          hospital&apos;s Razorpay account before saving.
        </p>
      )}

      <div className="mt-6 flex items-center justify-between">
        <span className="text-xs text-gray-400">
          {hasSecret ? "Credentials on file" : "Not configured yet"}
        </span>
        <button
          onClick={save}
          disabled={saving}
          data-testid="pay-save"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save Payments"}
        </button>
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
