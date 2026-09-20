# Audit trail specification

Every write to a business table is captured **at the database**, with context attached,
by a trigger. Application code cannot opt out, and cannot forget — the trigger rejects
writes that arrive without context.

SQL lives in `templates/sql/010_audit.sql`.

## Contents

- [Why triggers and not CDC](#why-triggers-and-not-cdc)
- [The audit_log table](#the-audit_log-table)
- [Context: how actor and request_id get in](#context-how-actor-and-request_id-get-in)
- [The trigger function](#the-trigger-function)
- [Attaching and detaching triggers](#attaching-and-detaching-triggers)
- [Application helper: withContext](#application-helper-withcontext)
- [Redaction](#redaction)
- [Cost and limits](#cost-and-limits)
- [Reading the trail](#reading-the-trail)

## Why triggers and not CDC

Bemi and similar tools stream changes off the write-ahead log. That catches everything,
including manual `psql` edits, and costs nothing on the write path.

We use triggers anyway, for one reason: **a CDC pipeline can fall behind or stop, and a
silently incomplete audit trail is worse than no audit trail**, because the owner will
trust it. A trigger is synchronous: if the audit row cannot be written, the business
write fails too. The trail is complete by construction.

The cost is throughput (see [Cost and limits](#cost-and-limits)). For internal software
that is the right trade. Say so to the owner rather than hiding it.

## The audit_log table

```sql
create schema if not exists audit;

create table audit.audit_log (
  id              bigserial primary key,
  happened_at     timestamptz not null default now(),
  table_schema    text        not null,
  table_name      text        not null,
  operation       text        not null check (operation in ('INSERT','UPDATE','DELETE')),
  record_id       uuid        not null,
  row_before      jsonb,
  row_after       jsonb,
  changed_columns text[],
  actor           text        not null,
  source          text        not null check (source in ('api','cron','run','migration','manual')),
  request_id      text,
  run_id          text,
  db_role         text        not null default current_user,
  txid            bigint      not null default txid_current()
);

create index audit_log_record_idx  on audit.audit_log (record_id, happened_at desc);
create index audit_log_table_idx   on audit.audit_log (table_name, happened_at desc);
create index audit_log_actor_idx   on audit.audit_log (actor, happened_at desc);
create index audit_log_request_idx on audit.audit_log (request_id) where request_id is not null;
create index audit_log_run_idx     on audit.audit_log (run_id) where run_id is not null;
```

`record_id` is a stable uuid derived from the row's primary key values, so the whole
history of one row is one index lookup rather than a scan of a jsonb column:

```sql
md5(table_schema || '.' || table_name || '#' || pk_values_text)::uuid
```

This is deterministic and dependency-free. It is not an RFC-4122 versioned uuid; it is an
identifier, not a namespace uuid, and nothing should parse a version out of it.

`changed_columns` is populated on UPDATE only, so the Audit page can show "status" instead
of making the owner diff two json blobs.

`db_role` and `txid` are defaulted by the database, not supplied by the app. They are the
columns that let you detect a write that came from somewhere unexpected: a row whose
`db_role` is the owner role did not come through a service.

## Context: how actor and request_id get in

Context travels on the **transaction**, using Postgres transaction-local settings. The
app sets them at the start of a transaction; the trigger reads them.

```sql
select set_config('traceable.actor',      $1, true);   -- true = local to transaction
select set_config('traceable.source',     $2, true);
select set_config('traceable.request_id', $3, true);
select set_config('traceable.run_id',     $4, true);
```

The `true` third argument is load-bearing: it scopes the setting to the current
transaction, so a pooled connection cannot leak one request's actor onto the next.

| Field | Meaning | Example |
| --- | --- | --- |
| `actor` | who or what caused this, in the owner's vocabulary | `user:ada@example.com`, `cron`, `job:tenant-status-review` |
| `source` | how it arrived | `api`, `cron`, `run`, `migration`, `manual` |
| `request_id` | the HTTP request, if any | `req_01J8X...` |
| `run_id` | the job run, if any | `run_01J8X...` |

`request_id` and `run_id` are what join the Audit page to the Runs page. A write made by
node 4 of a run carries that `run_id`, so the owner can click from "this row changed" to
"here is the AI step that changed it, its input, its output and what it cost".

## The trigger function

```sql
create or replace function audit.log_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, audit as $$
declare
  v_actor      text := current_setting('traceable.actor', true);
  v_source     text := current_setting('traceable.source', true);
  v_request_id text := nullif(current_setting('traceable.request_id', true), '');
  v_run_id     text := nullif(current_setting('traceable.run_id', true), '');
  v_pk         text;
  v_before     jsonb := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
  v_after      jsonb := case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end;
  v_changed    text[];
begin
  if v_actor is null or v_actor = '' or v_source is null or v_source = '' then
    raise exception
      'traceable: refusing to write %.% without audit context. Wrap this write in withContext().',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      using errcode = 'check_violation';
  end if;
  ...
end;
$$;
```

**The `raise exception` is the point of the whole design.** Without it, "every write is
audited" is a convention that decays the first time someone writes a quick script. With
it, an un-attributed write is impossible, and the failure is loud and immediate rather
than a gap discovered months later.

`security definer` lets the function insert into `audit.audit_log` even though service
roles have no direct grant on it — services can *cause* audit rows but cannot write or
alter them directly. Grant service roles `INSERT` on nothing in `audit`; the function
does it on their behalf. `set search_path` is mandatory on a `security definer` function.

## Attaching and detaching triggers

One trigger per audited table, named predictably so the drift checker can find it:

```sql
create trigger traceable_audit_tenants
  after insert or update or delete on public.tenants
  for each row execute function audit.log_change();
```

Name pattern: `traceable_audit_<table>`. The checker looks for exactly this and reports
`audit.trigger-missing` / `audit.trigger-unexpected`.

In practice you never write that `create trigger` by hand. `templates/sql/010_audit.sql`
defines `audit.attach(schema, table)` and `audit.detach(schema, table)`, so a migration
that adds a table ends with one line:

```sql
select audit.attach('public', 'tenants');
```

`attach` drops any existing trigger of that name first, so it is safe to re-run.

### Doing a legitimate manual edit

You cannot bypass the trigger, and should not want to. Set context first:

```sql
begin;
select audit.set_context('ada@example.com', 'manual', null, null);
update tenants set status = 'active' where id = 't_123';
commit;
```

That edit appears in the Audit page with `source: manual` and Ada's name. Requiring it
is a feature: the owner sees hand edits as clearly as API writes.

Migrations use `source: migration` and an actor naming the migration file.

## Application helper: withContext

Every database write in application code goes through one helper. Nothing else may open
a transaction.

```ts
export async function withContext<T>(
  db: PrismaClient,
  ctx: { actor: string; source: AuditSource; requestId?: string; runId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`select set_config('traceable.actor',      ${ctx.actor},          true)`;
    await tx.$executeRaw`select set_config('traceable.source',     ${ctx.source},         true)`;
    await tx.$executeRaw`select set_config('traceable.request_id', ${ctx.requestId ?? ''}, true)`;
    await tx.$executeRaw`select set_config('traceable.run_id',     ${ctx.runId ?? ''},     true)`;
    return fn(tx);
  });
}
```

This is the **only** sanctioned use of `$executeRaw` in the project, and it lives in
`src/traceable/`, which is on the `rawQueryAllowlist`. It touches no business table, so
it does not blind the static scan.

`ctx.actor` and `ctx.requestId` come from the request context, which the HTTP middleware
populates. Never pass a literal string like `'system'` from a handler — if you cannot
name the actor, you have found a design problem, not a formatting problem.

## Redaction

Columns declared `sensitivity: personal` or `secret` in the table manifest are **masked
in the UI**, not in the database. `row_before` and `row_after` hold the real values, so
the trail stays forensically useful; the Audit page replaces them with `••••••` unless
the viewer explicitly reveals, and the reveal is itself logged.

Do not mask at write time. A redacted audit trail cannot answer "what was it before?",
which is the question the trail exists for.

## Cost and limits

- Roughly 10–30% write throughput overhead on audited tables; negligible below ~1k
  writes/second, not advisable above ~3k.
- Two jsonb copies of every changed row. Size the retention policy: a table churning
  10k rows/day at 2KB/row is ~7GB/year of audit data.
- Partition `audit.audit_log` by month if you expect it to pass ~50M rows.
  `templates/sql/012_audit_retention.sql` is a partitioned variant of the table plus
  `audit.ensure_upcoming_partitions()` and `audit.drop_partitions_before()`. Use it
  **instead of** the plain table in `010_audit.sql`, and decide early: converting a flat
  table later means copying every row.
  A write with no partition to land in fails, and because the audit write is synchronous
  that fails the business write too — so run `ensure_upcoming_partitions()` on a schedule,
  ahead of time, not on demand.
- `audit.audit_log` itself is **not** audited (`audited: false` in its manifest), for the
  obvious reason.

Tell the owner these numbers when you set auditing up. A guarantee whose cost is hidden
gets switched off in a panic six months later.

## Reading the trail

The Audit page ([ui-pages-spec.md](ui-pages-spec.md)) filters by table, actor, source,
date range, `request_id` and `run_id`. The three queries that matter:

```sql
-- everything that happened to one row, newest first
select * from audit.audit_log where record_id = $1 order by happened_at desc;

-- everything one request changed, across all tables
select * from audit.audit_log where request_id = $1 order by happened_at;

-- everything one AI run changed
select * from audit.audit_log where run_id = $1 order by happened_at;
```

The second and third are what make the system explainable: one click from a run to
every row it touched, and back.
