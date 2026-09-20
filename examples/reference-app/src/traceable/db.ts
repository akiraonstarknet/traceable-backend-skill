// One Prisma client per actor, each with its own database role.
//
// Prisma 7 requires a driver adapter, which means the connection string is
// supplied in application code — so per-role clients are the natural shape here
// rather than a workaround.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

const clients = new Map<string, PrismaClient>();

/**
 * @param envVar e.g. DATABASE_URL_SVC_TENANT_ADMIN. The name is derived from the
 * actor by the drift checker too, so a typo here shows up as role.missing or
 * grant.owner-at-runtime rather than as a silently over-privileged connection.
 */
export function clientForActor(envVar: string): PrismaClient {
  const existing = clients.get(envVar);
  if (existing) return existing;

  const connectionString = process.env[envVar];
  if (!connectionString) {
    throw new Error(
      `${envVar} is not set. Each service and job connects with its own database role; ` +
      `see scripts/setup-db.sh.`
    );
  }
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  clients.set(envVar, client);
  return client;
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => c.$disconnect()));
  clients.clear();
}
