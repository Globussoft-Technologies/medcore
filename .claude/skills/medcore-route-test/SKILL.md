---
name: medcore-route-test
description: Scaffold a Vitest unit test for an Express route handler at apps/api/src/routes/<x>.ts — RBAC matrix, Zod validation rejections, happy paths, audit-log assertions, all with hoisted Prisma mocks (no real DB). Use when the user asks to "write a unit test for /api/v1/<resource>", "cover route <x>", or "close the test gap for this handler". Pairs with /medcore-fanout when closing several route test gaps in parallel. Companion to /medcore-e2e-spec for full-stack route coverage.
---

# medcore-route-test

Scaffolds a unit test (NOT integration test) for an Express route handler. Unit tests use hoisted Prisma mocks per the pattern in [`apps/api/src/routes/razorpay-webhook.test.ts`](../../../../apps/api/src/routes/razorpay-webhook.test.ts) — they're fast, run in the per-push gate, and don't need Postgres.

For DB-backed integration tests, the right pattern is under `apps/api/src/test/integration/` instead — that's a different skill (TBD `/medcore-route-integration-test`).

## Inputs

- **Route file path** (required): e.g. `apps/api/src/routes/billing.ts`. Ask the user if not provided.
- **Optional scope**: which endpoints to cover (e.g. "just the refund webhook handler" vs the whole router). If unspecified, cover every endpoint exported from the file.

## Workflow

### 1. Discover the route surface

Read in parallel (one tool message):

- The route file at `apps/api/src/routes/<x>.ts` — extract:
  - Every `router.<verb>(...)` registration: HTTP method, path, middleware chain.
  - `authorize(Role.X, Role.Y)` / `authenticate` middleware ordering.
  - Zod schemas referenced from `packages/shared` or defined inline.
  - Every `prisma.<model>.<op>(...)` call (and `tenantScopedPrisma` calls) — these become the mock surface.
  - Any state-machine helpers (`assertValidTransition`, `ALLOWED_*`).
  - Any audit-log calls (`auditLog(req, "...", "Entity", id, payload)`).
  - Any `crypto`, `signature`, fraud-guard logic.
- A sibling unit test file (best match): `apps/api/src/routes/razorpay-webhook.test.ts` is the canonical reference for hoisted-mock + supertest pattern. Other relevant patterns: `apps/api/src/routes/<sibling>.test.ts` if one exists for the same domain.
- The Zod schemas the route uses (from `packages/shared/src/validation/`) — needed to construct valid + invalid payloads.

### 2. Pick the test surface

For each endpoint in the route, plan:

- **Auth-tier:** `401 unauthenticated` (no token) — typically 1 case for the router.
- **RBAC-tier:** `403 forbidden` for each disallowed role (or 1-2 representative ones per route — pick based on the matrix).
- **Validation-tier:** Zod rejection paths (1-2 per schema; missing required field, wrong type, out-of-range).
- **Happy path:** 200/201 per allowed role — assert response shape (`success: true`, `data: {...}`).
- **State-machine guards:** illegal-transition 409 cases (e.g. dispatch → COMPLETED skipping ARRIVED_SCENE).
- **Audit-log assertions:** for any side-effecting endpoint, assert `auditLogMock` was called with the right args.
- **Idempotency / fraud guards:** if applicable (webhooks, payment handlers).

Aim for **8-15 tests per endpoint cluster, not per individual endpoint** — the right granularity is "behaviour group", not "every line".

### 3. Write the test at `apps/api/src/routes/<x>.test.ts`

Use this skeleton (replace `<…>` placeholders). Read [`razorpay-webhook.test.ts`](../../../../apps/api/src/routes/razorpay-webhook.test.ts) lines 1-120 for the canonical hoisted-mock setup.

```ts
/**
 * Unit tests for the <route> Express router.
 *
 * What this exercises:
 *   apps/api/src/routes/<x>.ts — <list endpoints, e.g. POST /api/v1/foo,
 *   GET /api/v1/foo/:id, PATCH /api/v1/foo/:id/status>
 *
 * Surfaces touched:
 *   - RBAC: <which roles are allowed/denied>
 *   - State machine: <if applicable, e.g. PENDING -> APPROVED | REJECTED>
 *   - Audit log: <which actions write audit rows>
 *
 * Why these tests exist:
 *   <regulation reference, prior bug, audit gap entry, RBAC matrix line>
 *
 * Companion to apps/api/src/test/integration/<x>.test.ts (real DB) where
 * applicable; this file pins the unit-tier behaviour with hoisted mocks.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Hoisted Prisma + audit mocks. Pattern from razorpay-webhook.test.ts.
const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    <model1>: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    // ... add other models the route uses
    $transaction: vi.fn(async (cb: any) => {
      if (typeof cb === "function") {
        return cb({ /* mirror of the model mocks */ });
      }
      return Promise.all(cb);
    }),
    $extends(_c: unknown) { return base; },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("../services/tenant-prisma", () => ({ tenantScopedPrisma: prismaMock }));

const { auditLogMock } = vi.hoisted(() => ({ auditLogMock: vi.fn(async () => {}) }));
vi.mock("../middleware/audit", () => ({ auditLog: auditLogMock }));

// Auth middleware mock — set req.user so the route's authorize() check
// can read it. Token-bearing tests override with the right role.
const { setMockUser } = vi.hoisted(() => {
  let mockUser: any = null;
  return {
    setMockUser: (u: any) => { mockUser = u; },
    _mockUser: () => mockUser,
  };
});
vi.mock("../middleware/auth", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = (require("../middleware/auth") as any)._mockUser?.() ?? null;
    if (!req.user) return _res.status(401).json({ success: false, error: "unauthenticated" });
    next();
  },
  authorize: (...roles: any[]) => (req: any, res: any, next: any) =>
    roles.includes(req.user?.role) ? next() : res.status(403).json({ success: false, error: "forbidden" }),
}));

import { <routerExportName> } from "./<x>";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", <routerExportName>);
  return app;
}

describe("<Route> — apps/api/src/routes/<x>.ts (<one-line: RBAC matrix + key behaviours pinned>)", () => {
  beforeEach(() => {
    setMockUser(null);
    Object.values(prismaMock).forEach((m: any) => {
      if (m && typeof m === "object") {
        Object.values(m).forEach((fn: any) => fn?.mockReset?.());
      }
    });
    auditLogMock.mockReset();
  });

  describe("POST /api/v1/<endpoint> — <what it does>", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await request(buildApp())
        .post("/api/v1/<endpoint>")
        .send({ /* valid payload */ });
      expect(res.status).toBe(401);
    });

    it("rejects <DISALLOWED_ROLE> with 403 (RBAC matrix: <X>)", async () => {
      setMockUser({ id: "u-1", role: "<DISALLOWED_ROLE>" });
      const res = await request(buildApp())
        .post("/api/v1/<endpoint>")
        .send({ /* valid payload */ });
      expect(res.status).toBe(403);
    });

    it("rejects malformed body with 400 + Zod field errors", async () => {
      setMockUser({ id: "u-1", role: "<ALLOWED_ROLE>" });
      const res = await request(buildApp())
        .post("/api/v1/<endpoint>")
        .send({ /* invalid payload */ });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/<expected zod path>/);
    });

    it("happy path: <ALLOWED_ROLE> creates the resource, audit row written", async () => {
      setMockUser({ id: "u-1", role: "<ALLOWED_ROLE>" });
      prismaMock.<model>.create.mockResolvedValueOnce({ id: "x-1", /* ... */ });

      const res = await request(buildApp())
        .post("/api/v1/<endpoint>")
        .send({ /* valid payload */ });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, data: { id: "x-1" } });
      expect(prismaMock.<model>.create).toHaveBeenCalledTimes(1);
      expect(auditLogMock).toHaveBeenCalledWith(
        expect.anything(),
        "<AUDIT_ACTION>",
        "<Entity>",
        "x-1",
        expect.objectContaining({ /* expected payload */ })
      );
    });

    // <state-machine guard cases, fraud guards, etc.>
  });

  // <repeat describe(...) blocks for each endpoint cluster>
});
```

### 4. Validate

```bash
cd <repo root>
npx vitest run apps/api/src/routes/<x>.test.ts --reporter=default
```

Must be green. If a test fails because of mock-shape drift (route uses a Prisma op the mock doesn't know), add the missing op to the hoisted mock and re-run.

Also lint:
```bash
npx turbo run lint --filter=@medcore/api
```

### 5. Commit (concurrency-safe — paired with /medcore-fanout)

```bash
git add apps/api/src/routes/<x>.test.ts
git commit -m "test(api/routes): unit coverage for <x> — <one-line summary>

<2-4 sentence body: endpoints covered, RBAC matrix pinned, any
state-machine or fraud-guard behaviour exercised, what the integration
test (if any) does NOT cover that this file does>

Tests: <N> cases across <M> endpoints." -- apps/api/src/routes/<x>.test.ts

# Rebase-retry push (mandatory under fanout):
for i in 1 2 3 4 5; do
  if git push origin main; then break; fi
  git fetch origin main
  git rebase origin/main
done
```

**No `Co-Authored-By: Claude` trailer.** Conventional-commit format (`test(api/routes): ...`).

## Reporting

Single-paragraph report (under 150 words):
- Commit SHA
- Endpoints covered + test count
- Any endpoint deliberately skipped + why (e.g. "covered by existing integration test", "needs real DB")
- Anything surprising in the route source: missing audit log, undocumented RBAC behaviour, Zod schema drift from caller assumptions

## Anti-patterns

- **Don't fabricate Prisma calls.** The hoisted mock must mirror what the route actually calls — read the route source first.
- **Don't write integration-tier setup in a unit test.** No real DB, no real Sarvam, no real Razorpay HMAC unless you're explicitly pinning crypto behaviour (then use `crypto.createHmac` directly, not network calls).
- **Don't test framework code.** Don't assert that `express.json()` parses JSON. Test the route's behaviour, not Express.
- **Don't skip the `--` in `git commit -m "..." -- <files>`.** Concurrent agents in a fanout will pull each other's staged files into your commit otherwise.
- **Don't mock more than the route uses.** Over-mocking makes the test fragile to refactors that should be safe.
