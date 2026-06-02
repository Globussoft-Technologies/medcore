// Unit tests for tenant-provisioning.
//
// What / which modules / why
// ──────────────────────────
// - WHAT: covers (a) pure helpers (`validateSubdomain`, `tenantConfigKey`),
//   (b) the `createTenant` Pearl-billing wiring landed 2026-05-25 —
//   `TenantSubscription` auto-creation + `Tenant.featureFlags` write
//   from the plan's `includedFeatures`, and (c) the
//   `backfillTenantSubscriptions` idempotent backfill helper for tenants
//   that pre-date the auto-provisioning landing.
// - MODULES: `@medcore/db` is mocked at the package boundary so no
//   real Postgres is touched — the `prisma.$transaction` callback is
//   invoked with a fake `tx` that captures every create() payload.
//   `bcryptjs` is left real (CPU-bound but cheap for one call) so the
//   passwordHash branch isn't a special-case.
// - WHY: the platform-invoice generator (piece 3b) skips any tenant
//   without a `TenantSubscription`. If `createTenant` ever stops
//   inserting the subscription row, the silent failure mode is "tenant
//   never billed" — these tests are the only guard before the cron
//   misses a billing cycle in production.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Build a hoisted prisma mock whose `$transaction` invokes the inner
// callback with a fake `tx`. Every model.method we touch in
// `createTenant` is captured via vi.fn() so tests can assert on the
// recorded create() payloads.
const { prismaMock, txStore } = vi.hoisted(() => {
  const txStore: {
    tenantCreate?: any;
    subscriptionCreate?: any;
    userCreate?: any;
    templateRows?: any[];
    holidayRows?: any[];
    configCreates?: any[];
    leaveRows?: any[];
    preferenceRows?: any[];
  } = {};

  const tx: any = {
    tenant: {
      create: vi.fn(async ({ data }: any) => {
        txStore.tenantCreate = data;
        return {
          id: "tenant-1",
          name: data.name,
          subdomain: data.subdomain,
          plan: data.plan,
          active: data.active,
          featureFlags: data.featureFlags ?? null,
          createdAt: new Date("2026-05-25T00:00:00.000Z"),
        };
      }),
    },
    user: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => {
        txStore.userCreate = data;
        return {
          id: "user-1",
          email: data.email,
          name: data.name,
          role: data.role,
        };
      }),
    },
    notificationTemplate: {
      createMany: vi.fn(async ({ data }: any) => {
        txStore.templateRows = data;
        return { count: data.length };
      }),
    },
    notificationPreference: {
      createMany: vi.fn(async ({ data }: any) => {
        txStore.preferenceRows = data;
        return { count: data.length };
      }),
    },
    leaveBalance: {
      createMany: vi.fn(async ({ data }: any) => {
        txStore.leaveRows = data;
        return { count: data.length };
      }),
    },
    holiday: {
      createMany: vi.fn(async ({ data }: any) => {
        txStore.holidayRows = data;
        return { count: data.length };
      }),
    },
    systemConfig: {
      create: vi.fn(async ({ data }: any) => {
        (txStore.configCreates ??= []).push(data);
        return data;
      }),
    },
    tenantSubscription: {
      create: vi.fn(async ({ data }: any) => {
        txStore.subscriptionCreate = data;
        return { id: "sub-1", ...data };
      }),
    },
  };

  // Plans are DB-backed now; `createTenant` resolves the chosen tier's
  // includedFeatures via the plan-catalog (prisma.platformPlan.findUnique)
  // BEFORE opening the transaction. Mirror the shipped STARTER/GROWTH/
  // ENTERPRISE feature ladder so the featureFlags assertions hold.
  const PLAN_FEATURES: Record<string, string[]> = {
    STARTER: [
      "opd",
      "appointments",
      "prescriptions",
      "opd_billing",
      "patient_pwa",
      "crm_basic",
      "abha_link",
    ],
    GROWTH: [
      "opd",
      "appointments",
      "prescriptions",
      "opd_billing",
      "patient_pwa",
      "crm_basic",
      "abha_link",
      "lab",
      "radiology",
      "abdm_m1",
    ],
    ENTERPRISE: [
      "opd",
      "appointments",
      "prescriptions",
      "opd_billing",
      "patient_pwa",
      "crm_basic",
      "abha_link",
      "lab",
      "radiology",
      "abdm_m1",
      "ipd",
      "ot",
      "abdm_m2",
      "ai_scribe",
    ],
  };

  const prismaMock: any = {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    // Top-level (non-tx) shape — used by backfill helper.
    tenant: {
      findMany: vi.fn(async () => []),
    },
    tenantSubscription: {
      create: vi.fn(async ({ data }: any) => ({ id: "sub-bk", ...data })),
    },
    platformPlan: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key: string = where.key;
        const includedFeatures = PLAN_FEATURES[key];
        if (!includedFeatures) return null;
        return {
          id: `plan-${key}`,
          key,
          name: key[0] + key.slice(1).toLowerCase(),
          monthlyPriceInPaise: 499900,
          includedFeatures,
          active: true,
          sortOrder: 0,
        };
      }),
    },
  };

  return { prismaMock, txStore };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import {
  validateSubdomain,
  RESERVED_SUBDOMAINS,
  tenantConfigKey,
  createTenant,
  backfillTenantSubscriptions,
} from "./tenant-provisioning";

beforeEach(() => {
  // Reset capture slots between tests.
  for (const k of Object.keys(txStore)) delete (txStore as any)[k];
  vi.clearAllMocks();
  // Re-prime the $transaction shape after clearAllMocks wiped the
  // hoisted implementation.
  prismaMock.$transaction.mockImplementation(async (fn: any) => {
    // Rebuild a minimal tx for each call so captured payloads are
    // independent. We re-use the same vi.fn instances via the tx
    // closure above to keep accounting simple.
    return fn({
      tenant: {
        create: async ({ data }: any) => {
          txStore.tenantCreate = data;
          return {
            id: "tenant-1",
            name: data.name,
            subdomain: data.subdomain,
            plan: data.plan,
            active: data.active,
            featureFlags: data.featureFlags ?? null,
            createdAt: new Date("2026-05-25T00:00:00.000Z"),
          };
        },
      },
      user: {
        findUnique: async () => null,
        create: async ({ data }: any) => {
          txStore.userCreate = data;
          return {
            id: "user-1",
            email: data.email,
            name: data.name,
            role: data.role,
          };
        },
      },
      notificationTemplate: {
        createMany: async ({ data }: any) => {
          txStore.templateRows = data;
          return { count: data.length };
        },
      },
      notificationPreference: {
        createMany: async ({ data }: any) => {
          txStore.preferenceRows = data;
          return { count: data.length };
        },
      },
      leaveBalance: {
        createMany: async ({ data }: any) => {
          txStore.leaveRows = data;
          return { count: data.length };
        },
      },
      holiday: {
        createMany: async ({ data }: any) => {
          txStore.holidayRows = data;
          return { count: data.length };
        },
      },
      systemConfig: {
        create: async ({ data }: any) => {
          (txStore.configCreates ??= []).push(data);
          return data;
        },
      },
      tenantSubscription: {
        create: async ({ data }: any) => {
          txStore.subscriptionCreate = data;
          return { id: "sub-1", ...data };
        },
      },
    });
  });
});

describe("validateSubdomain", () => {
  it("accepts valid subdomains", () => {
    expect(validateSubdomain("sunrise")).toBeNull();
    expect(validateSubdomain("apollo-hospitals")).toBeNull();
    expect(validateSubdomain("clinic-42")).toBeNull();
    expect(validateSubdomain("a1b")).toBeNull();
  });

  it("rejects too-short / too-long", () => {
    expect(validateSubdomain("")).not.toBeNull();
    expect(validateSubdomain("ab")).not.toBeNull();
    expect(validateSubdomain("a".repeat(31))).not.toBeNull();
  });

  it("rejects illegal characters", () => {
    expect(validateSubdomain("HELLO")).not.toBeNull();
    expect(validateSubdomain("hi there")).not.toBeNull();
    expect(validateSubdomain("hi_there")).not.toBeNull();
    expect(validateSubdomain("-leading")).not.toBeNull();
    expect(validateSubdomain("trailing-")).not.toBeNull();
  });

  it("rejects every reserved name", () => {
    for (const s of RESERVED_SUBDOMAINS) {
      expect(validateSubdomain(s)).not.toBeNull();
    }
    // Key legacy names are definitely in the list.
    for (const legacy of ["www", "api", "app", "admin", "medcore", "default"]) {
      expect(RESERVED_SUBDOMAINS.has(legacy)).toBe(true);
    }
  });
});

describe("tenantConfigKey", () => {
  it("prefixes keys with tenant:<id>:", () => {
    expect(tenantConfigKey("abc", "hospital_name")).toBe("tenant:abc:hospital_name");
    expect(tenantConfigKey("uuid-123", "onboarding_step_x_completed_at")).toBe(
      "tenant:uuid-123:onboarding_step_x_completed_at",
    );
  });
});

describe("createTenant — Pearl-billing auto-provisioning", () => {
  const BASE_PARAMS = {
    name: "Sunrise Hospital",
    subdomain: "sunrise",
    // Plans are unified + DB-backed now: `Tenant.plan` and the subscription
    // share one dynamic `PlatformPlan.key`. The base fixture uses STARTER so
    // the default (no explicit initialPlan) lands on STARTER — which is what
    // every assertion in this describe block relies on. GROWTH / ENTERPRISE
    // are covered by the explicit `initialPlan` overrides further down.
    plan: "STARTER" as any,
    adminEmail: "admin@sunrise.test",
    adminPassword: "S3cure-pass-2026!",
    adminName: "Admin User",
  };

  it("creates a TenantSubscription in the same transaction with status=trial and a 30-day window", async () => {
    const before = Date.now();
    const result = await createTenant(BASE_PARAMS);
    const after = Date.now();

    // Subscription was created.
    expect(txStore.subscriptionCreate).toBeDefined();
    expect(txStore.subscriptionCreate.tenantId).toBe("tenant-1");
    expect(txStore.subscriptionCreate.plan).toBe("STARTER");
    expect(txStore.subscriptionCreate.status).toBe("trial");

    // Trial window = 30 days; currentPeriodStart ≈ now; currentPeriodEnd = trialEndsAt.
    const trialMs =
      txStore.subscriptionCreate.trialEndsAt.getTime() -
      txStore.subscriptionCreate.currentPeriodStart.getTime();
    expect(trialMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(txStore.subscriptionCreate.currentPeriodEnd.getTime()).toBe(
      txStore.subscriptionCreate.trialEndsAt.getTime(),
    );
    expect(
      txStore.subscriptionCreate.currentPeriodStart.getTime(),
    ).toBeGreaterThanOrEqual(before);
    expect(
      txStore.subscriptionCreate.currentPeriodStart.getTime(),
    ).toBeLessThanOrEqual(after);

    // Result echoes the subscription back to the caller.
    expect(result.subscription.plan).toBe("STARTER");
    expect(result.subscription.status).toBe("trial");
    expect(result.subscription.id).toBe("sub-1");

    // Tenant.featureFlags carries the STARTER plan's includedFeatures set.
    expect(txStore.tenantCreate.featureFlags).toBeDefined();
    const flags = txStore.tenantCreate.featureFlags as Record<string, boolean>;
    expect(flags.opd).toBe(true);
    expect(flags.appointments).toBe(true);
    expect(flags.opd_billing).toBe(true);
    expect(flags.patient_pwa).toBe(true);
    expect(flags.crm_basic).toBe(true);
    expect(flags.abha_link).toBe(true);
    // STARTER must NOT silently unlock the GROWTH/ENTERPRISE features.
    expect(flags.lab).toBeUndefined();
    expect(flags.ipd).toBeUndefined();
    expect(flags.ai_scribe).toBeUndefined();
  });

  it("respects initialPlan override (GROWTH → unlocks lab/radiology/abdm_m1)", async () => {
    await createTenant({ ...BASE_PARAMS, initialPlan: "GROWTH" });

    expect(txStore.subscriptionCreate.plan).toBe("GROWTH");
    const flags = txStore.tenantCreate.featureFlags as Record<string, boolean>;
    // STARTER baseline still present.
    expect(flags.opd).toBe(true);
    expect(flags.opd_billing).toBe(true);
    // GROWTH adds lab / radiology / abdm_m1.
    expect(flags.lab).toBe(true);
    expect(flags.radiology).toBe(true);
    expect(flags.abdm_m1).toBe(true);
    // ENTERPRISE-only flags still locked.
    expect(flags.ipd).toBeUndefined();
    expect(flags.ai_scribe).toBeUndefined();
  });

  it("respects initialPlan override (ENTERPRISE → unlocks ipd/ot/abdm_m2/ai_scribe)", async () => {
    await createTenant({ ...BASE_PARAMS, initialPlan: "ENTERPRISE" });

    expect(txStore.subscriptionCreate.plan).toBe("ENTERPRISE");
    const flags = txStore.tenantCreate.featureFlags as Record<string, boolean>;
    expect(flags.ipd).toBe(true);
    expect(flags.ot).toBe(true);
    expect(flags.abdm_m2).toBe(true);
    expect(flags.ai_scribe).toBe(true);
  });
});

describe("backfillTenantSubscriptions", () => {
  it("creates one TenantSubscription per orphan tenant with status=active and aligned calendar window", async () => {
    const created: any[] = [];
    const client: any = {
      tenant: {
        findMany: vi.fn(async () => [{ id: "t1" }, { id: "t2" }, { id: "t3" }]),
      },
      tenantSubscription: {
        create: vi.fn(async ({ data }: any) => {
          created.push(data);
          return { id: `sub-${created.length}`, ...data };
        }),
      },
    };

    const result = await backfillTenantSubscriptions(client, {
      now: new Date(Date.UTC(2026, 4, 15)),
    });

    expect(result.created).toBe(3);
    expect(created).toHaveLength(3);
    for (const row of created) {
      expect(row.plan).toBe("STARTER");
      expect(row.status).toBe("active");
      expect(row.trialEndsAt).toBeNull();
      // Calendar-month window — May 1 UTC → June 1 UTC.
      expect(row.currentPeriodStart.toISOString()).toBe("2026-05-01T00:00:00.000Z");
      expect(row.currentPeriodEnd.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    }
  });

  it("is idempotent — skips tenants that already have a subscription (empty orphan list ⇒ zero creates)", async () => {
    const findManySpy = vi.fn(async () => []);
    const createSpy = vi.fn(async ({ data }: any) => ({ id: "sub-x", ...data }));
    const client: any = {
      tenant: { findMany: findManySpy },
      tenantSubscription: { create: createSpy },
    };

    const result = await backfillTenantSubscriptions(client);
    expect(result.created).toBe(0);
    expect(createSpy).not.toHaveBeenCalled();
    // The findMany call uses the orphan filter.
    const calls = findManySpy.mock.calls as unknown as any[][];
    const callArgs = calls[0]?.[0];
    expect(callArgs.where.tenantSubscription).toEqual({ is: null });
    expect(callArgs.select).toEqual({ id: true });
  });
});
