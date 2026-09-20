<!--
Copy the section below into the project's CLAUDE.md (and AGENTS.md if it has one).
Append it if the file already exists. Do not paraphrase it — the rules are the
contract between you and an owner who cannot read the code.
-->

## Traceable backend rules

This project is verified from its DevOps UI at `/devops`, by an owner who does not read
code. Manifests are the source of truth and a checker proves them against the running
system. Read `SKILL.md` of the `traceable-backend` skill before your first change.

### The change loop — run it for every change, in this order

1. Write or update the manifest **first**: `manifests/{apis,tables,jobs}/<name>.yaml`
2. `npm run manifests:validate`
3. Write the migration, if data changed (table + audit trigger + regenerated grants)
4. Write the code
5. `npm run drift` — **must exit 0**
6. Report to the owner: outcome first, real file/endpoint/table names

Writing the manifest first is load-bearing. If you write code first, you will write the
manifest to match the code, and it stops being a constraint.

### Any change touching an API, a table or a job MUST update its manifest in the same change

A pull request that changes a route, a column or a pipeline step without changing the
corresponding manifest is incomplete, regardless of whether the code works.

### Never say "done" until `npm run drift` passes

Not "should pass", not "passes apart from". Run it, in this session, and quote the result.

### Non-negotiables

- No route without a `kind: Api` manifest.
- No table without a `kind: Table` manifest and an audit trigger.
- No database write outside `withContext()` — the audit trigger rejects it anyway.
- No `$queryRaw` / `$executeRaw` / `*Unsafe` outside the `rawQueryAllowlist` in
  `traceable.config.json`. They blind the static table scan.
- No database handle, HTTP client or LLM client in a gate. Gates take a frozen input and
  a logger, and return `{ route, reason }`.
- No unrecorded run. A failed run is the run the owner most needs to see.
- No service or job connecting as the owner role. Migrations use `DATABASE_URL`;
  services use `DATABASE_URL_SVC_<SERVICE>`; jobs use `DATABASE_URL_JOB_<JOB>`.
- Never suppress, skip or weaken a drift finding to get green. Fix the code or fix the
  manifest and tell the owner which you changed.

### Data claims

Every API and job declares `reads`, `writes` and `must_not_touch`. `must_not_touch` is
enforced by the absence of a Postgres grant on that actor's role, not by a comment.
Grants are generated from manifests by `npm run grants:generate` — never hand-written.

If two endpoints of the same service disagree about a table (one writes it, another
forbids it), the drift check fails with `grant.forbidden`. The fix is to split the
service, not to weaken the claim.

### Naming

Literal and descriptive. No metaphor, nature, myth or mood names — no `atlas`, `phoenix`,
`nova`, `sentinel`, `core`, `engine`, `utils`, `manager`, `processor`. The test: could the
owner guess what it does from the name alone?

Node `display_name`s are actions ("Apply the new status"). Gate `display_name`s are
questions ("Was the reason acceptable?"). Both are shown to the owner in the Runs page.

### Reporting

Lead with the outcome. Name real files, endpoints and tables. Never "handles X
gracefully", "robust", "should work", "fully tested".

End every report of a change with: the drift check result and check count; files changed
by real path; which `/devops` page shows the change; and **anything you did not do**.
Omitting a known gap is the failure this project exists to prevent.
