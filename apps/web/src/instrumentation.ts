export async function register() {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    if (process.env.NEXT_RUNTIME === "nodejs") {
      const { init } = await import("@sentry/nextjs");
      init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        environment: process.env.NODE_ENV || "production",
        tracesSampleRate: 0.1,
      });
    }
    if (process.env.NEXT_RUNTIME === "edge") {
      const { init } = await import("@sentry/nextjs");
      init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        environment: process.env.NODE_ENV || "production",
      });
    }
  }
}
