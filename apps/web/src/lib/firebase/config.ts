// Firebase Web SDK initialisation. Lazy + singleton — the SDK is large
// (~250KB gzipped) and we only want to pay that cost on routes that actually
// invoke phone-auth (today: /patient/login). Callers MUST import via
// `lib/firebase` rather than reaching here directly so the entry point is
// always the same.
//
// Env contract (NEXT_PUBLIC_* so they're available in the browser bundle):
//   NEXT_PUBLIC_FIREBASE_API_KEY
//   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
//   NEXT_PUBLIC_FIREBASE_PROJECT_ID
//   NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
//   NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
//   NEXT_PUBLIC_FIREBASE_APP_ID
//
// Note: NEXT_PUBLIC_ vars are public — they ship in the JS bundle and any
// visitor can read them. That's fine for Firebase config (the API key is
// not a secret; access control happens via Firebase Security Rules + the
// reCAPTCHA verifier on phone-auth). The actual secret — the service
// account JSON — lives on the server only, see apps/api/src/services/
// firebase-admin.ts.

import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import { type Auth, getAuth } from "firebase/auth";

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;

function readConfig(): {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
} {
  // Required: the six core fields. Firebase will not init without them.
  const required = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
  // Surface a clear error early so a misconfigured deploy fails on first
  // SDK call rather than mid-way through an OTP request with a cryptic
  // "auth/invalid-api-key" inside Firebase internals.
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Firebase config is missing env vars: ${missing.join(", ")}. ` +
        "Set NEXT_PUBLIC_FIREBASE_* in apps/web/.env.local — see " +
        "apps/web/src/lib/firebase/config.ts for the contract.",
    );
  }
  // Optional: measurementId only matters when Firebase Analytics is wired
  // in. Pass through if present (empty string → undefined so Firebase
  // doesn't treat "" as a real ID).
  const measurementId = process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID;
  // We've just thrown if any required value was missing — narrow through
  // `unknown` to the return shape (Required<{...|undefined}> still resolves
  // to {...|undefined} in TS).
  return {
    ...(required as unknown as {
      apiKey: string;
      authDomain: string;
      projectId: string;
      storageBucket: string;
      messagingSenderId: string;
      appId: string;
    }),
    ...(measurementId ? { measurementId } : {}),
  };
}

export function getFirebaseApp(): FirebaseApp {
  if (cachedApp) return cachedApp;
  // Next.js dev server hot-reloads modules — reuse the app if Firebase has
  // already registered one for this page (otherwise we get
  // "Firebase App named '[DEFAULT]' already exists").
  const existing = getApps();
  if (existing.length > 0) {
    cachedApp = existing[0];
    return cachedApp;
  }
  cachedApp = initializeApp(readConfig());
  return cachedApp;
}

export function getFirebaseAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  cachedAuth = getAuth(getFirebaseApp());
  return cachedAuth;
}
