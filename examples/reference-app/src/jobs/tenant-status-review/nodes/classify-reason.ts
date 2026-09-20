// Node: asks the model whether the reason given is a real business reason.
//
// The model id here must match spec.pipeline[].model in the job manifest; the
// drift checker reports pipeline.model-mismatch otherwise, because the owner is
// shown the manifest value.

import type { TraceableNode } from '../../../traceable/types.js';
import type { LoadedTenant } from './load-tenant.js';

export const CLASSIFY_MODEL = 'anthropic/claude-sonnet-5';

export type ClassifiedReason = LoadedTenant & {
  verdict: 'accept' | 'reject';
  explanation: string;
};

export const classifyReason: TraceableNode<LoadedTenant, ClassifiedReason> = {
  type: 'node',
  name: 'classify-reason',
  displayName: 'Check the reason makes sense',
  description:
    'Asks the model whether the reason given is a real, specific business reason rather than a blank or a placeholder.',
  kind: 'llm',
  model: CLASSIFY_MODEL,

  async run(input, ctx) {
    const response = await ctx.llm.complete({
      model: CLASSIFY_MODEL,
      system:
        'You review reasons given for suspending a customer organisation. Reply with JSON ' +
        '{"verdict":"accept"|"reject","explanation":"one sentence"}. Accept only a specific ' +
        'business reason; reject blanks, placeholders and vague text.',
      user: `Organisation: ${input.tenantName}\nReason: ${input.reason}`,
      maxTokens: 200,
    });

    let verdict: 'accept' | 'reject' = 'reject';
    let explanation = 'The model did not return a usable verdict, so the change is refused.';
    try {
      const parsed = JSON.parse(response.text) as { verdict?: string; explanation?: string };
      if (parsed.verdict === 'accept' || parsed.verdict === 'reject') verdict = parsed.verdict;
      if (typeof parsed.explanation === 'string' && parsed.explanation) explanation = parsed.explanation;
    } catch {
      // Falling through to the refusal above is deliberate: an unparseable
      // answer must not be read as approval.
    }

    return {
      output: { ...input, verdict, explanation },
      usage: response.usage,
    };
  },
};
