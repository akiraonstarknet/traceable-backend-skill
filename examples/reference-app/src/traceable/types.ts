// Node and gate contracts.
//
// The whole point of the gate type is what it does NOT contain: GateContext has
// no database handle, no HTTP client and no LLM client, so a gate has nothing to
// call. Input is DeepReadonly, so it cannot mutate what it was handed. A gate
// returns a route label and a reason, and nothing else.

import type { PrismaClient } from '../generated/prisma/client.js';
import type { LlmClient } from './llm.js';

export type AuditSource = 'api' | 'cron' | 'run' | 'migration' | 'manual';

export type Logger = {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export type DeepReadonly<T> = T extends (infer R)[]
  ? ReadonlyArray<DeepReadonly<R>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type NodeContext = {
  runId: string;
  requestId: string | null;
  actor: string;
  db: PrismaClient;
  llm: LlmClient;
  logger: Logger;
};

/** Everything a gate gets. Deliberately tiny. */
export type GateContext = {
  runId: string;
  logger: Logger;
};

export type LlmUsage = {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  providerGenerationId: string | null;
};

export type NodeResult<Out> = {
  output: Out;
  usage?: LlmUsage;
};

export type TraceableNode<In, Out> = {
  type: 'node';
  name: string;
  displayName: string;
  description: string;
  kind: 'code' | 'llm';
  model?: string;
  terminal?: boolean;
  run(input: In, ctx: NodeContext): Promise<NodeResult<Out>>;
};

export type GateResult<R extends string> = {
  route: R;
  /** Plain English, shown verbatim on the run page. Often the most useful line there. */
  reason: string;
};

export type TraceableGate<In, R extends string> = {
  type: 'gate';
  name: string;
  displayName: string;
  description: string;
  routes: Record<R, string>;
  decide(input: DeepReadonly<In>, ctx: GateContext): GateResult<R> | Promise<GateResult<R>>;
};

export type PipelineStep =
  | TraceableNode<any, any>
  | TraceableGate<any, string>;

export type JobDefinition = {
  name: string;
  triggerType: 'cron' | 'api' | 'manual';
  schedule: string | null;
  steps: PipelineStep[];
};

/** Runtime deep-freeze, so a gate cannot mutate its input even in plain JS. */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value as DeepReadonly<T>;
}
