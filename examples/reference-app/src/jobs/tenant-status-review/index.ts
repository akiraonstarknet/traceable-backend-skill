// The job definition. The step order here is what runtime-facts.ts reports, and
// the drift checker compares it against spec.pipeline in the manifest - names,
// types, kinds, the LLM model and the gate route labels all have to agree.

import type { JobDefinition } from '../../traceable/types.js';
import { loadTenant } from './nodes/load-tenant.js';
import { checkReasonIsNeeded } from './gates/check-reason-is-needed.js';
import { classifyReason } from './nodes/classify-reason.js';
import { acceptOrReject } from './gates/accept-or-reject.js';
import { applyStatus } from './nodes/apply-status.js';
import { recordRejection } from './nodes/record-rejection.js';

export const tenantStatusReview: JobDefinition = {
  name: 'tenant-status-review',
  triggerType: 'api',
  schedule: null,
  steps: [
    loadTenant,
    checkReasonIsNeeded,
    classifyReason,
    acceptOrReject,
    applyStatus,
    recordRejection,
  ],
};

export type { StatusChangeRequest } from './nodes/load-tenant.js';
