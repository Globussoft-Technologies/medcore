import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export { PrismaClient };
export * from "@prisma/client";

// Shared helpers used by both seed scripts and data-correction scripts.
export * from "./lib/immunization-schedule";

// Issue #272: TEMPLATES is exported so the api regression test can pin
// the audience-scoping contract for seed-templated notifications.
export { TEMPLATES as NOTIFICATION_SEED_TEMPLATES } from "./seed-notifications-history";
export type { TemplateDef as NotificationSeedTemplateDef } from "./seed-notifications-history";
