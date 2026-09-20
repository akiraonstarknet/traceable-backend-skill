# traceable-backend

A Claude skill for building internal backend software that a **non-coder owner can
verify without reading code**.

Claude writes essentially all of it. So the owner needs a way to check what it built
that does not depend on trusting a summary. This skill makes Claude build that way:
every API, table and job is described in a manifest, a checker proves those manifests
against the running system, and a DevOps UI inside the app shows the result.

## The problem

Existing tools each solve a piece and stop short:

- **Backstage** gives you `catalog-info.yaml` — but nothing checks it, so catalogs rot.
- **Encore** derives a beautiful service catalog from code — but a derived catalog
  documents the AI's mistakes as facts, and it means adopting a framework.
- **Spec Kit** treats specs as the source of truth — but specs are prose, and prose
  cannot be diffed against a live route table.
- **Langfuse** tracks LLM cost per call — but knows nothing about your endpoints or tables.
- **Bemi** and **supa_audit** capture database changes — but not who was *allowed* to make them.

None of them can answer the question an owner actually asks: *"can this thing touch my
customer data, and how do I know?"*

## What this does instead

Manifests are narrowed until **every field maps to an observable runtime fact**. Then a
checker — with no LLM in it — compares them:

| The manifest says | Checked against |
| --- | --- |
| this endpoint exists, at this method and path | the app's live route table |
| it needs a login | the middleware actually mounted on that route |
| this table has these columns | `information_schema.columns` |
| its changes are recorded | `pg_trigger` |
| this service writes `tenants` | its Postgres role's grants |
| **this service must never touch `users`** | **the absence of any grant on `users`** |
| this job runs these steps, calling this model | the job registry the runner loads |

The last row is the one nothing else does. **"Not touched" is a revoked privilege, not a
comment.** Each service and job connects to Postgres as its own role, holding only the
grants its manifest justifies — and the grants are *generated from* the manifests, so
they cannot drift.

Every write is captured by a database trigger with the actor, the request id and the run
id attached. The trigger **refuses writes that arrive without that context**, so
attribution cannot be forgotten.

AI and multi-step jobs are built from **nodes** (do one thing) and **gates** (read the
last output, return a route label, change nothing — enforced by the type signature).
Every run is stored, success or failure, as a flat list a non-coder can read:

```
1  Load the organisation              node   3ms   ✓
2  Does this reason need checking?    gate   2ms   → needs_check
      "This is a suspension, so the reason text needs checking before access is removed."
3  Check the reason makes sense       llm    3ms   ✓
      anthropic/claude-sonnet-5 · 68 in → 29 out · $0.000639 · gen-abc123
4  Was the reason acceptable?         gate   2ms   → reject
      "The reason was not accepted: it looks like a placeholder rather than a real explanation."
5  Record that the change was refused node   7ms   ✓
```

## Install

Copy the skill into your Claude skills directory:

```bash
git clone https://github.com/akiraonstarknet/traceable-backend-skill
cp -r traceable-backend-skill ~/.claude/skills/traceable-backend
```

Then tell Claude what you want built. The skill triggers on endpoints, tables, cron jobs,
audit trails, drift, run logging and internal admin dashboards.

For an existing project, also copy `templates/CLAUDE.md.snippet.md` into your `CLAUDE.md`
and the three scripts into your `scripts/` directory. `references/bootstrap.md` has the
full sequence.

## Two-minute demo

Needs Node 20+ and PostgreSQL 15+.

```bash
cd examples/reference-app
npm install --legacy-peer-deps

# once, as a Postgres superuser
psql -f scripts/bootstrap-superuser.sql
psql -c "create database traceable_demo owner app_owner"

cp .env.example .env
npm run setup     # migrations, generated grants, one login per service and job
npm run seed
npm run drift     # OK  6 checks, no drift.
npm run demo      # one accepted change, one refused, one reactivation
npm start         # then open http://localhost:3000/devops
```

The DevOps UI needs a bearer token; in the demo any email works:
`curl -H 'Authorization: Bearer ada@example.com' localhost:3000/devops/apis`

Then try breaking it — that is the interesting part:

```bash
# grant a service something its manifest forbids
psql "$DATABASE_URL" -c "grant select on users to svc_tenant_admin"
npm run drift
#   grant.forbidden  svc_tenant_admin holds SELECT on public.users, which
#                    manifests/apis/tenant-list.yaml forbids
```

Or run the whole suite of deliberate breakages:

```bash
cd ../.. && npm install && npm test    # 16 cases, each asserting the checker fails correctly
```

## What is in here

```
SKILL.md                      the skill itself: seven rules, the change loop, scope limits
references/
  manifest-spec.md            the YAML, and what must NOT go in it
  drift-check-spec.md         every check id, what it compares, and what it deliberately does not do
  audit-spec.md               trigger design, context propagation, cost and limits
  node-gate-spec.md           node/gate contracts, run storage, LLM cost accounting
  ui-pages-spec.md            the six pages and who they are written for
  naming-and-reporting.md     literal names; reports that lead with the outcome
  bootstrap.md                setting up a new project, in order
templates/
  schemas/*.json              JSON Schema 2020-12 for each manifest kind
  sql/010_audit.sql           audit_log, context helper, trigger, attach/detach
  sql/020_runs.sql            runs, run_steps, model prices, stalled-run reaper
  CLAUDE.md.snippet.md        the rules, for your project's CLAUDE.md / AGENTS.md
  ci/drift-check.yml          GitHub Actions job that fails the build on drift
scripts/
  validate-manifests.mjs      schema + cross-reference validation
  generate-grants.mjs         generates the roles-and-grants migration from manifests
  check-drift.mjs             the checker
  self-test.mjs               proves the checker fails when it should
examples/reference-app/       a complete working app obeying every rule
research/NOTES.md             prior art: what was borrowed, what was avoided, licences
```

## Default stack

TypeScript · Hono · PostgreSQL 15+ · Prisma 7 (pg driver adapter) · YAML manifests
validated by JSON Schema · one Postgres role per service and job · server-rendered HTML
UI with no frontend build step.

The rules are stack-independent. You need a route table you can enumerate, a way to
statically see which tables a file touches, and per-role connections.

## Where this does not fit

Stated plainly, because a guarantee whose cost is hidden gets switched off in a panic:

- **High write throughput.** Trigger-based auditing costs roughly 10–30% write throughput
  and is not advisable above ~3k writes/second.
- **Hundreds of services.** One connection pool per service does not scale without a pooler.
- **No `CREATEROLE`.** Without it, "not touched" downgrades from an enforced privilege to
  a static check. The skill tells the owner rather than pretending otherwise.

## Prior art

`research/NOTES.md` credits what each idea came from: Backstage's manifest envelope,
Encore's single dashboard, LangGraph's route-label contract, Burr's per-node reads/writes,
Temporal's effects-in-named-units discipline, Inngest's per-step run view, Langfuse's
generation field set, Bemi's context model, supa_audit's trigger design, Spec Kit's
"specification is the source of truth" framing, and Anthropic's `skill-creator` for the
skill layout and eval approach.

## Licence

Apache-2.0. See `LICENSE`.
