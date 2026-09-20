#!/usr/bin/env node
// traceable-backend: compare manifests against runtime facts.
//
// There is no LLM here and no prose comparison. Every check is a deterministic
// query against the live route table, the Postgres catalog, the job registry, or
// the source text. A checker the owner cannot trust is worse than no checker.
//
// Usage:
//   node scripts/check-drift.mjs [projectRoot]
//   node scripts/check-drift.mjs [projectRoot] --no-db        skip catalog checks
//   node scripts/check-drift.mjs [projectRoot] --no-runtime   skip route/job checks

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import {
  loadConfig, loadManifests, crossReference, actorsFrom, grantPlan,
  prismaModelMap, scanSources, scanGateEffects, boundariesFor, finding, printFindings,
} from './lib/core.mjs';

const args = process.argv.slice(2);
const skipDb = args.includes('--no-db');
const skipRuntime = args.includes('--no-runtime');
const projectRoot = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
const config = loadConfig(projectRoot);

const findings = [];
let checksRun = 0;
const check = (name, fn) => { checksRun += 1; return fn(); };

// Declared up here because report() can be called before the checks below have
// run — a manifest that fails its schema exits early, and a `let` declared
// further down would be in the temporal dead zone at that point, crashing the
// checker instead of reporting the problem.
let runtime = null;
let dbChecked = false;

// ---------------------------------------------------------------------------
// 1. Manifests
// ---------------------------------------------------------------------------

const manifests = loadManifests(config);
check('manifest.schema', () => findings.push(...manifests.findings));

if (manifests.findings.length) {
  // Everything downstream reads these manifests; checking against broken ones
  // produces noise that hides the real problem.
  report(false);
}

check('manifest.cross-reference', () => findings.push(...crossReference(manifests, config)));

const actors = actorsFrom(manifests);
const tableSchema = new Map(manifests.tables.map((t) => [t.metadata.name, t.spec.schema ?? 'public']));

// ---------------------------------------------------------------------------
// 2. Runtime facts: the real route table and the real job registry
// ---------------------------------------------------------------------------

if (!skipRuntime) {
  try {
    runtime = loadRuntimeFacts();
  } catch (err) {
    findings.push(finding('route.missing', { kind: 'Runtime', name: config.runtimeFacts }, config.runtimeFacts,
      `could not load runtime facts: ${String(err.message).split('\n')[0]}`,
      `make ${config.runtimeFacts} export describeRuntime(), and make sure the app builds`));
  }
}

function loadRuntimeFacts() {
  const dir = join(projectRoot, '.traceable');
  mkdirSync(dir, { recursive: true });
  const loader = join(dir, 'dump-runtime-facts.mjs');
  const target = resolve(projectRoot, config.runtimeFacts);
  if (!existsSync(target)) throw new Error(`${config.runtimeFacts} does not exist`);

  writeFileSync(loader, [
    `import { pathToFileURL } from 'node:url';`,
    `const mod = await import(pathToFileURL(${JSON.stringify(target)}).href);`,
    `if (typeof mod.describeRuntime !== 'function') throw new Error('describeRuntime is not exported');`,
    `process.stdout.write(JSON.stringify(await mod.describeRuntime()));`,
    '',
  ].join('\n'));

  const out = config.runtimeFactsCommand
    ? execFileSync('sh', ['-c', config.runtimeFactsCommand], { cwd: projectRoot, encoding: 'utf8' })
    : execFileSync(process.execPath, ['--import', 'tsx', loader], {
        cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
  return JSON.parse(out);
}

if (runtime) {
  check('route.*', () => findings.push(...checkRoutes(manifests, runtime, config)));
  check('job.*', () => findings.push(...checkJobs(manifests, runtime)));
}

function checkRoutes(manifests, runtime, config) {
  const out = [];
  const declared = new Map(manifests.apis.map((a) => [`${a.spec.method} ${a.spec.path}`, a]));
  const live = new Map();
  for (const r of runtime.routes ?? []) live.set(`${r.method} ${r.path}`, r);

  for (const [key, api] of declared) {
    const entity = { kind: 'Api', name: api.metadata.name };
    const r = live.get(key);
    if (!r) {
      const samePath = (runtime.routes ?? []).filter((x) => x.path === api.spec.path);
      out.push(samePath.length
        ? finding('route.method-mismatch', entity, api.__file,
            `declared ${key} but the app registers ${samePath.map((x) => x.method).join(', ')} ${api.spec.path}`,
            'change the manifest method, or register the route with the declared method')
        : finding('route.missing', entity, api.__file,
            `declared ${key} but the app registers no such route`,
            'register the route, or delete the manifest'));
      continue;
    }
    const hasAuth = (r.middleware ?? []).includes(config.authMiddlewareName);
    if (api.spec.auth === 'secured' && !hasAuth) {
      out.push(finding('route.auth-mismatch', entity, api.__file,
        `declared auth: secured, but ${config.authMiddlewareName} is not on ${key}`,
        `add ${config.authMiddlewareName} to the route, or set auth: public and tell the owner`));
    }
    if (api.spec.auth === 'public' && hasAuth) {
      out.push(finding('route.auth-mismatch', entity, api.__file,
        `declared auth: public, but ${config.authMiddlewareName} is mounted on ${key}`,
        'set auth: secured — the manifest is what the owner was told'));
    }
    if (r.handler && api.spec.handler && !r.handler.endsWith(api.spec.handler)) {
      out.push(finding('route.handler-mismatch', entity, api.__file,
        `spec.handler is ${api.spec.handler} but the route is served by ${r.handler}`,
        'point spec.handler at the file that actually serves the route'));
    }
  }

  for (const [key, r] of live) {
    if (declared.has(key)) continue;
    out.push(finding('route.undeclared', { kind: 'Api', name: key }, null,
      `the app registers ${key} with no Api manifest`,
      `create manifests/apis/<name>.yaml for it — every route the owner can call must be declared`));
  }
  return out;
}

function checkJobs(manifests, runtime) {
  const out = [];
  const declared = new Map(manifests.jobs.map((j) => [j.metadata.name, j]));
  const live = new Map((runtime.jobs ?? []).map((j) => [j.name, j]));

  for (const [name, job] of declared) {
    const entity = { kind: 'Job', name };
    const r = live.get(name);
    if (!r) {
      out.push(finding('job.missing', entity, job.__file,
        'declared but the job registry does not contain it',
        'register the job, or delete the manifest'));
      continue;
    }
    if (r.triggerType !== job.spec.trigger.type) {
      out.push(finding('job.trigger-mismatch', entity, job.__file,
        `declared trigger.type ${job.spec.trigger.type}, registry says ${r.triggerType}`,
        'make them agree'));
    }
    const declaredSchedule = job.spec.trigger.schedule ?? null;
    if ((r.schedule ?? null) !== declaredSchedule) {
      out.push(finding('job.schedule-mismatch', entity, job.__file,
        `declared schedule ${declaredSchedule ?? '(none)'}, registry says ${r.schedule ?? '(none)'}`,
        'change one so they match — the Jobs page shows the manifest value to the owner'));
    }

    const declaredSteps = new Map(job.spec.pipeline.map((s) => [s.node ?? s.gate, s]));
    const liveSteps = new Map((r.steps ?? []).map((s) => [s.name, s]));

    for (const [stepName, s] of declaredSteps) {
      const ls = liveSteps.get(stepName);
      if (!ls) {
        out.push(finding('pipeline.step-missing', entity, job.__file,
          `pipeline declares step ${stepName}, which the job does not implement`,
          `implement ${stepName}, or remove it from the manifest`));
        continue;
      }
      const declaredType = s.node ? 'node' : 'gate';
      if (ls.type !== declaredType) {
        out.push(finding('pipeline.step-type-mismatch', entity, job.__file,
          `${stepName} is declared a ${declaredType} but implemented as a ${ls.type}`,
          'a gate decides and never acts; a node acts and never routes'));
        continue;
      }
      if (s.node && ls.kind !== s.kind) {
        out.push(finding('pipeline.step-type-mismatch', entity, job.__file,
          `node ${stepName} is declared kind: ${s.kind} but implemented as ${ls.kind}`,
          'make them agree'));
      }
      if (s.node && s.kind === 'llm' && ls.model !== s.model) {
        out.push(finding('pipeline.model-mismatch', entity, job.__file,
          `node ${stepName} declares model ${s.model} but calls ${ls.model ?? '(none)'}`,
          'the owner is shown the manifest value, so make the code match it'));
      }
      if (s.gate) {
        const declaredRoutes = JSON.stringify(Object.keys(s.routes).sort());
        const liveRoutes = JSON.stringify(Object.keys(ls.routes ?? {}).sort());
        if (declaredRoutes !== liveRoutes) {
          out.push(finding('pipeline.step-type-mismatch', entity, job.__file,
            `gate ${stepName} declares routes ${declaredRoutes} but implements ${liveRoutes}`,
            'make the route labels match exactly'));
        }
      }
    }

    for (const stepName of liveSteps.keys()) {
      if (!declaredSteps.has(stepName)) {
        out.push(finding('pipeline.step-undeclared', entity, job.__file,
          `the job implements step ${stepName}, which the manifest does not declare`,
          `add it to spec.pipeline with a display_name and description the owner can read`));
      }
    }
  }

  for (const name of live.keys()) {
    if (!declared.has(name)) {
      out.push(finding('job.undeclared', { kind: 'Job', name }, null,
        'the job registry contains a job with no manifest',
        `create manifests/jobs/${name}.yaml`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Static source scan
// ---------------------------------------------------------------------------

const modelMap = prismaModelMap(config);
check('code.*', () => {
  const entries = [
    ...manifests.apis.map((m) => ({ m, kind: 'Api', file: m.spec.handler })),
    ...manifests.jobs.map((m) => ({ m, kind: 'Job', file: m.spec.entrypoint })),
  ];
  for (const { m, kind, file } of entries) {
    if (!file || !existsSync(join(projectRoot, file))) continue;
    const entity = { kind, name: m.metadata.name };
    const boundaries = boundariesFor(manifests, config, file);
    const { accesses, rawUses } = scanSources(join(projectRoot, file), config, modelMap, boundaries);
    const reads = new Set(m.spec.data.reads);
    const writes = new Set(m.spec.data.writes);
    const forbidden = new Set(m.spec.data.must_not_touch);

    for (const [table, use] of accesses) {
      const where = [...use.files].join(', ');
      if (forbidden.has(table)) {
        findings.push(finding('code.undeclared-table-access', entity, m.__file,
          `code touches ${table}, which data.must_not_touch forbids (${where})`,
          'remove the access, or remove the table from must_not_touch and tell the owner'));
        continue;
      }
      if (use.write && !writes.has(table)) {
        findings.push(finding('code.undeclared-table-access', entity, m.__file,
          `code writes ${table}, which is not in data.writes (${where})`,
          `add ${table} to data.writes and regenerate grants, or stop writing it`));
        continue;
      }
      if (use.read && !reads.has(table) && !writes.has(table)) {
        findings.push(finding('code.undeclared-table-access', entity, m.__file,
          `code reads ${table}, which is not in data.reads (${where})`,
          `add ${table} to data.reads and regenerate grants, or stop reading it`));
      }
    }

    for (const raw of rawUses) {
      findings.push(finding('code.raw-query-forbidden', entity, m.__file,
        `${raw.file} uses ${raw.method}, which makes the table scan blind`,
        'use the typed client, or move the query into a file on rawQueryAllowlist'));
    }
  }
});

check('code.gate-side-effect', () => findings.push(...scanGateEffects(config)));

// ---------------------------------------------------------------------------
// 4. Database catalog: tables, columns, audit triggers, roles, grants
// ---------------------------------------------------------------------------

if (!skipDb) {
  const url = process.env[config.ownerDatabaseUrlEnv];
  if (!url) {
    findings.push(finding('grant.missing', { kind: 'Database', name: config.ownerDatabaseUrlEnv }, null,
      `${config.ownerDatabaseUrlEnv} is not set, so no database check ran`,
      `set ${config.ownerDatabaseUrlEnv} to the owner connection string, or pass --no-db and tell the owner the guarantee is unverified`));
  } else {
    await withClient(url, async (client) => {
      dbChecked = true;
      findings.push(...await checkDatabase(client));
    });
  }
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    findings.push(finding('grant.missing', { kind: 'Database', name: 'connection' }, null,
      `could not connect as the owner role: ${err.message}`,
      'check the connection string and that Postgres is running'));
    return;
  }
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

async function checkDatabase(client) {
  const out = [];
  // Query every schema the manifests mention, not just the managed ones: the
  // audit and traceable schemas are declared too, so the owner can read what
  // they contain. Only managedSchemas drive table.undeclared, below.
  const schemas = [...new Set([
    ...config.managedSchemas,
    ...manifests.tables.map((t) => t.spec.schema ?? 'public'),
  ])];

  const { rows: liveTables } = await client.query(
    `select table_schema, table_name
       from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema = any($1)`, [schemas]);
  const { rows: liveColumns } = await client.query(
    `select table_schema, table_name, column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = any($1)`, [schemas]);
  const { rows: liveTriggers } = await client.query(
    `select n.nspname as table_schema, c.relname as table_name, t.tgname as trigger_name
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and t.tgname like 'traceable\\_audit\\_%'`);
  const { rows: liveRoles } = await client.query(
    `select rolname from pg_roles where rolname like 'svc\\_%' or rolname like 'job\\_%'`);
  const { rows: liveGrants } = await client.query(
    `select grantee, table_schema, table_name, privilege_type
       from information_schema.role_table_grants
      where grantee like 'svc\\_%' or grantee like 'job\\_%'`);
  const { rows: liveKeys } = await client.query(
    `select n.nspname as table_schema, c.relname as table_name, a.attname as column_name, k.ord
       from pg_index i
       join pg_class c on c.oid = i.indrelid
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indisprimary and n.nspname = any($1)
      order by n.nspname, c.relname, k.ord`, [schemas]);
  const { rows: auditFn } = await client.query(
    `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'audit' and p.proname = 'log_change'`);

  const key = (s, t) => `${s}.${t}`;
  const liveTableSet = new Set(liveTables.map((r) => key(r.table_schema, r.table_name)));
  const triggerByTable = new Map(liveTriggers.map((r) => [key(r.table_schema, r.table_name), r.trigger_name]));
  const roleSet = new Set(liveRoles.map((r) => r.rolname));

  if (auditFn.length === 0) {
    out.push(finding('audit.function-missing', { kind: 'Database', name: 'audit.log_change' }, null,
      'audit.log_change() does not exist, so nothing is being audited',
      'apply templates/sql/010_audit.sql as part of a migration'));
  }

  // Tables and columns
  const declaredTableSet = new Set();
  for (const t of manifests.tables) {
    const schema = t.spec.schema ?? 'public';
    const k = key(schema, t.metadata.name);
    declaredTableSet.add(k);
    const entity = { kind: 'Table', name: t.metadata.name };

    if (!liveTableSet.has(k)) {
      out.push(finding('table.missing', entity, t.__file,
        `manifest describes ${k}, which does not exist in the database`,
        'write the migration that creates it, or delete the manifest'));
      continue;
    }

    const cols = new Set(liveColumns.filter((c) => key(c.table_schema, c.table_name) === k).map((c) => c.column_name));
    const declared = new Set(t.spec.columns.map((c) => c.name));
    for (const c of declared) {
      if (!cols.has(c)) {
        out.push(finding('column.missing', entity, t.__file,
          `manifest lists column ${c}, which ${k} does not have`,
          `remove it from spec.columns, or add the column in a migration`));
      }
    }
    for (const c of cols) {
      if (!declared.has(c)) {
        out.push(finding('column.undeclared', entity, t.__file,
          `${k}.${c} exists but the manifest does not describe it`,
          'add it to spec.columns with a plain-English description the owner can read'));
      }
    }

    const pk = liveKeys.filter((r) => key(r.table_schema, r.table_name) === k).map((r) => r.column_name);
    if (JSON.stringify(pk) !== JSON.stringify(t.spec.primary_key)) {
      out.push(finding('table.pk-mismatch', entity, t.__file,
        `declared primary_key [${t.spec.primary_key.join(', ')}], actual [${pk.join(', ') || 'none'}]`,
        pk.length ? 'correct the manifest' : 'add a primary key — audit.record_id() needs one'));
    }

    const hasTrigger = triggerByTable.has(k);
    if (t.spec.audited && !hasTrigger) {
      out.push(finding('audit.trigger-missing', entity, t.__file,
        `audited: true but no traceable_audit_${t.metadata.name} trigger on ${k}`,
        `add "select audit.attach('${schema}','${t.metadata.name}');" to a migration`));
    }
    if (!t.spec.audited && hasTrigger) {
      out.push(finding('audit.trigger-unexpected', entity, t.__file,
        `audited: false but ${triggerByTable.get(k)} is attached to ${k}`,
        `set audited: true, or detach with "select audit.detach('${schema}','${t.metadata.name}');"`));
    }
  }

  for (const k of liveTableSet) {
    if (declaredTableSet.has(k)) continue;
    if (k.endsWith('._prisma_migrations')) continue;
    // table.undeclared is scoped to the managed schemas: infrastructure schemas
    // may hold tables the app does not surface to the owner.
    if (!config.managedSchemas.includes(k.split('.')[0])) continue;
    out.push(finding('table.undeclared', { kind: 'Table', name: k }, null,
      `${k} exists in a managed schema but has no manifest`,
      `create manifests/tables/${k.split('.')[1]}.yaml, or remove the schema from managedSchemas and say why`));
  }

  // Roles
  const expectedRoles = new Set(actors.map((a) => a.role));
  for (const actor of actors) {
    if (!roleSet.has(actor.role)) {
      findings.push(finding('role.missing', { kind: actor.kind === 'job' ? 'Job' : 'Service', name: actor.name }, actor.members[0]?.file ?? null,
        `role ${actor.role} does not exist, so its data claims are not enforced`,
        'run npm run grants:generate and apply the migration'));
    }
  }
  for (const role of roleSet) {
    if (!expectedRoles.has(role)) {
      out.push(finding('role.orphaned', { kind: 'Service', name: role }, null,
        `role ${role} exists but no manifest implies it`,
        `drop the role, or add the manifests that justify it`));
    }
  }

  // Grants
  const grantsByRole = new Map();
  for (const g of liveGrants) {
    if (!grantsByRole.has(g.grantee)) grantsByRole.set(g.grantee, new Map());
    const byTable = grantsByRole.get(g.grantee);
    const k = key(g.table_schema, g.table_name);
    if (!byTable.has(k)) byTable.set(k, new Set());
    byTable.get(k).add(g.privilege_type);
  }

  for (const actor of actors) {
    if (!roleSet.has(actor.role)) continue;
    const entity = { kind: actor.kind === 'job' ? 'Job' : 'Service', name: actor.name };
    const manifestFile = actor.members[0]?.file ?? null;
    const held = grantsByRole.get(actor.role) ?? new Map();
    const plan = grantPlan(actor);

    for (const [table, privs] of plan) {
      const schema = tableSchema.get(table) ?? 'public';
      const k = key(schema, table);
      const actual = held.get(k) ?? new Set();
      const missing = [...privs].filter((p) => !actual.has(p));
      if (missing.length) {
        out.push(finding('grant.missing', entity, manifestFile,
          `${actor.role} is missing ${missing.join(', ')} on ${k}, which its manifest declares`,
          'run npm run grants:generate and apply the migration'));
      }
    }

    for (const [k, privs] of held) {
      const table = k.split('.')[1];
      if (actor.mustNotTouch.has(table)) {
        const why = actor.mustNotTouch.get(table).join(', ');
        const alsoUsed = actor.reads.has(table) || actor.writes.has(table);
        out.push(finding('grant.forbidden', entity, manifestFile,
          alsoUsed
            ? `${actor.role} holds ${[...privs].join(', ')} on ${k}: ${why} forbids it, but another manifest for the same actor uses it`
            : `${actor.role} holds ${[...privs].join(', ')} on ${k}, which ${why} forbids`,
          alsoUsed
            ? 'split the service so the claim is true at the database level, or drop the claim and tell the owner'
            : 'run npm run grants:generate and apply the migration'));
        continue;
      }
      if (!plan.has(table)) {
        out.push(finding('grant.excess', entity, manifestFile,
          `${actor.role} holds ${[...privs].join(', ')} on ${k}, which no manifest justifies`,
          `add ${table} to data.reads or data.writes, or regenerate grants to revoke it`));
        continue;
      }
      const allowed = plan.get(table);
      const extra = [...privs].filter((p) => !allowed.has(p) && p !== 'TRUNCATE' && p !== 'REFERENCES' && p !== 'TRIGGER');
      if (extra.length) {
        out.push(finding('grant.excess', entity, manifestFile,
          `${actor.role} holds ${extra.join(', ')} on ${k} beyond what its manifest declares`,
          'run npm run grants:generate and apply the migration'));
      }
    }

    // A service or job connecting as the owner makes every grant meaningless.
    const actorUrl = process.env[actor.envVar];
    const ownerUrl = process.env[config.ownerDatabaseUrlEnv];
    if (actorUrl && ownerUrl) {
      const userOf = (u) => { try { return new URL(u).username; } catch { return null; } };
      if (userOf(actorUrl) && userOf(actorUrl) === userOf(ownerUrl)) {
        out.push(finding('grant.owner-at-runtime', entity, manifestFile,
          `${actor.envVar} connects as ${userOf(actorUrl)}, the owner role — its data claims are unenforced`,
          `point ${actor.envVar} at ${actor.role}`));
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 5. Report
// ---------------------------------------------------------------------------

report(true);

function report(ranEverything) {
  const ok = findings.length === 0;
  const dir = join(projectRoot, '.traceable');
  mkdirSync(dir, { recursive: true });
  // Written whether it passed or failed: the Drift page must be able to tell
  // "checked and clean" from "nobody looked".
  writeFileSync(join(dir, 'drift.json'), JSON.stringify({
    checked_at: new Date().toISOString(),
    checks_run: checksRun,
    db_checked: dbChecked,
    runtime_checked: runtime !== null,
    complete: ranEverything && dbChecked && runtime !== null,
    ok,
    findings,
  }, null, 2) + '\n');

  printFindings(findings, checksRun);
  if (!dbChecked && !skipDb) console.log('note: database checks did not run — the "not touched" guarantee is unverified.');
  if (skipDb) console.log('note: --no-db passed, so grants and schema were not checked.');
  if (skipRuntime) console.log('note: --no-runtime passed, so routes and jobs were not checked.');
  process.exit(ok ? 0 : 1);
}
