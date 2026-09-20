-- traceable-backend: run history for jobs (nodes and gates)
-- Apply as the database OWNER role, inside a normal Prisma migration.
--
-- Every run is stored, success or failure, flattened node -> gate -> node.
-- display_name and description are COPIED onto the step row at write time, not
-- joined from the manifest: a run from March must still read correctly after the
-- step was renamed in June. Run history is a historical record, not a view over
-- current config.

create schema if not exists traceable;

create table if not exists traceable.runs (
  run_id         text primary key,
  job_name       text        not null,
  status         text        not null check (status in ('running','succeeded','failed')),
  trigger_source text        not null check (trigger_source in ('cron','api','manual')),
  triggered_by   text,
  request_id     text,
  input_json     jsonb,
  output_json    jsonb,
  error_message  text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  duration_ms    integer,
  total_cost_usd numeric(12,6) not null default 0,
  heartbeat_at   timestamptz not null default now()
);

create index if not exists runs_job_idx     on traceable.runs (job_name, started_at desc);
create index if not exists runs_status_idx  on traceable.runs (status, started_at desc);
create index if not exists runs_time_idx    on traceable.runs (started_at desc);
create index if not exists runs_request_idx on traceable.runs (request_id) where request_id is not null;

comment on table traceable.runs is
  'One row per execution of a job, including executions that failed or never finished.';


create table if not exists traceable.run_steps (
  id                         bigserial primary key,
  run_id                     text        not null references traceable.runs(run_id) on delete cascade,
  step_index                 integer     not null,
  step_type                  text        not null check (step_type in ('node','gate')),
  step_name                  text        not null,
  display_name               text        not null,
  description                text        not null,
  status                     text        not null check (status in ('running','succeeded','failed')),
  input_json                 jsonb,
  output_json                jsonb,
  gate_decision              text,
  gate_reason                text,
  next_step_name             text,
  error_message              text,
  started_at                 timestamptz not null default now(),
  finished_at                timestamptz,
  duration_ms                integer,
  node_kind                  text check (node_kind in ('code','llm')),
  llm_model                  text,
  llm_tokens_in              integer,
  llm_tokens_out             integer,
  llm_cost_usd               numeric(12,6),
  llm_provider_generation_id text,
  unique (run_id, step_index),

  -- A gate decides and nothing else; a node acts and never routes.
  constraint run_steps_gate_shape check (
    (step_type = 'gate' and node_kind is null and llm_model is null)
    or
    (step_type = 'node' and gate_decision is null and gate_reason is null)
  ),
  -- A finished LLM step without a model is an unanswerable cost question later.
  -- Scoped to succeeded rows: the step row is written BEFORE the call, and a
  -- step that died before reaching the provider still has to be recordable.
  constraint run_steps_llm_shape check (
    node_kind is distinct from 'llm' or status <> 'succeeded' or llm_model is not null
  )
);

create index if not exists run_steps_run_idx on traceable.run_steps (run_id, step_index);
create index if not exists run_steps_llm_idx on traceable.run_steps (llm_model, started_at desc)
  where llm_model is not null;
create index if not exists run_steps_gen_idx on traceable.run_steps (llm_provider_generation_id)
  where llm_provider_generation_id is not null;

comment on table traceable.run_steps is
  'The flattened node/gate sequence actually taken by a run, with inputs, outputs, durations, gate decisions and LLM cost.';


-- ---------------------------------------------------------------------------
-- Model prices live in a table, not in code, so the owner can see which price
-- was used and a price change does not need a deploy. llm_cost_usd computed
-- from this is an ESTIMATE; backfill the provider's billed cost where available.
-- ---------------------------------------------------------------------------
create table if not exists traceable.llm_model_prices (
  model             text primary key,
  input_usd_per_1m  numeric(12,6) not null,
  output_usd_per_1m numeric(12,6) not null,
  updated_at        timestamptz   not null default now()
);

comment on table traceable.llm_model_prices is
  'Price per million tokens used to estimate the cost of each LLM step. Update when your provider changes prices.';


-- ---------------------------------------------------------------------------
-- Reaper: a process killed mid-run leaves a step 'running' forever. Without
-- this, the Runs page shows a run that looks alive and the owner never learns
-- the job died. Call from a scheduled job.
-- ---------------------------------------------------------------------------
create or replace function traceable.reap_stalled_runs(p_older_than interval default interval '15 minutes')
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  with stalled as (
    update traceable.runs
       set status = 'failed',
           error_message = coalesce(error_message, 'run did not finish'),
           finished_at = now(),
           duration_ms = (extract(epoch from (now() - started_at)) * 1000)::integer
     where status = 'running'
       and heartbeat_at < now() - p_older_than
    returning run_id
  )
  update traceable.run_steps s
     set status = 'failed',
         error_message = coalesce(s.error_message, 'run did not finish'),
         finished_at = now()
    from stalled
   where s.run_id = stalled.run_id and s.status = 'running';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


-- These three tables are append-only infrastructure and are deliberately NOT
-- audited (they would audit themselves into a loop). They are listed in
-- traceable.config.json -> unauditedTables so the drift checker knows.
revoke all on traceable.runs, traceable.run_steps, traceable.llm_model_prices from public;
grant usage on schema traceable to public;
