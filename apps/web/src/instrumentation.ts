export async function register() {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    // SENTRY_RELEASE is set by scripts/deploy.sh to the deploying SHA
    // (CI hardening Phase 4.2). NEXT_PUBLIC_SENTRY_RELEASE is the
    // public-facing alias used by the browser bundle when Next bakes
    // env vars at build time; we read either to handle both runtimes.
    const release =
      process.env.SENTRY_RELEASE ?? process.env.NEXT_PUBLIC_SENTRY_RELEASE;
    if (process.env.NEXT_RUNTIME === "nodejs") {
      const { init } = await import("@sentry/nextjs");
      init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        environment: process.env.NODE_ENV || "production",
        release,
        tracesSampleRate: 0.1,
      });
    }
    if (process.env.NEXT_RUNTIME === "edge") {
      const { init } = await import("@sentry/nextjs");
      init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        environment: process.env.NODE_ENV || "production",
        release,
      });
    }
  }
}
