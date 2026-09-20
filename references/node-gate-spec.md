# Node and gate specification

How multi-step and AI jobs are structured so that a non-coder can read what happened.

## Contents

- [The model](#the-model)
- [Nodes](#nodes)
- [Gates](#gates)
- [Why gates must not have side effects](#why-gates-must-not-have-side-effects)
- [Enforcing "no side effects"](#enforcing-no-side-effects)
- [The runner](#the-runner)
- [Run storage](#run-storage)
- [LLM nodes: model, tokens, cost, generation id](#llm-nodes-model-tokens-cost-generation-id)
- [Failure handling](#failure-handling)
- [Why flattened, not a graph](#why-flattened-not-a-graph)

## The model

A job is an ordered pipeline of two kinds of step:

- **Node** — does one small thing. Takes the previous step's output as input, returns
  its output. May be code or a single LLM call.
- **Gate** — decides where to go next. Reads the previous output, returns **only a route
  label**. Changes nothing.

Node output is gate input. Gate route selects the next node. That alternation is what
makes a run readable as a list rather than a graph.

This is LangGraph's conditional-edge contract (a routing function returns a name, not a
jump) with Temporal's discipline that effects live only in named, recorded units — and
with the addition that the no-effects property is enforced by types, not convention.

## Nodes

```ts
export type NodeContext = {
  runId: string;
  requestId: string | null;
  actor: string;
  db: PrismaClient;                 // the job's own role
  llm: LlmClient;
  logger: Logger;
};

export type Node<In, Out> = {
  name: string;                     // kebab-case, matches the manifest
  displayName: string;              // plain English, shown in the UI
  description: string;              // plain English, shown in the UI
  kind: 'code' | 'llm';
  model?: string;                   // required when kind is 'llm'
  terminal?: boolean;
  run(input: In, ctx: NodeContext): Promise<Out>;
};
```

Rules:

- **One node does one thing.** If `displayName` needs "and", split it.
- Nodes are pure functions of `(input, ctx)`. Do not read module-level mutable state.
- All database access goes through `withContext(ctx.db, { ..., runId: ctx.runId })` so
  writes carry the run id into the audit trail.
- A node's output must be JSON-serialisable. It is stored and shown to the owner.
- Keep outputs small and meaningful. Dumping a 2MB payload into `run_steps` makes the
  Runs page unusable, which defeats the point. Summarise, and store the reference.

## Gates

```ts
export type GateContext = {
  runId: string;
  logger: Logger;                   // that is the entire context
};

export type GateResult<R extends string> = {
  route: R;
  reason: string;                   // plain English, shown in the UI
};

export type Gate<In, R extends string> = {
  name: string;
  displayName: string;
  description: string;
  routes: Record<R, string>;        // label → next step name, or 'END'
  decide(input: DeepReadonly<In>, ctx: GateContext): GateResult<R> | Promise<GateResult<R>>;
};
```

Rules:

- `decide` returns `{ route, reason }` and nothing else. The route must be a key of
  `routes`, which TypeScript enforces through `R`.
- `reason` is required and is shown verbatim on the Runs page: *"Suspension, so the
  reason text needs checking."* This is often the single most useful line in a run for
  the owner.
- `input` is `DeepReadonly`, so a gate cannot mutate what it was handed.
- Gates should be cheap and synchronous where possible. A gate that needs data it was
  not given is a sign the preceding node should have fetched it.

## Why gates must not have side effects

Three reasons, in order of how often they bite:

1. **The owner must be able to trust the run log.** If a gate can write, then the
   flattened list is no longer a complete account of what happened — a decision step
   silently became an action step, and the Audit page shows a change with no node to
   explain it.
2. **Decisions must be re-readable.** "Why did it go left?" is answerable from
   `input` + `reason` only if the gate is a pure function of its input.
3. **Branching code is where bugs hide.** Keeping it effect-free means the risky part
   of the pipeline is the part that cannot corrupt data.

## Enforcing "no side effects"

Three layers, because types alone are not enough.

**1. Type-level.** `GateContext` has no `db`, no `llm`, no `fetch`. There is nothing to
call. Input is `DeepReadonly`. This catches the accidental case, which is most of them.

```ts
type DeepReadonly<T> = T extends (infer R)[] ? ReadonlyArray<DeepReadonly<R>>
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
```

**2. Static.** The drift checker reports `code.gate-side-effect` when a file under
`gates/` imports anything from the db, http or llm module list in
`traceable.config.json`, or when a gate file's default export is not a gate. A gate that
reaches for `globalThis.fetch` or imports `node:fs` is caught here.

**3. Runtime.** The runner calls `decide` with a deep-frozen input and rejects the result
if it is not `{ route, reason }` with `route` in `routes`. Anything else fails the run
with `gate.invalid-result` — loudly, rather than routing somewhere arbitrary.

Layer 2 is the one that catches deliberate workarounds, so do not disable it "just for
this job".

## The runner

```
start run  →  insert into traceable.runs (status='running')
loop:
  step = pipeline[cursor]
  insert into traceable.run_steps (status='running', started_at=now())
  if node: out = await node.run(prevOutput, ctx)
  if gate: { route, reason } = await gate.decide(freeze(prevOutput), gateCtx)
  update run_steps (status='succeeded', output, duration_ms, gate_decision, gate_reason, next_step_name)
  cursor = node ? next-in-order-or-END : gate.routes[route]
until cursor === 'END' or step.terminal
finish run  →  update traceable.runs (status='succeeded'|'failed', finished_at, duration_ms, total_cost_usd)
```

Required behaviours:

- `run_steps` rows are written **as the step starts**, not after it finishes. A run that
  dies mid-step must still show which step it died in. This is the difference between
  "the job failed" and "the job failed while checking the reason text".
- `step_index` increments monotonically for the actual path taken. Skipped branches are
  not recorded — the owner sees what happened, not what might have.
- Durations are measured per step and on the run.
- The runner writes run rows through the **job's own role**, with `source: 'run'` and the
  run id in context, so the audit trail joins.
- A step that throws marks itself `failed`, marks the run `failed`, records the error
  message, and stops. It does not retry silently. If the job needs retries, they are an
  explicit node in the pipeline so the owner can see them.

## Run storage

```sql
create table traceable.runs (
  run_id         text primary key,
  job_name       text not null,
  status         text not null check (status in ('running','succeeded','failed')),
  trigger_source text not null check (trigger_source in ('cron','api','manual')),
  triggered_by   text,
  request_id     text,
  input_json     jsonb,
  output_json    jsonb,
  error_message  text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  duration_ms    integer,
  total_cost_usd numeric(12,6) not null default 0
);

create table traceable.run_steps (
  id                         bigserial primary key,
  run_id                     text not null references traceable.runs(run_id) on delete cascade,
  step_index                 integer not null,
  step_type                  text not null check (step_type in ('node','gate')),
  step_name                  text not null,
  display_name               text not null,
  description                text not null,
  status                     text not null check (status in ('running','succeeded','failed')),
  input_json                 jsonb,
  output_json                jsonb,
  gate_decision              text,
  gate_reason                text,
  next_step_name             text,
  error_message              text,
  started_at                 timestamptz not null default now(),
  finished_at                timestamptz,
  duration_ms                integer,
  node_kind                  text check (node_kind in ('code','llm')),
  llm_model                  text,
  llm_tokens_in              integer,
  llm_tokens_out             integer,
  llm_cost_usd               numeric(12,6),
  llm_provider_generation_id text,
  unique (run_id, step_index)
);
```

Full DDL in `templates/sql/020_runs.sql`.

`display_name` and `description` are **copied onto the step row at write time**, not
joined from the manifest. A run from March must still read correctly after the step was
renamed in June. Run history is a historical record, not a view over current config.

## LLM nodes: model, tokens, cost, generation id

Every `kind: llm` node records five extra fields. They are not optional — a run whose
cost is unknown cannot answer the question the owner will actually ask.

| Column | Source |
| --- | --- |
| `llm_model` | the model id sent, e.g. `anthropic/claude-sonnet-5` |
| `llm_tokens_in` / `llm_tokens_out` | the provider's usage block on the response |
| `llm_cost_usd` | price table × usage at write time; corrected by backfill |
| `llm_provider_generation_id` | the provider's own id for the call, e.g. OpenRouter's `gen-...` |

**Prices live in a table, not in code:**

```sql
create table traceable.llm_model_prices (
  model             text primary key,
  input_usd_per_1m  numeric(12,6) not null,
  output_usd_per_1m numeric(12,6) not null,
  updated_at        timestamptz not null default now()
);
```

so the owner can see which price was used, and a price change does not need a deploy.

**Backfill the authoritative cost.** Computed cost is an estimate. When the provider
exposes a stats endpoint, reconcile it. For OpenRouter:

```
GET https://openrouter.ai/api/v1/generation?id=<gen-id>
→ { model, provider_name, tokens_prompt, tokens_completion,
    native_tokens_prompt, native_tokens_completion, total_cost, latency }
```

`total_cost` is what you are billed. Run a small backfill job a minute after the run
(stats can lag the completion), update `llm_cost_usd` and the run's `total_cost_usd`.
Store the generation id even if you never backfill — it is what lets the owner or you
reconcile a surprising invoice line against a specific run.

Do not put the API key or the raw prompt in `run_steps` if the prompt contains personal
data; store what the node was given (`input_json`) and what it returned, and treat the
prompt template as code.

## Failure handling

| Situation | What the run record must show |
| --- | --- |
| Node throws | that step `failed` with the error message, run `failed`, later steps absent |
| Gate returns an unknown route | step `failed`, `gate.invalid-result`, run `failed` |
| LLM call times out | step `failed`, `llm_model` still recorded, tokens null, error message present |
| Process killed mid-run | step stays `running` with no `finished_at`; a reaper marks runs with no heartbeat older than N minutes as `failed` with `error_message: 'run did not finish'` |
| Job never started (cron missed) | nothing — which is why the Jobs page shows "last run" and flags overdue jobs |

The last two are the ones people forget, and they are exactly the ones where the owner
needs to know the system did nothing.

## Why flattened, not a graph

Burr and LangGraph render runs as graphs. A graph is the right picture for the person
who wrote the pipeline, and the wrong one for the person verifying it — it asks them to
trace arrows and infer which path was taken.

A run is shown as a numbered list of what actually happened:

```
1  Load the organisation              node   12ms    ✓
2  Does this reason need checking?    gate    1ms    → needs_check
      "Suspension, so the reason text needs checking."
3  Check the reason makes sense       llm   1,340ms  ✓  claude-sonnet-5 · 412→38 tok · $0.0021
4  Was the reason acceptable?         gate    0ms    → accept
      "The model judged the reason specific and business-related."
5  Apply the new status               node    9ms    ✓  wrote tenants, tenant_status_history
```

Reads top to bottom, no inference, and every line names a real thing. Show the graph in
the Jobs page as the *declared* shape; show the flattened list in the Runs page as what
happened.
