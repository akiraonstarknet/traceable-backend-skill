#!/usr/bin/env node
// Proves the drift checker fails when it should.
//
// A checker nobody has seen fail is a checker nobody should trust. Each case
// below breaks the reference app in one specific way, runs the real checker, and
// asserts the expected finding id appears. Everything is restored afterwards,
// including on failure.
//
// Usage: node scripts/self-test.mjs [pathToReferenceApp]
//   Requires a database: run the reference app's `npm run setup` first.
//   Without DATABASE_URL the database cases are skipped and reported as skipped.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = resolve(process.argv[2] ?? join(SKILL_ROOT, 'examples', 'reference-app'));

if (!existsSync(join(APP, 'traceable.config.json'))) {
  console.error(`No traceable.config.json in ${APP}`);
  process.exit(2);
}

loadEnvFile(join(APP, '.env'));
const hasDb = Boolean(process.env.DATABASE_URL);

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** Runs the real checker and returns the finding ids it produced. */
function driftIds(extraArgs = []) {
  try {
    execFileSync(process.execPath, [join(SKILL_ROOT, 'scripts', 'check-drift.mjs'), APP, ...extraArgs],
      { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // Non-zero exit is the expected outcome for a broken case.
  }
  const report = JSON.parse(readFileSync(join(APP, '.traceable', 'drift.json'), 'utf8'));
  return { ids: report.findings.map((f) => f.id), report };
}

const edits = [];
function patch(relPath, transform) {
  const full = join(APP, relPath);
  const before = readFileSync(full, 'utf8');
  edits.push({ full, before });
  const after = transform(before);
  if (after === before) throw new Error(`patch for ${relPath} changed nothing — the test is stale`);
  writeFileSync(full, after);
}
function addFile(relPath, contents) {
  const full = join(APP, relPath);
  edits.push({ full, before: null });
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}
function restore() {
  while (edits.length) {
    const e = edits.pop();
    if (e.before === null) rmSync(e.full, { force: true });
    else writeFileSync(e.full, e.before);
  }
}

const sql = (statement) => {
  execFileSync('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-qc', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
};

const cases = [
  {
    name: 'a route with no manifest is reported',
    expect: 'route.undeclared',
    break: () => patch('src/services/health/routes/health-check.ts', (s) =>
      s.replace('export function registerHealthCheck(app: Hono): void {',
        'export function registerHealthCheck(app: Hono): void {\n  app.get(\'/secret-backdoor\', (c) => c.json({ ok: true }));')),
  },
  {
    name: 'an endpoint declared secured but left unauthenticated is reported',
    expect: 'route.auth-mismatch',
    break: () => patch('src/services/tenant-admin/routes/tenant-list.ts', (s) =>
      s.replace('      middleware: [requireAuth],\n', '')),
  },
  {
    name: 'a column that exists but is not described is reported',
    expect: 'column.undeclared',
    break: () => patch('manifests/tables/tenants.yaml', (s) =>
      s.replace(/    - name: suspended_reason\n      description:.*\n      sensitivity: internal\n/, '')),
    needsDb: true,
  },
  {
    name: 'a manifest column the table does not have is reported',
    expect: 'column.missing',
    break: () => patch('manifests/tables/tenants.yaml', (s) =>
      s.replace('  columns:\n', '  columns:\n    - name: invented_column\n      description: A column nobody created.\n')),
    needsDb: true,
  },
  {
    name: 'code touching a table its manifest forbids is reported',
    expect: 'code.undeclared-table-access',
    break: () => patch('src/services/tenant-admin/routes/tenant-list.ts', (s) =>
      s.replace('const tenants = await db.tenant.findMany',
        'await db.user.findMany({});\n      const tenants = await db.tenant.findMany')),
  },
  {
    name: 'hand-written SQL outside the allowlist is reported',
    expect: 'code.raw-query-forbidden',
    break: () => patch('src/services/tenant-admin/routes/tenant-get.ts', (s) =>
      s.replace('const db = clientForActor(TENANT_ADMIN_DB);',
        'const db = clientForActor(TENANT_ADMIN_DB);\n      await db.$queryRawUnsafe(\'select 1\');')),
  },
  {
    name: 'a gate that imports a database client is reported',
    expect: 'code.gate-side-effect',
    break: () => patch('src/jobs/tenant-status-review/gates/accept-or-reject.ts', (s) =>
      `import pg from 'pg';\n${s}`),
  },
  {
    name: 'a pipeline step in the code but not the manifest is reported',
    expect: 'pipeline.step-undeclared',
    break: () => {
      addFile('src/jobs/tenant-status-review/nodes/undeclared-step.ts', `
import type { TraceableNode } from '../../../traceable/types.js';
export const undeclaredStep: TraceableNode<unknown, unknown> = {
  type: 'node', name: 'undeclared-step',
  displayName: 'A step nobody declared', description: 'Exists only in code.',
  kind: 'code', async run(input) { return { output: input }; },
};
`);
      patch('src/jobs/tenant-status-review/index.ts', (s) =>
        s.replace("import { recordRejection } from './nodes/record-rejection.js';",
          "import { recordRejection } from './nodes/record-rejection.js';\nimport { undeclaredStep } from './nodes/undeclared-step.js';")
         .replace('    recordRejection,\n', '    recordRejection,\n    undeclaredStep,\n'));
    },
  },
  {
    name: 'an LLM node calling a different model than declared is reported',
    expect: 'pipeline.model-mismatch',
    break: () => patch('src/jobs/tenant-status-review/nodes/classify-reason.ts', (s) =>
      s.replace("export const CLASSIFY_MODEL = 'anthropic/claude-sonnet-5';",
        "export const CLASSIFY_MODEL = 'some-other/model';")),
  },
  {
    name: 'a gate route pointing at a step that does not exist is reported',
    expect: 'pipeline.gate-route-unknown',
    break: () => patch('manifests/jobs/tenant-status-review.yaml', (s) =>
      s.replace('        accept: apply-status', '        accept: step-that-does-not-exist')),
  },
  {
    name: 'a manifest that breaks its schema is reported',
    expect: 'manifest.schema',
    break: () => patch('manifests/apis/tenant-list.yaml', (s) =>
      s.replace('  auth: secured', '  auth: sort-of')),
  },
  {
    name: 'a grant on a table the manifest forbids is reported',
    expect: 'grant.forbidden',
    needsDb: true,
    break: () => sql('grant select on public.users to svc_tenant_admin'),
    undo: () => sql('revoke all on public.users from svc_tenant_admin'),
  },
  {
    name: 'a grant no manifest justifies is reported',
    expect: 'grant.excess',
    needsDb: true,
    break: () => sql('grant insert on public.tenants to svc_devops'),
    undo: () => sql('revoke insert on public.tenants from svc_devops'),
  },
  {
    name: 'a role holding privileges here that no manifest implies is reported',
    expect: 'role.orphaned',
    needsDb: true,
    break: () => {
      sql('create role svc_left_over nologin');
      // Only a role that actually holds a privilege in THIS database counts:
      // Postgres roles are cluster-wide, so a bare role is another database's
      // business, not drift here.
      sql('grant select on public.tenants to svc_left_over');
    },
    undo: () => {
      sql('revoke all on public.tenants from svc_left_over');
      sql('drop role if exists svc_left_over');
    },
  },
  {
    name: 'a cluster-wide role with no privileges here is NOT reported',
    expect: null,
    needsDb: true,
    break: () => sql('create role svc_other_application nologin'),
    undo: () => sql('drop role if exists svc_other_application'),
  },
  {
    name: 'a missing audit trigger is reported',
    expect: 'audit.trigger-missing',
    needsDb: true,
    break: () => sql("select audit.detach('public','tenants')"),
    undo: () => sql("select audit.attach('public','tenants')"),
  },
  {
    name: 'a table with no manifest is reported',
    expect: 'table.undeclared',
    needsDb: true,
    break: () => sql('create table public.undeclared_table (id text primary key)'),
    undo: () => sql('drop table if exists public.undeclared_table'),
  },
  {
    name: 'a service connecting as the owner role is reported',
    expect: 'grant.owner-at-runtime',
    needsDb: true,
    break: () => { process.env.DATABASE_URL_SVC_TENANT_ADMIN = process.env.DATABASE_URL; },
    undo: () => {
      process.env.DATABASE_URL_SVC_TENANT_ADMIN =
        'postgresql://svc_tenant_admin:demo_pw@127.0.0.1:5432/traceable_demo';
    },
  },
];

console.log(`self-test: ${APP}`);
console.log(hasDb ? 'database checks: on\n' : 'database checks: SKIPPED (no DATABASE_URL)\n');

// Baseline: the reference app must be clean before anything is broken.
const baseline = driftIds();
if (baseline.report.findings.length) {
  console.error('FAIL  the reference app has drift before any test ran:');
  for (const f of baseline.report.findings) console.error(`        ${f.id}  ${f.message}`);
  process.exit(1);
}
console.log(`PASS  baseline clean (${baseline.report.checks_run} checks)`);

let failed = 0;
let skipped = 0;

for (const c of cases) {
  if (c.needsDb && !hasDb) { console.log(`SKIP  ${c.name}`); skipped += 1; continue; }
  let ids = [];
  try {
    c.break();
    ids = driftIds().ids;
  } finally {
    restore();
    if (c.undo) c.undo();
  }
  // expect: null means the opposite - this must NOT produce a finding.
  const ok = c.expect === null ? ids.length === 0 : ids.includes(c.expect);
  if (ok) {
    console.log(`PASS  ${c.name}`);
  } else {
    console.error(`FAIL  ${c.name}`);
    console.error(c.expect === null
      ? `        expected no findings, got ${[...new Set(ids)].join(', ')}`
      : `        expected ${c.expect}, got ${ids.length ? [...new Set(ids)].join(', ') : '(nothing)'}`);
    failed += 1;
  }
}

// And clean again afterwards, which proves restore() actually restored.
const after = driftIds();
if (after.report.findings.length) {
  console.error('FAIL  the reference app is not clean after the tests:');
  for (const f of after.report.findings) console.error(`        ${f.id}  ${f.message}`);
  failed += 1;
} else {
  console.log('PASS  clean again afterwards');
}

console.log(`\n${cases.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
