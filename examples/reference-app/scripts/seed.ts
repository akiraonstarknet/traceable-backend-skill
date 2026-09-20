// Seeds three organisations and two people.
//
// Even seeding goes through withContext(): the audit trigger refuses writes with
// no context, and that applies to setup scripts too. The rows appear on the
// Audit page with source "migration", which is exactly right - the owner should
// be able to see where their starting data came from.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (owner role) is required to seed');

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

await db.$transaction(async (tx) => {
  await tx.$executeRaw`select audit.set_context('seed-script', 'migration', null, null)`;

  await tx.tenant.createMany({
    data: [
      { id: 't_northwind', name: 'Northwind Trading', status: 'active' },
      { id: 't_acme', name: 'Acme Supplies', status: 'active' },
      { id: 't_globex', name: 'Globex Manufacturing', status: 'suspended',
        suspendedReason: 'Unpaid invoices older than 90 days.' },
    ],
    skipDuplicates: true,
  });

  await tx.user.createMany({
    data: [
      { id: 'u_ada', email: 'ada@example.com', fullName: 'Ada Okafor' },
      { id: 'u_ben', email: 'ben@example.com', fullName: 'Ben Larsen' },
    ],
    skipDuplicates: true,
  });
});

console.log('seeded 3 organisations and 2 people');
await db.$disconnect();
