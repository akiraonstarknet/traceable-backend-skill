-- traceable-backend: audit trail
-- Apply as the database OWNER role, inside a normal Prisma migration.
--
-- Design: trigger-based (not CDC) so the audit write is synchronous with the business
-- write. If the audit row cannot be written, the business write fails. The trail is
-- complete by construction rather than by a worker keeping up.
--
-- Context (actor / source / request_id / run_id) travels on transaction-local settings
-- set by the application via withContext(). The trigger REFUSES writes that arrive
-- without context, so attribution cannot be forgotten.

create schema if not exists audit;

create table if not exists audit.audit_log (
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

create index if not exists audit_log_record_idx  on audit.audit_log (record_id, happened_at desc);
create index if not exists audit_log_table_idx   on audit.audit_log (table_schema, table_name, happened_at desc);
create index if not exists audit_log_actor_idx   on audit.audit_log (actor, happened_at desc);
create index if not exists audit_log_time_idx    on audit.audit_log (happened_at desc, id desc);
create index if not exists audit_log_request_idx on audit.audit_log (request_id) where request_id is not null;
create index if not exists audit_log_run_idx     on audit.audit_log (run_id)     where run_id is not null;

comment on table audit.audit_log is
  'Every insert, update and delete on an audited table, with the actor and request or run that caused it.';


-- ---------------------------------------------------------------------------
-- Context helper. Callable by service and job roles.
-- The third argument to set_config MUST be true: it scopes the setting to the
-- current transaction, so a pooled connection cannot leak one request''s actor
-- onto the next.
-- ---------------------------------------------------------------------------
create or replace function audit.set_context(
  p_actor      text,
  p_source     text,
  p_request_id text default null,
  p_run_id     text default null
) returns void
language plpgsql
as $$
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'traceable: actor is required' using errcode = 'check_violation';
  end if;
  if p_source not in ('api','cron','run','migration','manual') then
    raise exception 'traceable: source must be one of api, cron, run, migration, manual (got %)', p_source
      using errcode = 'check_violation';
  end if;
  perform set_config('traceable.actor',      p_actor,                   true);
  perform set_config('traceable.source',     p_source,                  true);
  perform set_config('traceable.request_id', coalesce(p_request_id,''), true);
  perform set_config('traceable.run_id',     coalesce(p_run_id,''),     true);
end;
$$;


-- ---------------------------------------------------------------------------
-- Stable record id from the primary key values.
-- Deterministic and dependency-free. NOTE: this is an identifier, not an
-- RFC-4122 versioned uuid. Nothing should parse a version out of it.
-- ---------------------------------------------------------------------------
create or replace function audit.record_id(
  p_schema text,
  p_table  text,
  p_row    jsonb,
  p_pk     text[]
) returns uuid
language sql
immutable
as $$
  select md5(
    p_schema || '.' || p_table || '#' ||
    coalesce(
      (select string_agg(coalesce(p_row ->> col, '\0'), '|' order by ord)
         from unnest(p_pk) with ordinality as t(col, ord)),
      ''
    )
  )::uuid;
$$;


-- ---------------------------------------------------------------------------
-- The trigger function.
-- security definer so service roles can cause audit rows without holding any
-- grant on audit.audit_log: they can never write or alter the trail directly.
-- search_path is pinned, which is mandatory for security definer functions.
-- ---------------------------------------------------------------------------
create or replace function audit.log_change() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, audit, public
as $$
declare
  v_actor      text := current_setting('traceable.actor', true);
  v_source     text := current_setting('traceable.source', true);
  v_request_id text := nullif(current_setting('traceable.request_id', true), '');
  v_run_id     text := nullif(current_setting('traceable.run_id', true), '');
  v_pk         text[];
  v_before     jsonb;
  v_after      jsonb;
  v_key_row    jsonb;
  v_changed    text[];
begin
  -- This refusal is the point of the design. Without it, "every write is audited"
  -- is a convention that decays the first time someone writes a quick script.
  if v_actor is null or btrim(v_actor) = '' or v_source is null or btrim(v_source) = '' then
    raise exception
      'traceable: refusing to write %.% without audit context. Wrap this write in withContext().',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      using errcode = 'check_violation',
            hint = 'Call audit.set_context(actor, source, request_id, run_id) first.';
  end if;

  v_before := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
  v_after  := case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end;
  v_key_row := coalesce(v_after, v_before);

  select coalesce(array_agg(a.attname::text order by k.ord), array[]::text[])
    into v_pk
    from pg_index i
    cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
   where i.indrelid = TG_RELID and i.indisprimary;

  if array_length(v_pk, 1) is null then
    raise exception 'traceable: cannot audit %.% because it has no primary key',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      using errcode = 'check_violation';
  end if;

  if TG_OP = 'UPDATE' then
    select coalesce(array_agg(key order by key), array[]::text[])
      into v_changed
      from jsonb_each(v_after)
     where v_before -> key is distinct from v_after -> key;

    -- Nothing actually changed: do not manufacture an audit row.
    if array_length(v_changed, 1) is null then
      return NEW;
    end if;
  end if;

  insert into audit.audit_log (
    table_schema, table_name, operation, record_id,
    row_before, row_after, changed_columns,
    actor, source, request_id, run_id
  ) values (
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP,
    audit.record_id(TG_TABLE_SCHEMA, TG_TABLE_NAME, v_key_row, v_pk),
    v_before, v_after, v_changed,
    v_actor, v_source, v_request_id, v_run_id
  );

  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;


-- ---------------------------------------------------------------------------
-- Attach / detach. Trigger name pattern traceable_audit_<table> is what the
-- drift checker looks for; do not rename.
-- ---------------------------------------------------------------------------
create or replace function audit.attach(p_schema text, p_table text) returns void
language plpgsql
as $$
declare
  v_trigger text := 'traceable_audit_' || p_table;
begin
  execute format('drop trigger if exists %I on %I.%I', v_trigger, p_schema, p_table);
  execute format(
    'create trigger %I after insert or update or delete on %I.%I
       for each row execute function audit.log_change()',
    v_trigger, p_schema, p_table
  );
end;
$$;

create or replace function audit.detach(p_schema text, p_table text) returns void
language plpgsql
as $$
begin
  execute format('drop trigger if exists %I on %I.%I',
                 'traceable_audit_' || p_table, p_schema, p_table);
end;
$$;


-- ---------------------------------------------------------------------------
-- Permissions. Service and job roles may set context and read nothing here by
-- default; the DevOps UI role is granted SELECT separately.
-- ---------------------------------------------------------------------------
revoke all on audit.audit_log from public;
revoke all on function audit.log_change() from public;
grant usage on schema audit to public;
grant execute on function audit.set_context(text, text, text, text) to public;
