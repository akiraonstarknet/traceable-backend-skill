-- traceable-backend: partitioned audit log, for when the flat table gets big.
--
-- Use this INSTEAD OF the plain audit.audit_log in 010_audit.sql, from the
-- start. Converting an existing flat table means copying every row, so decide
-- early: a table churning 10k rows/day at 2KB/row is roughly 7GB of audit data
-- per year, and partitioning pays off somewhere past ~50M rows.
--
-- Everything else in 010_audit.sql (set_context, record_id, log_change, attach,
-- detach) works unchanged against a partitioned table.

create schema if not exists audit;

create table if not exists audit.audit_log (
  id              bigserial   not null,
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
  txid            bigint      not null default txid_current(),
  -- The partition key must be part of the primary key, which is why this is
  -- (id, happened_at) rather than id alone.
  primary key (id, happened_at)
) partition by range (happened_at);

-- Indexes on the parent are created on every partition automatically.
create index if not exists audit_log_record_idx  on audit.audit_log (record_id, happened_at desc);
create index if not exists audit_log_table_idx   on audit.audit_log (table_schema, table_name, happened_at desc);
create index if not exists audit_log_actor_idx   on audit.audit_log (actor, happened_at desc);
create index if not exists audit_log_time_idx    on audit.audit_log (happened_at desc, id desc);
create index if not exists audit_log_request_idx on audit.audit_log (request_id) where request_id is not null;
create index if not exists audit_log_run_idx     on audit.audit_log (run_id)     where run_id is not null;

comment on table audit.audit_log is
  'Every insert, update and delete on an audited table, with the actor and request or run that caused it. Partitioned by month.';


-- ---------------------------------------------------------------------------
-- Create the partition covering a given month, if it does not exist.
-- ---------------------------------------------------------------------------
create or replace function audit.ensure_partition(p_month date default date_trunc('month', now())::date)
returns text
language plpgsql
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := 'audit_log_' || to_char(v_start, 'YYYY_MM');
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'audit' and c.relname = v_name
  ) then
    execute format(
      'create table audit.%I partition of audit.audit_log for values from (%L) to (%L)',
      v_name, v_start, v_end);
  end if;
  return v_name;
end;
$$;


-- ---------------------------------------------------------------------------
-- Make sure the current and next months exist. Call this from a scheduled job
-- (monthly, or nightly and let it no-op). A write with no partition to land in
-- FAILS, and because the audit write is synchronous that fails the business
-- write too - so run it ahead of time, not on demand.
-- ---------------------------------------------------------------------------
create or replace function audit.ensure_upcoming_partitions(p_months integer default 2)
returns setof text
language plpgsql
as $$
declare
  i integer;
begin
  for i in 0 .. greatest(p_months - 1, 0) loop
    return next audit.ensure_partition((date_trunc('month', now()) + (i || ' months')::interval)::date);
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- Detach and drop partitions older than the retention window.
--
-- DROPPING AUDIT DATA IS IRREVERSIBLE. Only call this once the retention
-- declared in the table manifests actually says so, and archive the partition
-- somewhere first if the answer to "who changed this row" still matters.
-- Returns the partitions it dropped, so a job can report them to the owner.
-- ---------------------------------------------------------------------------
create or replace function audit.drop_partitions_before(p_cutoff date)
returns setof text
language plpgsql
as $$
declare
  r record;
begin
  for r in
    select c.relname,
           (regexp_replace(c.relname, '^audit_log_', '') || '_01')::text as stamp
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_inherits i on i.inhrelid = c.oid
      join pg_class p on p.oid = i.inhparent
     where n.nspname = 'audit' and p.relname = 'audit_log'
  loop
    if to_date(replace(r.stamp, '_', '-'), 'YYYY-MM-DD') < date_trunc('month', p_cutoff) then
      execute format('drop table audit.%I', r.relname);
      return next r.relname;
    end if;
  end loop;
end;
$$;


-- Create the first partitions so the very first write has somewhere to go.
select audit.ensure_upcoming_partitions(2);

revoke all on audit.audit_log from public;
grant usage on schema audit to public;
