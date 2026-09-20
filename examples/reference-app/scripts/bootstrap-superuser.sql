-- One-time, run as a Postgres superuser. Everything after this runs as app_owner.
--
-- CREATEDB is for Prisma's shadow database during `migrate dev` (without it you
-- get P3014). CREATEROLE is because the generated grants migration creates one
-- database role per service and job - that is what makes "must_not_touch" a
-- revoked privilege rather than a comment.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_owner') then
    create role app_owner login password 'demo_owner_pw';
  end if;
end $$;

alter role app_owner createdb createrole;

-- create database cannot run inside a transaction block, so it is left to the
-- caller: psql -c "create database traceable_demo owner app_owner"
