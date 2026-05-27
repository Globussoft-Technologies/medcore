// Firebase phone-auth helpers — the two operations the patient login flow
// needs, plus the invisible reCAPTCHA verifier setup. Wrapping
// signInWithPhoneNumber + confirmationResult.confirm in our own helpers
// keeps the UI page small (just state + 2 async calls) and gives us one
// place to translate Firebase's auth/error-code shape into user-facing copy.

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
  switch (code) {
    case "auth/invalid-phone-number":
      return "That phone number doesn't look right. Use the international format, e.g. +91 9876543210.";
    case "auth/missing-phone-number":
      return "Please enter your phone number.";
    case "auth/quota-exceeded":
      return "We've hit our SMS limit for now. Please try again in a few minutes.";
    case "auth/captcha-check-failed":
      return "The bot-check failed. Please refresh the page and try again.";
    case "auth/invalid-verification-code":
      return "That code didn't match. Please check and try again.";
    case "auth/code-expired":
      return "That code expired. Please request a new one.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a few minutes before trying again.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    default:
      return (err as FirebaseErrorLike)?.message || fallback;
  }
}
