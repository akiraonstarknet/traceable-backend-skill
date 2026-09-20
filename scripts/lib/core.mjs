// traceable-backend: shared manifest loading, actor derivation and source scanning.
// Used by validate-manifests.mjs, generate-grants.mjs and check-drift.mjs.
//
// No LLM calls. Every function here is deterministic.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
// draft 2020-12 needs ajv's 2020 entry point; the default export only knows draft-07.
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_CONFIG = {
  manifestsDir: 'manifests',
  schemasDir: null, // defaults to the skill's templates/schemas
  runtimeFacts: 'src/traceable/runtime-facts.ts',
  runtimeFactsCommand: null, // optional override, e.g. "npm run -s facts"
  managedSchemas: ['public'],
  unauditedTables: ['audit.audit_log', 'traceable.runs', 'traceable.run_steps', 'traceable.llm_model_prices'],
  rawQueryAllowlist: ['prisma/', 'src/traceable/'],
  gateEffectModules: ['@prisma/client', 'pg', 'node:fs', 'node:http', 'node:https', 'undici', 'axios'],
  gateDirPattern: '/gates/',
  authMiddlewareName: 'requireAuth',
  ownerDatabaseUrlEnv: 'DATABASE_URL',
  prismaSchema: 'prisma/schema.prisma',
  srcDir: 'src',
  // Generated and built output is never scanned: the generated Prisma client
  // names every model and uses every raw method, so scanning it would report
  // that every handler touches every table.
  excludePaths: ['src/generated/', 'dist/', 'build/', '.next/', 'node_modules/'],
  dbClientNames: ['db', 'tx', 'prisma'],
  grantsMigrationDir: 'prisma/migrations',
};

export function loadConfig(projectRoot) {
  const path = join(projectRoot, 'traceable.config.json');
  const user = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { ...DEFAULT_CONFIG, ...user, projectRoot };
}

// --------------------------------------------------------------------------
// Findings
// --------------------------------------------------------------------------

export function finding(id, entity, manifest, message, fix) {
  return { id, severity: 'error', entity, manifest, message, fix };
}

// --------------------------------------------------------------------------
// Manifest loading and schema validation
// --------------------------------------------------------------------------

const KIND_BY_DIR = { apis: 'Api', tables: 'Table', jobs: 'Job' };
const SCHEMA_BY_KIND = { Api: 'api.schema.json', Table: 'table.schema.json', Job: 'job.schema.json' };

function listYaml(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile())
    .sort();
}

export function loadManifests(config) {
  const schemasDir = config.schemasDir
    ? resolve(config.projectRoot, config.schemasDir)
    : join(SKILL_ROOT, 'templates', 'schemas');

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validators = {};
  for (const [kind, file] of Object.entries(SCHEMA_BY_KIND)) {
    validators[kind] = ajv.compile(JSON.parse(readFileSync(join(schemasDir, file), 'utf8')));
  }

  const findings = [];
  const out = { apis: [], tables: [], jobs: [] };

  for (const [dirName, kind] of Object.entries(KIND_BY_DIR)) {
    const dir = join(config.projectRoot, config.manifestsDir, dirName);
    for (const file of listYaml(dir)) {
      const rel = file.slice(config.projectRoot.length + 1);
      let doc;
      try {
        doc = YAML.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        findings.push(finding('manifest.schema', { kind, name: basename(file) }, rel,
          `YAML does not parse: ${err.message}`,
          'fix the YAML syntax'));
        continue;
      }
      if (!doc || typeof doc !== 'object') {
        findings.push(finding('manifest.schema', { kind, name: basename(file) }, rel,
          'file is empty or not a YAML mapping', 'write a manifest, or delete the file'));
        continue;
      }
      if (doc.kind !== kind) {
        findings.push(finding('manifest.schema', { kind, name: doc?.metadata?.name ?? basename(file) }, rel,
          `file is in ${dirName}/ but declares kind: ${doc.kind}`,
          `set kind: ${kind}, or move the file to the right directory`));
        continue;
      }
      if (!validators[kind](doc)) {
        for (const e of validators[kind].errors) {
          findings.push(finding('manifest.schema', { kind, name: doc?.metadata?.name ?? basename(file) }, rel,
            `${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` (allowed: ${e.params.allowedValues.join(', ')})` : ''}`,
            'correct the field to match templates/schemas/' + SCHEMA_BY_KIND[kind]));
        }
        continue;
      }
      const expected = basename(file, extname(file));
      if (expected !== doc.metadata.name) {
        findings.push(finding('manifest.filename', { kind, name: doc.metadata.name }, rel,
          `file is ${expected}.yaml but metadata.name is ${doc.metadata.name}`,
          `rename the file to ${doc.metadata.name}.yaml, or change metadata.name`));
      }
      out[dirName].push({ ...doc, __file: rel });
    }
  }

  return { ...out, findings };
}

// --------------------------------------------------------------------------
// Actors: services and jobs. Role names are DERIVED, never declared, so a typo
// in YAML can never point a role at the wrong actor.
// --------------------------------------------------------------------------

export const snake = (s) => s.replace(/-/g, '_');

export function serviceRole(service) {
  return `svc_${snake(service)}`;
}
export function jobRole(job) {
  return `job_${snake(job)}`;
}
export function envVarForRole(role) {
  return `DATABASE_URL_${role.toUpperCase()}`;
}

/**
 * Collapse manifests into one entry per actor (a service, or a job), unioning the
 * data claims of everything that shares the actor and remembering which manifest
 * contributed each table. Provenance is what makes the grant.forbidden message
 * name the endpoint responsible.
 */
export function actorsFrom(manifests) {
  const actors = new Map();

  const ensure = (key, kind, name, role) => {
    if (!actors.has(key)) {
      actors.set(key, {
        key, kind, name, role,
        envVar: envVarForRole(role),
        reads: new Map(),          // table -> [manifest files]
        writes: new Map(),
        mustNotTouch: new Map(),
        members: [],
      });
    }
    return actors.get(key);
  };

  const add = (map, table, file) => {
    if (!map.has(table)) map.set(table, []);
    if (!map.get(table).includes(file)) map.get(table).push(file);
  };

  for (const api of manifests.apis) {
    const a = ensure(`service:${api.spec.service}`, 'service', api.spec.service, serviceRole(api.spec.service));
    a.members.push({ kind: 'Api', name: api.metadata.name, file: api.__file });
    for (const t of api.spec.data.reads) add(a.reads, t, api.__file);
    for (const t of api.spec.data.writes) add(a.writes, t, api.__file);
    for (const t of api.spec.data.must_not_touch) add(a.mustNotTouch, t, api.__file);
  }

  for (const job of manifests.jobs) {
    const a = ensure(`job:${job.metadata.name}`, 'job', job.metadata.name, jobRole(job.metadata.name));
    a.members.push({ kind: 'Job', name: job.metadata.name, file: job.__file });
    for (const t of job.spec.data.reads) add(a.reads, t, job.__file);
    for (const t of job.spec.data.writes) add(a.writes, t, job.__file);
    for (const t of job.spec.data.must_not_touch) add(a.mustNotTouch, t, job.__file);
  }

  return [...actors.values()].sort((x, y) => x.role.localeCompare(y.role));
}

/**
 * Grants every job holds without declaring them: a job appends to its own run
 * history and reads the model price table. This is infrastructure the runner
 * owns, not the job's business data, so making every job manifest restate it
 * would be boilerplate that adds no information.
 *
 * Defined once and consumed by BOTH the generator and the checker, so the two
 * cannot drift from each other.
 */
export const RUN_HISTORY_GRANTS = [
  { table: 'runs', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  { table: 'run_steps', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  { table: 'llm_model_prices', privileges: ['SELECT'] },
];

/** Tables an actor should hold grants on, and at what level. */
export function grantPlan(actor) {
  const plan = new Map(); // table -> Set of privileges
  const add = (table, privileges) => {
    const s = plan.get(table) ?? new Set();
    for (const p of privileges) s.add(p);
    plan.set(table, s);
  };

  for (const t of actor.reads.keys()) add(t, ['SELECT']);
  for (const t of actor.writes.keys()) add(t, ['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
  if (actor.kind === 'job') {
    for (const g of RUN_HISTORY_GRANTS) add(g.table, g.privileges);
  }
  return plan;
}

// --------------------------------------------------------------------------
// Cross-reference checks (everything JSON Schema cannot express)
// --------------------------------------------------------------------------

export function crossReference(manifests, config) {
  const findings = [];
  const tableNames = new Set(manifests.tables.map((t) => t.metadata.name));
  const jobNames = new Map(manifests.jobs.map((j) => [j.metadata.name, j]));
  const seen = { Api: new Map(), Table: new Map(), Job: new Map() };
  const routes = new Map();

  const all = [
    ...manifests.apis.map((m) => ['Api', m]),
    ...manifests.tables.map((m) => ['Table', m]),
    ...manifests.jobs.map((m) => ['Job', m]),
  ];

  for (const [kind, m] of all) {
    const name = m.metadata.name;
    const entity = { kind, name };

    if (seen[kind].has(name)) {
      findings.push(finding('manifest.duplicate-name', entity, m.__file,
        `another ${kind} manifest is already named ${name} (${seen[kind].get(name)})`,
        'rename one of them'));
    }
    seen[kind].set(name, m.__file);

    if (m.metadata.description.trim().toLowerCase() === name.replace(/[-_]/g, ' ')) {
      findings.push(finding('manifest.weak-description', entity, m.__file,
        'metadata.description just restates the name',
        'describe what it does and why, in the vocabulary the owner uses'));
    }

    if (kind !== 'Table') {
      const data = m.spec.data;
      const pairs = [['reads', 'writes'], ['reads', 'must_not_touch'], ['writes', 'must_not_touch']];
      for (const [a, b] of pairs) {
        for (const t of data[a]) {
          if (data[b].includes(t)) {
            findings.push(finding('manifest.overlapping-data', entity, m.__file,
              `table ${t} appears in both data.${a} and data.${b}`,
              `remove it from one — ${a === 'reads' && b === 'writes' ? 'writes already implies read access' : 'a table cannot be both used and forbidden'}`));
          }
        }
      }
      for (const key of ['reads', 'writes', 'must_not_touch']) {
        for (const t of data[key]) {
          if (!tableNames.has(t)) {
            findings.push(finding('manifest.unknown-table', entity, m.__file,
              `data.${key} names table ${t}, which has no manifest`,
              `create manifests/tables/${t}.yaml, or correct the name`));
          }
        }
      }
    }

    const filePath = kind === 'Api' ? m.spec.handler : kind === 'Job' ? m.spec.entrypoint : null;
    if (filePath && !existsSync(join(config.projectRoot, filePath))) {
      findings.push(finding('manifest.missing-file', entity, m.__file,
        `${kind === 'Api' ? 'spec.handler' : 'spec.entrypoint'} points at ${filePath}, which does not exist`,
        'create the file, or correct the path'));
    }

    if (kind === 'Api') {
      const routeKey = `${m.spec.method} ${m.spec.path}`;
      if (routes.has(routeKey)) {
        findings.push(finding('manifest.duplicate-route', entity, m.__file,
          `${routeKey} is already declared by ${routes.get(routeKey)}`,
          'two endpoints cannot share a method and path'));
      }
      routes.set(routeKey, m.__file);

      if (m.spec.runs_job) {
        const job = jobNames.get(m.spec.runs_job);
        if (!job) {
          findings.push(finding('manifest.bad-job-reference', entity, m.__file,
            `runs_job names ${m.spec.runs_job}, which has no manifest`,
            `create manifests/jobs/${m.spec.runs_job}.yaml, or remove runs_job`));
        } else if (job.spec.trigger.type !== 'api') {
          findings.push(finding('manifest.bad-job-reference', entity, m.__file,
            `runs_job names ${m.spec.runs_job}, whose trigger.type is ${job.spec.trigger.type}, not api`,
            `set that job's trigger.type to api, or stop starting it from an endpoint`));
        }
      }
    }

    if (kind === 'Table') {
      const cols = new Set(m.spec.columns.map((c) => c.name));
      for (const pk of m.spec.primary_key) {
        if (!cols.has(pk)) {
          findings.push(finding('manifest.schema', entity, m.__file,
            `primary_key names ${pk}, which is not in spec.columns`,
            `add ${pk} to spec.columns with a description`));
        }
      }
      const qualified = `${m.spec.schema ?? 'public'}.${m.metadata.name}`;
      if (!m.spec.audited && !config.unauditedTables.includes(qualified)) {
        findings.push(finding('audit.trigger-missing', entity, m.__file,
          `audited: false on a business table (${qualified})`,
          `set audited: true, or add ${qualified} to unauditedTables in traceable.config.json and say why in the description`));
      }
    }

    if (kind === 'Job') findings.push(...checkPipeline(m));
  }

  return findings;
}

function checkPipeline(job) {
  const findings = [];
  const entity = { kind: 'Job', name: job.metadata.name };
  const steps = job.spec.pipeline;
  const names = new Map();

  for (const step of steps) {
    const name = step.node ?? step.gate;
    if (names.has(name)) {
      findings.push(finding('manifest.duplicate-name', entity, job.__file,
        `pipeline has two steps named ${name}`, 'rename one'));
    }
    names.set(name, step);
  }

  for (const step of steps) {
    if (!step.gate) continue;
    for (const [label, target] of Object.entries(step.routes)) {
      if (target !== 'END' && !names.has(target)) {
        findings.push(finding('pipeline.gate-route-unknown', entity, job.__file,
          `gate ${step.gate} routes ${label} to ${target}, which is not a step in this pipeline`,
          `add a step named ${target}, or point the route at an existing step or END`));
      }
    }
  }

  // Reachability from the first step, following gate routes and node fallthrough.
  const reachable = new Set();
  const order = steps.map((s) => s.node ?? s.gate);
  const walk = (name) => {
    if (name === 'END' || name === undefined || reachable.has(name)) return;
    const step = names.get(name);
    if (!step) return;
    reachable.add(name);
    if (step.gate) {
      for (const target of Object.values(step.routes)) walk(target);
    } else if (!step.terminal) {
      walk(order[order.indexOf(name) + 1]);
    }
  };
  walk(order[0]);

  for (const name of order) {
    if (!reachable.has(name)) {
      findings.push(finding('pipeline.unreachable-step', entity, job.__file,
        `step ${name} cannot be reached from the first step`,
        'route a gate to it, remove it, or reorder the pipeline'));
    }
  }

  const ends = order.filter((n) => {
    const s = names.get(n);
    return s.node ? s.terminal === true : Object.values(s.routes).includes('END');
  });
  if (ends.length === 0) {
    findings.push(finding('pipeline.unreachable-step', entity, job.__file,
      'no step is terminal and no gate routes to END, so the pipeline never finishes',
      'mark the final node terminal: true, or route a gate to END'));
  }

  return findings;
}

// --------------------------------------------------------------------------
// Prisma model -> table mapping
//
// Prisma does NOT pluralise or snake_case by default: the table name equals the
// model name unless @@map says otherwise. The client property is the model name
// with a lower-cased first letter.
// --------------------------------------------------------------------------

export function prismaModelMap(config) {
  const path = join(config.projectRoot, config.prismaSchema);
  const map = new Map(); // client property -> table name
  if (!existsSync(path)) return map;

  const src = readFileSync(path, 'utf8');
  const modelRe = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\s*\}/gm;
  let m;
  while ((m = modelRe.exec(src)) !== null) {
    const [, model, body] = m;
    const mapped = /@@map\(\s*"([^"]+)"\s*\)/.exec(body);
    const prop = model.charAt(0).toLowerCase() + model.slice(1);
    map.set(prop, mapped ? mapped[1] : model);
  }
  return map;
}

// --------------------------------------------------------------------------
// Static source scan
// --------------------------------------------------------------------------

const READ_METHODS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'exists',
]);
const WRITE_METHODS = new Set([
  'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany',
  'upsert', 'delete', 'deleteMany',
]);
export const RAW_METHODS = ['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'];

export function isExcluded(relPath, config) {
  const normalised = relPath.split(sep).join('/');
  return (config.excludePaths ?? []).some((p) => normalised.startsWith(p) || normalised.includes(`/${p}`));
}

/** Resolve a relative import specifier to a real file under srcDir. */
function resolveImport(fromFile, spec, config) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.js`, `${base}.mjs`,
    join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js'),
  ];
  const srcRoot = resolve(config.projectRoot, config.srcDir);
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && c.startsWith(srcRoot)) return c;
  }
  return null;
}

/**
 * Walk from an entry file through relative imports within srcDir, collecting
 * table access and raw-query use.
 *
 * Limits, stated honestly: this is regex over source text, not a type checker.
 * A client aliased to a name outside config.dbClientNames, or a model reached
 * through a computed property, is NOT seen. That is why grants exist underneath
 * — the scan is the fine-grained check, the grants are the guarantee.
 */
export function scanSources(entryFile, config, modelMap, boundaries = []) {
  const accesses = new Map(); // table -> { read: bool, write: bool, files: Set }
  const rawUses = [];
  const visited = new Set();
  const files = [];

  const clientAlt = config.dbClientNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const accessRe = new RegExp(`\\b(?:${clientAlt})\\.([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g');
  const importRe = /(?:^|\n)\s*(?:import[\s\S]*?from\s*|import\s*|export[\s\S]*?from\s*)['"]([^'"]+)['"]/g;

  const visit = (file) => {
    const abs = resolve(config.projectRoot, file);
    if (visited.has(abs) || !existsSync(abs)) return;
    visited.add(abs);
    const rel = abs.slice(config.projectRoot.length + 1);
    if (isExcluded(rel, config)) return;
    files.push(rel);
    const src = readFileSync(abs, 'utf8');

    const allowed = config.rawQueryAllowlist.some((p) => rel.startsWith(p));
    if (!allowed) {
      for (const raw of RAW_METHODS) {
        if (src.includes(raw)) rawUses.push({ file: rel, method: raw });
      }
    }

    let a;
    accessRe.lastIndex = 0;
    while ((a = accessRe.exec(src)) !== null) {
      const [, prop, method] = a;
      const isRead = READ_METHODS.has(method);
      const isWrite = WRITE_METHODS.has(method);
      if (!isRead && !isWrite) continue;
      const table = modelMap.get(prop) ?? prop;
      if (!accesses.has(table)) accesses.set(table, { read: false, write: false, files: new Set() });
      const entry = accesses.get(table);
      if (isRead) entry.read = true;
      if (isWrite) entry.write = true;
      entry.files.add(rel);
    }

    let i;
    importRe.lastIndex = 0;
    while ((i = importRe.exec(src)) !== null) {
      const target = resolveImport(abs, i[1], config);
      // Stop at another actor's boundary. A handler that starts a job imports
      // that job's code, but the job runs under its OWN role with its OWN
      // manifest and grants — charging the job's tables to the endpoint would
      // force the endpoint to declare writes it cannot perform.
      if (target && !crossesBoundary(target, boundaries)) visit(target);
    }
  };

  visit(entryFile);
  return { accesses, rawUses, files };
}

function crossesBoundary(target, boundaries) {
  return boundaries.some((b) =>
    b.kind === 'file' ? target === b.path : target.startsWith(b.path));
}

/**
 * The boundary set for scanning one manifest: every OTHER actor's entry point.
 * A job owns its whole directory (its nodes and gates are part of it); an API
 * owns only its handler file, so genuinely shared helpers still get scanned.
 */
export function boundariesFor(manifests, config, selfFile) {
  const out = [];
  for (const api of manifests.apis) {
    if (!api.spec.handler || api.spec.handler === selfFile) continue;
    out.push({ kind: 'file', path: resolve(config.projectRoot, api.spec.handler) });
  }
  for (const job of manifests.jobs) {
    if (!job.spec.entrypoint || job.spec.entrypoint === selfFile) continue;
    out.push({ kind: 'dir', path: dirname(resolve(config.projectRoot, job.spec.entrypoint)) + '/' });
  }
  return out;
}

/** Gate files must not import anything that can cause an effect. */
export function scanGateEffects(config) {
  const findings = [];
  const srcRoot = resolve(config.projectRoot, config.srcDir);
  if (!existsSync(srcRoot)) return findings;

  const walkDir = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!isExcluded(full.slice(config.projectRoot.length + 1) + '/', config)) walkDir(full);
        continue;
      }
      if (!/\.(ts|tsx|mts|js|mjs)$/.test(name)) continue;
      const rel = full.slice(config.projectRoot.length + 1);
      if (isExcluded(rel, config)) continue;
      if (!rel.includes(config.gateDirPattern.replace(/^\//, '').replace(/\/$/, '') + '/')) continue;

      const src = readFileSync(full, 'utf8');
      const importRe = /(?:^|\n)\s*(?:import[\s\S]*?from\s*|import\s*)['"]([^'"]+)['"]/g;
      let m;
      while ((m = importRe.exec(src)) !== null) {
        const spec = m[1];
        if (config.gateEffectModules.some((bad) => spec === bad || spec.startsWith(`${bad}/`))) {
          findings.push(finding('code.gate-side-effect', { kind: 'Gate', name: basename(rel) }, rel,
            `gate file imports ${spec}, which can cause side effects`,
            'a gate takes a frozen input and a logger and returns { route, reason } — move the effect into a node'));
        }
      }
      for (const raw of RAW_METHODS) {
        if (src.includes(raw)) {
          findings.push(finding('code.gate-side-effect', { kind: 'Gate', name: basename(rel) }, rel,
            `gate file uses ${raw}`, 'move the query into the node before the gate'));
        }
      }
      if (/\bfetch\s*\(/.test(src)) {
        findings.push(finding('code.gate-side-effect', { kind: 'Gate', name: basename(rel) }, rel,
          'gate file calls fetch()', 'move the network call into a node'));
      }
    }
  };

  walkDir(srcRoot);
  return findings;
}

// --------------------------------------------------------------------------
// Reporting
// --------------------------------------------------------------------------

export function printFindings(findings, checksRun) {
  if (findings.length === 0) {
    console.log(`OK  ${checksRun} checks, no drift.`);
    return;
  }
  console.log(`DRIFT  ${findings.length} finding${findings.length === 1 ? '' : 's'}\n`);
  const byFile = new Map();
  for (const f of findings) {
    const key = f.manifest ?? '(no manifest)';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(f);
  }
  const pad = Math.max(...findings.map((f) => f.id.length)) + 2;
  for (const [file, group] of [...byFile.entries()].sort()) {
    console.log(file);
    for (const f of group) {
      console.log(`  ${f.id.padEnd(pad)}${f.message}`);
      if (f.fix) console.log(`  ${''.padEnd(pad)}fix: ${f.fix}`);
    }
    console.log('');
  }
}
