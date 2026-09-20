// Read-only queries for the DevOps UI, plus manifest loading for the pages that
// describe declared shape rather than live state.
//
// The UI connects as svc_devops, which holds SELECT and nothing else — the
// generated grants give it no INSERT, UPDATE or DELETE anywhere, so no page can
// change data even if a future handler tried. src/devops/ is on
// rawQueryAllowlist because the audit and traceable schemas are infrastructure
// with no Prisma models.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import YAML from 'yaml';

const DEVOPS_DB = 'DATABASE_URL_SVC_DEVOPS';

let pool: pg.Pool | null = null;
export function devopsPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env[DEVOPS_DB];
    if (!connectionString) throw new Error(`${DEVOPS_DB} is not set`);
    pool = new pg.Pool({ connectionString, max: 4 });
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await devopsPool().query(sql, params as never[]);
  return result.rows as T[];
}

// --------------------------------------------------------------------------
// Manifests: the declared side of every page
// --------------------------------------------------------------------------

export type AnyManifest = {
  apiVersion: string;
  kind: 'Api' | 'Table' | 'Job';
  metadata: { name: string; description: string; owner?: string };
  spec: Record<string, any>;
  __file: string;
};

const ROOT = process.cwd();

export function loadManifests(): { apis: AnyManifest[]; tables: AnyManifest[]; jobs: AnyManifest[] } {
  const read = (dir: string): AnyManifest[] => {
    const full = join(ROOT, 'manifests', dir);
    if (!existsSync(full)) return [];
    return readdirSync(full)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => ({ ...YAML.parse(readFileSync(join(full, f), 'utf8')), __file: `manifests/${dir}/${f}` }))
      .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  };
  return { apis: read('apis'), tables: read('tables'), jobs: read('jobs') };
}

/**
 * Who reads and writes each table, derived from Api and Job manifests. Declaring
 * this on the table as well would guarantee the two disagree, so the table
 * manifest has no accessed_by field and this is computed instead.
 */
export function actorsByTable(m: { apis: AnyManifest[]; jobs: AnyManifest[] }) {
  const byTable = new Map<string, { uses: Array<{ actor: string; access: string; file: string }>;
                                    forbidden: Array<{ actor: string; file: string }> }>();
  const ensure = (t: string) => {
    if (!byTable.has(t)) byTable.set(t, { uses: [], forbidden: [] });
    return byTable.get(t)!;
  };

  const add = (actor: string, manifest: AnyManifest) => {
    const d = manifest.spec.data ?? { reads: [], writes: [], must_not_touch: [] };
    for (const t of d.reads ?? []) ensure(t).uses.push({ actor, access: 'read', file: manifest.__file });
    for (const t of d.writes ?? []) ensure(t).uses.push({ actor, access: 'read, write', file: manifest.__file });
    for (const t of d.must_not_touch ?? []) ensure(t).forbidden.push({ actor, file: manifest.__file });
  };

  for (const api of m.apis) add(`${api.spec.service} (service)`, api);
  for (const job of m.jobs) add(`${job.metadata.name} (job)`, job);
  return byTable;
}

// --------------------------------------------------------------------------
// Drift report
// --------------------------------------------------------------------------

export type DriftReport = {
  checked_at: string;
  checks_run: number;
  db_checked: boolean;
  runtime_checked: boolean;
  complete: boolean;
  ok: boolean;
  findings: Array<{
    id: string; severity: string; message: string; fix?: string;
    manifest: string | null; entity: { kind: string; name: string };
  }>;
};

/** null means nobody has ever run the check — which must not look like "clean". */
export function readDrift(): DriftReport | null {
  const path = join(ROOT, '.traceable', 'drift.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DriftReport;
  } catch {
    return null;
  }
}

export function driftBadge(): { state: 'clean' | 'findings' | 'unchecked'; count: number } {
  const report = readDrift();
  if (!report) return { state: 'unchecked', count: 0 };
  if (!report.ok) return { state: 'findings', count: report.findings.length };
  if (!report.complete) return { state: 'unchecked', count: 0 };
  return { state: 'clean', count: 0 };
}

// --------------------------------------------------------------------------
// Redaction: personal and secret columns are masked in the UI, never in the
// database. A redacted trail cannot answer "what was it before?", which is the
// question the trail exists for.
// --------------------------------------------------------------------------

export function sensitiveColumns(tables: AnyManifest[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of tables) {
    const set = new Set<string>();
    for (const c of t.spec.columns ?? []) {
      if (c.sensitivity === 'personal' || c.sensitivity === 'secret') set.add(c.name);
    }
    if (set.size) out.set(t.metadata.name, set);
  }
  return out;
}

export function maskRow(
  row: Record<string, unknown> | null,
  table: string,
  sensitive: Map<string, Set<string>>,
): Record<string, unknown> | null {
  if (!row) return null;
  const cols = sensitive.get(table);
  if (!cols) return row;
  const copy: Record<string, unknown> = { ...row };
  for (const c of cols) if (c in copy && copy[c] !== null) copy[c] = '••••••';
  return copy;
}

export const ms = (v: unknown) => (v === null || v === undefined ? '' : `${Number(v).toLocaleString()}ms`);
export const usd = (v: unknown) =>
  v === null || v === undefined ? '' : `$${Number(v).toFixed(4)}`;
export const when = (v: unknown) =>
  v ? new Date(v as string).toISOString().replace('T', ' ').slice(0, 19) : '';
