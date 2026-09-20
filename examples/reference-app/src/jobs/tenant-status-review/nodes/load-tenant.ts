// Node: reads the organisation that is about to change, so later steps work
// from what is actually stored rather than what the caller sent.

import type { TraceableNode } from '../../../traceable/types.js';

export type StatusChangeRequest = {
  tenantId: string;
  requestedStatus: 'active' | 'suspended';
  reason: string;
  requestedBy: string;
};

export type LoadedTenant = StatusChangeRequest & {
  currentStatus: 'active' | 'suspended';
  tenantName: string;
};

export const loadTenant: TraceableNode<StatusChangeRequest, LoadedTenant> = {
  type: 'node',
  name: 'load-tenant',
  displayName: 'Load the organisation',
  description:
    'Reads the organisation that is about to change, so later steps work from what is actually stored rather than what the caller sent.',
  kind: 'code',

  async run(input, ctx) {
    const db = ctx.db;
    const tenant = await db.tenant.findUnique({ where: { id: input.tenantId } });
    if (!tenant) throw new Error(`no organisation with id ${input.tenantId}`);
    return {
      output: {
        ...input,
        currentStatus: tenant.status as 'active' | 'suspended',
        tenantName: tenant.name,
      },
    };
  },
};
