// The only sanctioned place in the project that opens a transaction, and the
// only sanctioned use of $executeRaw. It touches no business table, so it does
// not blind the static table scan; src/traceable/ is on rawQueryAllowlist.
//
// The audit trigger raises an exception when this context is missing, so a write
// that skips withContext() fails loudly rather than landing unattributed.

import type { PrismaClient, Prisma } from '../generated/prisma/client.js';
import type { AuditSource } from './types.js';

export type AuditContext = {
  actor: string;
  source: AuditSource;
  requestId?: string | null;
  runId?: string | null;
};

export async function withContext<T>(
  db: PrismaClient,
  ctx: AuditContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!ctx.actor.trim()) {
    // If you cannot name the actor you have found a design problem, not a
    // formatting problem. Never pass a literal 'system'.
    throw new Error('withContext requires a named actor');
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`select audit.set_context(${ctx.actor}, ${ctx.source}, ${ctx.requestId ?? null}, ${ctx.runId ?? null})`;
    return fn(tx);
  });
}
