// Firebase phone-auth helpers — the two operations the patient login flow
// needs, plus the invisible reCAPTCHA verifier setup. Wrapping
// signInWithPhoneNumber + confirmationResult.confirm in our own helpers
// keeps the UI page small (just state + 2 async calls) and gives us one
// place to translate Firebase's auth/error-code shape into user-facing copy.
//
// reCAPTCHA notes (Pearl §6.3 — patient OTP, debug history 2026-05-29):
//
// We pass `size: "invisible"` below — that's the hint for the LEGACY v2
// invisible reCAPTCHA. The Firebase web SDK AUTO-DETECTS the project's
// reCAPTCHA configuration and silently switches modes:
//   * v2-only project          → SDK uses invisible v2.
//   * Enterprise on project    → SDK switches to Enterprise mode and
//                                emits `recaptchaVersion:
//                                "RECAPTCHA_ENTERPRISE"` in the
//                                accounts:sendVerificationCode payload.
//
// Debugging INVALID_APP_CREDENTIAL — ranked by frequency:
//
//   STEP 1 — confirm it's actually project-side, not a code bug. Run
//   this exact curl from your terminal:
//     curl -X POST \
//       "https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode\
//         ?key=<NEXT_PUBLIC_FIREBASE_API_KEY>" \
//       -H "Content-Type: application/json" \
//       -H "Referer: http://localhost:3000" \
//       -d '{"phoneNumber":"+919999999999","clientType":"CLIENT_TYPE_WEB",
//            "captchaResponse":"NO_RECAPTCHA",
//            "recaptchaVersion":"RECAPTCHA_ENTERPRISE"}'
//   If this gets the SAME 400 INVALID_APP_CREDENTIAL, the issue is
//   entirely project-side. NO code change in this file can fix it.
//
//   STEP 2 — probe the Firebase config endpoint to see project state:
//     curl "https://identitytoolkit.googleapis.com/v2/recaptchaConfig?\
//       key=<NEXT_PUBLIC_FIREBASE_API_KEY>\
//       &clientType=CLIENT_TYPE_WEB\
//       &version=RECAPTCHA_ENTERPRISE"
//   Look at `recaptchaEnforcementState.PHONE_PROVIDER`:
//     - ENFORCE → reCAPTCHA failure blocks the request
//     - AUDIT   → reCAPTCHA failure is logged but does NOT block
//
//   STEP 3 — look at the browser DevTools Console for SDK logs:
//   If you see Firebase emit a log like:
//     "Failed to verify with reCAPTCHA Enterprise. Automatically
//      triggering the reCAPTCHA v2 flow to complete the
//      sendVerificationCode flow."
//   and BOTH the Enterprise attempt AND the v2 fallback get a 400, the
//   issue is NOT reCAPTCHA — both modes are being rejected upstream. The
//   ONLY thing that can reject both is the Google Cloud API key itself
//   being restricted (HTTP referrer allowlist missing the current
//   domain, OR API restrictions excluding Identity Toolkit API).
//
//   If enforcement is AUDIT and you still see INVALID_APP_CREDENTIAL, the
//   cause is one of these, in this order:
//     1. Google Cloud API key restrictions — open
//        https://console.cloud.google.com/apis/credentials → click the
//        API key → "Application restrictions" section. If "HTTP
//        referrers" is set, the localhost dev URL must be in the
//        allowlist or auth requests get rejected.
//     2. reCAPTCHA Enterprise key's own domain allowlist (separate
//        from Firebase Authorized Domains) — open
//        https://console.cloud.google.com/security/recaptcha → find
//        the configured Enterprise key → ensure `localhost` and
//        `127.0.0.1` are in its domain list.
//     3. Identity Toolkit API is disabled on the GCP project — enable
//        at https://console.cloud.google.com/apis/library/
//        identitytoolkit.googleapis.com
//     4. Firebase Authentication "Authorized Domains" (Console →
//        Authentication → Settings → Authorized Domains) doesn't
//        include `localhost`. This is the easiest to miss because the
//        UI is in Firebase Console, not Cloud Console.
//
//   If enforcement is ENFORCE, the fix paths additionally include:
//     5. Switch enforcement to AUDIT or OFF for dev (Identity Platform →
//        Providers → Phone), OR
//     6. Fully register the Enterprise site key in Firebase Auth
//        settings with the dev domain in its allowlist.
//
// In ALL cases above, the fix is project-side configuration. There is
// no code change in this file that resolves INVALID_APP_CREDENTIAL — it
// is always a config drift between what the Firebase SDK sends and what
// Google's edge accepts for the project.

import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  type ConfirmationResult,
} from "firebase/auth";

import { getFirebaseAuth } from "./config";

// Phone-auth flows hold a ConfirmationResult between sendOtp() and
// verifyOtp(); we stash it module-side rather than threading it through
// the caller because the UI is mid-flow and we don't want a re-render to
// drop the handle. Cleared on success / abort.
let pendingConfirmation: ConfirmationResult | null = null;

// Likewise: the RecaptchaVerifier MUST be initialised once and kept alive
// across the send/verify cycle. Firebase mounts a hidden DOM element under
// the container element id we pass; tearing it down between sends would
// trigger a new bot-check every time and break sandbox testing.
let recaptchaVerifier: RecaptchaVerifier | null = null;

/**
 * Initialise an invisible reCAPTCHA verifier mounted under the DOM element
 * with the supplied id. Idempotent — calling twice returns the same
 * verifier so a React strict-mode double-mount or a re-render doesn't
 * double-install the widget.
 *
 * The container element must exist in the DOM before this runs. Typical
 * usage: `useEffect(() => ensureRecaptcha("patient-recaptcha"), [])`.
 */
export function ensureRecaptcha(containerId: string): RecaptchaVerifier {
  if (recaptchaVerifier) return recaptchaVerifier;
  recaptchaVerifier = new RecaptchaVerifier(getFirebaseAuth(), containerId, {
    size: "invisible",
  });
  return recaptchaVerifier;
}

/**
 * Drop the cached verifier. Call from the page's unmount cleanup so a
 * subsequent visit to /patient/login installs a fresh one.
 */
export function disposeRecaptcha(): void {
  if (recaptchaVerifier) {
    try {
      recaptchaVerifier.clear();
    } catch {
      // clear() throws if the container is already gone — non-fatal.
    }
  }
  recaptchaVerifier = null;
}

/**
 * Step 1 of the flow. Sends an OTP SMS to the supplied E.164 phone number
 * (e.g. "+919876543210"). Throws with a user-facing message on failure.
 *
 * Firebase requires the reCAPTCHA verifier to be live before this call —
 * the caller must have invoked ensureRecaptcha() once on mount.
 */
export async function sendOtp(phoneE164: string): Promise<void> {
  if (!recaptchaVerifier) {
    throw new Error(
      "reCAPTCHA verifier is not initialised — call ensureRecaptcha() first.",
    );
  }
  try {
    pendingConfirmation = await signInWithPhoneNumber(
      getFirebaseAuth(),
      phoneE164,
      recaptchaVerifier,
    );
  } catch (err) {
    throw new Error(humanizeFirebaseError(err, "Could not send OTP."));
  }
}

/**
 * Step 2 of the flow. Confirms the 6-digit code and returns the freshly
 * minted Firebase ID token. The caller is expected to POST that token to
 * `/api/v1/patient-auth/firebase-verify` which validates it server-side
 * and mints the medcore_at / medcore_rt session cookies (BOLA + audit +
 * tenant scoping all stay in the existing backend's hands).
 *
 * Throws with a user-facing message on failure.
 */
export async function verifyOtp(otp: string): Promise<string> {
  if (!pendingConfirmation) {
    throw new Error("No OTP request is in progress. Please request a new code.");
  }
  try {
    const credential = await pendingConfirmation.confirm(otp);
    const idToken = await credential.user.getIdToken(/* forceRefresh */ true);
    // Clear after success so a subsequent flow starts fresh — and so a
    // mistaken second submit doesn't replay an already-burned code.
    pendingConfirmation = null;
    return idToken;
  } catch (err) {
    throw new Error(humanizeFirebaseError(err, "Could not verify OTP."));
  }
}

/**
 * Abort the in-flight flow. Useful if the user closes the form before
 * entering the code so the next visit starts clean.
 */
export function resetPhoneAuthState(): void {
  pendingConfirmation = null;
}

// ─── Internal: error mapper ─────────────────────────────────────────────

interface FirebaseErrorLike {
  code?: string;
  message?: string;
}

function humanizeFirebaseError(err: unknown, fallback: string): string {
  const code = (err as FirebaseErrorLike)?.code;

  // Dump the raw Firebase error to the dev console so a developer can see
  // the SDK's full stack and the original code. The user-facing message
  // returned below is intentionally short + non-leaky.
  if (typeof window !== "undefined" && code) {
    // eslint-disable-next-line no-console
    console.warn("[firebase phone-auth]", code, err);
  }

  switch (code) {
    case "auth/invalid-phone-number":
      return "That phone number doesn't look right. Use the international format, e.g. +91 9876543210.";
    case "auth/missing-phone-number":
      return "Please enter your phone number.";
    case "auth/quota-exceeded":
      return "We've hit our SMS limit for now. Please try again in a few minutes.";
    case "auth/captcha-check-failed":
      return "The bot-check failed. Please refresh the page and try again.";
    case "auth/invalid-app-credential":
      // 99% of the time this is a PROJECT-SIDE Firebase config issue, NOT
      // a bug in our code:
      //   - reCAPTCHA Enterprise enforcement is on but no Enterprise site
      //     key is configured in Authentication settings, OR
      //   - The configured Enterprise site key doesn't include the
      //     current domain (e.g. `localhost`), OR
      //   - Authorized Domains in Firebase Console doesn't include
      //     `localhost`.
      // The browser network tab will show the request payload had
      // `recaptchaVersion: "RECAPTCHA_ENTERPRISE"` if Enterprise is on.
      // Pearl: ask the project owner to either (a) disable Enterprise
      // enforcement for Phone in Cloud Console → Identity Platform →
      // Providers → Phone, OR (b) configure a valid Enterprise site key
      // that whitelists this domain. See /docs/FIREBASE_OTP_SETUP.md.
      return "Sign-in is misconfigured on the server side. Please contact support — the Firebase reCAPTCHA setup needs attention.";
    case "auth/invalid-verification-code":
      return "That code didn't match. Please check and try again.";
    case "auth/code-expired":
      return "That code expired. Please request a new one.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a few minutes before trying again.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    case "auth/operation-not-allowed":
      // Project-side: Phone auth is disabled, OR the SMS region of the
      // dialled number is not on the project's allowed regions list.
      return "Phone sign-in isn't available for your region yet. Please contact support.";
    case "auth/app-not-authorized":
      // Project-side: the API key in the web env isn't authorised for
      // this project, or the current domain isn't in Authorized Domains.
      return "This domain isn't authorised for sign-in. Please contact support.";
    default:
      return (err as FirebaseErrorLike)?.message || fallback;
  }
}
