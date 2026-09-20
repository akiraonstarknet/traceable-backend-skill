#!/usr/bin/env bash
# Applies migrations, generates the grants from the manifests, and gives each
# derived role a login password.
#
# Run scripts/bootstrap-superuser.sql once as a superuser first, and create the
# database. Everything here runs as the owner role in DATABASE_URL.
#
# Passwords are set HERE, not in the generated migration: the generator creates
# NOLOGIN roles so no credential is ever committed.
set -euo pipefail

# Load .env the same way the npm scripts do.
if [ -f .env ]; then set -a; . ./.env; set +a; fi

: "${DATABASE_URL:?set DATABASE_URL to the owner connection string (see .env.example)}"
ROLE_PW="${ROLE_PW:-demo_pw}"

if ! psql "$DATABASE_URL" -tAc 'select 1' >/dev/null 2>&1; then
  cat >&2 <<MSG
Cannot connect as the owner role.

Run this once as a Postgres superuser:
  psql -f scripts/bootstrap-superuser.sql
  psql -c "create database traceable_demo owner app_owner"

Then re-run: npm run setup
MSG
  exit 1
fi

echo "==> generating the Prisma client"
npx prisma generate

echo "==> generating grants from the manifests"
node ../../scripts/generate-grants.mjs

echo "==> applying migrations as the owner role"
npx prisma migrate deploy

echo "==> giving each derived role a login password"
for role in $(psql "$DATABASE_URL" -tAc \
      "select rolname from pg_roles where rolname like 'svc\_%' or rolname like 'job\_%' order by 1"); do
  psql "$DATABASE_URL" -qv ON_ERROR_STOP=1 -c "alter role \"${role}\" login password '${ROLE_PW}';"
  echo "    ${role}"
done

echo
echo "Done. Next: npm run seed && npm run drift && npm run demo"
