#!/usr/bin/env node
/**
 * Migration safety check (dry-run prisma migrate diff in CI).
 *
 * Why this exists:
 *   medcore's deploy.sh ultimately runs `prisma db push` against the demo
 *   box. NOT-NULL on a populated table without a default, a column drop,
 *   type narrowing, a UNIQUE on a column with duplicates, or an FK without
 *   an explicit ON DELETE strategy = guaranteed prod outage / data loss.
 *   This script DRY-RUNS the migration via `prisma migrate diff --script`
 *   and post-processes the emitted Postgres DDL to detect the five
 *   high-severity risk classes below. CI invokes it on PR / push BEFORE
 *   the deploy job runs the real db push.
 *
 *   Ported from globussoft-crm/backend/scripts/check-migration-safety.js
 *   (MySQL DDL dialect) for medcore's Postgres dialect. Same architecture,
 *   same CLI, same JSON output shape — just regex patterns rewritten for
 *   what `prisma migrate diff` emits when the datasource is postgresql.
 *
 * Commit-message blessings:
 *   When the detector can't reason at the semantic level — e.g. tightening
 *   a `@@unique([provider, externalId])` to `@@unique([tenantId, provider,
 *   externalId])` is strictly MORE permissive but trips UNIQUE_ADDITION —
 *   the author can opt-in to skip the matching detector for THIS commit
 *   only by adding one of these markers anywhere in the latest commit
 *   message:
 *     [allow-unique]    — bless UNIQUE_ADDITION risks
 *     [allow-drop]      — bless COLUMN_DROP risks
 *     [allow-not-null]  — bless NOT_NULL_WITHOUT_DEFAULT risks
 *     [allow-narrow]    — bless TYPE_NARROWING risks
 *   Blessings are case-insensitive and read once per run from `git log -1
 *   --format=%B`. Pass `--no-commit-blessings` to disable. Blessed risks
 *   are still recorded in the JSON report under `suppressed: true` so the
 *   CI summary shows what was waived. There is intentionally NO
 *   `[allow-fk-without-on-delete]` — that one is too easy to default into.
 *
 * Risk classes detected (Postgres DDL):
 *   1. NOT-NULL added to existing column without DEFAULT
 *      Patterns:
 *        ALTER TABLE "..." ALTER COLUMN "..." SET NOT NULL
 *        ALTER TABLE "..." ADD COLUMN "..." <type> NOT NULL  (no DEFAULT)
 *      Flagged when NOT NULL is being SET without a non-null DEFAULT, AND
 *      the FROM schema actually had the column nullable (we walk the .prisma
 *      datamodel to skip MODIFYs caused by type changes on already-NOT-NULL
 *      columns — those are caught by the narrowing detector).
 *   2. Column drop on a (potentially) populated table
 *      Pattern: ALTER TABLE "..." DROP COLUMN "..."
 *      Always flagged. Bless with --allow-drop or [allow-drop] in the commit.
 *   3. Type narrowing
 *      Pattern: ALTER TABLE "..." ALTER COLUMN "..." TYPE varchar(N) where
 *      N <= 50, or any other narrowing target. We can't see the FROM type
 *      from a single ALTER COLUMN TYPE statement, but Prisma only emits a
 *      type ALTER when the type ACTUALLY CHANGED — so a width drop is
 *      necessarily a narrowing.
 *   4. UNIQUE constraint added (potentially over duplicate values)
 *      Patterns:
 *        CREATE UNIQUE INDEX "..." ON "..."(...)
 *        ALTER TABLE "..." ADD CONSTRAINT "..." UNIQUE (...)
 *      Bless with --allow-unique or [allow-unique].
 *   5. Foreign key added without explicit ON DELETE
 *      Pattern: ALTER TABLE "..." ADD CONSTRAINT "..." FOREIGN KEY (...)
 *               REFERENCES "..."(...) — no ON DELETE clause.
 *      Postgres defaults to NO ACTION (close to RESTRICT semantics).
 *      DROP FOREIGN KEY — sorry, DROP CONSTRAINT — is intentionally NOT
 *      flagged: when a FK rule changes (Cascade → Restrict), Prisma emits
 *      DROP CONSTRAINT + ADD CONSTRAINT. The DROP half can't declare
 *      ON DELETE; the ADD half is the candidate.
 *
 * Output contract:
 *   - Non-risk run: `[OK] No migration risks detected (N statements analyzed)`
 *     to stdout, exit code 0.
 *   - Any risk: one `[RISK]` log line per finding to stderr with shape
 *     `[RISK] <class>: <table>.<column> — <reason>`, plus a JSON report
 *     at the end (consumed by the CI workflow's summary step). Exit code 1.
 *   - Diff failure (prisma engine error, schema parse error): exit code 2
 *     (treated by CI as gate failure, distinct from risk finding).
 *
 * CLI:
 *   node check-migration-safety.js \
 *     --schema fixtures/safe.prisma \
 *     --against fixtures/baseline.prisma \
 *     [--allow-drop] [--allow-unique] [--no-commit-blessings] [--json] [--verbose]
 *
 *   --schema      "to" datamodel — the proposed change. Defaults to
 *                  packages/db/prisma/schema.prisma.
 *   --against     "from" datamodel — the baseline. In CI this is the
 *                  merge-base or HEAD~1.
 *   --allow-drop  Bless column drops for this run.
 *   --allow-unique Bless UNIQUE additions for this run.
 *   --no-commit-blessings
 *                 Disable scanning the latest commit message for
 *                 [allow-unique]/[allow-drop]/[allow-not-null]/[allow-narrow]
 *                 markers. Used by the test suite.
 *   --json        Emit a single JSON report to stdout.
 *   --verbose     Echo the raw migrate-diff SQL too.
 *
 * Env override (testing only):
 *   MIGRATION_SAFETY_COMMIT_MSG — when set, the blessing scanner uses this
 *   string instead of shelling out to `git log`. Lets the spec feed
 *   synthetic commit messages without fabricating real commits.
 */

'use strict';

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Commit-message blessings ────────────────────────────────────────
function readBlessingsFromCommitMessage() {
  let msg = '';
  if (typeof process.env.MIGRATION_SAFETY_COMMIT_MSG === 'string') {
    msg = process.env.MIGRATION_SAFETY_COMMIT_MSG;
  } else {
    try {
      msg = execSync('git log -1 --format=%B', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      msg = '';
    }
  }
  return {
    allowUnique: /\[allow-unique\]/i.test(msg),
    allowDrop: /\[allow-drop\]/i.test(msg),
    allowNotNull: /\[allow-not-null\]/i.test(msg),
    allowNarrow: /\[allow-narrow\]/i.test(msg),
    raw: msg,
  };
}

// ── Argv parsing ────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    schema: null,
    against: null,
    allowDrop: false,
    allowUnique: false,
    noCommitBlessings: false,
    json: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--schema': args.schema = argv[++i]; break;
      case '--against': args.against = argv[++i]; break;
      case '--allow-drop': args.allowDrop = true; break;
      case '--allow-unique': args.allowUnique = true; break;
      case '--no-commit-blessings': args.noCommitBlessings = true; break;
      case '--json': args.json = true; break;
      case '--verbose': args.verbose = true; break;
      case '-h':
      case '--help':
        process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith(' *')).map(l => l.slice(3)).join('\n'));
        process.exit(0);
        break;
      default:
        if (a.startsWith('--')) {
          process.stderr.write(`[migration-safety] unknown arg: ${a}\n`);
          process.exit(2);
        }
    }
  }
  if (!args.schema) {
    args.schema = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');
  } else {
    args.schema = path.resolve(args.schema);
  }
  if (args.against) args.against = path.resolve(args.against);
  return args;
}

// ── prisma migrate diff invocation ──────────────────────────────────
//
// `prisma migrate diff --script` for a postgresql datasource emits Postgres
// DDL with double-quoted identifiers. We pass --exit-code so a non-empty
// diff returns exit 2 (which we treat as success — we WANT the diff).
function runMigrateDiff({ schema, against, verbose }) {
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const argsList = ['prisma', 'migrate', 'diff'];
  // medcore pins prisma@6.19.3 (package-lock root). Prisma 6 uses
  // `--from-schema-datamodel` / `--to-schema-datamodel`. Prisma 7 renamed
  // these to `--from-schema` / `--to-schema` and they're not aliased —
  // hence the strict pin.
  if (against) {
    argsList.push('--from-schema-datamodel', against);
  } else {
    argsList.push('--from-empty');
  }
  argsList.push('--to-schema-datamodel', schema);
  argsList.push('--script');
  argsList.push('--exit-code');

  if (verbose) {
    process.stderr.write(`[migration-safety] running: ${npxCmd} ${argsList.join(' ')}\n`);
  }

  // The cwd needs to be a directory where `npx prisma` resolves the local
  // copy. Use packages/db/ so we get the workspace's pinned prisma.
  const dbPkgDir = path.resolve(__dirname, '..');
  let stdout = '';
  try {
    stdout = execFileSync(npxCmd, argsList, {
      cwd: dbPkgDir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
  } catch (e) {
    if (e.status === 2) {
      stdout = (e.stdout || '').toString();
    } else {
      const stderr = e.stderr ? e.stderr.toString() : '';
      process.stderr.write(`[migration-safety] prisma migrate diff failed (exit ${e.status}):\n${stderr || e.message}\n`);
      process.exit(2);
    }
  }
  return stdout;
}

// ── SQL parsing helpers (Postgres dialect) ──────────────────────────
//
// Postgres DDL emitted by `prisma migrate diff --script` uses double-quoted
// identifiers. Statements are line-oriented and end with `;`. Splitting on
// semicolons works because Prisma never emits a function body with embedded
// semicolons in this path.
function splitStatements(sql) {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n');
  return cleaned
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

// Extract the table name from an `ALTER TABLE "name" ...` or
// `ALTER TABLE "schema"."name" ...` head. Postgres accepts unquoted
// identifiers too if they're lowercase and don't collide with keywords;
// Prisma always emits double-quoted identifiers from migrate diff, but
// stay tolerant of the unquoted case.
function tableOf(stmt) {
  // Try schema-qualified form first ("public"."Foo" or "Foo"), then bare.
  let m = stmt.match(/ALTER\s+TABLE\s+(?:"[^"]+"\s*\.\s*)?"([A-Za-z0-9_]+)"/i);
  if (m) return m[1];
  m = stmt.match(/ALTER\s+TABLE\s+([A-Za-z0-9_]+)/i);
  return m ? m[1] : null;
}

function typeWidth(typeStr) {
  const m = typeStr.match(/\(\s*(\d+)\s*\)/);
  return m ? Number(m[1]) : null;
}

function typeFamily(typeStr) {
  const m = typeStr.toLowerCase().match(/^([a-z][a-z0-9_]*)/);
  return m ? m[1] : null;
}

// ── Schema parser (lightweight) ─────────────────────────────────────
//
// We need to know, for each ALTER COLUMN ... SET NOT NULL statement,
// whether the FROM schema already had the column non-nullable. Walking
// the FROM .prisma datamodel suffices.
//
// Returns: { '<Model>.<field>': { nullable: boolean } }
function parseFromSchema(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const src = fs.readFileSync(filePath, 'utf8');
  const out = {};
  const modelRe = /^model\s+(\w+)\s*\{([^}]*)\}/gm;
  let m;
  while ((m = modelRe.exec(src)) !== null) {
    const modelName = m[1];
    const body = m[2];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      const f = line.match(/^(\w+)\s+([\w()]+)(\??)/);
      if (!f) continue;
      const [, fieldName, , optional] = f;
      out[`${modelName}.${fieldName}`] = { nullable: optional === '?' };
    }
  }
  return out;
}

// ── Risk detectors (Postgres dialect) ───────────────────────────────

function detectNotNullWithoutDefault(stmt, ctx) {
  const risks = [];
  const upper = stmt.toUpperCase();
  if (!upper.includes('NOT NULL') && !upper.includes('SET NOT NULL')) {
    return risks;
  }

  const tbl = tableOf(stmt);
  if (!tbl) return risks;

  // Two Postgres patterns:
  //   ALTER TABLE "Foo" ALTER COLUMN "bar" SET NOT NULL
  //   ALTER TABLE "Foo" ADD COLUMN "bar" varchar(255) NOT NULL
  // (CHANGE / MODIFY do not exist in Postgres.)
  let isAlterColumn = false;
  let isAddColumn = false;
  let col = null;

  let m = stmt.match(/ALTER\s+COLUMN\s+"([A-Za-z0-9_]+)"/i);
  if (m) {
    isAlterColumn = true;
    col = m[1];
  } else {
    m = stmt.match(/ADD\s+COLUMN\s+"([A-Za-z0-9_]+)"/i);
    if (m) {
      isAddColumn = true;
      col = m[1];
    }
  }
  if (!col) return risks;

  // For ALTER COLUMN the NOT NULL transition we care about is
  //   ALTER COLUMN "x" SET NOT NULL
  // That's only emitted by Prisma when the FROM schema had the column
  // nullable and the TO schema has it non-nullable. So if the FROM map
  // says non-nullable, this can't be a SET NOT NULL — Prisma wouldn't
  // emit it. But stay defensive: if the FROM schema column is already
  // non-nullable, skip (ALTER COLUMN ... TYPE on an already-non-nullable
  // column is a type change; the narrowing detector handles it).
  if (isAlterColumn && ctx && ctx.fromFields) {
    const key = `${tbl}.${col}`;
    const prior = ctx.fromFields[key];
    if (prior && !prior.nullable) {
      return risks;
    }
  }

  // For both shapes, look for DEFAULT in the column-definition tail.
  // Postgres DEFAULT NULL is a no-op (column defaults to NULL anyway)
  // so it doesn't satisfy the not-null contract.
  const colHeadMatch = stmt.match(/(?:ALTER|ADD)\s+COLUMN\s+"[A-Za-z0-9_]+"/i);
  const tail = colHeadMatch
    ? stmt.slice(stmt.indexOf(colHeadMatch[0]) + colHeadMatch[0].length)
    : '';
  const tailUpper = tail.toUpperCase();
  const hasDefault = /\bDEFAULT\b/.test(tailUpper);
  const hasDefaultNull = /\bDEFAULT\s+NULL\b/.test(tailUpper);

  if (isAlterColumn && /SET\s+NOT\s+NULL/i.test(stmt)) {
    if (!hasDefault || hasDefaultNull) {
      risks.push({
        class: 'NOT_NULL_WITHOUT_DEFAULT',
        table: tbl,
        column: col,
        statement: stmt,
        message: `${tbl}.${col} — NOT NULL without a non-null DEFAULT will fail on populated rows. Add a DEFAULT clause or backfill before tightening.`,
      });
    }
  } else if (isAddColumn && /NOT\s+NULL/i.test(tail)) {
    if (!hasDefault || hasDefaultNull) {
      risks.push({
        class: 'NOT_NULL_WITHOUT_DEFAULT',
        table: tbl,
        column: col,
        statement: stmt,
        message: `${tbl}.${col} — NOT NULL without a non-null DEFAULT will fail on populated rows. Add a DEFAULT clause or backfill before tightening.`,
      });
    }
  }
  return risks;
}

function detectColumnDrop(stmt) {
  const risks = [];
  // ALTER TABLE "Foo" DROP COLUMN "bar"
  // (Postgres also has IF EXISTS variant; cover both.)
  const m = stmt.match(/ALTER\s+TABLE\s+(?:"[^"]+"\s*\.\s*)?"([A-Za-z0-9_]+)"\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"([A-Za-z0-9_]+)"/i);
  if (m) {
    risks.push({
      class: 'COLUMN_DROP',
      table: m[1],
      column: m[2],
      statement: stmt,
      message: `${m[1]}.${m[2]} — column drop will discard existing data. Confirm with --allow-drop / [allow-drop] or stage a rename-then-drop two-deploy pattern.`,
    });
  }
  return risks;
}

function detectTypeNarrowing(stmt) {
  const risks = [];
  // Postgres pattern: ALTER TABLE "Foo" ALTER COLUMN "bar" TYPE varchar(50)
  // or: ALTER TABLE "Foo" ALTER COLUMN "bar" SET DATA TYPE varchar(50)
  const m = stmt.match(/ALTER\s+TABLE\s+(?:"[^"]+"\s*\.\s*)?"([A-Za-z0-9_]+)"\s+ALTER\s+COLUMN\s+"([A-Za-z0-9_]+)"\s+(?:SET\s+DATA\s+)?TYPE\s+([A-Za-z][A-Za-z0-9_]*(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)/i);
  if (!m) return risks;
  const [, table, column, rawType] = m;
  const family = typeFamily(rawType);
  const width = typeWidth(rawType);

  // Width-based narrowing detection (mirrors the MySQL port's heuristic):
  // any varchar/char with width <= 50 in an ALTER COLUMN TYPE is a
  // narrowing. Prisma only emits ALTER COLUMN TYPE when the type
  // actually changed — so a width drop is necessarily a narrowing.
  if (['varchar', 'char'].includes(family) && width !== null && width <= 50) {
    risks.push({
      class: 'TYPE_NARROWING',
      table, column,
      statement: stmt,
      message: `${table}.${column} — narrowed to ${rawType.toUpperCase()}; existing values longer than ${width} chars will be truncated. Verify max(LENGTH(${column})) before merging.`,
    });
  }

  // Family-level narrowing: text → varchar (any width), bigint → int, etc.
  // Postgres's ALTER COLUMN TYPE typically requires a USING clause for
  // implicit narrowing-to-stricter conversions, but Prisma emits a bare
  // TYPE change which Postgres accepts when the conversion is implicit
  // (e.g. text → varchar). Flag the obvious narrowing targets.
  const narrowFamilies = new Set(['varchar', 'char', 'int', 'integer', 'smallint', 'real', 'date']);
  // We can't see the FROM family from the statement. The width-based
  // varchar branch above covers the common case. Leave the family branch
  // empty here unless additional narrowing patterns surface in the wild.
  return risks;
}

function detectUniqueAddition(stmt) {
  const risks = [];
  // Postgres patterns:
  //   CREATE UNIQUE INDEX "name" ON "schema"."Foo"("col")
  //   CREATE UNIQUE INDEX "name" ON "Foo"("col", "col2")
  //   ALTER TABLE "Foo" ADD CONSTRAINT "name" UNIQUE ("col", "col2")
  let m = stmt.match(/CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"[A-Za-z0-9_]+"\s+ON\s+(?:"[^"]+"\s*\.\s*)?"([A-Za-z0-9_]+)"\s*\(\s*([^)]+)\s*\)/i);
  if (!m) {
    m = stmt.match(/ALTER\s+TABLE\s+(?:"[^"]+"\s*\.\s*)?"([A-Za-z0-9_]+)"\s+ADD\s+CONSTRAINT\s+"[A-Za-z0-9_]+"\s+UNIQUE\s*\(\s*([^)]+)\s*\)/i);
  }
  if (m) {
    const [, table, cols] = m;
    risks.push({
      class: 'UNIQUE_ADDITION',
      table,
      column: cols.replace(/["\s]/g, ''),
      statement: stmt,
      message: `${table}(${cols.replace(/["\s]/g, '')}) — UNIQUE addition will fail if duplicate values exist. Run a duplicate-check query or pass --allow-unique / [allow-unique] after backfill.`,
    });
  }
  return risks;
}

function detectForeignKeyWithoutOnDelete(stmt) {
  const risks = [];
  // Skip DROP CONSTRAINT — those can't declare ON DELETE; they're paired
  // with an ADD CONSTRAINT below them which is the real candidate.
  if (/DROP\s+CONSTRAINT/i.test(stmt) && !/ADD\s+CONSTRAINT/i.test(stmt)) {
    return risks;
  }
  if (!/FOREIGN\s+KEY/i.test(stmt)) return risks;
  const tbl = tableOf(stmt);
  const colMatch = stmt.match(/FOREIGN\s+KEY\s*\(\s*"([A-Za-z0-9_]+)"\s*\)/i);
  const col = colMatch ? colMatch[1] : null;
  if (!/ON\s+DELETE/i.test(stmt)) {
    risks.push({
      class: 'FK_WITHOUT_ON_DELETE',
      table: tbl,
      column: col,
      statement: stmt,
      message: `${tbl}.${col} — foreign key added without explicit ON DELETE. Postgres defaults to NO ACTION (RESTRICT-like) which is a silent semantic change. Declare onDelete: Cascade|SetNull|Restrict in schema.prisma.`,
    });
  }
  return risks;
}

// ── Main analyser ───────────────────────────────────────────────────
function analyse(sql, opts) {
  const stmts = splitStatements(sql);
  const ctx = {
    fromFields: opts && opts.against ? parseFromSchema(opts.against) : {},
  };
  const allRisks = [];
  for (const stmt of stmts) {
    allRisks.push(...detectNotNullWithoutDefault(stmt, ctx));
    allRisks.push(...detectColumnDrop(stmt));
    allRisks.push(...detectTypeNarrowing(stmt));
    allRisks.push(...detectUniqueAddition(stmt));
    allRisks.push(...detectForeignKeyWithoutOnDelete(stmt));
  }

  const blessings = (opts && opts.blessings) || {
    allowUnique: false, allowDrop: false, allowNotNull: false, allowNarrow: false,
  };
  for (const r of allRisks) {
    if (r.class === 'COLUMN_DROP' && opts.allowDrop) {
      r.suppressed = true;
      r.suppressedBy = 'flag';
    } else if (r.class === 'COLUMN_DROP' && blessings.allowDrop) {
      r.suppressed = true;
      r.suppressedBy = 'commit-blessing';
    } else if (r.class === 'UNIQUE_ADDITION' && opts.allowUnique) {
      r.suppressed = true;
      r.suppressedBy = 'flag';
    } else if (r.class === 'UNIQUE_ADDITION' && blessings.allowUnique) {
      r.suppressed = true;
      r.suppressedBy = 'commit-blessing';
    } else if (r.class === 'NOT_NULL_WITHOUT_DEFAULT' && blessings.allowNotNull) {
      r.suppressed = true;
      r.suppressedBy = 'commit-blessing';
    } else if (r.class === 'TYPE_NARROWING' && blessings.allowNarrow) {
      r.suppressed = true;
      r.suppressedBy = 'commit-blessing';
    }
  }

  return {
    statementCount: stmts.length,
    risks: allRisks,
    failing: allRisks.filter(r => !r.suppressed),
    blessedCount: allRisks.filter(r => r.suppressedBy === 'commit-blessing').length,
  };
}

// ── Entrypoint ──────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.schema)) {
    process.stderr.write(`[migration-safety] schema not found: ${opts.schema}\n`);
    process.exit(2);
  }
  if (opts.against && !fs.existsSync(opts.against)) {
    process.stderr.write(`[migration-safety] against schema not found: ${opts.against}\n`);
    process.exit(2);
  }

  opts.blessings = opts.noCommitBlessings
    ? { allowUnique: false, allowDrop: false, allowNotNull: false, allowNarrow: false }
    : readBlessingsFromCommitMessage();

  const sql = runMigrateDiff(opts);
  if (opts.verbose) {
    process.stderr.write('--- migrate diff SQL ---\n');
    process.stderr.write(sql);
    process.stderr.write('\n--- end SQL ---\n');
  }

  const report = analyse(sql, opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      schema: opts.schema,
      against: opts.against,
      statementCount: report.statementCount,
      riskCount: report.failing.length,
      suppressedCount: report.risks.length - report.failing.length,
      blessedCount: report.blessedCount,
      blessings: {
        allowUnique: !!opts.blessings.allowUnique,
        allowDrop: !!opts.blessings.allowDrop,
        allowNotNull: !!opts.blessings.allowNotNull,
        allowNarrow: !!opts.blessings.allowNarrow,
      },
      risks: report.risks,
    }, null, 2) + '\n');
  } else {
    for (const r of report.risks) {
      if (r.suppressedBy === 'commit-blessing') {
        process.stdout.write(`[BLESSED] ${r.class}: ${r.message}\n`);
      }
    }
    if (report.failing.length === 0) {
      process.stdout.write(`[OK] No migration risks detected (${report.statementCount} statements analyzed)\n`);
      const flagSuppressed = report.risks.filter(r => r.suppressedBy === 'flag').length;
      if (flagSuppressed > 0) {
        process.stdout.write(`     (${flagSuppressed} risks suppressed via --allow-* flags)\n`);
      }
      if (report.blessedCount > 0) {
        process.stdout.write(`[BLESSED] ${report.blessedCount} risk(s) suppressed by commit-message blessings\n`);
      }
    } else {
      process.stderr.write(`[migration-safety] ${report.failing.length} risk(s) detected across ${report.statementCount} DDL statement(s):\n\n`);
      for (const r of report.failing) {
        process.stderr.write(`[RISK] ${r.class}: ${r.message}\n`);
      }
      if (report.blessedCount > 0) {
        process.stderr.write(`\n[BLESSED] ${report.blessedCount} risk(s) suppressed by commit-message blessings\n`);
      }
      process.stderr.write(`\nReview the SQL with --verbose; bless intentional drops/uniques with --allow-drop / --allow-unique flags or [allow-drop] / [allow-unique] / [allow-not-null] / [allow-narrow] in the commit message.\n`);
    }
  }

  process.exit(report.failing.length > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  splitStatements,
  parseFromSchema,
  analyse,
  readBlessingsFromCommitMessage,
  detectNotNullWithoutDefault,
  detectColumnDrop,
  detectTypeNarrowing,
  detectUniqueAddition,
  detectForeignKeyWithoutOnDelete,
};
