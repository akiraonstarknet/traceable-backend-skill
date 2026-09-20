// LLM client.
//
// Two implementations behind one interface:
//   - OpenRouter, used when OPENROUTER_API_KEY is set. Captures the provider's
//     generation id, which is what lets a surprising invoice line be traced back
//     to a specific run step.
//   - A deterministic stub, used otherwise, so the reference app runs offline
//     and its demo output is reproducible. The stub reports token counts and a
//     fake generation id of the form stub-... so nothing pretends to be real.
//
// Cost is computed from traceable.llm_model_prices at write time; that is an
// ESTIMATE. backfillCost() replaces it with the provider's billed figure.

import type { LlmUsage } from './types.js';

export type LlmRequest = {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
};

export type LlmResponse = {
  text: string;
  usage: LlmUsage;
};

export type LlmClient = {
  complete(req: LlmRequest): Promise<LlmResponse>;
};

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function createLlmClient(): LlmClient {
  const key = process.env.OPENROUTER_API_KEY;
  return key ? openRouterClient(key) : stubClient();
}

function openRouterClient(apiKey: string): LlmClient {
  return {
    async complete(req) {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 256,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenRouter returned ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        id?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: body.choices?.[0]?.message?.content ?? '',
        usage: {
          model: req.model,
          tokensIn: body.usage?.prompt_tokens ?? 0,
          tokensOut: body.usage?.completion_tokens ?? 0,
          costUsd: null, // filled from the price table, then backfilled
          providerGenerationId: body.id ?? null,
        },
      };
    },
  };
}

/**
 * Deterministic stand-in. It judges a reason acceptable when it is specific
 * enough to be a real business reason: long enough, and not a placeholder.
 * Obvious and reproducible on purpose — a stub that behaved cleverly would make
 * the demo run look more convincing than it is.
 */
function stubClient(): LlmClient {
  const placeholders = ['test', 'asdf', 'n/a', 'na', 'none', 'tbd', 'x', '-', 'because'];
  return {
    async complete(req) {
      const reason = extractReason(req.user);
      const normalised = reason.trim().toLowerCase();
      const acceptable =
        normalised.length >= 15 &&
        !placeholders.includes(normalised) &&
        /[a-z]{3,}\s+[a-z]{3,}/.test(normalised);

      const verdict = acceptable ? 'accept' : 'reject';
      const explanation = acceptable
        ? 'The reason names a specific business circumstance.'
        : 'The reason is too short or looks like a placeholder rather than a real explanation.';

      return {
        text: JSON.stringify({ verdict, explanation }),
        usage: {
          model: req.model,
          tokensIn: estimateTokens(`${req.system}\n${req.user}`),
          tokensOut: estimateTokens(explanation) + 8,
          costUsd: null,
          providerGenerationId: `stub-${hash(`${req.model}:${normalised}`)}`,
        },
      };
    },
  };
}

function extractReason(user: string): string {
  const m = /Reason:\s*([\s\S]*)$/i.exec(user);
  return m?.[1] ?? user;
}

// Rough, and labelled as rough. Real token counts come from the provider.
const estimateTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Authoritative cost for an OpenRouter generation. Stats can lag the completion,
 * so callers should retry once after a short delay before giving up.
 */
export async function fetchOpenRouterCost(generationId: string): Promise<number | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || generationId.startsWith('stub-')) return null;
  const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { total_cost?: number }; total_cost?: number };
  return body.data?.total_cost ?? body.total_cost ?? null;
}
