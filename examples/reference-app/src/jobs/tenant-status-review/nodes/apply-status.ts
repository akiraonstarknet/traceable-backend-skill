// Node: writes the new status and records why.
//
// Every write goes through withContext() with source 'run' and this run's id, so
// the rows it changes are joined to this run on the Audit page. Without it the
// audit trigger raises an exception and the run fails - which is the intended
// behaviour, not an inconvenience.

import type { TraceableNode } from '../../../traceable/types.js';
import { withContext } from '../../../traceable/with-context.js';
import { newHistoryId } from '../../../traceable/ids.js';
import type { LoadedTenant } from './load-tenant.js';
import type { ClassifiedReason } from './classify-reason.js';

export type StatusApplied = {
  tenantId: string;
  applied: true;
  fromStatus: string;
  toStatus: string;
  historyId: string;
};

export const applyStatus: TraceableNode<LoadedTenant | ClassifiedReason, StatusApplied> = {
  type: 'node',
  name: 'apply-status',
  displayName: 'Apply the new status',
  description:
    'Writes the new status on the organisation and adds an entry to its status history saying what changed and why.',
  kind: 'code',
  terminal: true,

  async run(input, ctx) {
    const historyId = newHistoryId();
    await withContext(
      ctx.db,
      { actor: `job:tenant-status-review`, source: 'run', requestId: ctx.requestId, runId: ctx.runId },
      async (tx) => {
        await tx.tenant.update({
          where: { id: input.tenantId },
          data: {
            status: input.requestedStatus,
            suspendedReason: input.requestedStatus === 'suspended' ? input.reason : null,
            updatedAt: new Date(),
          },
        });
        await tx.tenantStatusHistory.create({
          data: {
            id: historyId,
            tenantId: input.tenantId,
            fromStatus: input.currentStatus,
            toStatus: input.requestedStatus,
            reason: input.reason,
            decidedBy: input.requestedBy,
            runId: ctx.runId,
          },
        });
      },
    );

    return {
      output: {
        tenantId: input.tenantId,
        applied: true,
        fromStatus: input.currentStatus,
        toStatus: input.requestedStatus,
        historyId,
      },
    };
  },
};
