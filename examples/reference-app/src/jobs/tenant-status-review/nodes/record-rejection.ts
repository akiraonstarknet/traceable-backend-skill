// Node: the organisation is left alone, and a history entry explains why.
//
// A refusal is written as deliberately as a change. If nothing were recorded,
// the owner would see an absence and have no way to tell it from a request that
// was never made.

import type { TraceableNode } from '../../../traceable/types.js';
import { withContext } from '../../../traceable/with-context.js';
import { newHistoryId } from '../../../traceable/ids.js';
import type { ClassifiedReason } from './classify-reason.js';

export type RejectionRecorded = {
  tenantId: string;
  applied: false;
  explanation: string;
  historyId: string;
};

export const recordRejection: TraceableNode<ClassifiedReason, RejectionRecorded> = {
  type: 'node',
  name: 'record-rejection',
  displayName: 'Record that the change was refused',
  description:
    'Leaves the organisation as it was and adds a history entry explaining why nothing changed.',
  kind: 'code',
  terminal: true,

  async run(input, ctx) {
    const historyId = newHistoryId();
    await withContext(
      ctx.db,
      { actor: `job:tenant-status-review`, source: 'run', requestId: ctx.requestId, runId: ctx.runId },
      async (tx) => {
        await tx.tenantStatusHistory.create({
          data: {
            id: historyId,
            tenantId: input.tenantId,
            fromStatus: input.currentStatus,
            // Unchanged on purpose: the row records that the status stayed put.
            toStatus: input.currentStatus,
            reason: `Refused: ${input.reason}`,
            decidedBy: 'job:tenant-status-review',
            runId: ctx.runId,
          },
        });
      },
    );

    return {
      output: { tenantId: input.tenantId, applied: false, explanation: input.explanation, historyId },
    };
  },
};
