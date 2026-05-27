// Firebase Admin SDK — lazy, singleton init.
//
// Why: the patient phone-OTP flow uses Firebase to deliver SMS + verify the
// 6-digit code. The Firebase ID token that comes back to the client is NOT
// trusted directly by our backend — we verify it here with the Admin SDK
// (which checks the JWT signature against Google's public keys, the
// audience, the issuer, and the expiry), pull the verified phone number
// out, and use that to look up the patient User row. Everything downstream
// (cookie issuance, audit log, tenant scoping) is our existing machinery —
// Firebase is just the OTP transport.
//
// Credentials: a Firebase service-account JSON file path supplied via
//   FIREBASE_ADMIN_CREDENTIALS_PATH   (e.g. /etc/medcore/firebase-sa.json)
// AND
//   FIREBASE_PROJECT_ID               (must match the client-side project
//                                      so the audience/issuer check passes)
//
// Both env vars are mandatory; missing them throws at first call so a
// misconfigured deploy fails the FIRST patient sign-in cleanly rather than
// 5xx-ing somewhere deeper in the route handler.

import { existsSync, readFileSync } from "node:fs";
import {
  cert,
  getApps,
  initializeApp,
  type App,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

let cachedApp: App | null = null;
let cachedAuth: Auth | null = null;

function loadServiceAccount(): ServiceAccount {
  const path = process.env.FIREBASE_ADMIN_CREDENTIALS_PATH;
  if (!path) {
    throw new Error(
      "FIREBASE_ADMIN_CREDENTIALS_PATH is not set. " +
        "Drop the Firebase service-account JSON outside the repo and point this env var at it.",
    );
  }
  if (!existsSync(path)) {
    throw new Error(
      `FIREBASE_ADMIN_CREDENTIALS_PATH points at "${path}" but that file does not exist.`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read FIREBASE_ADMIN_CREDENTIALS_PATH at "${path}": ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `FIREBASE_ADMIN_CREDENTIALS_PATH file is not valid JSON: ${(err as Error).message}`,
    );
  }
  const sa = parsed as ServiceAccount & { project_id?: string };
  if (!sa.projectId && sa.project_id) {
    // Service-account JSONs use snake_case; firebase-admin's ServiceAccount
    // type wants camelCase. Bridge for older JSON exports.
    sa.projectId = sa.project_id;
  }
  return sa;
}

function getFirebaseAdminApp(): App {
  if (cachedApp) return cachedApp;
  // firebase-admin keeps its own app registry — if hot-reload or another
  // module has already initialised the default app, reuse it.
  const existing = getApps();
  if (existing.length > 0) {
    cachedApp = existing[0];
    return cachedApp;
  }
  const serviceAccount = loadServiceAccount();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      "FIREBASE_PROJECT_ID is not set. It must match the NEXT_PUBLIC_FIREBASE_PROJECT_ID used by the web client so ID-token audience/issuer checks pass.",
    );
  }
  cachedApp = initializeApp({
    credential: cert(serviceAccount),
    projectId,
  });
  return cachedApp;
}

/** Lazy-initialised Firebase Admin Auth client. Safe to call repeatedly. */
export function getFirebaseAdminAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  cachedAuth = getAuth(getFirebaseAdminApp());
  return cachedAuth;
}

export interface VerifiedFirebasePhoneToken {
  uid: string;
  phoneNumber: string; // E.164, e.g. "+919876543210"
  emailVerified: boolean;
}

/**
 * Verify a Firebase ID token and assert that it came from a phone-auth
 * sign-in (so an attacker can't take any old anonymous-auth token from the
 * same project and use it as a patient login). Returns the verified phone
 * number on success, throws on any failure.
 */
export async function verifyPhoneIdToken(
  idToken: string,
): Promise<VerifiedFirebasePhoneToken> {
  if (typeof idToken !== "string" || idToken.length === 0) {
    throw new Error("ID token is required.");
  }
  const auth = getFirebaseAdminAuth();
  // `checkRevoked=true` makes the call also reject tokens whose underlying
  // Firebase user has been disabled or whose refresh tokens have been
  // revoked since the token was minted — cheap defence vs. a stolen token
  // replay after the patient signs out.
  const decoded = await auth.verifyIdToken(idToken, /* checkRevoked */ true);
  // Firebase phone-auth populates `phone_number` on the decoded token; if
  // it's missing, the token came from a different sign-in method (e.g.
  // anonymous or email) and we refuse to honour it as a patient login.
  const phoneNumber = decoded.phone_number;
  if (!phoneNumber || typeof phoneNumber !== "string") {
    throw new Error(
      "Firebase token has no phone_number claim — only phone sign-in tokens are accepted here.",
    );
  }
  return {
    uid: decoded.uid,
    phoneNumber,
    emailVerified: Boolean(decoded.email_verified),
  };
}
