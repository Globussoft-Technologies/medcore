// Single entry point for Firebase consumers. Always import via this file
// so the lazy-init contract stays consistent across the app.
export { getFirebaseApp, getFirebaseAuth } from "./config";
export {
  ensureRecaptcha,
  disposeRecaptcha,
  sendOtp,
  verifyOtp,
  resetPhoneAuthState,
} from "./phone-auth";
