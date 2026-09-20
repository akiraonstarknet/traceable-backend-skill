---
name: traceable-backend
description: >-
  Build internal backend software that a non-coder owner can verify from a built-in
  DevOps UI instead of reading code. Use this skill whenever you are adding, changing
  or reviewing an HTTP API endpoint, a database table or migration, a cron job, a
  background job, a scheduled task, or an AI/LLM pipeline in an internal tool or
  admin backend — and whenever the user mentions manifests, drift, drift detection,
  audit trail, audit log, who changed this row, DB grants or per-service database
  roles, run history, node/gate pipelines, agent step logging, token cost tracking,
  an internal DevOps or admin dashboard, "how do I know the AI did what it said", or
  wanting a non-technical owner to verify what the system does. Also use it when
  asked to set up a new internal backend project that must be auditable or verifiable
  by someone who cannot read code.
license: Apache-2.0
---

# Traceable backend

## What this skill is for

You are writing almost all of the code in this project. The owner cannot read it.
So the owner must be able to verify the system **without reading code** — from a
DevOps UI inside the app, backed by machine-checked facts.

That means: nothing is true because you said so. Every claim about this backend is
written in a manifest, and a checker proves the manifest against the running system.

**The one rule that generates all the others:** if a claim in a manifest cannot be
falsified by a script, the claim does not belong in a manifest.

## The seven rules

1. **Manifests are the source of truth.** Every API, table and job has a YAML manifest
   declaring what it is, what data it reads, what it writes, and what it must not
   touch. Code is validated against them. The UI reads them.
2. **Drift is detected, not trusted.** A checker compares every manifest field against
   a runtime fact — live route table, `information_schema`, `pg_trigger`,
   `role_table_grants`, the job registry. Mismatches appear on the Drift page and fail CI.
3. **"Not touched" is enforced, not claimed.** Each service and job connects to Postgres
   as its own role, holding only the grants its manifests justify. A forbidden table is
   a revoked privilege, not a comment.
4. **Every write is audited at the database.** Triggers capture old row, new row and
   context (actor, source, request_id, run_id). The trigger *refuses the write* if
   context is missing, so attribution cannot be forgotten.
5. **AI and multi-step jobs are nodes and gates.** A node does one action. A gate reads
   the previous output and returns only a route label — it has no side effects, enforced
   by its type signature. Every run is stored, success or failure, flattened
   node → gate → node, with plain-English names, inputs, outputs, durations, and for LLM
   nodes the model, tokens, cost and provider generation id.
6. **One DevOps UI**, grouped nav: APIs, Data, Jobs, Runs, Audit, Drift.
7. **Manifest and code change together.** Any change touching an API, table or job updates
   its manifest in the same change, and `npm run drift` must pass before you say "done".

## Default stack

TypeScript · Hono · PostgreSQL 15+ · Prisma 7 (pg driver adapter) · YAML manifests
validated by JSON Schema 2020-12 · per-service Postgres roles · server-rendered HTML UI
with no frontend build step.

The rules are stack-independent. If the project already uses Express, Fastify, Drizzle or
raw SQL, keep it and adapt: you need a route table you can enumerate, a way to statically
see which tables a file touches, and per-role connections.

## Start here

**Before writing any code**, read the manifest spec. Everything else follows from it.

| You are about to... | Read |
| --- | --- |
| Write or change any manifest | `references/manifest-spec.md` |
| Add or change an endpoint, table or job | `references/manifest-spec.md`, then `references/drift-check-spec.md` |
| Set up auditing, or touch a migration | `references/audit-spec.md` |
| Build or change an AI / multi-step job | `references/node-gate-spec.md` |
| Build or change the DevOps UI | `references/ui-pages-spec.md` |
| Name anything, or write a report to the owner | `references/naming-and-reporting.md` |
| Set up a brand new project | `references/bootstrap.md` |

Templates you copy rather than invent live in `templates/`. Scripts you copy into the
project's own `scripts/` directory live in `scripts/`. A complete working app that obeys
every rule is in `examples/reference-app/` — read it when a rule is unclear.

## The change loop

Run this for every change. It is not optional and the order matters.

```
1. Write or update the manifest first.        manifests/{apis,tables,jobs}/<name>.yaml
2. npm run manifests:validate                 schema + cross-reference errors
3. Write the migration (if data changed).     prisma/migrations + audit trigger + grants
4. Write the code.                            handler / job, using the declared tables only
5. npm run drift                              must exit 0
6. Report to the owner.                       outcome first, real file and endpoint names
```

If step 5 fails, fix the code or fix the manifest — never silence the checker. A
suppressed drift finding is the exact failure this project exists to prevent.

### Writing the manifest first is load-bearing

Writing the manifest first forces you to decide what the change is allowed to touch
before you are holding a half-written handler that already touches more. If you write
code first you will write the manifest to match the code, and the manifest stops being
a constraint.

## Non-negotiables

These have no exceptions. If one seems to block you, the design is wrong, not the rule.

- **Never** add a route that has no `kind: Api` manifest. The checker reports
  `route.undeclared` and CI fails.
- **Never** create a table without a `kind: Table` manifest and an audit trigger.
- **Never** write to the database outside a transaction that has set the audit context.
  Use the project's `withContext()` helper; the trigger will reject the write otherwise.
- **Never** use `$queryRaw`, `$executeRaw`, `$queryRawUnsafe` or `$executeRawUnsafe` in
  service or job code. They make the static table scan blind. The only allowed place is
  the migration/admin directory listed in `traceable.config.json`.
- **Never** give a gate a database handle, an HTTP client, or an LLM client. Gates take
  a frozen input and a context containing only a logger, and return `{ route, reason }`.
- **Never** let a run go unrecorded because it failed. A failed run is the run the owner
  most needs to see.
- **Never** connect a service to Postgres as the owner/superuser role at runtime.
  Migrations run as the owner; services run as `svc_<service>`; jobs run as `job_<name>`.
- **Never** report "done" without a green `npm run drift` in the same session.

## How the checks actually work

The checker never reads your code with an LLM and never diffs prose. Each manifest field
maps to one observable fact:

| Manifest says | Checked against |
| --- | --- |
| endpoint method + path | the app's live route table (`app.routes`) |
| `auth: secured` / `public` | the middleware actually mounted on that route |
| table exists, column names | `information_schema.tables` / `.columns` |
| `audited: true` | `pg_trigger` on that table |
| `data.writes: [x]` | `INSERT/UPDATE/DELETE` grant to that actor's role on `x` |
| `data.must_not_touch: [y]` | **no** grant to that actor's role on `y` |
| handler touches only declared tables | static scan of `prisma.<model>.<method>` calls |
| job schedule | the registered scheduler entries |
| job pipeline steps and gate routes | the node/gate registry the runner loads |

`references/drift-check-spec.md` has the full list of check ids and what each failure means.

## Scope boundaries

This skill is for **internal** software: admin backends, ops tools, back-office systems,
internal AI pipelines. Order of magnitude: tens of endpoints, tens of tables, hundreds to
thousands of writes per minute.

Do not apply it unchanged to:

- **High write throughput.** Trigger-based auditing costs roughly 10–30% write throughput
  and is not advisable above ~3k writes/second. Above that, say so plainly and propose
  logical-replication CDC instead of quietly dropping the audit trail.
- **Public consumer products at scale.** Per-service roles and one connection pool per
  service do not scale to hundreds of services without a pooler.
- **Systems where you are not allowed to create database roles.** Rule 3 is unenforceable
  without `CREATEROLE`. Tell the owner the guarantee is downgraded to a static check
  rather than pretending it holds.

## When the owner asks you something

Lead with the outcome. Refer to real files, endpoints and tables. No metaphors, no
abstractions, no "the system now handles X gracefully". `references/naming-and-reporting.md`
is short and binding — read it before writing any report, PR description or commit message.

Bad: *"Added resilient tenant lifecycle orchestration."*

Good: *"`POST /api/tenants/:id/status` now sets `tenants.status`. It writes `tenants` and
`tenant_status_history`, and cannot touch `users` or `invoices` — its DB role has no grant
on them. Every change is in Audit, filtered by `request_id`. Drift check passes (17 checks)."*
