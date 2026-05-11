# Prisma 6.19.3 → 7.8.0 Migration Plan (stop-point report)

Captures the research findings from the 2026-05-11 attempt on
`feat/prisma-7-migration` (closes #470). The migration was **STOPPED before
touching source code** because the Prisma 7 surface change hits multiple
explicit stop-and-report criteria — see "Why stopped" below. This document
exists so the next session (or the user, after making the architectural
calls flagged here) can pick up where this one left off without re-doing
the research.

---

## What Prisma 7 changes (verified against the upstream upgrade guide)

Source: `https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7`

### 1. ESM-only — no CommonJS path

> "Prisma ORM now ships as an ES module."

Required consumer changes:
- `package.json` → `"type": "module"`
- `tsconfig.json` → `"module": "ESNext"`, `"moduleResolution": "bundler"`,
  `"target": "ES2023"`

There is **no `moduleFormat: "cjs"` escape hatch** documented in the v7
generator. The classic `@prisma/client` import path is **not preserved**
in v7 — the generated client lives at the path declared in the schema's
`generator client { output = "..." }` block (typically
`./generated/prisma/client`).

### 2. Generator switch

```prisma
// Before (Prisma 6)
generator client {
  provider = "prisma-client-js"
}

// After (Prisma 7)
generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}
```

### 3. `prisma.config.ts` is now mandatory

The `url`, `directUrl`, and `shadowDatabaseUrl` fields in the
`datasource` block are removed. Connection config lives in a new
`prisma.config.ts` next to the schema:

```ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
```

### 4. `PrismaClient` requires a driver adapter

```ts
// Before
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// After
import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
```

### 5. `migrate diff` CLI flag renames

- `--from-schema-datamodel` → `--from-schema`
- `--to-schema-datamodel` → `--to-schema`
- `--from-url` → `--from-config-datasource`
- `--to-url` → `--to-config-datasource`
- `--shadow-database-url` removed (now in `prisma.config.ts`)

### 6. Removed APIs

- `prisma.$use(...)` (middleware) — must be replaced by `$extends` query hooks.
  **medcore is unaffected**: `grep -r '\.\$use(' medcore` returns no results.
- Connection-pool defaults differ between Prisma 6 and the v7 driver
  adapters (PrismaPg uses the underlying `pg` driver's pool defaults; these
  may differ significantly from Prisma 6's bundled pool).

---

## Inventory of medcore's affected surface (verified by grep, 2026-05-11)

| Surface | Count | Files (representative) |
|---|---|---|
| Files importing `from "@prisma/client"` | **47** | `apps/api/src/services/abdm/consent.ts`, `apps/api/src/services/notification.ts`, `apps/api/src/routes/ai-scribe.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/test/helpers/audit-wait.ts`, ... |
| Sites calling `new PrismaClient(...)` | **33** | `packages/db/src/client.ts` (the canonical one), 32 seed scripts in `packages/db/src/seed-*.ts`, 1 reseed-demo-accounts script |
| Files referencing any Prisma `$` API surface | **127** | (per the diff-surface grep — mostly `$extends`, `$transaction`, `$queryRaw` which are all preserved in v7) |
| `$use(...)` callers | **0** | none — clean |
| `$on(...)` callers | **0** | none — clean |

**The two big concrete change sets**:

A. **47 import-rewrites** from `from "@prisma/client"` →
   `from "@medcore/db/generated/prisma/client"` (the new generator output
   path), OR keep a thin re-export shim in `packages/db/src/index.ts` that
   forwards the new path under the legacy specifier.

B. **33 `new PrismaClient()` constructor sites** all need adapter wiring.
   Realistically this should be solved by a centralized factory in
   `packages/db/src/client.ts` and the 32 seed scripts should be
   refactored to **import `prisma` from `@medcore/db`** instead of
   constructing their own. (That refactor is independently desirable —
   today each seed script opens a fresh connection pool, which costs
   a TCP roundtrip × 33 on `deploy.sh` reseeds.)

---

## Workspace-shape blockers (the structural deltas that turn this from a 1-day to a multi-day job)

1. **CommonJS-only workspace.** The repo today is uniformly CJS:
   - `apps/api/tsconfig.json` → `"module": "CommonJS"`,
     `"moduleResolution": "node"`
   - `tsconfig.base.json` → `"module": "ESNext"` but `target: ES2022`,
     and the per-app tsconfigs override module back to CJS
   - No `package.json` in the workspace declares `"type": "module"`
   - The integration test suite runs via `vitest` with `singleFork: true`
     and relies on `vi.mock`'s CJS-style hoisting semantics (documented
     in `CLAUDE.md` gotcha #2)
   - `tsx` is used at the `dev` entrypoint for both api and the seed
     scripts; `tsx` handles ESM/CJS interop but the downstream code
     contracts assume CJS resolution

   **Flipping the workspace to ESM is invasive.** Every workspace
   `package.json` needs `"type": "module"`, every relative import inside
   `apps/api/src/` (hundreds of sites) needs the `.js` extension under
   bundler-mode TS, and the vitest config needs validation under ESM
   loader semantics. This is the biggest risk multiplier.

2. **Adapter-package architectural choice (STOP-AND-REPORT criterion #4
   from the brief).** Prisma 7 ships multiple adapter options:
   - `@prisma/adapter-pg` — wraps the `pg` driver (native libpq via node-postgres).
     Works on Node and standard hosts. **Most natural fit for medcore.**
   - `@prisma/adapter-pg-worker` — pg-compatible adapter built for
     Cloudflare Workers / Vercel Edge.
   - `@prisma/adapter-neon` — for Neon's serverless driver.
   - `@prisma/adapter-libsql` — non-applicable here.

   medcore currently runs on PM2 (Node, classic VPS at
   `medcore.globusdemos.com`), so `@prisma/adapter-pg` is the
   non-controversial choice. **But** the connection-pool sizing changes
   under that adapter (uses `pg.Pool` defaults, not Prisma's bundled
   pool). The brief explicitly flags this as a "your call would be a
   guess" stop point.

3. **`prisma.config.ts` migrations.seed contract.** The seed entry in v7
   moves from `package.json#prisma.seed` (which medcore doesn't currently
   use — seeding goes through `deploy.sh` and `npm run db:seed` →
   `turbo db:seed` → per-package `tsx` invocations) to
   `migrations.seed: "tsx prisma/seed.ts"`. medcore has 30 distinct seed
   scripts wired via `deploy.sh` step 8b through 9e. Picking which one
   becomes "THE" `prisma.config.ts` seed (vs. keeping the multi-seed
   chain unwired from Prisma's notion of "seed") is a product call.

4. **Connection-pool sizing under PrismaPg.** PRD-adjacent: the
   integration test suite's `resetDB()` helper assumes Prisma's
   bundled pool size (~5 connections by default). Under `@prisma/adapter-pg`
   the pool defaults come from `pg.Pool` (10 connections). This may
   silently fix or silently break the `singleFork: true` test
   contention pattern — needs an empirical pass, not a desk decision.

---

## Why stopped

Per the dispatch brief, all of these are explicit stop-and-report criteria:

> **A Prisma 7 API surface change that has multiple valid interpretations
> (your call would be a guess)**

- Hits #1: PrismaClient construction. Whether to add a thin re-export shim
  in `packages/db` to keep the 47 `from "@prisma/client"` import sites
  working, vs. doing 47 import rewrites across the api app, is a stylistic
  call I should not make unilaterally.
- Hits #2: Workspace ESM flip. Today's CJS layout is load-bearing for
  vitest's `singleFork: true` + `vi.mock` hoisting (documented invariant
  in `CLAUDE.md` gotcha #2). Flipping the workspace to ESM may break
  ~150 integration tests in ways that take a day each to diagnose. That's
  a Phase-2 vs Phase-1 product call.

> **The `prisma.config.ts` file needs an `adapter` for direct database
> connection (which one? `@prisma/adapter-pg` vs the bundled one? — that's
> an architectural choice)**

- Confirmed: yes, an adapter is required at construction time
  (`new PrismaClient({ adapter })`). `@prisma/adapter-pg` is the natural
  fit; the connection-pool-sizing flip-effect on the integration test
  suite is a known risk that needs empirical validation.

> **A schema syntax change that requires a database-side migration (could
> break prod)**

- Not strictly hit. The schema change (removing `url = env("DATABASE_URL")`
  from the datasource block) is metadata-only — no DDL is emitted. But the
  combined effect (new generator output path → migration history
  bookkeeping shifts) needs `prisma migrate diff` to be validated against
  the live demo DB before merge, which I cannot do safely in a foreground
  agent session without coordination.

---

## Proposed phased execution (for the next session, after the user makes
the architectural calls above)

### Phase 0 — Prep (no Prisma version bump)
- Centralize all `new PrismaClient(...)` construction into
  `packages/db/src/client.ts`. The 32 seed scripts switch to `import { prisma } from "@medcore/db"`. **Independently mergeable** — closes a real
  CPU-and-connection-pool waste, no version bump.

### Phase 1 — Schema + config rewrite (no consumer changes yet)
- Add the `output` field to the generator block in
  `packages/db/prisma/schema.prisma`.
- Remove `url = env("DATABASE_URL")` from the datasource block.
- Create `packages/db/prisma.config.ts` with the chosen adapter.
- Update `packages/db/scripts/check-migration-safety.js` flag names
  (`--from-schema-datamodel` → `--from-schema`,
  `--to-schema-datamodel` → `--to-schema`).
- `package.json` (root + `packages/db`) bump `@prisma/client` +
  `prisma` to `^7.8.0`, add `@prisma/adapter-pg`.
- `npm install` + commit lockfile.

### Phase 2 — Consumer migration (the long one)
- Add re-export shim in `packages/db/src/index.ts`:
  `export { PrismaClient } from "./generated/prisma/client"` (this
  preserves the `import { PrismaClient } from "@medcore/db"` pattern that
  already exists at `packages/db/src/index.ts:6`).
- Run the 47-import rewrite: `from "@prisma/client"` →
  `from "@medcore/db"` (much cleaner specifier than the generated path).
- Update `packages/db/src/client.ts` to construct via PrismaPg adapter.
- Update `apps/api/src/test/helpers/audit-wait.ts` to import types
  from `@medcore/db` (it's the one test helper that goes direct).

### Phase 3 — Workspace ESM flip (highest-risk, can defer)
- `"type": "module"` on workspace `package.json`s.
- Per-app tsconfig flips to `"module": "ESNext"`,
  `"moduleResolution": "bundler"`.
- All relative imports inside `apps/api/src/` get `.js` extensions.
- Vitest + tsx config validation pass.
- Integration suite green-validation (the long pole).

### Phase 4 — Verify + ship
- `npx prisma validate`
- `npx tsc --noEmit` (all workspaces)
- `npm run test:unit`
- `npm run test:contract`
- `npm run test:api` (integration — the real risk surface)
- `npm run build` (all workspaces, both for api dist + the new
  generated client output)
- `npm run test:e2e` (Playwright — light smoke)

---

## What this PR contains

Only this planning doc. Working tree was kept clean — no code changes
were applied because Phase 0 cannot proceed past the
adapter-choice + workspace-ESM-flip product calls flagged above.

The branch `feat/prisma-7-migration` is suitable for picking up Phase 0
work (the seed-script consolidation refactor, which is independently
mergeable) without waiting for the architectural decisions.
