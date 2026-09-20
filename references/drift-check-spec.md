# Drift check specification

The drift checker compares manifests against runtime facts and exits non-zero on any
mismatch. It contains **no LLM call and no prose comparison**. Every check is a
deterministic query against the route table, the database catalog, the job registry,
or the source text.

Implementation: `scripts/check-drift.mjs`. Run with `npm run drift`.

## Contents

- [Where runtime facts come from](#where-runtime-facts-come-from)
- [Check catalog](#check-catalog)
- [Output format](#output-format)
- [Configuration](#configuration)
- [The static table scan](#the-static-table-scan)
- [What the checker deliberately does not do](#what-the-checker-deliberately-does-not-do)
- [Running it in CI](#running-it-in-ci)

## Where runtime facts come from

The checker imports one module from the project and runs one set of SQL queries. It does
**not** need a server listening on a port — that would make CI flaky and would let a
broken build silently skip checks.

```
src/traceable/runtime-facts.ts   →  export function describeRuntime(): RuntimeFacts
```

`describeRuntime()` builds the real Hono app and the real job registry, then returns
plain JSON:

```ts
type RuntimeFacts = {
  routes: Array<{
    method: string;              // upper case
    path: string;                // as registered, with :params
    middleware: string[];        // names of middleware in the chain, in order
  }>;
  jobs: Array<{
    name: string;
    triggerType: 'cron' | 'api' | 'manual';
    schedule: string | null;
    steps: Array<{
      name: string;
      type: 'node' | 'gate';
      kind: 'code' | 'llm' | null;
      model: string | null;
      routes: Record<string, string> | null;
      terminal: boolean;
    }>;
  }>;
};
```

Because it builds the same objects the server builds, a route that exists only in a
comment does not appear, and a route registered outside the registry does.

Database facts come from four queries, run as the **owner** role:

| Fact | Query |
| --- | --- |
| tables | `information_schema.tables` where `table_schema` not in (`pg_catalog`, `information_schema`) |
| columns | `information_schema.columns` |
| audit triggers | `pg_trigger` joined to `pg_class`, trigger name `traceable_audit_*`, `tgisinternal = false` |
| grants | `information_schema.role_table_grants` for every `svc_*` / `job_*` grantee |
| roles | `pg_roles` where `rolname` like `svc\_%` or `job\_%` |

## Check catalog

Each finding has an `id`, a `severity` (`error` — everything currently fails CI), the
entity it concerns, and a message that names real files, endpoints and tables.

### Manifest integrity

| id | Fires when |
| --- | --- |
| `manifest.schema` | YAML does not validate against its JSON Schema |
| `manifest.filename` | File basename ≠ `metadata.name` |
| `manifest.duplicate-name` | Two manifests of the same kind share a name |
| `manifest.unknown-table` | `data.*` names a table with no Table manifest |
| `manifest.overlapping-data` | A table appears in two of reads/writes/must_not_touch |
| `manifest.missing-file` | `handler` / `entrypoint` path does not exist |
| `manifest.duplicate-route` | Two Api manifests share method + path |
| `manifest.bad-job-reference` | `runs_job` names a missing job, or one whose trigger is not `api` |
| `manifest.weak-description` | `metadata.description` shorter than 20 chars, or equals the name |

### Routes

| id | Fires when |
| --- | --- |
| `route.missing` | Manifest declares an endpoint the app does not register |
| `route.undeclared` | App registers a route with no Api manifest |
| `route.method-mismatch` | Same path registered with a different method than declared |
| `route.auth-mismatch` | `auth: secured` but the auth middleware is absent from the chain, or `auth: public` but it is present |
| `route.handler-mismatch` | Registered handler file differs from `spec.handler` |

### Tables and columns

| id | Fires when |
| --- | --- |
| `table.missing` | Table manifest exists, table does not |
| `table.undeclared` | Table exists in a managed schema with no Table manifest |
| `column.missing` | Manifest lists a column the table does not have |
| `column.undeclared` | Table has a column the manifest does not describe |
| `table.pk-mismatch` | `primary_key` differs from the actual primary key |

### Audit

| id | Fires when |
| --- | --- |
| `audit.trigger-missing` | `audited: true` but no `traceable_audit_*` trigger on the table |
| `audit.trigger-unexpected` | Audit trigger present on a table declared `audited: false` |
| `audit.function-missing` | `audit.log_change()` absent, or its source differs from the template |

### Grants and roles

| id | Fires when |
| --- | --- |
| `role.missing` | `svc_*` / `job_*` role implied by manifests does not exist |
| `role.orphaned` | A `svc_*` / `job_*` role exists that no manifest implies |
| `grant.missing` | `reads` implies SELECT, or `writes` implies INSERT/UPDATE/DELETE, and the grant is absent |
| `grant.excess` | Role holds a grant no manifest justifies |
| `grant.forbidden` | Role holds any grant on a table in its `must_not_touch` — including one another endpoint of the same service justified |
| `grant.owner-at-runtime` | A `DATABASE_URL_SVC_*` / `_JOB_*` env var resolves to the owner role |

### Jobs and pipelines

| id | Fires when |
| --- | --- |
| `job.missing` | Job manifest exists, registry has no such job |
| `job.undeclared` | Registry has a job with no manifest |
| `job.schedule-mismatch` | Registered cron expression ≠ `spec.trigger.schedule` |
| `job.trigger-mismatch` | Registered trigger type ≠ declared type |
| `pipeline.step-missing` | Manifest declares a step the registry does not implement |
| `pipeline.step-undeclared` | Registry implements a step the manifest does not declare |
| `pipeline.step-type-mismatch` | Manifest says node, registry says gate (or `code` vs `llm`) |
| `pipeline.model-mismatch` | LLM node's registered model ≠ `spec.pipeline[].model` |
| `pipeline.gate-route-unknown` | A gate route points at a step that does not exist |
| `pipeline.unreachable-step` | A step no route or fallthrough can reach |

### Code

| id | Fires when |
| --- | --- |
| `code.undeclared-table-access` | A handler or job file touches a table its own manifest does not declare |
| `code.raw-query-forbidden` | `$queryRaw` / `$executeRaw` / `*Unsafe` outside the allowed directory |
| `code.gate-side-effect` | A gate module imports a db, http or llm module, or its file exports something other than a gate |
| `code.missing-context` | A write path reachable from a handler does not go through `withContext()` |

## Output format

Human output goes to stdout, grouped by entity, each line naming the file to fix:

```
DRIFT  3 findings

apis/tenant-status-update.yaml
  route.auth-mismatch   declared auth: secured, but no auth middleware on POST /api/tenants/:tenantId/status
                        fix: add requireAuth to the route, or set auth: public and tell the owner

tables/tenants.yaml
  column.undeclared     column tenants.suspended_reason exists but is not described in the manifest
                        fix: add it to spec.columns with a plain-English description

jobs/tenant-status-review.yaml
  grant.forbidden       job_tenant_status_review has SELECT on users, declared in must_not_touch
                        fix: revoke it, or remove users from must_not_touch and tell the owner

exit 1
```

Machine output goes to `.traceable/drift.json` on every run, whether it passes or fails:

```json
{
  "checked_at": "2026-09-20T10:00:00.000Z",
  "checks_run": 17,
  "ok": false,
  "findings": [
    {
      "id": "route.auth-mismatch",
      "severity": "error",
      "entity": { "kind": "Api", "name": "tenant-status-update" },
      "manifest": "manifests/apis/tenant-status-update.yaml",
      "message": "declared auth: secured, but no auth middleware on POST /api/tenants/:tenantId/status",
      "fix": "add requireAuth to the route, or set auth: public and tell the owner"
    }
  ]
}
```

The **Drift page in the UI reads this file**, so the owner sees exactly what CI saw.
Write it even when there are no findings — a missing file means "never checked", which
the UI must show differently from "checked and clean".

Every finding carries a `fix` string. A finding without a concrete next action is a
finding the owner cannot act on and you will be tempted to ignore.

## Configuration

`traceable.config.json` at the project root:

```json
{
  "manifestsDir": "manifests",
  "runtimeFacts": "src/traceable/runtime-facts.ts",
  "managedSchemas": ["public"],
  "unauditedTables": ["audit.audit_log", "traceable.runs", "traceable.run_steps"],
  "rawQueryAllowlist": ["prisma/", "src/traceable/migrations-admin/"],
  "authMiddlewareName": "requireAuth",
  "ownerDatabaseUrlEnv": "DATABASE_URL",
  "modelToTable": "prisma/schema.prisma"
}
```

`managedSchemas` bounds `table.undeclared`: schemas outside the list (extensions, the
`audit` and `traceable` schemas) are ignored. Adding a schema here without adding its
table manifests is how people accidentally hide tables from the owner — don't.

## The static table scan

For each Api and Job manifest, the scanner starts at `handler` / `entrypoint`, follows
relative imports transitively within `src/` (never into `node_modules`), and collects
every match of:

```
(db|tx|prisma)\.<model>\.<method>(
```

`<model>` here is the Prisma **client property** (the model name with a lower-cased first
letter). It is mapped to a table name through `@@map` in `schema.prisma`. Prisma does not
pluralise or snake_case on its own — without `@@map`, the table name *is* the model name —
so **always write `@@map("snake_case_plural")` on every model**, or the manifest table
names and the real table names will not match. `<method>` classifies the access:

| Methods | Access |
| --- | --- |
| `findMany` `findFirst` `findFirstOrThrow` `findUnique` `findUniqueOrThrow` `count` `aggregate` `groupBy` `exists` | read |
| `create` `createMany` `createManyAndReturn` `update` `updateMany` `upsert` `delete` `deleteMany` | write |

Then:

- table read but not in `reads` or `writes` → `code.undeclared-table-access`
- table written but not in `writes` → `code.undeclared-table-access`
- table in `must_not_touch` and touched at all → `code.undeclared-table-access` (with a
  message that says "forbidden", because that is the more serious version)

### Known limits, stated honestly

Regex over source text is not a type checker. It will miss:

- a Prisma client aliased to a name other than `db`, `tx` or `prisma`
- a model accessed through a computed property (`prisma[modelName]`)
- table access inside a raw query

The first two are style violations the scan reports as `code.undeclared-table-access`
being *silent*, not as a false pass — which is why the grants layer exists underneath.
The third is why raw queries are banned outright. **The scan is the fine-grained check;
the grants are the guarantee.** Never describe the scan to the owner as the guarantee.

## What the checker deliberately does not do

- **It does not read your code with an LLM.** Non-deterministic checks cannot gate CI,
  and a checker the owner cannot trust is worse than none.
- **It does not compare manifest prose to code.** Descriptions are for humans; they are
  checked for existence and length, never for accuracy.
- **It does not auto-fix.** A checker that silently rewrites manifests to match code
  inverts the source of truth. It prints the fix; a human or you applies it.
- **It does not warn.** Every finding is an error. A warning tier becomes a backlog of
  permanently-yellow findings, and then the Drift page means nothing.

## Running it in CI

`templates/ci/drift-check.yml` is a ready GitHub Actions job. It:

1. starts a Postgres service container,
2. runs `prisma migrate deploy` as the owner role,
3. runs `npm run grants:generate` and fails if the committed grants migration differs,
4. runs `npm run manifests:validate`,
5. runs `npm run drift`,
6. uploads `.traceable/drift.json` as an artifact so a failing PR shows the findings.

Step 3 matters: grants are generated *from manifests* into a migration, so CI checks
the generated grants against the manifests that generated them. That sounds circular but
is not — it catches a generated migration that was committed stale, which is the common
real failure.
