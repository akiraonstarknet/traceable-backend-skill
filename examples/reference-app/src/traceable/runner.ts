// The run recorder.
//
// Rules this implements, from references/node-gate-spec.md:
//   - a run_steps row is written AS THE STEP STARTS, so a run that dies mid-step
//     still shows which step it died in;
//   - display_name and description are copied onto the row at write time, so an
//     old run still reads correctly after a step is renamed;
//   - every run is stored, success or failure;
//   - a gate result that is not { route, reason } with a known route fails the
//     run loudly instead of routing somewhere arbitrary.
//
// Raw SQL against the traceable schema: those tables are infrastructure with no
// Prisma model, and src/traceable/ is on rawQueryAllowlist.

import type { PrismaClient } from '../generated/prisma/client.js';
import { newRunId } from './ids.js';
import { deepFreeze } from './types.js';
import type {
  GateContext, JobDefinition, Logger, LlmUsage, NodeContext, PipelineStep,
} from './types.js';
import type { LlmClient } from './llm.js';

export type StartRunOptions = {
  job: JobDefinition;
  input: unknown;
  triggerSource: 'cron' | 'api' | 'manual';
  triggeredBy: string;
  requestId?: string | null;
  db: PrismaClient;
  llm: LlmClient;
  logger?: Logger;
};

export type RunOutcome = {
  runId: string;
  status: 'succeeded' | 'failed';
  output: unknown;
  error: string | null;
  durationMs: number;
  totalCostUsd: number;
};

const defaultLogger: Logger = {
  info: (m, f) => console.log(JSON.stringify({ level: 'info', message: m, ...f })),
  error: (m, f) => console.error(JSON.stringify({ level: 'error', message: m, ...f })),
};

export async function runJob(opts: StartRunOptions): Promise<RunOutcome> {
  const { job, db, llm } = opts;
  const logger = opts.logger ?? defaultLogger;
  const runId = newRunId();
  const runStarted = Date.now();

  const byName = new Map(job.steps.map((s) => [s.name, s]));
  const order = job.steps.map((s) => s.name);

  await db.$executeRaw`
    insert into traceable.runs (run_id, job_name, status, trigger_source, triggered_by, request_id, input_json)
    values (${runId}, ${job.name}, 'running', ${opts.triggerSource}, ${opts.triggeredBy},
            ${opts.requestId ?? null}, ${JSON.stringify(opts.input ?? null)}::jsonb)`;

  let cursor: string | undefined = order[0];
  let carried: unknown = opts.input;
  let stepIndex = 0;
  let totalCost = 0;
  let failure: string | null = null;

  while (cursor && cursor !== 'END') {
    const step: PipelineStep | undefined = byName.get(cursor);
    if (!step) {
      failure = `pipeline points at step ${cursor}, which does not exist`;
      break;
    }
    stepIndex += 1;
    const stepStarted = Date.now();

    // Written before the step runs. This is the difference between "the job
    // failed" and "the job failed while checking the reason text".
    await db.$executeRaw`
      insert into traceable.run_steps
        (run_id, step_index, step_type, step_name, display_name, description, status,
         input_json, node_kind, llm_model)
      values (${runId}, ${stepIndex}, ${step.type}, ${step.name}, ${step.displayName},
              ${step.description}, 'running', ${JSON.stringify(carried ?? null)}::jsonb,
              ${step.type === 'node' ? step.kind : null},
              ${step.type === 'node' ? (step.model ?? null) : null})`;
    await db.$executeRaw`update traceable.runs set heartbeat_at = now() where run_id = ${runId}`;

    try {
      if (step.type === 'node') {
        const ctx: NodeContext = {
          runId,
          requestId: opts.requestId ?? null,
          actor: opts.triggeredBy,
          db,
          llm,
          logger,
        };
        const result = await step.run(carried, ctx);
        const usage = result.usage ?? null;
        const costUsd = usage ? await priceOf(db, usage) : null;
        if (costUsd !== null) totalCost += costUsd;

        await db.$executeRaw`
          update traceable.run_steps
             set status = 'succeeded',
                 output_json = ${JSON.stringify(result.output ?? null)}::jsonb,
                 finished_at = now(),
                 duration_ms = ${Date.now() - stepStarted},
                 llm_model = coalesce(${usage?.model ?? null}, llm_model),
                 llm_tokens_in = ${usage?.tokensIn ?? null},
                 llm_tokens_out = ${usage?.tokensOut ?? null},
                 llm_cost_usd = ${costUsd},
                 llm_provider_generation_id = ${usage?.providerGenerationId ?? null},
                 next_step_name = ${step.terminal ? 'END' : (order[order.indexOf(step.name) + 1] ?? 'END')}
           where run_id = ${runId} and step_index = ${stepIndex}`;

        carried = result.output;
        cursor = step.terminal ? 'END' : order[order.indexOf(step.name) + 1];
      } else {
        const gateCtx: GateContext = { runId, logger };
        const decision = await step.decide(deepFreeze(structuredClone(carried)), gateCtx);

        if (
          !decision || typeof decision !== 'object' ||
          typeof decision.route !== 'string' || typeof decision.reason !== 'string' ||
          !(decision.route in step.routes)
        ) {
          throw new Error(
            `gate.invalid-result: ${step.name} returned ${JSON.stringify(decision)}; ` +
            `expected { route, reason } with route in ${Object.keys(step.routes).join(' | ')}`
          );
        }

        const next = step.routes[decision.route] as string;
        await db.$executeRaw`
          update traceable.run_steps
             set status = 'succeeded',
                 output_json = ${JSON.stringify({ route: decision.route, reason: decision.reason })}::jsonb,
                 gate_decision = ${decision.route},
                 gate_reason = ${decision.reason},
                 next_step_name = ${next},
                 finished_at = now(),
                 duration_ms = ${Date.now() - stepStarted}
           where run_id = ${runId} and step_index = ${stepIndex}`;

        // A gate changes nothing, so what it was given is what the next node gets.
        cursor = next;
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      await db.$executeRaw`
        update traceable.run_steps
           set status = 'failed', error_message = ${failure},
               finished_at = now(), duration_ms = ${Date.now() - stepStarted}
         where run_id = ${runId} and step_index = ${stepIndex}`;
      break;
    }
  }

  const status = failure ? 'failed' : 'succeeded';
  const durationMs = Date.now() - runStarted;
  await db.$executeRaw`
    update traceable.runs
       set status = ${status}, output_json = ${JSON.stringify(failure ? null : carried)}::jsonb,
           error_message = ${failure}, finished_at = now(), duration_ms = ${durationMs},
           total_cost_usd = ${totalCost}, heartbeat_at = now()
     where run_id = ${runId}`;

  logger.info(`run ${status}`, { runId, job: job.name, durationMs, totalCostUsd: totalCost });
  return { runId, status, output: failure ? null : carried, error: failure, durationMs, totalCostUsd: totalCost };
}

/** Estimate from the price table. The provider's billed figure replaces this later. */
async function priceOf(db: PrismaClient, usage: LlmUsage): Promise<number | null> {
  if (usage.costUsd !== null) return usage.costUsd;
  const rows = await db.$queryRaw<Array<{ input_usd_per_1m: string; output_usd_per_1m: string }>>`
    select input_usd_per_1m, output_usd_per_1m
      from traceable.llm_model_prices where model = ${usage.model}`;
  const price = rows[0];
  if (!price) return null;
  const cost =
    (usage.tokensIn / 1_000_000) * Number(price.input_usd_per_1m) +
    (usage.tokensOut / 1_000_000) * Number(price.output_usd_per_1m);
  return Number(cost.toFixed(6));
}
