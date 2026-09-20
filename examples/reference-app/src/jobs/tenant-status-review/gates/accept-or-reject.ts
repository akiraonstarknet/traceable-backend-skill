// Gate: turns the model's verdict into a route. Reads the previous output and
// returns a label; it does not act on the verdict itself.

import type { TraceableGate } from '../../../traceable/types.js';
import type { ClassifiedReason } from '../nodes/classify-reason.js';

export const acceptOrReject: TraceableGate<ClassifiedReason, 'accept' | 'reject'> = {
  type: 'gate',
  name: 'accept-or-reject',
  displayName: 'Was the reason acceptable?',
  description:
    'Applies the change when the model accepted the reason, and records a refusal when it did not.',
  routes: {
    accept: 'apply-status',
    reject: 'record-rejection',
  },

  decide(input) {
    return input.verdict === 'accept'
      ? { route: 'accept', reason: `The reason was accepted: ${input.explanation}` }
      : { route: 'reject', reason: `The reason was not accepted: ${input.explanation}` };
  },
};
