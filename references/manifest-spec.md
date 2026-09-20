# Manifest specification

Machine-checkable YAML describing every API, table and job. JSON Schemas live in
`templates/schemas/`. The validator is `scripts/validate-manifests.mjs`.

## Contents

- [Layout and envelope](#layout-and-envelope)
- [kind: Api](#kind-api)
- [kind: Table](#kind-table)
- [kind: Job](#kind-job)
- [Actors, services and roles](#actors-services-and-roles)
- [Data claims: reads, writes, must_not_touch](#data-claims-reads-writes-must_not_touch)
- [What must NOT go in a manifest](#what-must-not-go-in-a-manifest)
- [Cross-reference rules the validator enforces](#cross-reference-rules-the-validator-enforces)
- [Worked example](#worked-example)

## Layout and envelope

```
manifests/
  apis/<endpoint-name>.yaml      kind: Api    — one file per endpoint
  tables/<table-name>.yaml       kind: Table  — one file per table
  jobs/<job-name>.yaml           kind: Job    — one file per cron/job
```

One entity per file. The file's basename must equal `metadata.name`. Every manifest
starts with the same four-key envelope, borrowed from Backstage:

```yaml
apiVersion: traceable.dev/v1
kind: Api | Table | Job
metadata:
  name: <kebab-case for apis and jobs, snake_case for tables>
  description: >-
    One or two plain-English sentences the owner will read in the UI.
    Say what it does and why it exists. No jargon.
  owner: <team or person responsible>          # optional
spec:
  ...
```

`metadata.description` is **required everywhere** and is rendered verbatim in the
DevOps UI. It is the main thing a non-coder reads. Write it for them, not for you.

## kind: Api

```yaml
apiVersion: traceable.dev/v1
kind: Api
metadata:
  name: tenant-status-update
  description: >-
    Sets a customer organisation to active or suspended. An AI step first checks the
    reason text is a real reason, then the status is written and the change recorded.
  owner: platform
spec:
  service: tenant-admin              # which service (→ DB role svc_tenant_admin)
  method: POST                       # GET | POST | PUT | PATCH | DELETE
  path: /api/tenants/:tenantId/status
  auth: secured                      # public | secured — see below
  handler: src/services/tenant-admin/routes/tenant-status-update.ts
  request:                           # optional, documentation for the UI
    description: Tenant id in the path; JSON body with status and reason.
  response:
    description: The updated tenant row.
  data:
    reads: [tenants]
    writes: [tenants, tenant_status_history]
    must_not_touch: [users, api_keys, invoices]
  runs_job: tenant-status-review     # optional — a Job this endpoint starts
```

### `auth`

Exactly two values, because exactly two are checkable:

- `public` — no authentication middleware on this route. Anyone who can reach the
  process can call it.
- `secured` — the project's authentication middleware is mounted on this route, and
  the checker verifies it is actually in the route's middleware chain.

Authorization detail (which role may call it) is **not** in `auth`. If you need it,
put it in `metadata.description` as prose for the owner — it cannot be machine-checked
from the route table, so it must not masquerade as a checked field.

Every `public` endpoint is highlighted on the APIs page in the UI. If a manifest says
`public` and the middleware is mounted anyway, that is `route.auth-mismatch` — it fails
just as loudly as the reverse, because the manifest is what the owner was told.

## kind: Table

```yaml
apiVersion: traceable.dev/v1
kind: Table
metadata:
  name: tenants
  description: >-
    One row per customer organisation. The status column controls whether that
    organisation can sign in.
spec:
  schema: public
  primary_key: [id]
  audited: true
  retention: indefinite              # indefinite | "<N> days" — prose is not allowed
  columns:
    - name: id
      description: Unique id of the organisation.
    - name: name
      description: Display name of the organisation.
      sensitivity: internal          # public | internal | personal | secret
    - name: status
      description: Either active or suspended.
```

### Columns declare names and meaning, never types

Types come from `information_schema.columns` and are shown in the UI from there.
Restating types in YAML creates a second source of truth that fights `schema.prisma`
and silently rots. The checker compares the **set of column names** only:

- a column in the DB with no manifest entry → `column.undeclared`
- a manifest entry with no column in the DB → `column.missing`

So every column still has to be described, and no column can appear without the owner
being told what it is.

`sensitivity` is declared, not derived. It drives redaction in the Audit UI
(`personal` and `secret` values are masked by default). Defaults to `internal`.

### `audited`

`true` for every table holding business data. The checker asserts the audit trigger is
attached (`audit.trigger-missing`) — and also that no table has a trigger it did not
declare (`audit.trigger-unexpected`).

`false` is allowed only for append-only log tables that would audit themselves into a
loop: `audit.audit_log`, `traceable.runs`, `traceable.run_steps`. Setting `audited: false`
on a business table is a review-blocking decision; say so in the description.

### There is no `accessed_by` field

Who reads and writes a table is **derived** from the `data` blocks of Api and Job
manifests, and rendered on the table's UI page. Declaring it in two places guarantees
they disagree. If you want to know who touches `tenants`, the UI already tells you.

## kind: Job

```yaml
apiVersion: traceable.dev/v1
kind: Job
metadata:
  name: tenant-status-review
  description: >-
    Checks that the reason given for a status change is a real reason, then applies
    the change. Runs when the status endpoint calls it, and nightly to catch retries.
spec:
  trigger:
    type: cron                       # cron | api | manual
    schedule: "0 3 * * *"            # required when type is cron
    timezone: UTC
  entrypoint: src/jobs/tenant-status-review/index.ts
  data:
    reads: [tenants]
    writes: [tenants, tenant_status_history]
    must_not_touch: [users, api_keys, invoices]
  pipeline:
    - node: load-tenant
      display_name: Load the organisation
      description: Reads the organisation row that is about to change.
      kind: code
    - gate: check-reason-is-needed
      display_name: Does this reason need checking?
      description: Suspensions get an AI check. Re-activations do not.
      routes:
        needs_check: classify-reason
        skip_check: apply-status
    - node: classify-reason
      display_name: Check the reason makes sense
      description: Asks the model whether the reason text is a real business reason.
      kind: llm
      model: anthropic/claude-sonnet-5
    - gate: accept-or-reject
      display_name: Was the reason acceptable?
      description: Routes to applying the change, or to recording a rejection.
      routes:
        accept: apply-status
        reject: record-rejection
    - node: apply-status
      display_name: Apply the new status
      description: Writes the new status and records the change in history.
      kind: code
      terminal: true
    - node: record-rejection
      display_name: Record that the change was refused
      description: Writes a history row explaining why nothing changed.
      kind: code
      terminal: true
```

Rules the validator enforces on `pipeline`:

- Every entry is **either** `node:` **or** `gate:`, never both.
- Step names are unique within the job and kebab-case.
- `node` entries need `kind: code | llm`. `kind: llm` needs `model`.
- `gate` entries need `routes`: a map of route label → step name or the literal `END`.
- Every route target exists in the pipeline (or is `END`) — `pipeline.gate-route-unknown`.
- At least one path reaches a `terminal: true` node or `END`.
- `display_name` and `description` are required on every step and are what the Runs
  page shows. Write them so someone who has never seen the code understands the step.

Jobs get their **own** DB role, `job_<name>`, independent of any service. A job is an
actor in its own right; that is what makes its `must_not_touch` meaningful.

`trigger.type: api` means the job is started by an endpoint (which declares `runs_job`).
`manual` means only a person starts it from the Jobs page in the UI.

## Actors, services and roles

An **actor** is anything that holds a database connection. There are exactly two kinds,
and the role name is derived, never declared:

| Actor | Declared by | DB role | Connection URL env var |
| --- | --- | --- | --- |
| service `tenant-admin` | `spec.service` on one or more Api manifests | `svc_tenant_admin` | `DATABASE_URL_SVC_TENANT_ADMIN` |
| job `tenant-status-review` | a Job manifest | `job_tenant_status_review` | `DATABASE_URL_JOB_TENANT_STATUS_REVIEW` |

Derivation: kebab-case → snake_case, prefixed. No manifest field sets a role name, so a
role can never be pointed at the wrong actor by a typo in YAML.

Migrations run as the **owner** role (`DATABASE_URL`), which is the only role allowed to
create tables, triggers and roles. No service or job ever connects as the owner.

## Data claims: reads, writes, must_not_touch

Three lists of table names per Api and per Job.

- `reads` — tables this endpoint or job selects from. Grants `SELECT`.
- `writes` — tables it inserts, updates or deletes rows in. Grants
  `SELECT, INSERT, UPDATE, DELETE`. A table in `writes` does not need to be in `reads`.
- `must_not_touch` — tables it is asserted never to use. **No grant at all**, and the
  checker fails if any grant exists.

### `must_not_touch` is a claim about the whole actor

Grants attach to a role, and a role is shared by every endpoint of a service. So if
`tenant-status-update` says `must_not_touch: [invoices]` while another endpoint in the
same `tenant-admin` service writes `invoices`, the claim is a lie at the database level.

The checker treats that as a hard failure: `grant.forbidden` — *"service tenant-admin
must not touch invoices (per tenant-status-update) but tenant-invoice-list reads it"*.

The fix is to **split the service**, not to weaken the claim. That is the intended
pressure: services end up small enough that their data boundary is a real boundary.

Per-endpoint precision is still checked, by the static scan: each handler file may only
touch the tables *its own* manifest declares (`code.undeclared-table-access`). So you get
two layers — a coarse runtime fence (grants) and a fine compile-time one (the scan).

### Choosing what goes in `must_not_touch`

Not every table you don't use. List the tables where the owner would be alarmed if this
code touched them: personal data, credentials, money, anything with
`sensitivity: personal | secret`. A `must_not_touch` list of thirty tables is noise
nobody reads; five load-bearing ones are a guarantee.

If an actor's `must_not_touch` is empty, say why in `metadata.description`.

## What must NOT go in a manifest

A field belongs in a manifest only if a script can prove it wrong. Keep these out:

| Do not declare | Why | Where it goes instead |
| --- | --- | --- |
| Column types, nullability, defaults | `schema.prisma` + the live DB already own this | nowhere — the UI reads the live DB |
| Rate limits, timeouts, SLAs | not observable from the route table | code + `metadata.description` |
| Which user roles may call an endpoint | not observable from middleware presence | `metadata.description` as prose |
| "This endpoint is fast / safe / idempotent" | unfalsifiable adjectives | delete it |
| Business rationale, tickets, links | not a runtime fact | `metadata.description`, or a link in it |

Adding an unfalsifiable field is the single most damaging thing you can do to this
system, because it teaches the owner that manifest fields are opinions.

## Cross-reference rules the validator enforces

Beyond JSON Schema, `scripts/validate-manifests.mjs` checks:

1. File basename equals `metadata.name`.
2. Names are unique across all manifests of the same kind.
3. Every table named in any `data.reads` / `data.writes` / `data.must_not_touch` has a
   `kind: Table` manifest.
4. `reads`, `writes` and `must_not_touch` of one manifest are pairwise disjoint.
5. `spec.handler` and `spec.entrypoint` point at files that exist.
6. `runs_job` names an existing Job manifest, and that job's `trigger.type` is `api`.
7. No two Api manifests declare the same `method` + `path`.
8. Pipeline rules listed under [kind: Job](#kind-job).
9. Table `primary_key` columns all appear in `spec.columns`.
10. `metadata.description` is at least 20 characters and is not a restatement of the name.

## Worked example

`examples/reference-app/manifests/` contains a complete, passing set: three tables, four
endpoints (one public, three secured), two jobs (one cron, one api-triggered), with an
LLM node and two gates. Read it before writing your first manifest — it is faster than
reading this file twice.
