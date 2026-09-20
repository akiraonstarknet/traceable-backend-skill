# DevOps UI specification

Six pages, one nav, mounted inside the application itself at `/devops`. The owner opens
one URL and can answer every question about the system without reading code.

Server-rendered HTML. No frontend build step, no SPA, no npm run build for Claude to
break. Progressive enhancement only (a little vanilla JS for filters).

## Contents

- [Audience and tone](#audience-and-tone)
- [Navigation](#navigation)
- [APIs](#apis)
- [Data](#data)
- [Jobs](#jobs)
- [Runs](#runs)
- [Audit](#audit)
- [Drift](#drift)
- [Cross-links that matter](#cross-links-that-matter)
- [Access control](#access-control)
- [Implementation notes](#implementation-notes)

## Audience and tone

The reader is the owner. They are smart, they know the business, they cannot read code.

- Every page leads with what is true right now, not with controls.
- Use the manifest `description` fields verbatim. They were written for this.
- Never show a raw identifier without its plain-English name next to it.
- Never show a stack trace above the fold. Show the error message; put the trace behind
  a disclosure.
- No icons carrying meaning on their own. Colour is never the only signal.
- Numbers get units and context: `1,340ms`, `$0.0021`, `412→38 tokens`.

## Navigation

```
APIs    Data    Jobs    Runs    Audit    Drift ●
```

`Drift` carries a count badge when `.traceable/drift.json` has findings, and a distinct
"never checked" state when the file is missing. That badge is the system's headline
health indicator; nothing else in the nav has one.

## APIs

**List.** One row per Api manifest: method, path, plain-English name, service, auth.
`public` endpoints are visually distinct and sorted first — a public endpoint appearing
unexpectedly is the thing most worth noticing.

Filters: service, method, auth.

**Detail**, for `POST /api/tenants/:tenantId/status`:

- Description from the manifest.
- Auth: `secured`, with the middleware actually found on the route.
- Handler file path (text, and a link if the repo has a browsable URL).
- **Data**: three lists, visually distinct —
  reads (`tenants`), writes (`tenants`, `tenant_status_history`),
  and **cannot touch** (`users`, `api_keys`, `invoices`) rendered as a guarantee with
  the sentence *"its database role has no permission on these tables"*, not as a note.
- Job it starts, if any → link to Jobs.
- Recent audit rows caused by this endpoint → link to Audit filtered by this endpoint.
- Drift findings for this endpoint, inline, if any.

Optionally a **Try it** control for `GET` endpoints, prefilled from the manifest. Never
offer one-click execution of a write endpoint from the UI.

## Data

**List.** One row per table: name, plain-English description, row count, audited yes/no,
number of actors that read it, number that write it.

**Detail**, for `tenants`:

- Description.
- **Columns**: name, type (from `information_schema`, not the manifest), the manifest's
  plain-English description, sensitivity badge.
- **Who touches this table** — derived from manifests, never declared:

  | Actor | Access | Declared in |
  | --- | --- | --- |
  | `tenant-admin` (service) | read, write | `apis/tenant-status-update.yaml` |
  | `tenant-status-review` (job) | read, write | `jobs/tenant-status-review.yaml` |

- **Who is forbidden** — actors listing this table in `must_not_touch`, with the same
  "has no permission" phrasing.
- Audited: yes, trigger `traceable_audit_tenants`, N changes in the last 7 days →
  link to Audit filtered by table.
- Recent changes: last 10 audit rows, inline.

Never show table data itself. This page is about the shape and the rules, not a data
browser; a data browser bypasses the audit trail's read story and invites edits.

## Jobs

**List.** Name, plain-English description, trigger (cron + human-readable schedule:
"every day at 03:00 UTC"), last run status and time, next run time, success rate over
the last 20 runs.

Flag **overdue** jobs — a cron job whose last run is older than its interval allows.
A job that silently stopped running is invisible everywhere else.

**Detail:**

- Description, trigger, entrypoint file.
- **Declared pipeline** as a simple diagram or indented list: nodes and gates in order,
  with each gate's routes. This is the *shape*, from the manifest.
- Data: reads / writes / cannot touch, same treatment as APIs.
- Recent runs table → links into Runs.
- Cost over the last 30 days, if the job has LLM nodes.
- Manual trigger button for `trigger.type: manual` jobs only, behind a confirmation.

## Runs

The page that justifies the whole design.

**List.** Run id, job (plain-English name), status, trigger source, who triggered it,
started, duration, cost. Filters: job, status, date range, actor, and free-text on
`run_id` / `request_id`.

Default view: newest first, failures first within the same day.

**Detail** — the flattened list, exactly as in
[node-gate-spec.md](node-gate-spec.md#why-flattened-not-a-graph):

```
Run run_01J8X…   tenant-status-review   ✓ succeeded   1,362ms   $0.0021
Started by POST /api/tenants/t_123/status  (request req_01J8X…)  by ada@example.com

1  Load the organisation              node   12ms    ✓
2  Does this reason need checking?    gate    1ms    → needs_check
      "Suspension, so the reason text needs checking."
3  Check the reason makes sense       llm   1,340ms  ✓
      claude-sonnet-5 · 412 in → 38 out · $0.0021 · gen-abc123
4  Was the reason acceptable?         gate    0ms    → accept
      "The model judged the reason specific and business-related."
5  Apply the new status               node    9ms    ✓
      wrote tenants, tenant_status_history
```

Each step expands to show `input_json` and `output_json` pretty-printed. Gate steps show
the route and the reason without expanding — the reason is the point.

LLM steps show model, tokens in/out, cost, and the provider generation id as text the
owner can quote back to a provider.

Failed runs open with the failing step expanded and the error message in plain text.

A "changed N rows" link on each node goes to Audit filtered by this `run_id`.

## Audit

**List.** When, table, operation, plain-English row identity where possible, actor,
source, and the request or run it belongs to.

Filters: table, actor, source, operation, date range, `request_id`, `run_id`, `record_id`.
Filters compose and belong in the URL so the owner can send someone a link.

**Row detail.** Before and after, side by side, with changed columns highlighted and
unchanged ones collapsed by default. Columns whose manifest `sensitivity` is `personal`
or `secret` are masked; revealing is a deliberate click and is itself logged.

**History of one record.** From any row, "show everything that happened to this record"
→ filtered by `record_id`, oldest to newest. This is the "who changed this and when"
question, answered in one click.

Never paginate by offset over a large audit table; key-set paginate on
`(happened_at, id)`.

## Drift

Reads `.traceable/drift.json`. Three states, and the third is the one people forget:

1. **Clean** — "17 checks, no drift. Last checked 4 minutes ago, commit `a1b2c3d`."
2. **Findings** — grouped by entity, each with the check id, the message, and the `fix`
   line. Each entity links to its APIs/Data/Jobs page.
3. **Never checked / stale** — no file, or `checked_at` older than the latest deploy.
   Show this as a warning state in its own right. "No findings" and "nobody looked" must
   never look the same.

Show what each check actually compares, in one line, so the owner understands the
guarantee: *"`grant.forbidden` — compares each actor's database permissions against the
tables its manifest says it must not touch."*

## Cross-links that matter

The value is in the joins. These five must work:

1. API detail → Audit filtered by that endpoint's writes.
2. Run step → Audit filtered by `run_id`.
3. Audit row → the run or request that caused it.
4. Table detail → every actor that touches it, and each actor's manifest.
5. Drift finding → the entity page it concerns.

## Access control

`/devops` is `auth: secured` and admin-only. It is itself declared in manifests like any
other route — the DevOps UI is not exempt from the rules it displays.

It reads business data (audit rows contain row contents). Its DB role gets `SELECT` on
`audit`, `traceable` and the tables it summarises, and **no write grants at all** except
the reveal log.

## Implementation notes

- One module per page under `src/devops/pages/`, each exporting a Hono route.
- Shared layout in `src/devops/layout.ts`, inline CSS, no external fonts or CDNs.
- Queries live in `src/devops/queries/` and are read-only.
- Keep it fast: every page must render under 300ms on a laptop with a year of audit data.
  Use the indexes in `templates/sql/010_audit.sql`; add a covering index before adding a
  cache.
- Do not add a chart library for a number that could be a sentence.
