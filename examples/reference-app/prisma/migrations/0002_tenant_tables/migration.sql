-- Business tables for the reference app.
--
-- Note the audit.attach() calls at the bottom: a table is not finished until its
-- audit trigger is attached. The drift checker reports audit.trigger-missing
-- otherwise, and the owner would be shown a table whose changes nobody records.

create table tenants (
  id               text        primary key,
  name             text        not null,
  status           text        not null check (status in ('active','suspended')),
  suspended_reason text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table tenant_status_history (
  id          text        primary key,
  tenant_id   text        not null references tenants(id),
  from_status text        not null,
  to_status   text        not null,
  reason      text        not null,
  decided_by  text        not null,
  run_id      text,
  created_at  timestamptz not null default now()
);

create index tenant_status_history_tenant_idx on tenant_status_history (tenant_id, created_at desc);

create table users (
  id         text        primary key,
  email      text        not null unique,
  full_name  text        not null,
  created_at timestamptz not null default now()
);

select audit.attach('public', 'tenants');
select audit.attach('public', 'tenant_status_history');
select audit.attach('public', 'users');

insert into traceable.llm_model_prices (model, input_usd_per_1m, output_usd_per_1m)
values ('anthropic/claude-sonnet-5', 3.000000, 15.000000)
on conflict (model) do nothing;
