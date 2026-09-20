# Bootstrapping a new traceable backend

Order matters. Each step depends on the one before it.

## 0. Prerequisites

- Node 20+ and PostgreSQL 15+.
- A Postgres **owner** role with `CREATEROLE` and `CREATEDB`. `CREATEDB` is needed for
  Prisma's shadow database during `migrate dev`; without it you get `P3014`.
- If you cannot get `CREATEROLE`, rule 3 ("not touched" is enforced) cannot hold. Say so
  to the owner before writing any code, and record the downgrade in the README.

## 1. Project skeleton

```
manifests/{apis,tables,jobs}/
prisma/{schema.prisma,migrations/}
scripts/{validate-manifests.mjs,check-drift.mjs,generate-grants.mjs}
src/
  traceable/        runtime-facts.ts, context.ts, with-context.ts, runner.ts, ids.ts
  services/<service>/routes/
  jobs/<job>/{nodes,gates,index.ts}
  devops/           pages/, queries/, layout.ts
traceable.config.json
CLAUDE.md
.github/workflows/drift-check.yml
```

Copy the three scripts from this skill's `scripts/` directory unchanged. Copy
`templates/CLAUDE.md.snippet.md` into the project's `CLAUDE.md` (append if one exists).

## 2. Dependencies

```bash
npm i hono @hono/node-server @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0 pg
npm i -D prisma@7.10.0 tsx typescript ajv ajv-formats yaml @types/node @types/pg
```

Pin Prisma. At the time of writing npm's `latest` tag for `prisma` points at an
`8.0.0-rc`, so an unpinned install gets a release candidate.

`package.json` needs `"type": "module"` and these scripts:

```json
{
  "scripts": {
    "manifests:validate": "node scripts/validate-manifests.mjs",
    "grants:generate": "node scripts/generate-grants.mjs",
    "drift": "node scripts/check-drift.mjs",
    "dev": "tsx watch src/server.ts"
  }
}
```

## 3. Prisma 7 configuration

Prisma 7 requires a driver adapter and moves the datasource URL out of `schema.prisma`:

```prisma
// prisma/schema.prisma
generator client { provider = "prisma-client", output = "../src/generated/prisma" }
datasource db    { provider = "postgresql" }
```

```ts
// prisma.config.ts
import { defineConfig, env } from 'prisma/config';
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },   // owner role, migrations only
});
```

Per-actor clients are then natural — each gets its own connection string:

```ts
// src/traceable/db.ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export function clientForActor(envVar: string) {
  const connectionString = process.env[envVar];
  if (!connectionString) throw new Error(`missing ${envVar}`);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
```

## 4. Audit and runs infrastructure

Apply, in this order, as the owner role:

1. `templates/sql/010_audit.sql` — `audit` schema, `audit_log`, `set_context()`,
   `log_change()`, `attach()` / `detach()`.
2. `templates/sql/020_runs.sql` — `traceable` schema, `runs`, `run_steps`,
   `llm_model_prices`.

Put both in `prisma/migrations/<timestamp>_traceable_infrastructure/migration.sql` so
they are part of the normal migration history, not a side-channel setup script.

## 5. First table, end to end

Do one table completely before adding a second. The loop is the product.

1. `manifests/tables/tenants.yaml` — every column described.
2. Model in `schema.prisma`, `@@map("tenants")`.
3. `npx prisma migrate dev --name add_tenants`.
4. Append to that migration: `select audit.attach('public','tenants');`
5. `npm run manifests:validate`.

## 6. First service, role and grants

1. `manifests/apis/<name>.yaml` with `service: tenant-admin` and its `data` block.
2. `npm run grants:generate` — writes a **new**
   `prisma/migrations/<timestamp>_traceable_grants/migration.sql` containing `create
   role`, `grant` and `revoke` statements derived from every manifest. **Never
   hand-write grants**; the generator is what keeps them equal to the manifests.
3. `npx prisma migrate deploy`.
4. Put the role's connection string in `DATABASE_URL_SVC_TENANT_ADMIN`. Roles are
   created `NOLOGIN`, so the deployment sets the password out of band and no
   credential is ever committed.

Each regeneration writes a new migration rather than rewriting the last one. That is
deliberate: Prisma records migrations as applied by directory name, so rewriting one in
place makes `migrate deploy` report "no pending migrations" and apply nothing — the
database ends up with no role for a service the code expects, silently. If nothing
changed, the generator says so and writes no file.

Each generated migration revokes the full set before granting, and every statement is
guarded by `to_regclass`, so replaying the chain on a fresh database converges on the
current state and a removed `reads` entry produces a `revoke`.

## 7. Runtime facts and the first drift run

`src/traceable/runtime-facts.ts` must build the real app and the real job registry:

```ts
import { buildApp } from '../server.js';
import { jobRegistry } from '../jobs/registry.js';

export function describeRuntime() {
  const app = buildApp();
  return {
    routes: app.routes.map(r => ({
      method: r.method.toUpperCase(),
      path: r.path,
      middleware: middlewareNamesFor(r),
    })),
    jobs: jobRegistry.describe(),
  };
}
```

Then `npm run drift`. Expect findings on the first run — that is the checker working.

## 8. DevOps UI

Add the six pages from [ui-pages-spec.md](ui-pages-spec.md) last, once there is
something real to show. Declare them in manifests like any other route; a `svc_devops`
role with `SELECT` only.

## 9. CI

Copy `templates/ci/drift-check.yml` to `.github/workflows/`. Confirm it fails on a
deliberate mismatch (delete a column from a manifest and push) before trusting it.

## Common first-run failures

| Symptom | Cause |
| --- | --- |
| `P3014 could not create the shadow database` | owner role lacks `CREATEDB` |
| `traceable: refusing to write ... without audit context` | a write outside `withContext()` — correct, fix the caller |
| `role.missing` on every actor | `npm run grants:generate` not run, or its migration not applied |
| `route.undeclared` for `/devops/*` | the UI's own routes need manifests too |
| `code.raw-query-forbidden` in `with-context.ts` | add `src/traceable/` to `rawQueryAllowlist` |
| Every table is `table.undeclared` | `managedSchemas` does not include the schema you used |
