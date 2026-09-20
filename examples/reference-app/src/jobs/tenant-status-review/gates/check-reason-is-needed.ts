// Gate: decides whether the reason needs checking by a model.
//
// Note what this file does not import: no database client, no HTTP client, no
// LLM client. GateContext offers only a logger, so there is nothing to call. The
// drift checker also reports code.gate-side-effect if that ever changes.

import type { TraceableGate } from '../../../traceable/types.js';
import type { LoadedTenant } from '../nodes/load-tenant.js';

export const checkReasonIsNeeded: TraceableGate<LoadedTenant, 'needs_check' | 'skip_check'> = {
  type: 'gate',
  name: 'check-reason-is-needed',
  displayName: 'Does this reason need checking?',
  description:
    'Suspensions get their reason checked by a model. Reactivations do not, because turning access back on is not the risky direction.',
  routes: {
    needs_check: 'classify-reason',
    skip_check: 'apply-status',
  },

  decide(input) {
    if (input.requestedStatus === 'suspended') {
      return {
        route: 'needs_check',
        reason: 'This is a suspension, so the reason text needs checking before access is removed.',
      };
    }
    return {
      route: 'skip_check',
      reason: 'This reactivates the organisation, which does not remove anyone’s access, so no check is needed.',
    };
  },
};
