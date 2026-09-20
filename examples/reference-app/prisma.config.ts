import { defineConfig, env } from 'prisma/config';

// Prisma 7 moves the datasource URL out of schema.prisma. DATABASE_URL here is
// the OWNER role, used for migrations only. Services and jobs connect with their
// own roles through DATABASE_URL_SVC_* / DATABASE_URL_JOB_* (see src/traceable/db.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
