# Reference app

A complete, working application that obeys every rule in the `traceable-backend` skill.
Read it when a rule is unclear — it is faster than reading the reference docs twice.

## What it does

Three customer organisations that can be suspended and reactivated. A status change does
not happen in the endpoint: it starts a job whose steps check the reason with a language
model first, and the job may refuse the change. Every outcome, including refusals, is
recorded.

## What each rule looks like here

| Rule | Where to look |
| --- | --- |
| Manifests are the source of truth | `manifests/` — 11 endpoints, 7 tables, 1 job |
| Drift is detected | `npm run drift`, then break something and run it again |
| "Not touched" is enforced | `prisma/migrations/*_traceable_grants/migration.sql` — generated, never hand-written |
| Every write is audited | `prisma/migrations/0001_traceable_infrastructure/migration.sql`, and `src/traceable/with-context.ts` |
| Nodes and gates | `src/jobs/tenant-status-review/` — 4 nodes, 2 gates, one of them an LLM node |
| DevOps UI | `src/devops/pages/` — six pages at `/devops` |
| Manifest and code change together | every endpoint here has a manifest; adding one without it fails `npm run drift` |

## Running it

```bash
npm install --legacy-peer-deps

# once, as a Postgres superuser
psql -f scripts/bootstrap-superuser.sql
psql -c "create database traceable_demo owner app_owner"

cp .env.example .env
npm run setup     # generate client, generate grants, migrate, set role passwords
npm run seed
npm run drift     # OK  6 checks, no drift.
npm run demo      # accepted change, refused change, reactivation, page render check
npm start         # http://localhost:3000/devops
```

The UI is `auth: secured` like everything else. Any email works as a bearer token in the
demo: `curl -H 'Authorization: Bearer ada@example.com' localhost:3000/devops/apis`

## Things worth trying

```bash
# 1. The audit trigger refuses un-attributed writes
psql "$DATABASE_URL" -c "update tenants set name='x' where id='t_acme';"
#    ERROR: traceable: refusing to write public.tenants without audit context.

# 2. A service cannot reach a table its manifest forbids
PGPASSWORD=demo_pw psql -h 127.0.0.1 -U svc_tenant_admin -d traceable_demo \
  -c "select * from users;"
#    ERROR: permission denied for table users

# 3. The endpoint service cannot write at all - the job does the writing
PGPASSWORD=demo_pw psql -h 127.0.0.1 -U svc_tenant_admin -d traceable_demo \
  -c "update tenants set name='x';"
#    ERROR: permission denied for table tenants

# 4. Grant something the manifest forbids, and watch the checker find it
psql "$DATABASE_URL" -c "grant select on users to svc_tenant_admin"
npm run drift
#    grant.forbidden  svc_tenant_admin holds SELECT on public.users, which
#                     manifests/apis/tenant-list.yaml forbids
psql "$DATABASE_URL" -c "revoke all on users from svc_tenant_admin"
```

## Notes

- `prisma` is pinned to 7.10.0: npm's `latest` tag currently points at an 8.0 release
  candidate. `--legacy-peer-deps` works around an npm 10.9 peer-resolution bug.
- The LLM node uses a deterministic offline stub unless `OPENROUTER_API_KEY` is set, so
  the demo runs without network access and its output is reproducible. Stub generation
  ids are prefixed `stub-` so nothing pretends to be a real provider call.
- The scripts are referenced from `../../scripts/`. In a real project you copy them into
  your own `scripts/` directory — see `references/bootstrap.md`.
